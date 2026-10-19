// A live session's events on the device: the session's stream, read with its
// client token (`ct_…`) or a read-only view token (`vt_…`) in the
// Authorization header. Each event arrives once, in order: a redelivered one
// is dropped by its `id`, a gap in `sequence` is reported, a dropped
// connection resumes after the last event (Last-Event-ID), and the
// subscription ends by itself after the session's final status.
//
//   const sub = subscribe({ ...streamOf(session), onEvent: (event) => hud.feed(event) });
//   // later
//   sub.close();
//
// It needs no publish, so it reads a sandbox session as well as a live one.

import { SseParser, type SseFrame } from './sse.ts';
import { isFinalEvent, isSessionEvent, type SessionEvent, type SessionEventType } from './events.ts';

/** Where a session's events are read: its `results.streamUrl` and a token for it. */
export interface StreamSource {
  streamUrl: string;
  /** The session's `results.clientToken`, or a view token from createViewToken. */
  token: string;
}

export type SubscriptionState =
  /** Opening the stream. */
  | 'connecting'
  /** Reading it. */
  | 'open'
  /** It dropped; trying again after a pause, from the last event. */
  | 'reconnecting'
  /** The session's final status arrived; nothing more will. */
  | 'ended'
  /** The token was refused (it expired, or the session is gone); no more tries. */
  | 'refused'
  /** Closed by the caller. */
  | 'closed';

export interface SubscriptionDetail {
  /** The HTTP status, when a response said why. */
  status?: number;
  /** When a reconnect will be tried. */
  retryInMs?: number;
  /** The problem's `code`, when the API sent one. */
  code?: string;
}

export interface SubscribeOptions extends StreamSource {
  /** Only these types (the server filters); every type by default. */
  types?: readonly SessionEventType[];
  /** Start after this event `id` instead of from the first. */
  after?: string;
  onEvent: (event: SessionEvent) => void;
  onState?: (state: SubscriptionState, detail?: SubscriptionDetail) => void;
  /** An event's `sequence` skipped ahead; only reported when no `types` filter is set. */
  onGap?: (gap: { expected: number; received: number }) => void;
  /** A frame that is not a session event this SDK knows (a newer type, or a stream's own frames), by name. */
  onFrame?: (name: string, data: unknown) => void;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Silence after which the connection is presumed dead; keep-alives come every 15 s. */
  idleTimeoutMs?: number;
  /** The waits before each successive reconnect; the last repeats. */
  retryDelaysMs?: readonly number[];
}

export interface Subscription {
  close(): void;
  readonly state: SubscriptionState;
  readonly lastEventId: string | null;
  /** Resolves when the subscription is over: `ended`, `refused` or `closed`. */
  readonly done: Promise<'ended' | 'refused' | 'closed'>;
}

/** A session's stream source, from createLiveSession's response. */
export function streamOf(session: { results: { streamUrl: string; clientToken: string } }): StreamSource {
  return { streamUrl: session.results.streamUrl, token: session.results.clientToken };
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const SEEN_LIMIT = 4_096;
/** Responses that will not change on a retry. */
const REFUSED = new Set([400, 401, 403, 404, 410, 422]);

export function subscribe(options: SubscribeOptions): Subscription {
  const fetchImpl = options.fetchImpl ?? fetch;
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : BACKOFF_MS;
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  let lastEventId: string | null = options.after ?? null;
  let lastSequence: number | null = null;
  let state: SubscriptionState = 'connecting';
  let attempt = 0;
  let controller: AbortController | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let finish!: (end: 'ended' | 'refused' | 'closed') => void;
  const done = new Promise<'ended' | 'refused' | 'closed'>((resolve) => {
    finish = resolve;
  });

  const over = () => state === 'ended' || state === 'refused' || state === 'closed';

  const setState = (next: SubscriptionState, detail?: SubscriptionDetail) => {
    if (over()) return;
    state = next;
    options.onState?.(next, detail);
    if (over()) {
      if (retryTimer !== null) clearTimeout(retryTimer);
      retryTimer = null;
      controller?.abort();
      controller = null;
      finish(next as 'ended' | 'refused' | 'closed');
    }
  };

  const remember = (id: string) => {
    seen.add(id);
    seenOrder.push(id);
    if (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift()!);
  };

  const deliver = (frame: SseFrame) => {
    let data: unknown;
    try {
      data = frame.data === '' ? null : JSON.parse(frame.data);
    } catch {
      return; // a malformed frame is skipped
    }
    if (!isSessionEvent(data)) {
      options.onFrame?.(frame.event, data);
      return;
    }
    const event = data;
    if (seen.has(event.id)) return;
    remember(event.id);
    lastEventId = event.id;
    if (!options.types && lastSequence !== null && event.sequence > lastSequence + 1) {
      options.onGap?.({ expected: lastSequence + 1, received: event.sequence });
    }
    if (lastSequence === null || event.sequence > lastSequence) lastSequence = event.sequence;
    options.onEvent(event);
    if (isFinalEvent(event)) setState('ended');
  };

  const url = (): string => {
    const target = new URL(options.streamUrl);
    if (options.types?.length) target.searchParams.set('types', options.types.join(','));
    return target.toString();
  };

  const retryLater = (detail: SubscriptionDetail = {}, retryAfterMs?: number) => {
    if (over()) return;
    const wait = retryAfterMs ?? delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    setState('reconnecting', { ...detail, retryInMs: wait });
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, wait);
  };

  const connect = async (): Promise<void> => {
    if (over()) return;
    setState('connecting');
    const abort = new AbortController();
    controller = abort;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const touch = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => abort.abort(), idleTimeoutMs);
    };
    try {
      const headers: Record<string, string> = { authorization: `Bearer ${options.token}`, accept: 'text/event-stream' };
      if (lastEventId) headers['last-event-id'] = lastEventId;
      touch();
      const response = await fetchImpl(url(), { headers, signal: abort.signal, cache: 'no-store' });
      if (!response.ok || !response.body) {
        const problem = (await response.json().catch(() => null)) as { code?: string } | null;
        const detail = { status: response.status, code: problem?.code };
        if (REFUSED.has(response.status)) return void setState('refused', detail);
        const retryAfter = Number(response.headers.get('retry-after'));
        return void retryLater(detail, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
      }
      setState('open');
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      const parser = new SseParser();
      let frames = 0;
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) break;
        touch();
        for (const frame of parser.push(value)) {
          frames += 1;
          attempt = 0;
          deliver(frame);
          if (over()) {
            await reader.cancel().catch(() => {});
            return;
          }
        }
      }
      // The server ends a stream only once its session is over: with nothing
      // after the last event read, there is nothing more to come.
      if (frames === 0 && lastEventId !== null) return void setState('ended');
      // It closed mid-session (a restart): read on from the last event.
      retryLater();
    } catch {
      retryLater();
    } finally {
      if (idle !== null) clearTimeout(idle);
      if (controller === abort) controller = null;
    }
  };

  if (options.signal) {
    if (options.signal.aborted) setState('closed');
    else options.signal.addEventListener('abort', () => setState('closed'), { once: true });
  }
  void connect();

  return {
    close: () => setState('closed'),
    get state() {
      return state;
    },
    get lastEventId() {
      return lastEventId;
    },
    done,
  };
}
