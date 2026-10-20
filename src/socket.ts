// Stimulation reports from your product: the device's level, channels and
// mode, sent over the session's WebSocket (`results.websocketUrl`) while it
// is open and over HTTP (`reportStimulation`) while it is not. A report is
// merged into the one waiting to go, the way orgasm.dev merges them, and at
// most four go a second, so a dial turned fast sends where it ended up and
// never a queue of where it was.
//
//   const reporter = stimulationReporter(reporterOf(session));
//   reporter.report({ state: 'on', level: 31, levelMax: 60, mode: 'waves' });
//   reporter.report({ state: 'on', level: 34 });   // only the level changed
//   await reporter.flush();
//   reporter.close();
//
// The socket also carries the session's events, so `onEvent` can read them
// from the same connection; by default it asks only for `session.status`, to
// know when the session is over. A dropped socket reconnects after the last
// event it read (`after`), sending over HTTP until it is back.

import { isFaceFrame, isFinalEvent, isSessionEvent, type FaceFrame, type SessionEvent, type SessionEventType, type StimulationDrive } from './events.ts';
import type { FrameKind } from './subscribe.ts';

/** What changed, as `reportStimulation` takes it: a field left out keeps its last value, and null clears it. */
export interface StimulationReport {
  state: 'on' | 'off';
  /** 0 to 1 on your product's own scale. */
  intensity?: number | null;
  /** The device's level on its own scale. */
  level?: number | null;
  /** The highest level the device will go to now; a display fills a bar toward it. */
  levelMax?: number | null;
  /** Each output's level, for a device with more than one (at most four). */
  channels?: { id: string; level: number; levelMax?: number | null }[] | null;
  mode?: string | null;
  /** The mode's name to show; without it a display shows `mode` in words. */
  modeLabel?: string | null;
  /** Never the person's name. */
  device?: { label?: string | null; connected?: boolean } | null;
  drive?: StimulationDrive | null;
  /** When it happened, in stream seconds; by default when orgasm.dev receives it. */
  streamTimeS?: number;
}

/** `later` over `earlier`, as orgasm.dev merges reports: what `later` carries wins, an output's or the device's fields one by one. */
export function mergeReports(earlier: StimulationReport, later: StimulationReport): StimulationReport {
  const merged: StimulationReport = { ...earlier, ...later };
  if (Array.isArray(later.channels) && Array.isArray(earlier.channels)) {
    merged.channels = later.channels.map((channel) => {
      if (channel.levelMax !== undefined) return channel;
      const before = earlier.channels!.find((c) => c.id === channel.id);
      return before?.levelMax !== undefined ? { ...channel, levelMax: before.levelMax } : channel;
    });
  }
  if (later.device && earlier.device) merged.device = { ...earlier.device, ...later.device };
  if (later.streamTimeS === undefined) delete merged.streamTimeS;
  return merged;
}

export type ReporterState =
  /** Opening the socket. */
  | 'connecting'
  /** Reports go over the socket. */
  | 'open'
  /** Reports go over HTTP: no socket here, or it is down and being tried again. */
  | 'http'
  /** The session is over; reports are dropped. */
  | 'ended'
  /** The token was refused; reports are dropped. */
  | 'refused'
  /** Closed by the caller. */
  | 'closed';

export interface ReporterError {
  /** `socket.error`'s code, or the problem's from the HTTP route. */
  code: string;
  detail: string;
}

export interface StimulationReporterOptions {
  /** The session's `results.websocketUrl`. */
  websocketUrl: string;
  /** Its HTTP twin, `POST /v1/live-sessions/{sessionId}/stimulation`. */
  reportUrl: string;
  /** The session's client token on the device; your secret key on your server. */
  token: string;
  /**
   * How the socket is opened. By default the platform's WebSocket, with the
   * client token in the URL as the contract allows; a secret key never goes
   * in a URL, so with one the reports go over HTTP unless this opens a
   * socket that sends it as a header.
   */
  openSocket?: ((url: string) => WebSocket) | null;
  /** `http` sends every report over HTTP. */
  transport?: 'auto' | 'http';
  /** At most one report per this many ms; 250 by default, the rate the contract keeps. */
  intervalMs?: number;
  fetchImpl?: typeof fetch;
  onState?: (state: ReporterState) => void;
  /** A report refused, over either transport. */
  onError?: (error: ReporterError) => void;
  /** The events the socket carries (`types`); only `session.status` unless asked. */
  onEvent?: (event: SessionEvent) => void;
  types?: readonly SessionEventType[];
  frames?: readonly FrameKind[];
  onFaceFrame?: (frame: FaceFrame) => void;
  /** The waits before each successive reconnect; the last repeats. */
  retryDelaysMs?: readonly number[];
}

export interface StimulationReporter {
  /** Queue a report; it goes with the next send, merged with any still waiting. */
  report(report: StimulationReport): void;
  /** Resolves when nothing is waiting or in flight (or the reporter is done). */
  flush(): Promise<void>;
  close(): void;
  readonly state: ReporterState;
}

/** A reporter's addresses, from createLiveSession's response. */
export function reporterOf(session: { id: string; results: { websocketUrl: string; streamUrl: string; clientToken: string } }): Pick<StimulationReporterOptions, 'websocketUrl' | 'reportUrl' | 'token'> {
  const origin = new URL(session.results.streamUrl).origin;
  return { websocketUrl: session.results.websocketUrl, reportUrl: `${origin}/v1/live-sessions/${session.id}/stimulation`, token: session.results.clientToken };
}

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const SEEN_LIMIT = 4_096;
const SOCKET_OPEN = 1;
/** HTTP answers a retry will not change. */
const REFUSED = new Set([400, 401, 403, 404, 422]);

export function stimulationReporter(options: StimulationReporterOptions): StimulationReporter {
  const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const intervalMs = options.intervalMs ?? 250;
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : BACKOFF_MS;
  const clientToken = options.token.startsWith('ct_');
  const openSocket =
    options.transport === 'http'
      ? null
      : options.openSocket !== undefined
        ? options.openSocket
        : clientToken && typeof WebSocket === 'function'
          ? (url: string) => new WebSocket(url)
          : null;

  let state: ReporterState = openSocket ? 'connecting' : 'http';
  let socket: WebSocket | null = null;
  let pending: StimulationReport | null = null;
  let inFlight: Promise<void> | null = null;
  let lastSentAt = -Infinity;
  let sendTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;
  let lastEventId: string | null = null;
  const seen = new Set<string>();
  const seenOrder: string[] = [];
  const idle: (() => void)[] = [];

  const over = () => state === 'ended' || state === 'refused' || state === 'closed';
  const settleIdle = () => {
    if (pending || inFlight) return;
    for (const resolve of idle.splice(0)) resolve();
  };
  const setState = (next: ReporterState) => {
    if (over() || state === next) return;
    state = next;
    options.onState?.(next);
    if (over()) {
      pending = null;
      if (sendTimer !== null) clearTimeout(sendTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      sendTimer = retryTimer = null;
      const open = socket;
      socket = null;
      if (open && open.readyState <= SOCKET_OPEN) open.close(1000);
      for (const resolve of idle.splice(0)) resolve();
    }
  };

  const schedule = () => {
    if (over() || !pending || sendTimer !== null || inFlight) return;
    const wait = Math.max(0, lastSentAt + intervalMs - Date.now());
    sendTimer = setTimeout(() => {
      sendTimer = null;
      send();
    }, wait);
  };

  const requeue = (report: StimulationReport) => {
    pending = pending ? mergeReports(report, pending) : report;
  };

  const send = () => {
    if (over() || !pending) return settleIdle();
    const report = pending;
    pending = null;
    lastSentAt = Date.now();
    if (socket && socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify({ action: 'stimulation', ...report }));
      schedule();
      return settleIdle();
    }
    inFlight = postReport(report).finally(() => {
      inFlight = null;
      schedule();
      settleIdle();
    });
  };

  const postReport = async (report: StimulationReport): Promise<void> => {
    try {
      const response = await fetchImpl(options.reportUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(report),
      });
      if (response.ok) return;
      const problem = (await response.json().catch(() => null)) as { code?: string; detail?: string } | null;
      const error = { code: problem?.code ?? `http_${response.status}`, detail: problem?.detail ?? `The report was answered ${response.status}.` };
      if (response.status === 409) return void setState('ended');
      if (response.status === 401) {
        options.onError?.(error);
        return void setState('refused');
      }
      if (REFUSED.has(response.status)) return void options.onError?.(error);
      requeue(report);
      await new Promise((resolve) => setTimeout(resolve, delays[Math.min(attempt++, delays.length - 1)]));
    } catch {
      requeue(report);
      await new Promise((resolve) => setTimeout(resolve, delays[Math.min(attempt++, delays.length - 1)]));
    }
  };

  const socketUrl = () => {
    const url = new URL(options.websocketUrl);
    if (clientToken) url.searchParams.set('token', options.token);
    url.searchParams.set('types', (options.types?.length ? options.types : ['session.status']).join(','));
    if (options.frames?.length) url.searchParams.set('frames', options.frames.join(','));
    if (lastEventId) url.searchParams.set('after', lastEventId);
    return url.toString();
  };

  const reconnectLater = () => {
    if (over() || !openSocket) return;
    setState('http');
    const wait = delays[Math.min(attempt, delays.length - 1)];
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, wait);
  };

  const onMessage = (data: unknown) => {
    let message: unknown;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (isSessionEvent(message)) {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      seenOrder.push(message.id);
      if (seenOrder.length > SEEN_LIMIT) seen.delete(seenOrder.shift()!);
      lastEventId = message.id;
      options.onEvent?.(message);
      if (isFinalEvent(message)) setState('ended');
      return;
    }
    if (isFaceFrame(message)) return void options.onFaceFrame?.(message);
    const refusal = message as { type?: string; code?: string; detail?: string };
    if (refusal?.type === 'socket.error') {
      if (refusal.code === 'session_ended') return void setState('ended');
      if (refusal.code === 'rate_limited') return; // the close that follows says the rest
      options.onError?.({ code: refusal.code ?? 'invalid_message', detail: refusal.detail ?? '' });
    }
  };

  const connect = () => {
    if (over() || !openSocket) return;
    let ws: WebSocket;
    try {
      ws = openSocket(socketUrl());
    } catch {
      return void reconnectLater();
    }
    socket = ws;
    if (state !== 'http') setState('connecting');
    ws.onopen = () => {
      if (socket !== ws) return;
      attempt = 0;
      setState('open');
      schedule();
    };
    ws.onmessage = (event: MessageEvent) => onMessage(event.data);
    ws.onclose = (event: CloseEvent) => {
      if (socket !== ws) return;
      socket = null;
      if (event.code === 1000) return void setState('ended');
      if (event.code === 1008) return void setState('refused');
      // 1013: the session's streams are all taken; HTTP carries the reports, and the socket is tried again later.
      reconnectLater();
      schedule();
    };
    ws.onerror = () => {};
  };

  if (openSocket) connect();

  return {
    report(report) {
      if (over()) return;
      pending = pending ? mergeReports(pending, report) : report;
      schedule();
    },
    flush() {
      if (over() || (!pending && !inFlight)) return Promise.resolve();
      return new Promise<void>((resolve) => {
        idle.push(resolve);
        schedule();
      });
    },
    close: () => setState('closed'),
    get state() {
      return state;
    },
  };
}
