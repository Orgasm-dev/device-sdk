// The HUD's model against the sandbox's own scenarios (test/fixtures: each
// scenario's full event list, as the sandbox sends it to a view token made
// without includeFace; `toy` is the edge scenario with a product reporting a
// two-channel device and the face's channels in), replayed at real pace:
// what the HUD shows every 15 stream seconds is held in test/golden.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { FaceChannels, FaceFrame, SessionEvent, StimulationData } from '../src/events.ts';
import {
  FRAME_HOLD_MS,
  HISTORY_BIN_S,
  HISTORY_CAP_BINS,
  HUD_FRESH_MS,
  clockText,
  faceRegionsOf,
  hudFrameReducer,
  hudReducer,
  hudStrings,
  hudView,
  initialHudState,
  modeWords,
  type HudState,
} from '../src/hud/model.ts';
import { demoCameraHead, demoEvents, demoFace } from '../src/hud/demo.ts';

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
      strip: view.stimulation ? `${view.stimulation.label}: ${view.stimulation.detail}${view.stimulation.bars ? ` [${view.stimulation.bars.map((b) => `${b.label}${b.level}/${b.max}`).join(' ')}]` : ''}` : null,
      face: view.face ? (view.face.channels ? `${view.face.source} jaw ${Math.round(view.face.regions!.find((r) => r.key === 'jaw')!.level * 100)}%` : view.face.detail) : null,
      timeline: view.timeline
        ? `${view.timeline.startS}-${Math.round(view.timeline.endS)} s: ${(['imminence', 'stimulation', 'body'] as const).filter((lane) => view.timeline![lane]).join(', ')}; ${view.timeline.stimulation?.modes.map((m) => m.label).join(' ') ?? ''}`.trim()
        : null,
    });
  }
  return { rows, state };
}

describe('the HUD model over the sandbox scenarios', () => {
  for (const scenario of ['edge', 'ruin', 'finish', 'face-lost', 'man-peak', 'toy']) {
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
    expect(final('toy')).toEqual({ orgasms: 0, ruins: 0, edges: 3 });
  });
});

const signals = (atS: number, face: FaceChannels | null, extra: Record<string, unknown> = {}): SessionEvent =>
  ({
    id: `evt_s${String(atS).padStart(19, '0')}`,
    object: 'event',
    type: 'signals.updated',
    mode: 'test',
    sessionId: 'ls_8f3kq2m7x9w4c1n6t5ra',
    sequence: atS,
    streamTimeS: atS,
    wallTime: new Date(T0 + atS * 1000).toISOString(),
    confidence: 'high',
    data: { vocalizationsPerMin: 6, loudnessAboveBaselineDb: 2, contractionsPerMin: null, movement: null, faceRegions: null, face, ...extra },
  }) as SessionEvent;

const stimulation = (atS: number, data: Partial<StimulationData>): SessionEvent =>
  ({
    id: `evt_t${String(atS).padStart(19, '0')}`,
    object: 'event',
    type: 'stimulation.updated',
    mode: 'test',
    sessionId: 'ls_8f3kq2m7x9w4c1n6t5ra',
    sequence: atS,
    streamTimeS: atS,
    wallTime: new Date(T0 + atS * 1000).toISOString(),
    confidence: null,
    data: { state: 'on', intensity: null, level: null, levelMax: null, channels: null, mode: null, modeLabel: null, device: null, drive: null, changedAtS: atS, ...data },
  }) as SessionEvent;

const faceWith = (jawOpen: number, yawDeg = 0): FaceChannels => {
  const face = demoFace('edge', 120)!;
  return { expression: { ...face.expression, jawOpen }, head: { yawDeg, pitchDeg: 0, rollDeg: 0 } };
};

describe('the face', () => {
  it('is the reading’s, and a frame’s while frames come; the reading takes over once they stop', () => {
    let state = hudReducer(initialHudState(), signals(100, faceWith(0.2)), T0);
    expect(hudView(state, T0 + 100).face).toMatchObject({ source: 'reading', detail: '' });
    const frame: FaceFrame = { type: 'face.frame', sessionId: 'ls_8f3kq2m7x9w4c1n6t5ra', streamTimeS: 100.4, face: faceWith(0.6) };
    state = hudFrameReducer(state, frame, T0 + 400);
    state = hudReducer(state, signals(101, faceWith(0.3)), T0 + 1000);
    expect(hudView(state, T0 + 1000).face?.channels?.expression.jawOpen).toBe(0.6);
    state = hudReducer(state, signals(104, faceWith(0.35)), T0 + 400 + FRAME_HOLD_MS + 1);
    expect(hudView(state, T0 + 4000).face).toMatchObject({ source: 'reading', channels: { expression: { jawOpen: 0.35 } } });
    expect(hudFrameReducer(state, { ...frame, sessionId: 'ls_000000000000000other' }, T0 + 5000)).toBe(state);
  });

  it('reads its seven regions from the channels, says out of view, and goes stale', () => {
    const face = faceWith(0.7);
    expect(faceRegionsOf(face).jaw).toBe(0.7);
    let state = hudReducer(initialHudState(), signals(100, face), T0);
    const view = hudView(state, T0 + 10).face!;
    expect(view.regions!.map((r) => r.key)).toEqual(['brows', 'eyes', 'cheeks', 'nose', 'lips', 'corners', 'jaw']);
    state = hudReducer(state, { ...signals(101, null), data: { ...(signals(101, null).data as object), face: null } } as SessionEvent, T0 + 1000);
    const baselined = { ...state, baselineReady: true };
    expect(hudView(baselined, T0 + 1100).face).toMatchObject({ channels: null, detail: 'Face out of view' });
    expect(hudView(state, T0 + 1000 + HUD_FRESH_MS + 1).face).toMatchObject({ stale: true, channels: null });
    // A server before the face channels sends none: no face part to draw.
    const older = hudReducer(initialHudState(), { ...signals(100, null), data: { vocalizationsPerMin: 4, loudnessAboveBaselineDb: null, contractionsPerMin: null, movement: null, faceRegions: null } } as SessionEvent, T0);
    expect(hudView(older, T0).face).toBeNull();
  });

  it('turns the head as the camera sees it where frames say so, before the baseline too, and by the channels otherwise', () => {
    const sessionId = 'ls_8f3kq2m7x9w4c1n6t5ra';
    const onItsSide = { yawDeg: 4, pitchDeg: -6, rollDeg: 88 };
    let state = hudFrameReducer(initialHudState(), { type: 'face.frame', sessionId, streamTimeS: 30.2, face: null, cameraHead: onItsSide }, T0);
    expect(hudView(state, T0).face).toMatchObject({ channels: null, cameraHead: onItsSide, detail: 'The face shows once the baseline is in' });
    state = hudFrameReducer(state, { type: 'face.frame', sessionId, streamTimeS: 100.4, face: faceWith(0.6), cameraHead: onItsSide }, T0 + 200);
    expect(hudView(state, T0 + 200).face).toMatchObject({ cameraHead: onItsSide, channels: { expression: { jawOpen: 0.6 } } });
    // A frame from an older server has none; nor has the reading's copy once frames stop; nor a face gone stale.
    expect(hudView(hudFrameReducer(state, { type: 'face.frame', sessionId, streamTimeS: 100.6, face: faceWith(0.6) }, T0 + 400), T0 + 400).face!.cameraHead).toBeNull();
    expect(hudView(hudReducer(state, signals(105, faceWith(0.3)), T0 + 200 + FRAME_HOLD_MS + 1), T0 + 4000).face!.cameraHead).toBeNull();
    expect(hudView(state, T0 + 200 + HUD_FRESH_MS + 1).face!.cameraHead).toBeNull();
  });
});

describe('the stimulation strip', () => {
  const strip = (...events: SessionEvent[]) => {
    let state = initialHudState();
    for (const event of events) state = hudReducer(state, event, T0);
    return hudView(state, T0).stimulation;
  };

  it('names the device, says its mode and fills a bar per output toward its maximum', () => {
    const two = strip(stimulation(100, { level: 31, levelMax: 60, channels: [{ id: 'a', level: 31, levelMax: 60 }, { id: 'b', level: 24, levelMax: 60 }], mode: 'waves', device: { label: 'Unit', connected: true }, drive: 'auto' }))!;
    expect([two.label, two.detail, two.tone]).toEqual(['Unit', 'Waves', 'live']);
    expect(two.bars!.map((b) => [b.label, b.fraction])).toEqual([['A', 31 / 60], ['B', 0.4]]);
    expect(two.text).toBe('Unit: Waves, A level 31 of 60, B level 24 of 60');
  });

  it('says who sets the level and when it is held, off, paused or out of reach', () => {
    expect(strip(stimulation(100, { level: 12, levelMax: 50, mode: 'phase1', drive: 'manual' }))!.detail).toBe('Manual · Phase 1');
    expect(strip(stimulation(100, { level: 12, drive: 'hold' }))!.detail).toBe('Holding · level 12');
    expect(strip(stimulation(100, { level: 12, levelMax: 50, drive: 'paused' }))).toMatchObject({ detail: 'Paused', tone: 'neutral' });
    const off = strip(stimulation(100, { state: 'off', level: 12, levelMax: 50 }))!;
    expect([off.detail, off.bars![0].fraction]).toEqual(['Off', 0]);
    expect(strip(stimulation(100, { level: 12, device: { label: 'Wand', connected: false } }))).toMatchObject({ label: 'Wand', detail: 'Not reachable', tone: 'warn', bars: null });
    expect(strip(stimulation(100, { intensity: 0.4 }))).toMatchObject({ label: 'Stimulation', detail: 'On', bars: [{ fraction: 0.4 }] });
    expect(strip(stimulation(100, { level: 7 }))!.detail).toBe('On · level 7');
    expect([modeWords('lower-back-2'), modeWords('stroke'), modeWords(null)]).toEqual(['Lower back 2', 'Stroke', null]);
  });
});

describe('the timeline', () => {
  it('keeps the session in five-second bins, each output’s level carried between reports, its modes marked', () => {
    let state = initialHudState();
    for (let t = 60; t < 120; t++) state = hudReducer(state, { ...signals(t, null), id: `evt_s${t}` } as SessionEvent, T0 + t * 1000);
    state = hudReducer(state, stimulation(70, { level: 10, levelMax: 40, channels: [{ id: 'a', level: 10, levelMax: 40 }, { id: 'b', level: 6, levelMax: 40 }], mode: 'waves' }), T0);
    state = hudReducer(state, stimulation(90, { level: 30, levelMax: 40, channels: [{ id: 'a', level: 30, levelMax: 40 }, { id: 'b', level: 20, levelMax: 40 }], mode: 'pulse' }), T0);
    const bins = state.history.bins;
    expect(bins[0].atS).toBe(60);
    expect(bins.every((b, i) => i === 0 || b.atS - bins[i - 1].atS === HISTORY_BIN_S)).toBe(true);
    expect(bins.find((b) => b.atS === 70)!.levels).toEqual({ a: 10, b: 6 });
    expect(state.history.modes.map((m) => m.label)).toEqual(['Waves', 'Pulse']);
    for (let t = 120; t < 140; t++) state = hudReducer(state, { ...signals(t, null), id: `evt_s${t}` } as SessionEvent, T0 + t * 1000);
    expect(state.history.bins.at(-1)!.levels).toEqual({ a: 30, b: 20 });

    const view = hudView(state, T0 + 140_000).timeline!;
    expect(view.imminence).toBeNull();
    expect(view.stimulation!.channels.map((c) => c.label)).toEqual(['A', 'B']);
    expect(view.stimulation!.scale).toBe(40);
    expect(view.body!.vocalizations!.length).toBe(state.history.bins.length);
    expect(view.ticks.map((t) => t.text)).toEqual(['1:00', '2:00']);
  });

  it('keeps three hours, and breaks a lane across a gap', () => {
    let state = initialHudState();
    for (let t = 0; t < (HISTORY_CAP_BINS + 10) * HISTORY_BIN_S; t += HISTORY_BIN_S) state = hudReducer(state, { ...signals(t, null), id: `evt_s${t}` } as SessionEvent, T0);
    expect(state.history.bins).toHaveLength(HISTORY_CAP_BINS);
    expect(state.history.bins[0].atS).toBe(10 * HISTORY_BIN_S);

    let gapped = initialHudState();
    for (const t of [60, 61, 62, 90, 91]) gapped = hudReducer(gapped, { ...signals(t, null), id: `evt_s${t}` } as SessionEvent, T0);
    const points = hudView(gapped, T0).timeline!.body!.vocalizations!;
    expect(points.some((p) => p.y === null)).toBe(true);
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

  it('reads the face, and reports a two-channel device that is held near the edge and stopped at the ruin', () => {
    const edge = demoEvents('edge');
    const reports = edge.filter((e): e is Extract<SessionEvent, { type: 'stimulation.updated' }> => e.type === 'stimulation.updated');
    expect(reports.length).toBeGreaterThan(10);
    expect(reports.some((e) => e.data.drive === 'hold')).toBe(true);
    expect(new Set(reports.map((e) => e.data.mode))).toEqual(new Set(['waves', 'pulse']));
    expect(edge.filter((e) => e.type === 'signals.updated').every((e) => (e.data as { face: unknown }).face !== undefined)).toBe(true);
    const ruin = demoEvents('ruin').filter((e): e is Extract<SessionEvent, { type: 'stimulation.updated' }> => e.type === 'stimulation.updated');
    expect(ruin.some((e) => e.data.state === 'off')).toBe(true);
    expect(demoFace('face-lost', 170)).toBeNull();
    expect(demoFace('edge', 30)).toBeNull();
    expect(demoFace('edge', 140)!.expression.jawOpen).toBeGreaterThan(demoFace('edge', 70)!.expression.jawOpen);
    // The camera's head is there from the first second in view, the face's own head where both are.
    expect(demoCameraHead('edge', 30)).not.toBeNull();
    expect(demoCameraHead('face-lost', 170)).toBeNull();
    expect(demoCameraHead('edge', 140)).toEqual(demoFace('edge', 140)!.head);
  });
});
