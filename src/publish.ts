// Publish the device's front camera and microphone to the verified enclave
// over WHIP, with every signalling request sealed to the enclave and the
// answer held to the enclave's signed evidence before it is applied - so the
// DTLS handshake that follows can only be with the attested enclave.
//
// A trimmed WHIP peer: POST the offer, follow Location, trickle ICE with
// PATCH, hang up with DELETE. Browser/WebView only (RTCPeerConnection).

import { verifyAnswerEvidence, type VerifiedEnclave } from './attestation.ts';
import type { SlotCredential, SlotRequest } from './seal.ts';

const DEFAULT_MAX_BITRATE = 2_500_000;
const DEFAULT_MAX_FRAMERATE = 30;

export type PublishState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export interface PublishOptions {
  endpoint: string;
  enclave: VerifiedEnclave;
  credential: SlotCredential;
  clientNonce: string;
  iceServers: RTCIceServer[];
  stream: MediaStream;
  withoutAudio?: boolean;
  maxBitrate?: number;
  maxFramerate?: number;
  onState?: (state: PublishState, detail?: string) => void;
}

interface OfferDescription {
  iceUfrag: string;
  icePwd: string;
  medias: string[];
}

function parseOffer(sdp: string): OfferDescription {
  const description: OfferDescription = { iceUfrag: '', icePwd: '', medias: [] };
  for (const line of sdp.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('m=')) description.medias.push(trimmed.slice(2));
    else if (!description.iceUfrag && trimmed.startsWith('a=ice-ufrag:')) description.iceUfrag = trimmed.slice(12);
    else if (!description.icePwd && trimmed.startsWith('a=ice-pwd:')) description.icePwd = trimmed.slice(10);
  }
  return description;
}

function sdpFragment(offer: OfferDescription, candidates: RTCIceCandidate[]): string {
  const byMedia = new Map<number, RTCIceCandidate[]>();
  for (const candidate of candidates) {
    const index = candidate.sdpMLineIndex ?? 0;
    if (!byMedia.has(index)) byMedia.set(index, []);
    byMedia.get(index)!.push(candidate);
  }
  let fragment = `a=ice-ufrag:${offer.iceUfrag}\r\na=ice-pwd:${offer.icePwd}\r\n`;
  offer.medias.forEach((media, index) => {
    const list = byMedia.get(index);
    if (!list) return;
    fragment += `m=${media}\r\na=mid:${index}\r\n`;
    for (const candidate of list) fragment += `a=candidate:${candidate.candidate.replace(/^candidate:/, '')}\r\n`;
  });
  return fragment;
}

function preferH264(transceiver: RTCRtpTransceiver): void {
  try {
    const capabilities = RTCRtpSender.getCapabilities?.('video');
    if (!capabilities || typeof transceiver.setCodecPreferences !== 'function') return;
    const h264 = capabilities.codecs.filter((c) => /h264/i.test(c.mimeType));
    const rest = capabilities.codecs.filter((c) => !/h264/i.test(c.mimeType));
    if (h264.length) transceiver.setCodecPreferences([...h264, ...rest]);
  } catch {
    // leave the browser's default order
  }
}

/** One live publish of the device's camera (and microphone) to the enclave. */
export class EnclavePublisher {
  state: PublishState = 'new';
  private pc: RTCPeerConnection | null = null;
  private location: string | null = null;
  private offer: OfferDescription | null = null;
  private queued: RTCIceCandidate[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private audioClone: MediaStreamTrack | null = null;
  private stopped = false;

  constructor(private readonly options: PublishOptions) {}

  private setState(state: PublishState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.options.onState?.(state, detail);
  }

  private async send(method: string, url: string, headers: Record<string, string>, body: string | null): Promise<Response> {
    const request: SlotRequest = { method, url, headers, body };
    const prepared = await this.options.credential.prepare(request);
    return fetch(url, { method, headers: prepared.headers, body: prepared.body });
  }

  async start(): Promise<void> {
    if (this.pc) return;
    this.stopped = false;
    this.setState('connecting');
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    this.pc = pc;

    const track = this.options.stream.getVideoTracks()[0];
    if (!track) throw new Error('no video track to publish');
    const transceiver = pc.addTransceiver(track, {
      direction: 'sendonly',
      streams: [this.options.stream],
      sendEncodings: [{ maxBitrate: this.options.maxBitrate ?? DEFAULT_MAX_BITRATE, maxFramerate: this.options.maxFramerate ?? DEFAULT_MAX_FRAMERATE }],
    });
    preferH264(transceiver);
    const mic = this.options.withoutAudio ? undefined : this.options.stream.getAudioTracks().find((t) => t.readyState === 'live');
    if (mic) {
      this.audioClone = mic.clone();
      pc.addTransceiver(this.audioClone, { direction: 'sendonly', streams: [this.options.stream] });
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !event.candidate.candidate) return;
      this.queued.push(event.candidate);
      this.scheduleFlush();
    };
    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case 'connected': this.setState('connected'); break;
        case 'disconnected': this.setState('disconnected'); break;
        case 'failed': this.setState('failed', 'connection failed'); break;
        case 'closed': this.setState('closed'); break;
        default: break;
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.offer = parseOffer(offer.sdp ?? '');

    const headers = { 'content-type': 'application/sdp', [headerKey('client-nonce')]: this.options.clientNonce };
    const response = await this.send('POST', this.options.endpoint, headers, offer.sdp ?? '');
    if (this.stopped) return;
    if (response.status !== 201) {
      const detail = await response.text().catch(() => '');
      this.setState('failed', `publish POST ${response.status}`);
      throw Object.assign(new Error(`publish signalling ${response.status}${detail ? ` ${detail.slice(0, 120)}` : ''}`), { status: response.status });
    }
    const location = response.headers.get('location');
    const answer = await response.text();
    // The answer must be the attested enclave's, or nothing is sent to it.
    await verifyAnswerEvidence({ enclave: this.options.enclave, role: 'whip', headers: response.headers, answerSdp: answer, clientNonce: this.options.clientNonce });
    if (this.stopped) return;
    this.location = location;
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || !this.location || !this.queued.length) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, 60);
  }

  private async flush(): Promise<void> {
    if (!this.location || !this.offer || this.stopped) return;
    const batch = this.queued.splice(0, this.queued.length);
    if (!batch.length) return;
    try {
      await this.send('PATCH', this.location, { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': '*' }, sdpFragment(this.offer, batch));
    } catch {
      // the relay may be catching up; the next batch retries
    }
    if (this.queued.length) this.scheduleFlush();
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const location = this.location;
    this.location = null;
    const pc = this.pc;
    this.pc = null;
    if (location) {
      try {
        await this.send('DELETE', location, {}, null);
      } catch {
        // the relay may be gone
      }
    }
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      pc.close();
    }
    if (this.audioClone) {
      this.audioClone.stop();
      this.audioClone = null;
    }
    this.setState('closed');
  }
}

/** The enclave's client-nonce header, lowercased for a request's header map. */
function headerKey(suffix: string): string {
  return `x-masseuse-${suffix}`;
}
