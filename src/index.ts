// The orgasm.dev device SDK: capture, attest, seal, publish.
//
// Your server creates a live session (POST /v1/live-sessions with the secret
// key and the device's capability hash) and hands the device the session's
// `ingest` and `results.clientToken`. On the device:
//
//   import { publishLiveSession, newCapability } from '@orgasm-dev/device';
//   const { capability, capabilityHash } = await newCapability();  // keep `capability` here; send the hash to your server
//   const session = await yourServer.createLiveSession(capabilityHash);
//   const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
//   const live = await publishLiveSession({ session, capability, stream });
//   live.events((event) => render(event));   // imminence, onset, peak, end...
//   // later: await live.stop();
//
// The device verifies the enclave's attestation against the published policy
// before it sends a frame, seals every signalling request to the enclave, and
// holds the WHIP answer to the enclave's signed evidence. Video never reaches
// orgasm.dev's servers; only the numbers in the events do.

import { newCapability, newClientNonce, verifyEnclave, type AttestationPolicy, type VerifiedEnclave } from './attestation.ts';
import { slotCredential } from './seal.ts';
import { EnclavePublisher, type PublishState } from './publish.ts';

export {
  newCapability,
  newClientNonce,
  verifyEnclave,
  AttestationRefused,
} from './attestation.ts';
export type { AttestationPolicy, VerifiedEnclave } from './attestation.ts';
export { EnclavePublisher } from './publish.ts';
export type { PublishState } from './publish.ts';

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
  /** Subscribe to the session's events over server-sent events; returns an unsubscribe. */
  events(onEvent: (event: unknown) => void, onError?: (error: Event) => void): () => void;
  stop(): Promise<void>;
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

  return {
    enclave,
    publisher,
    events(onEvent, onError) {
      const source = new EventSource(`${session.results.streamUrl}?token=${encodeURIComponent(session.results.clientToken)}`);
      const handler = (event: MessageEvent) => {
        try {
          onEvent(JSON.parse(event.data));
        } catch {
          // a malformed frame is skipped
        }
      };
      for (const type of ['imminence.updated', 'orgasm.onset', 'orgasm.peak', 'orgasm.end', 'subject.identified', 'session.status', 'input.warning']) {
        source.addEventListener(type, handler as EventListener);
      }
      source.onmessage = handler;
      if (onError) source.onerror = onError;
      return () => source.close();
    },
    async stop() {
      await publisher.stop();
    },
  };
}
