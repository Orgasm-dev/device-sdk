import { describe, expect, it } from 'vitest';
import { SseParser } from '../src/sse.ts';
import { subscribe, streamOf, type SubscriptionState } from '../src/subscribe.ts';
import type { SessionEvent } from '../src/events.ts';

const SESSION = 'ls_8f3kq2m7x9w4c1n6t5ra';
const STREAM = `https://orgasm.dev/v1/live-sessions/${SESSION}/stream`;

function event(sequence: number, type: SessionEvent['type'] = 'imminence.updated', data: Record<string, unknown> = {}): SessionEvent {
  return {
    id: `evt_${String(sequence).padStart(20, '0')}`,
    object: 'event',
    type,
    mode: 'test',
    sessionId: SESSION,
    sequence,
    streamTimeS: 60 + sequence,
    wallTime: new Date(Date.UTC(2026, 9, 19, 12, 0, sequence)).toISOString(),
    confidence: 'high',
    data: { p30: 0.2, p60: 0.3, faceVisible: true, baselineReady: true, recentCalls: [], ...data },
  } as unknown as SessionEvent;
}

const frame = (e: unknown, name: string = (e as SessionEvent).type) => `id: ${(e as SessionEvent).id ?? ''}\nevent: ${name}\ndata: ${JSON.stringify(e)}\n\n`;
const ended = (sequence: number) => event(sequence, 'session.status', { status: 'ended', previousStatus: 'analyzing', degraded: false, endedReason: 'client_ended' });

/** A fetch that answers each call with the next scripted response, and records what it was asked. */
function scripted(responses: (() => Response)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    const next = responses.shift();
    if (!next) return new Promise<Response>(() => {});
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function stream(chunks: string[], close = true): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('the frame parser', () => {
  it('reads fields across chunks, CRLF and comments, and dispatches on a blank line', () => {
    const parser = new SseParser();
    expect(parser.push(': keep-alive\n\nid: evt_1\r\nevent: imminence.updated\r\ndata: {"a"')).toEqual([]);
    expect(parser.push(':1}\r')).toEqual([]);
    const frames = parser.push('\n\r\ndata: one\ndata: two\nretry: 1500\n\n');
    expect(frames).toEqual([
      { event: 'imminence.updated', data: '{"a":1}', id: 'evt_1', retry: null },
      { event: 'message', data: 'one\ntwo', id: null, retry: 1500 },
    ]);
  });
});

describe('subscribe', () => {
  it('sends the token in a header, never the URL, and delivers each event once, in order, until the final status', async () => {
    const first = event(1);
    const { calls, fetchImpl } = scripted([() => stream([frame(first), frame(first), frame(event(2)), frame(ended(3))])]);
    const seen: SessionEvent[] = [];
    const states: SubscriptionState[] = [];
    const sub = subscribe({ streamUrl: STREAM, token: 'ct_abc', fetchImpl, onEvent: (e) => seen.push(e), onState: (s) => states.push(s) });
    expect(await sub.done).toBe('ended');
    expect(seen.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe(STREAM);
    expect(calls[0].headers.authorization).toBe('Bearer ct_abc');
    expect(states).toEqual(['connecting', 'open', 'ended']);
  });

  it('reports a gap, resumes after the last event when the stream drops, and ends on an empty close', async () => {
    const { calls, fetchImpl } = scripted([() => stream([frame(event(1)), frame(event(4))]), () => stream([])]);
    const gaps: { expected: number; received: number }[] = [];
    const sub = subscribe({ streamUrl: STREAM, token: 'vt_abc', fetchImpl, retryDelaysMs: [1], onEvent: () => {}, onGap: (g) => gaps.push(g) });
    expect(await sub.done).toBe('ended');
    expect(gaps).toEqual([{ expected: 2, received: 4 }]);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers['last-event-id']).toBe(event(4).id);
  });

  it('stops for good when the token is refused, and keeps trying on a server error', async () => {
    const refused = scripted([() => new Response(JSON.stringify({ code: 'unauthorized' }), { status: 401 })]);
    const states: [SubscriptionState, number | undefined][] = [];
    const sub = subscribe({ streamUrl: STREAM, token: 'ct_old', fetchImpl: refused.fetchImpl, onEvent: () => {}, onState: (s, d) => states.push([s, d?.status]) });
    expect(await sub.done).toBe('refused');
    expect(states.at(-1)).toEqual(['refused', 401]);
    expect(refused.calls).toHaveLength(1);

    const flaky = scripted([() => new Response('', { status: 503 }), () => stream([frame(ended(1))])]);
    const again = subscribe({ streamUrl: STREAM, token: 'ct_abc', fetchImpl: flaky.fetchImpl, retryDelaysMs: [1], onEvent: () => {} });
    expect(await again.done).toBe('ended');
    expect(flaky.calls).toHaveLength(2);
  });

  it('passes on frames that are not session events, filters by type on the server, and closes on request', async () => {
    const { calls, fetchImpl } = scripted([() => stream([frame({ at: 1 }, 'waiting'), frame(event(1))], false)]);
    const frames: [string, unknown][] = [];
    const seen: number[] = [];
    const sub = subscribe({
      ...streamOf({ results: { streamUrl: STREAM, clientToken: 'ct_abc' } }),
      types: ['imminence.updated', 'orgasm.onset'],
      fetchImpl,
      onEvent: (e) => seen.push(e.sequence),
      onFrame: (name, data) => frames.push([name, data]),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(frames).toEqual([['waiting', { at: 1 }]]);
    expect(seen).toEqual([1]);
    expect(new URL(calls[0].url).searchParams.get('types')).toBe('imminence.updated,orgasm.onset');
    sub.close();
    expect(await sub.done).toBe('closed');
    expect(sub.lastEventId).toBe(event(1).id);
  });
});
