// Scripted sessions that play into a HUD with no network and no camera: for
// a docs page, a design review, or placing an overlay in OBS before a show.
// They are made-up readings shaped like the sandbox's scenarios, not a
// recording of anyone: imminence, the voice, a face (its channels once a
// second, and five frames a second to a HUD that draws it), and a scripted
// two-channel device whose level follows the curve, as a product reporting
// its device would.
//
//   const stop = playDemo((event) => hud.feed(event), { scenario: 'edge', speed: 4, onFaceFrame: (f) => hud.feedFrame(f) });

import { FACE_EXPRESSION_CHANNELS, type FaceChannels, type FaceExpressionChannel, type FaceFrame, type FaceRegions, type SessionEvent, type SessionEventOf, type SessionEventType, type StimulationData } from '../events.ts';

export type DemoScenario = 'edge' | 'finish' | 'ruin' | 'face-lost';

export const DEMO_SCENARIOS: readonly DemoScenario[] = Object.freeze(['edge', 'finish', 'ruin', 'face-lost']);

/** A curve as [stream second, p30] knots, eased between them. */
type Knots = [number, number][];

interface Script {
  durationS: number;
  knots: Knots;
  /** Orgasms: onset (and end) moments, each called a few seconds later. */
  orgasms: { onsetS: number; endS: number; ruined?: boolean }[];
  /** Spans with the face out of view. */
  away?: [number, number][];
}

const SCRIPTS: Record<DemoScenario, Script> = {
  edge: {
    durationS: 460,
    knots: [[60, 0.06], [100, 0.2], [138, 0.66], [150, 0.5], [172, 0.24], [200, 0.18], [240, 0.71], [254, 0.55], [276, 0.22], [300, 0.2], [350, 0.78], [362, 0.6], [386, 0.25], [460, 0.12]],
    orgasms: [],
  },
  finish: {
    durationS: 470,
    knots: [[60, 0.05], [130, 0.22], [200, 0.58], [236, 0.86], [244, 0.93], [268, 0.4], [290, 0.08], [320, 0.12], [380, 0.62], [398, 0.9], [420, 0.35], [470, 0.06]],
    orgasms: [{ onsetS: 245, endS: 266 }, { onsetS: 402, endS: 419 }],
  },
  ruin: {
    durationS: 380,
    knots: [[60, 0.05], [140, 0.3], [210, 0.66], [228, 0.79], [236, 0.6], [252, 0.3], [280, 0.1], [380, 0.08]],
    orgasms: [{ onsetS: 233, endS: 247, ruined: true }],
  },
  'face-lost': {
    durationS: 360,
    knots: [[60, 0.06], [140, 0.34], [200, 0.48], [260, 0.4], [360, 0.2]],
    orgasms: [],
    away: [[160, 182]],
  },
};

const CALL_LAG_S = 4;
const LETTER: Record<DemoScenario, string> = { edge: 'e', finish: 'f', ruin: 'r', 'face-lost': 'l' };

function eased(knots: Knots, t: number): number {
  if (t <= knots[0][0]) return knots[0][1];
  for (let i = 1; i < knots.length; i++) {
    const [t1, v1] = knots[i];
    const [t0, v0] = knots[i - 1];
    if (t <= t1) {
      const u = (t - t0) / (t1 - t0);
      const smooth = u * u * (3 - 2 * u);
      return v0 + (v1 - v0) * smooth;
    }
  }
  return knots[knots.length - 1][1];
}

/** A small, repeatable wobble, so the line looks read rather than drawn. */
const wobble = (t: number) => 0.018 * Math.sin(t * 0.9) + 0.011 * Math.sin(t * 2.3 + 1.7);

const round = (v: number, digits = 3) => Math.round(v * 10 ** digits) / 10 ** digits;

const BASELINE_S = 62;
const sessionIdOf = (scenario: DemoScenario, loop: number) => `ls_demo${LETTER[scenario]}${String(loop).padStart(15, '0')}`;
const awayAt = (script: Script, t: number) => script.away?.some(([a, b]) => t >= a && t < b) ?? false;

/** Each channel at rest and at its fullest, eased between by imminence (made-up, like the rest of the demo). */
const EXPRESSION: Record<FaceExpressionChannel, [number, number]> = {
  eyeBlinkL: [0.04, 0.32], eyeBlinkR: [0.04, 0.3], eyeWideL: [0.05, 0.5], eyeWideR: [0.05, 0.47], browDownL: [0.05, 0.34], browDownR: [0.05, 0.31],
  browInnerUp: [0.12, 0.62], browOuterUpL: [0.06, 0.41], browOuterUpR: [0.06, 0.38], jawOpen: [0.1, 0.8], lipsPart: [0.14, 0.7], mouthSmileL: [0.05, 0.3],
  mouthSmileR: [0.06, 0.35], mouthStretch: [0.05, 0.55], mouthPucker: [0.03, 0.2], noseSneer: [0.03, 0.3], noseFlare: [0.05, 0.42], cheekSquintL: [0.07, 0.55],
  cheekSquintR: [0.08, 0.52], chinRaise: [0.04, 0.26], lidTighten: [0.06, 0.5], browTogether: [0.04, 0.4], noseWrinkle: [0.03, 0.35], lidRaise: [0.04, 0.3],
};

/** The demo's face at a stream moment: null before the baseline and while away; a function of time, so readings and frames agree. */
export function demoFace(scenario: DemoScenario, t: number): FaceChannels | null {
  const script = SCRIPTS[scenario];
  if (t < BASELINE_S || awayAt(script, t)) return null;
  const drive = eased(script.knots, t);
  const phase = (((t + 1.3) % 3.7) + 3.7) % 3.7;
  const blink = phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) : 0;
  const expression = Object.fromEntries(
    FACE_EXPRESSION_CHANNELS.map((name, k) => {
      const [rest, full] = EXPRESSION[name];
      const value = Math.min(1, Math.max(0, rest + (full - rest) * drive + 0.03 * Math.sin(t * (0.9 + 0.13 * k) + k * 1.7) + 0.02 * Math.sin(t * (2.3 + 0.07 * k) + k)));
      return [name, round(name.startsWith('eyeBlink') ? Math.max(value, blink) : value, 2)];
    }),
  ) as FaceChannels['expression'];
  return {
    expression,
    head: {
      yawDeg: round(6 * Math.sin(t / 1.7 + 0.4) + 3 * drive * Math.sin(t * 1.9 + 1.2), 1),
      pitchDeg: round(2.5 * Math.sin(t / 2.1 + 2) + 8 * drive - 2, 1),
      rollDeg: round(3.5 * Math.sin(t / 1.4 + 0.9) + 2 * drive * Math.sin(t * 2.7 + 0.3), 1),
    },
  };
}

const REGIONS: Record<keyof FaceRegions, FaceExpressionChannel[]> = {
  brows: ['browDownL', 'browDownR', 'browTogether', 'browInnerUp', 'browOuterUpL', 'browOuterUpR'],
  eyes: ['eyeBlinkL', 'eyeBlinkR', 'eyeWideL', 'eyeWideR'],
  cheeks: ['cheekSquintL', 'cheekSquintR', 'lidTighten'],
  nose: ['noseWrinkle', 'noseSneer', 'noseFlare'],
  lips: ['lipsPart', 'mouthStretch', 'mouthPucker'],
  corners: ['mouthSmileL', 'mouthSmileR'],
  jaw: ['jawOpen', 'chinRaise'],
};
const regionsOf = (face: FaceChannels): FaceRegions =>
  Object.fromEntries(Object.entries(REGIONS).map(([key, names]) => [key, Math.max(...names.map((n) => face.expression[n]))])) as unknown as FaceRegions;

const LEVEL_MAX = 60;

/**
 * The scripted device's state at a stream second: its level follows the
 * curve, its mode changes as imminence rises, it is held near the edge
 * (the edging scenario), stopped at the ruin, paused while the face is away,
 * and at rest for a while after an orgasm.
 */
function deviceAt(scenario: DemoScenario, script: Script, t: number): Omit<StimulationData, 'changedAtS'> {
  const p = eased(script.knots, t);
  const resting = script.orgasms.some((o) => !o.ruined && t >= o.endS && t < o.endS + 20);
  const stopped = script.orgasms.some((o) => o.ruined && t >= o.onsetS - 3 && t < o.endS + 25);
  const away = awayAt(script, t);
  const held = scenario === 'edge' && p >= 0.6;
  const on = !resting && !stopped;
  const a = Math.round(10 + 38 * p);
  const level = held ? Math.round(a * 0.6) : a;
  const b = Math.round(level * 0.75);
  const mode = p >= 0.45 ? 'pulse' : 'waves';
  return {
    state: on ? 'on' : 'off',
    intensity: null,
    level,
    levelMax: LEVEL_MAX,
    channels: [
      { id: 'a', level, levelMax: LEVEL_MAX },
      { id: 'b', level: b, levelMax: LEVEL_MAX },
    ],
    mode,
    modeLabel: mode === 'pulse' ? 'Pulse' : 'Waves',
    device: { label: 'Unit', connected: true },
    drive: away ? 'paused' : held ? 'hold' : 'auto',
  };
}

/** The whole scripted session, in order. */
export function demoEvents(scenario: DemoScenario = 'edge', loop = 0): SessionEvent[] {
  const script = SCRIPTS[scenario];
  const sessionId = sessionIdOf(scenario, loop);
  const events: SessionEvent[] = [];
  let sequence = 0;
  const start = Date.UTC(2026, 9, 19, 20, 0, 0);
  const emit = <T extends SessionEventType>(type: T, atS: number, data: SessionEventOf<T>['data'], confidence: SessionEvent['confidence'] = 'high') => {
    sequence += 1;
    events.push({
      id: `evt_d${LETTER[scenario]}${String(loop).padStart(4, '0')}${String(sequence).padStart(14, '0')}`,
      object: 'event',
      type,
      mode: 'test',
      sessionId,
      sequence,
      streamTimeS: atS,
      wallTime: new Date(start + atS * 1000).toISOString(),
      confidence,
      data,
    } as SessionEvent);
  };
  const inputs = { face: { present: true, baselineReady: false }, audio: { declared: true, present: true }, body: { declared: false, present: false } };
  emit('session.status', 0, { status: 'calibrating', previousStatus: 'ready', degraded: false, inputs, endedReason: null }, null);

  const calls: { atS: number; fire: () => void }[] = [];
  const recent: { id: string; type: 'orgasm.onset' | 'orgasm.end'; eventAtS: number }[] = [];
  script.orgasms.forEach((o, i) => {
    calls.push({
      atS: o.onsetS + CALL_LAG_S,
      fire: () => {
        emit('orgasm.onset', o.onsetS + CALL_LAG_S, { orgasmIndex: i + 1, eventAtS: o.onsetS, calledAtS: o.onsetS + CALL_LAG_S, lagS: CALL_LAG_S, detector: 'onset_end', score: 0.91, threshold: 0.5 });
        recent.push({ id: events[events.length - 1].id, type: 'orgasm.onset', eventAtS: o.onsetS });
      },
    });
    calls.push({
      atS: o.endS + CALL_LAG_S,
      fire: () => {
        emit('orgasm.end', o.endS + CALL_LAG_S, { orgasmIndex: i + 1, eventAtS: o.endS, startedAtS: o.onsetS, durationS: o.endS - o.onsetS, calledAtS: o.endS + CALL_LAG_S, lagS: CALL_LAG_S, detector: 'onset_end', score: 0.88, threshold: 0.5, ruined: o.ruined === true });
        recent.push({ id: events[events.length - 1].id, type: 'orgasm.end', eventAtS: o.endS });
      },
    });
  });

  let edgeIndex = 0;
  let approach: { startedAtS: number; peak: number } | null = null;
  // After a call, and the fall of imminence after it, a new approach starts only below 0.3.
  let settling = false;
  let awayFrom: number | null = null;
  let lastDevice = '';
  let lastDeviceAt = -Infinity;
  let lastLevel: number | null = null;
  for (let t = 1; t <= script.durationS; t++) {
    if (t === 30) emit('subject.identified', 30, { sex: 'woman', pWoman: 0.86, secondsObserved: 30, decidedAtS: 30, hint: null, detectors: ['onset_end'] });
    if (t === 62) emit('session.status', 62, { status: 'analyzing', previousStatus: 'calibrating', degraded: false, inputs: { ...inputs, face: { present: true, baselineReady: true } }, endedReason: null }, null);
    for (const call of calls) if (call.atS === t) call.fire();
    const away = script.away?.some(([a, b]) => t >= a && t < b) ?? false;
    if (away && awayFrom === null) {
      awayFrom = t;
      emit('input.warning', t, { code: 'face_not_visible', state: 'raised', message: 'The face is out of view.', sinceS: t }, null);
    } else if (!away && awayFrom !== null) {
      emit('input.warning', t, { code: 'face_not_visible', state: 'cleared', message: 'The face is back in view.', sinceS: awayFrom }, null);
      awayFrom = null;
    }
    const baselineReady = t >= BASELINE_S;
    const p30 = baselineReady && !away ? round(Math.max(0.01, Math.min(0.99, eased(script.knots, t) + wobble(t)))) : null;
    const p60 = p30 === null ? null : round(Math.min(0.995, p30 + 0.12 + 0.25 * p30 * (1 - p30)));
    emit('imminence.updated', t, {
      p30,
      p60,
      logit30: null,
      logit60: null,
      featuresPresent: away ? 0 : 0.96,
      faceVisible: !away,
      baselineReady,
      stimulationAware: baselineReady,
      recentCalls: recent.slice(-8),
    }, away ? 'low' : 'high');
    if (baselineReady) {
      const face = demoFace(scenario, t);
      const p = eased(script.knots, t);
      emit('signals.updated', t, {
        vocalizationsPerMin: Math.max(0, Math.round(2 + 24 * p ** 1.3 + 3 * Math.sin(t * 0.7))),
        loudnessAboveBaselineDb: Math.round(1 + 13 * p),
        contractionsPerMin: null,
        movement: null,
        faceRegions: face ? regionsOf(face) : null,
        face,
      }, away ? 'low' : 'high');
      // The device, reported when it changes, and at most every five seconds as its level climbs.
      const device = deviceAt(scenario, script, t);
      const key = `${device.state}|${device.mode}|${device.drive}`;
      if (key !== lastDevice || (t - lastDeviceAt >= 5 && device.level !== lastLevel)) {
        emit('stimulation.updated', t, { ...device, changedAtS: t }, null);
        lastDevice = key;
        lastDeviceAt = t;
        lastLevel = device.level;
      }
    }
    // Edges, counted as the sandbox counts them: up to 0.6, back under 0.3, no call between.
    if (p30 !== null) {
      if (settling && p30 < 0.3) settling = false;
      if (!approach && !settling && p30 >= 0.6) approach = { startedAtS: t, peak: p30 };
      else if (approach) {
        approach.peak = Math.max(approach.peak, p30);
        const called = script.orgasms.some((o) => o.onsetS >= approach!.startedAtS && o.onsetS <= t);
        if (called) {
          approach = null;
          settling = true;
        } else if (p30 < 0.3) {
          edgeIndex += 1;
          emit('edge.completed', t, { edgeIndex, startedAtS: approach.startedAtS, eventAtS: t, durationS: t - approach.startedAtS, peakP30: round(approach.peak) });
          approach = null;
        }
      }
    }
  }
  emit('session.status', script.durationS, { status: 'ended', previousStatus: 'analyzing', degraded: false, inputs: { ...inputs, face: { present: true, baselineReady: true } }, endedReason: 'client_ended' }, null);
  return events;
}

export interface DemoOptions {
  scenario?: DemoScenario;
  /** Stream seconds per wall second: 1 is real time. */
  speed?: number;
  /** Start again after the end, as a new session (default true). */
  loop?: boolean;
  /** Start this far in, in stream seconds (skip the baseline minute with 60). */
  fromS?: number;
  /** The face five times a second, as a stream with `frames: ['face']` sends it. */
  onFaceFrame?: (frame: FaceFrame) => void;
}

/** Play a scripted session into `onEvent`; returns a function that stops it. */
export function playDemo(onEvent: (event: SessionEvent) => void, options: DemoOptions = {}): () => void {
  const scenario = options.scenario ?? 'edge';
  const speed = Math.max(0.1, options.speed ?? 1);
  const loop = options.loop !== false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let frames: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let run = 0;

  const play = (fromS: number) => {
    const events = demoEvents(scenario, run);
    const durationS = events[events.length - 1].streamTimeS;
    const sessionId = sessionIdOf(scenario, run);
    // What happened before the start, at once, so the HUD opens mid-session.
    let i = 0;
    while (i < events.length && events[i].streamTimeS < fromS) onEvent(events[i++]);
    const t0 = Date.now() - (fromS * 1000) / speed;
    const onFaceFrame = options.onFaceFrame;
    if (onFaceFrame) {
      let sawFace = false;
      frames = setInterval(() => {
        const atS = ((Date.now() - t0) * speed) / 1000;
        if (stopped || atS > durationS) return;
        const face = demoFace(scenario, atS);
        if (face || sawFace) onFaceFrame({ type: 'face.frame', sessionId, streamTimeS: round(atS, 1), face });
        sawFace = face !== null;
      }, 200);
    }
    const step = () => {
      if (stopped) return;
      const atS = ((Date.now() - t0) * speed) / 1000;
      while (i < events.length && events[i].streamTimeS <= atS) onEvent(events[i++]);
      if (i >= events.length) {
        if (frames !== null) clearInterval(frames);
        frames = null;
        if (!loop) return;
        run += 1;
        timer = setTimeout(() => play(options.fromS ?? 0), 4000);
        return;
      }
      const wait = ((events[i].streamTimeS - atS) * 1000) / speed;
      timer = setTimeout(step, Math.max(16, Math.min(1000, wait)));
    };
    step();
  };
  play(options.fromS ?? 0);
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (frames !== null) clearInterval(frames);
  };
}
