// The orgasm.dev device SDK: capture, attest, seal, publish.
//
// Your server creates a live session (POST /v1/live-sessions with the secret
// key and the device's capability hash) and hands the device the session's
// `ingest` and `results.clientToken`. On the device:
//
//   import { publishLiveSession, newCapability } from '@orgasm-dev/device';
//   const { capability, capabilityHash } = await newCapability();  // keep `capability` here; send the hash to your server
//   const session = await yourServer.createLiveSession(capabilityHash);
//   const { stream } = await requestCapture();   // '@orgasm-dev/device/capture'
//   const live = await publishLiveSession({ session, capability, stream });
//   live.subscribe({ onEvent: (event) => render(event) });   // imminence, onset, peak, end...
//   live.reportStimulation({ state: 'on', level: 31, levelMax: 60, mode: 'waves' });   // if your product drives a device
//   // later: await live.stop({ releaseCamera: true });
//
// The device verifies the enclave's attestation against the published policy
// before it sends a frame, seals every signalling request to the enclave, and
// holds the WHIP answer to the enclave's signed evidence. Video never reaches
// orgasm.dev's servers; only the numbers in the events do.
//
// This entry point is the part that touches the media and the enclave, kept
// small to be read. The optional parts are their own entry points:
// '@orgasm-dev/device/capture' (the camera and microphone prompt) and
// '@orgasm-dev/device/hud' (the heads-up display and its model).

import { newCapability, newClientNonce, verifyEnclave, type AttestationPolicy, type VerifiedEnclave } from './attestation.ts';
import { slotCredential } from './seal.ts';
import { EnclavePublisher, type PublishState } from './publish.ts';
import { subscribe, type SubscribeOptions, type Subscription } from './subscribe.ts';
import { reporterOf, stimulationReporter, type StimulationReport, type StimulationReporter } from './socket.ts';

export {
  newCapability,
  newClientNonce,
  verifyEnclave,
  AttestationRefused,
} from './attestation.ts';
export type { AttestationPolicy, VerifiedEnclave } from './attestation.ts';
export { EnclavePublisher } from './publish.ts';
export type { PublishState } from './publish.ts';
export { subscribe, streamOf } from './subscribe.ts';
export type { FrameKind, StreamSource, SubscribeOptions, Subscription, SubscriptionDetail, SubscriptionState } from './subscribe.ts';
export { mergeReports, reporterOf, stimulationReporter } from './socket.ts';
export type { ReporterError, ReporterState, StimulationReport, StimulationReporter, StimulationReporterOptions } from './socket.ts';
export { FACE_EXPRESSION_CHANNELS, SESSION_EVENT_TYPES, isFaceFrame, isSessionEvent, isFinalEvent } from './events.ts';
export type * from './events.ts';

/** The `ingest` object a live session returns (specs/openapi.yaml Ingest). */
export interface Ingest {
  protocol: 'whip';
  url: string;
  bodyUrl: string | null;
  attestationUrl: string;
  seal: 'v1';
  iceServersUrl: string;
  expiresAt: string;
  video?: unknown;
  audio?: unknown;
}

/** Enough of a live session for the device (createLiveSession's response). */
export interface LiveSession {
  id: string;
  ingest: Ingest | null;
  results: { streamUrl: string; websocketUrl: string; eventsUrl: string; clientToken: string; clientTokenExpiresAt: string };
}

export interface PublishLiveInput {
  session: LiveSession;
  /** The 32-byte capability (base64url) whose hash your server sent (newCapability). */
  capability: string;
  stream: MediaStream;
  /** Override the attestation policy URL; by default derived from the session's API origin. */
  policyUrl?: string;
  withoutAudio?: boolean;
  onState?: (state: PublishState, detail?: string) => void;
  fetchImpl?: typeof fetch;
}

export interface LiveHandle {
  enclave: VerifiedEnclave;
  publisher: EnclavePublisher;
  /** The session's events, with its client token (see `subscribe`). */
  subscribe(options: Omit<SubscribeOptions, 'streamUrl' | 'token'>): Subscription;
  /**
   * The session's events; returns an unsubscribe. `onError` is called once if
   * the stream is refused. Kept for 0.1 code: `subscribe` says more.
   */
  events(onEvent: (event: unknown) => void, onError?: (error: Event) => void): () => void;
  /**
   * Tell orgasm.dev what the device your product drives is doing: its level,
   * channels and mode. Merged and sent at most four times a second, over the
   * session's socket or, while it is down, over HTTP (see `stimulationReporter`).
   */
  reportStimulation(report: StimulationReport): void;
  /** The reporter behind reportStimulation, once a report has been made. */
  readonly stimulation: StimulationReporter | null;
  /** Hang up. With `releaseCamera`, also stop the stream's tracks, so the camera light goes off. */
  stop(options?: { releaseCamera?: boolean }): Promise<void>;
}

function apiOriginOf(session: LiveSession): string {
  return new URL(session.results.streamUrl).origin;
}

/**
 * Verify the enclave, fetch the session's ICE servers, and publish the camera
 * and microphone. Resolves once the WHIP answer is applied; throws
 * AttestationRefused if the enclave does not verify (nothing is sent then).
 */
export async function publishLiveSession(input: PublishLiveInput): Promise<LiveHandle> {
  const { session, capability, stream } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const ingest = session.ingest;
  if (!ingest) throw new Error('this session has ended; it has no ingest');

  const enclaveOrigin = new URL(ingest.url).origin;
  const policyUrl = input.policyUrl ?? `${apiOriginOf(session)}/v1/attestation-policy?mode=live`;
  const enclave = await verifyEnclave({ origin: enclaveOrigin, policyUrl, fetchImpl });

  const iceServers = await fetchImpl(ingest.iceServersUrl, { headers: { authorization: `Bearer ${session.results.clientToken}` } })
    .then((r) => (r.ok ? r.json() : { iceServers: [] }))
    .then((body) => (body.iceServers ?? []) as RTCIceServer[])
    .catch(() => [] as RTCIceServer[]);

  const credential = slotCredential(capability, enclave.seal);
  const publisher = new EnclavePublisher({
    endpoint: ingest.url,
    enclave,
    credential,
    clientNonce: newClientNonce(),
    iceServers,
    stream,
    withoutAudio: input.withoutAudio,
    onState: input.onState,
  });
  await publisher.start();

  const source = { streamUrl: session.results.streamUrl, token: session.results.clientToken };
  let reporter: StimulationReporter | null = null;
  return {
    enclave,
    publisher,
    reportStimulation(report) {
      reporter ??= stimulationReporter({ ...reporterOf(session), fetchImpl: input.fetchImpl });
      reporter.report(report);
    },
    get stimulation() {
      return reporter;
    },
    subscribe(options) {
      return subscribe({ fetchImpl: input.fetchImpl, ...options, ...source });
    },
    events(onEvent, onError) {
      const subscription = subscribe({
        ...source,
        fetchImpl: input.fetchImpl,
        onEvent,
        onState: (state) => {
          if (state === 'refused' && onError) onError(new Event('error'));
        },
      });
      return () => subscription.close();
    },
    async stop(options) {
      await reporter?.flush();
      reporter?.close();
      await publisher.stop();
      if (options?.releaseCamera) for (const track of stream.getTracks()) track.stop();
    },
  };
}
