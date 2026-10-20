import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeReports, reporterOf, stimulationReporter, type ReporterState } from '../src/socket.ts';

const SESSION = 'ls_8f3kq2m7x9w4c1n6t5ra';
const SOCKET = `wss://orgasm.dev/v1/live-sessions/${SESSION}/ws`;
const REPORT = `https://orgasm.dev/v1/live-sessions/${SESSION}/stimulation`;

class FakeSocket {
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.drop(code);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  drop(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

const openSocket = (url: string) => new FakeSocket(url) as unknown as WebSocket;

function http(answer: (body: Record<string, unknown>) => Response = () => new Response('{}', { status: 200 })) {
  const posts: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    posts.push(body);
    return answer(body);
  }) as typeof fetch;
  return { posts, fetchImpl };
}

const status = (sequence: number, value: string) => ({
  id: `evt_${String(sequence).padStart(20, '0')}`,
  object: 'event',
  type: 'session.status',
  mode: 'test',
  sessionId: SESSION,
  sequence,
  streamTimeS: sequence,
  wallTime: '2026-10-19T20:00:00Z',
  confidence: null,
  data: { status: value, previousStatus: 'analyzing', degraded: false, inputs: {}, endedReason: value === 'ended' ? 'client_ended' : null },
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.made = [];
});
afterEach(() => vi.useRealTimers());

describe('merging reports', () => {
  it('lets the later report win field by field, an output’s maximum and the device’s fields kept where it says nothing', () => {
    const merged = mergeReports(
      { state: 'on', level: 10, levelMax: 60, mode: 'waves', channels: [{ id: 'a', level: 10, levelMax: 60 }], device: { label: 'Unit' }, streamTimeS: 12 },
      { state: 'on', level: 12, mode: null, channels: [{ id: 'a', level: 12 }], device: { connected: false } },
    );
    expect(merged).toEqual({ state: 'on', level: 12, levelMax: 60, mode: null, channels: [{ id: 'a', level: 12, levelMax: 60 }], device: { label: 'Unit', connected: false } });
  });
});

describe('the stimulation reporter', () => {
  it('sends over the socket, at most four a second, each the merge of what waited', async () => {
    const reporter = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', openSocket });
    const socket = FakeSocket.made[0];
    const url = new URL(socket.url);
    expect([url.searchParams.get('token'), url.searchParams.get('types')]).toEqual(['ct_abc', 'session.status']);
    socket.open();
    expect(reporter.state).toBe('open');

    reporter.report({ state: 'on', level: 10, mode: 'waves' });
    await vi.advanceTimersByTimeAsync(0);
    reporter.report({ state: 'on', level: 11 });
    reporter.report({ state: 'on', level: 12, drive: 'manual' });
    await vi.advanceTimersByTimeAsync(100);
    expect(socket.sent).toEqual([{ action: 'stimulation', state: 'on', level: 10, mode: 'waves' }]);
    await vi.advanceTimersByTimeAsync(150);
    expect(socket.sent[1]).toEqual({ action: 'stimulation', state: 'on', level: 12, drive: 'manual' });
    await reporter.flush();
    reporter.close();
    expect(reporter.state).toBe('closed');
  });

  it('reports over HTTP while the socket is down, and reconnects after the last event it read', async () => {
    const { posts, fetchImpl } = http();
    const states: ReporterState[] = [];
    const reporter = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', openSocket, fetchImpl, onState: (s) => states.push(s) });
    reporter.report({ state: 'on', level: 5 });
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toEqual([{ state: 'on', level: 5 }]);

    const first = FakeSocket.made[0];
    first.open();
    first.receive(status(7, 'analyzing'));
    first.drop(1006);
    expect(reporter.state).toBe('http');
    reporter.report({ state: 'on', level: 6 });
    await vi.advanceTimersByTimeAsync(300);
    expect(posts.at(-1)).toEqual({ state: 'on', level: 6 });

    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.made[1];
    expect(new URL(second.url).searchParams.get('after')).toBe(status(7, 'analyzing').id);
    second.open();
    expect(states).toEqual(['open', 'http', 'open']);
    reporter.close();
  });

  it('stops at the final status, at a close of 1000 or a 409, and at a refused token', async () => {
    const ended = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', openSocket });
    FakeSocket.made[0].open();
    FakeSocket.made[0].receive(status(9, 'ended'));
    expect(ended.state).toBe('ended');
    ended.report({ state: 'on', level: 1 });
    await vi.advanceTimersByTimeAsync(300);
    expect(FakeSocket.made[0].sent).toEqual([]);

    const closed = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', openSocket });
    FakeSocket.made[1].drop(1008);
    expect(closed.state).toBe('refused');

    const { fetchImpl } = http(() => new Response(JSON.stringify({ code: 'session_ended' }), { status: 409 }));
    const late = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', transport: 'http', fetchImpl });
    late.report({ state: 'off' });
    await vi.advanceTimersByTimeAsync(0);
    expect(late.state).toBe('ended');
  });

  it('keeps a secret key out of URLs: HTTP, unless it is given a socket that sends the key as a header', async () => {
    const { posts, fetchImpl } = http();
    const server = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'sk_test_abc', fetchImpl });
    expect([server.state, FakeSocket.made.length]).toEqual(['http', 0]);
    server.report({ state: 'on', intensity: 0.4 });
    const flushed = server.flush();
    await vi.advanceTimersByTimeAsync(0);
    await flushed;
    expect(posts).toEqual([{ state: 'on', intensity: 0.4 }]);

    stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'sk_test_abc', openSocket });
    expect(new URL(FakeSocket.made[0].url).searchParams.has('token')).toBe(false);
  });

  it('says what was refused and keeps going; retries what failed, merged under what came since', async () => {
    let answer = 422;
    const { posts, fetchImpl } = http(() => new Response(JSON.stringify({ code: 'invalid_request', detail: 'level must be a number of at least 0, or null to clear it.' }), { status: answer }));
    const errors: string[] = [];
    const reporter = stimulationReporter({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc', transport: 'http', fetchImpl, onError: (e) => errors.push(e.code) });
    reporter.report({ state: 'on', level: -1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['invalid_request']);

    answer = 503;
    reporter.report({ state: 'on', level: 4, mode: 'waves' });
    await vi.advanceTimersByTimeAsync(0);
    reporter.report({ state: 'on', level: 5 });
    answer = 200;
    await vi.advanceTimersByTimeAsync(1_300);
    expect(posts.at(-1)).toEqual({ state: 'on', level: 5, mode: 'waves' });
    expect(reporter.state).toBe('http');
  });

  it('takes its addresses from the session', () => {
    expect(
      reporterOf({ id: SESSION, results: { websocketUrl: SOCKET, streamUrl: `https://orgasm.dev/v1/live-sessions/${SESSION}/stream`, clientToken: 'ct_abc' } }),
    ).toEqual({ websocketUrl: SOCKET, reportUrl: REPORT, token: 'ct_abc' });
  });
});
