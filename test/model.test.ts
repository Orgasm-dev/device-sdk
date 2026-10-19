// The HUD's model against the sandbox's own scenarios (test/fixtures: each
// scenario's full event list, as the sandbox sends it), replayed at real pace:
// what the HUD shows every 15 stream seconds is held in test/golden.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/events.ts';
import { HUD_FRESH_MS, clockText, hudReducer, hudStrings, hudView, initialHudState, type HudState } from '../src/hud/model.ts';
import { demoEvents } from '../src/hud/demo.ts';

const fixture = (name: string): SessionEvent[] => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const T0 = Date.UTC(2026, 9, 19, 20, 0, 0);
/** When an event reaches the device at real pace: its stream time after the start, plus a moment. */
const arrival = (event: SessionEvent) => T0 + event.streamTimeS * 1000 + 300;

function replay(events: SessionEvent[], everyS = 15) {
  let state: HudState = initialHudState();
  const rows: unknown[] = [];
  const endS = events[events.length - 1].streamTimeS;
  let i = 0;
  for (let atS = 0; atS <= endS + everyS; atS += everyS) {
    const now = T0 + atS * 1000 + 800;
    while (i < events.length && arrival(events[i]) <= now) state = hudReducer(state, events[i], arrival(events[i++]));
    const view = hudView(state, now);
    rows.push({
      atS,
      phase: view.phase,
      detail: view.detail,
      percent: view.gauge.percent,
      p60: view.gauge.p60,
      counts: view.counts,
      clock: view.clock.text,
      notices: view.notices.map((n) => n.code),
      marks: view.trend.marks.map((m) => `${m.kind}@${Math.round(m.x * 100)}%${m.ruined ? ' ruined' : ''}`),
      analysing: view.analysing,
    });
  }
  return { rows, state };
}

describe('the HUD model over the sandbox scenarios', () => {
  for (const scenario of ['edge', 'ruin', 'finish', 'face-lost', 'man-peak']) {
    it(scenario, async () => {
      const { rows } = replay(fixture(scenario));
      await expect(JSON.stringify(rows, null, 1) + '\n').toMatchFileSnapshot(`./golden/${scenario}.json`);
    });
  }

  it('counts what each scenario counts, as the sandbox charges it', () => {
    const final = (name: string) => hudView(replay(fixture(name)).state, T0 + 10_000_000).counts;
    expect(final('edge')).toEqual({ orgasms: 0, ruins: 0, edges: 3 });
    expect(final('ruin')).toEqual({ orgasms: 0, ruins: 1, edges: 0 });
    expect(final('finish')).toEqual({ orgasms: 2, ruins: 0, edges: 0 });
    expect(final('man-peak')).toEqual({ orgasms: 1, ruins: 0, edges: 0 });
  });
});

describe('the phases', () => {
  const imminence = (atS: number, p30: number | null, extra: Record<string, unknown> = {}): SessionEvent =>
    ({
      id: `evt_${String(atS).padStart(20, '0')}`,
      object: 'event',
      type: 'imminence.updated',
      mode: 'test',
      sessionId: 'ls_8f3kq2m7x9w4c1n6t5ra',
      sequence: atS,
      streamTimeS: atS,
      wallTime: new Date(T0 + atS * 1000).toISOString(),
      confidence: 'high',
      data: { p30, p60: p30 === null ? null : Math.min(1, p30 + 0.1), logit30: null, logit60: null, featuresPresent: 1, faceVisible: true, baselineReady: true, stimulationAware: false, recentCalls: [], ...extra },
    }) as SessionEvent;

  it('sits at the presets’ levels, says when it is stale, and never counts down', () => {
    const at = (p30: number) => hudView(hudReducer(initialHudState(), imminence(100, p30), T0), T0 + 500).phase;
    expect([at(0.1), at(0.3), at(0.6), at(0.75)]).toEqual(['building', 'rising', 'close', 'very_close']);
    const state = hudReducer(initialHudState(), imminence(100, 0.64), T0);
    expect(hudView(state, T0 + 500).detail).toBe('64% within 30 s');
    expect(hudView(state, T0 + 500).gauge.valueText).toBe('Close: a 64% chance of an orgasm within 30 seconds');
    const stale = hudView(state, T0 + HUD_FRESH_MS + 1);
    expect([stale.phase, stale.stale, stale.gauge.percent]).toEqual(['paused', true, null]);
  });

  it('calibrates for the baseline minute, and says the face is out of view', () => {
    const early = hudReducer(initialHudState(), imminence(18, null, { baselineReady: false }), T0);
    expect(hudView(early, T0 + 500)).toMatchObject({ phase: 'calibrating', detail: 'Baseline in 0:41' });
    const away = hudReducer(initialHudState(), imminence(120, null, { faceVisible: false }), T0);
    expect(hudView(away, T0 + 500)).toMatchObject({ phase: 'away', detail: 'Step back into view' });
  });

  it('rewords with partial strings, and clocks like a stopwatch', () => {
    const strings = hudStrings({ phases: { close: 'Nearly there' }, within30: '{percent} % in 30 s' });
    const view = hudView(hudReducer(initialHudState(), imminence(100, 0.62), T0), T0 + 500, strings);
    expect([view.word, view.detail]).toEqual(['Nearly there', '62 % in 30 s']);
    expect(strings.phases.building).toBe('Building');
    expect([clockText(74), clockText(3725), clockText(null)]).toEqual(['1:14', '1:02:05', '0:00']);
  });

  it('starts afresh for another session on the same HUD', () => {
    const first = hudReducer(initialHudState(), imminence(100, 0.5), T0);
    const other = { ...imminence(5, 0.1), sessionId: 'ls_000000000000000other' } as SessionEvent;
    expect(hudReducer(first, other, T0).trend).toHaveLength(1);
  });
});

describe('the demo', () => {
  it('scripts what each scenario is named for', () => {
    const count = (scenario: Parameters<typeof demoEvents>[0]) => {
      let state = initialHudState();
      for (const event of demoEvents(scenario)) state = hudReducer(state, event, T0);
      return hudView(state, T0).counts;
    };
    expect(count('edge')).toEqual({ orgasms: 0, ruins: 0, edges: 3 });
    expect(count('finish')).toEqual({ orgasms: 2, ruins: 0, edges: 0 });
    expect(count('ruin')).toEqual({ orgasms: 0, ruins: 1, edges: 0 });
    const lost = demoEvents('face-lost');
    expect(lost.filter((e) => e.type === 'input.warning').map((e) => (e.data as { state: string }).state)).toEqual(['raised', 'cleared']);
    expect(new Set(demoEvents('edge').map((e) => e.id)).size).toBe(demoEvents('edge').length);
  });
});
