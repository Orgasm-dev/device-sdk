// The heads-up display's model: a session's events in, what to show out.
// Pure and framework-free, so a game engine can draw the same thing natively
// (feed it the events, read `hudView` once a frame or once a second) and
// <orgasm-hud> draws exactly this.
//
//   let state = initialHudState();
//   onEvent((event) => { state = hudReducer(state, event); });
//   const view = hudView(state);   // phase, gauge, trend, counts, clock, notices
//
// Imminence is a probability, not a countdown: the gauge is the chance of an
// orgasm within 30 seconds (`p30`), with the 60-second chance (`p60`) as a
// ghost mark. The phase words sit at the reference presets' levels (0.3,
// 0.6 and 0.75); a call (onset, peak, end) or a completed edge takes over the
// phase for a while after it arrives, which is a few seconds after the moment
// it names.

import type {
  EndedReason, EventMode, FaceRegions, LiveSessionStatus, Movement, SessionEvent, SignalsData, SubjectSex, WarningCode,
} from '../events.ts';

export type HudPhase =
  | 'waiting'
  | 'starting'
  | 'calibrating'
  | 'away'
  | 'building'
  | 'rising'
  | 'close'
  | 'very_close'
  | 'onset'
  | 'peak'
  | 'afterglow'
  | 'edge'
  | 'paused'
  | 'ended';

/** The reference presets' levels on `p30` (https://orgasm.dev/docs/concepts/presets). */
export const PHASE_LEVELS = Object.freeze({ rising: 0.3, close: 0.6, veryClose: 0.75 });
/** A reading older than this, by the receiving clock, is stale: the gauge says so instead of holding. */
export const HUD_FRESH_MS = 10_000;
/** The trend line's span, in stream seconds. */
export const TREND_WINDOW_S = 180;
/** How long, in stream seconds after the call, a phase from a call holds (an afterglow gives way sooner to a new approach). */
export const CALL_HOLD_S = Object.freeze({ onset: 45, peak: 45, end: 60, edge: 6 });
/** How long the clock runs on from the newest event before it waits for the next. */
const CLOCK_CARRY_MS = 90_000;
/** The baseline takes about a minute of media. */
export const BASELINE_S = 60;

export type MarkKind = 'onset' | 'peak' | 'end' | 'edge';

export interface HudMark {
  id: string;
  kind: MarkKind;
  /** The moment the mark names, in stream seconds. */
  atS: number;
  orgasmIndex: number | null;
  ruined: boolean;
}

export interface TrendPoint {
  atS: number;
  p30: number | null;
  p60: number | null;
}

export interface HudState {
  sessionId: string | null;
  mode: EventMode | null;
  status: LiveSessionStatus | null;
  endedReason: EndedReason | null;
  /** The stream time of the newest event. */
  streamTimeS: number | null;
  /** When the newest event of any type arrived, on the receiving clock (ms): the clock runs on from it. */
  eventAt: number | null;
  /** When the newest imminence arrived, on the receiving clock (ms): freshness. */
  receivedAt: number | null;
  p30: number | null;
  p60: number | null;
  faceVisible: boolean | null;
  baselineReady: boolean;
  trend: TrendPoint[];
  marks: HudMark[];
  /** Each orgasm by its index: ruined or not, as its end says. */
  orgasms: Record<number, 'orgasm' | 'ruin'>;
  edges: number;
  lastCall: { kind: MarkKind; atS: number; calledAtS: number } | null;
  subject: { sex: SubjectSex; pWoman: number | null } | null;
  warnings: Partial<Record<WarningCode, { message: string; sinceS: number }>>;
  signals: SignalsData | null;
  /** When the newest signals arrived, on the receiving clock (ms). */
  signalsAt: number | null;
}

export function initialHudState(): HudState {
  return {
    sessionId: null,
    mode: null,
    status: null,
    endedReason: null,
    streamTimeS: null,
    eventAt: null,
    receivedAt: null,
    p30: null,
    p60: null,
    faceVisible: null,
    baselineReady: false,
    trend: [],
    marks: [],
    orgasms: {},
    edges: 0,
    lastCall: null,
    subject: null,
    warnings: {},
    signals: null,
    signalsAt: null,
  };
}

const KEEP_TREND_S = TREND_WINDOW_S + 30;
const KEEP_MARKS = 64;

function addMark(marks: HudMark[], mark: HudMark): HudMark[] {
  if (marks.some((m) => m.id === mark.id)) return marks;
  const next = [...marks, mark].sort((a, b) => a.atS - b.atS);
  return next.length > KEEP_MARKS ? next.slice(next.length - KEEP_MARKS) : next;
}

const callKind = (type: string): MarkKind => (type === 'orgasm.onset' ? 'onset' : type === 'orgasm.peak' ? 'peak' : 'end');

/** The state after one event; `receivedAt` is the receiving clock (ms), for freshness. */
export function hudReducer(state: HudState, event: SessionEvent, receivedAt: number = Date.now()): HudState {
  if (state.sessionId !== null && event.sessionId !== state.sessionId) {
    // Another session's event: a new show on the same HUD starts it afresh.
    state = initialHudState();
  }
  const newest = state.streamTimeS === null || event.streamTimeS >= state.streamTimeS;
  const next: HudState = {
    ...state,
    sessionId: event.sessionId,
    mode: event.mode,
    streamTimeS: newest ? event.streamTimeS : state.streamTimeS,
    eventAt: newest ? receivedAt : state.eventAt,
  };
  switch (event.type) {
    case 'imminence.updated': {
      const d = event.data;
      next.p30 = d.p30;
      next.p60 = d.p60;
      next.faceVisible = d.faceVisible;
      next.baselineReady = d.baselineReady;
      next.receivedAt = receivedAt;
      const point = { atS: event.streamTimeS, p30: d.p30, p60: d.p60 };
      const trend = state.trend.length && state.trend[state.trend.length - 1].atS >= point.atS ? state.trend.filter((p) => p.atS < point.atS) : [...state.trend];
      trend.push(point);
      const from = point.atS - KEEP_TREND_S;
      next.trend = trend[0] && trend[0].atS < from ? trend.filter((p) => p.atS >= from) : trend;
      // A call the HUD's own subscription missed still gets its mark.
      for (const call of d.recentCalls ?? []) next.marks = addMark(next.marks, { id: call.id, kind: callKind(call.type), atS: call.eventAtS, orgasmIndex: null, ruined: false });
      break;
    }
    case 'orgasm.onset':
    case 'orgasm.peak':
    case 'orgasm.end': {
      const d = event.data;
      const kind = callKind(event.type);
      const ruined = event.type === 'orgasm.end' && event.data.ruined;
      next.marks = addMark(state.marks.filter((m) => m.id !== event.id), { id: event.id, kind, atS: d.eventAtS, orgasmIndex: d.orgasmIndex, ruined });
      const seen = state.orgasms[d.orgasmIndex];
      next.orgasms = { ...state.orgasms, [d.orgasmIndex]: ruined ? 'ruin' : (seen ?? 'orgasm') };
      next.lastCall = { kind, atS: d.eventAtS, calledAtS: event.streamTimeS };
      break;
    }
    case 'edge.completed': {
      const d = event.data;
      next.marks = addMark(state.marks, { id: event.id, kind: 'edge', atS: d.eventAtS, orgasmIndex: null, ruined: false });
      next.edges = Math.max(state.edges + (state.marks.some((m) => m.id === event.id) ? 0 : 1), d.edgeIndex);
      next.lastCall = { kind: 'edge', atS: d.eventAtS, calledAtS: event.streamTimeS };
      break;
    }
    case 'subject.identified':
      next.subject = { sex: event.data.sex, pWoman: event.data.pWoman };
      break;
    case 'session.status':
      next.status = event.data.status;
      next.endedReason = event.data.endedReason;
      break;
    case 'input.warning': {
      const warnings = { ...state.warnings };
      if (event.data.state === 'raised') warnings[event.data.code] = { message: event.data.message, sinceS: event.data.sinceS };
      else delete warnings[event.data.code];
      next.warnings = warnings;
      break;
    }
    case 'signals.updated':
      next.signals = event.data;
      next.signalsAt = receivedAt;
      break;
    default:
      return state;
  }
  return next;
}

export interface HudStrings {
  phases: Record<HudPhase, string>;
  /** {percent} */
  within30: string;
  /** The gauge's name, for a screen reader. */
  meterLabel: string;
  /** {word}, {percent} */
  meterText: string;
  meterUnknown: string;
  /** {clock} */
  baselineIn: string;
  baselineSoon: string;
  awayDetail: string;
  pausedDetail: string;
  startingDetail: string;
  waitingDetail: string;
  endedDetail: string;
  callDetail: Record<MarkKind, string>;
  analysisOn: string;
  analysisOff: string;
  stop: string;
  orgasms: string;
  ruins: string;
  edges: string;
  session: string;
  trend: string;
  marks: Record<MarkKind, string>;
  ruinedMark: string;
  subject: Record<SubjectSex, string>;
  warnings: Record<WarningCode, string>;
  vocalizations: string;
  contractions: string;
  movement: string;
  face: string;
  perMin: string;
  /** {db} */
  aboveBaseline: string;
  movementWords: Record<Movement, string>;
  regions: Record<keyof FaceRegions, string>;
}

export const HUD_STRINGS: HudStrings = {
  phases: {
    waiting: 'Waiting',
    starting: 'Starting',
    calibrating: 'Calibrating',
    away: 'Out of view',
    building: 'Building',
    rising: 'Rising',
    close: 'Close',
    very_close: 'Very close',
    onset: 'Onset',
    peak: 'Peak',
    afterglow: 'Afterglow',
    edge: 'Edge',
    paused: 'Signals paused',
    ended: 'Session over',
  },
  within30: '{percent}% within 30 s',
  meterLabel: 'Chance of an orgasm within 30 seconds',
  meterText: '{word}: a {percent}% chance of an orgasm within 30 seconds',
  meterUnknown: 'No reading yet',
  baselineIn: 'Baseline in {clock}',
  baselineSoon: 'Getting your baseline',
  awayDetail: 'Step back into view',
  pausedDetail: 'No reading for a few seconds',
  startingDetail: 'Connecting to the enclave',
  waitingDetail: 'Waiting for the session',
  endedDetail: 'Analysis is off',
  callDetail: { onset: 'An orgasm began', peak: 'At its peak', end: 'It has ended', edge: 'An edge, held back' },
  analysisOn: 'Analysis on',
  analysisOff: 'Analysis off',
  stop: 'Stop',
  orgasms: 'Orgasms',
  ruins: 'Ruins',
  edges: 'Edges',
  session: 'Session',
  trend: 'The last three minutes',
  marks: { onset: 'Onset', peak: 'Peak', end: 'End', edge: 'Edge' },
  ruinedMark: 'Ruined',
  subject: { woman: 'Face reads as a woman’s', man: 'Face reads as a man’s', undetermined: 'Face read undetermined' },
  warnings: {
    face_not_visible: 'Your face is out of view',
    multiple_faces: 'More than one face is in view',
    audio_absent: 'No sound from the microphone',
    baseline_pending: 'Getting your baseline',
    body_stream_absent: 'No body view',
    low_confidence: 'The reading is uncertain',
  },
  vocalizations: 'Vocalizations',
  contractions: 'Contractions',
  movement: 'Movement',
  face: 'Face',
  perMin: '/min',
  aboveBaseline: '+{db} dB',
  movementWords: { settled: 'Settled', shifting: 'Shifting', unsettled: 'Unsettled' },
  regions: { brows: 'Brows', eyes: 'Eyes', cheeks: 'Cheeks', nose: 'Nose', lips: 'Lips', corners: 'Corners', jaw: 'Jaw' },
};

/** Merge partial overrides into the default words (one level deep). */
export function hudStrings(overrides: Partial<{ [K in keyof HudStrings]: Partial<HudStrings[K]> }> = {}): HudStrings {
  const out = { ...HUD_STRINGS } as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const base = (HUD_STRINGS as unknown as Record<string, unknown>)[key];
    out[key] = value && typeof value === 'object' && base && typeof base === 'object' ? { ...base, ...value } : value;
  }
  return out as unknown as HudStrings;
}

export interface HudTile {
  key: 'vocalizations' | 'contractions' | 'movement';
  label: string;
  value: string;
  unit: string;
  detail: string | null;
}

export interface HudView {
  phase: HudPhase;
  word: string;
  /** A second line: the percent, the baseline's countdown, what a call means, or what to do. */
  detail: string;
  /** Analysis is on: the session is calibrating or analysing and not over. */
  analysing: boolean;
  /** The newest reading is older than HUD_FRESH_MS. */
  stale: boolean;
  gauge: {
    p30: number | null;
    p60: number | null;
    /** `p30` as a whole percent, or null. */
    percent: number | null;
    /** For a screen reader: the phase and the chance in words. */
    valueText: string;
  };
  trend: {
    /** The window's end, in stream seconds; points and marks are placed 0 to 1 across the window before it. */
    endS: number;
    windowS: number;
    points: { x: number; p30: number | null; p60: number | null }[];
    marks: { id: string; x: number; kind: MarkKind; label: string; ruined: boolean }[];
  };
  counts: { orgasms: number; ruins: number; edges: number };
  clock: { seconds: number | null; text: string };
  notices: { code: WarningCode; text: string }[];
  subject: { sex: SubjectSex; text: string } | null;
  signals: { tiles: HudTile[]; faceRegions: { key: keyof FaceRegions; label: string; level: number }[] | null } | null;
}

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');

/** 74 -> "1:14"; 3725 -> "1:02:05". */
export function clockText(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '0:00';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function imminencePhase(p30: number): HudPhase {
  if (p30 >= PHASE_LEVELS.veryClose) return 'very_close';
  if (p30 >= PHASE_LEVELS.close) return 'close';
  if (p30 >= PHASE_LEVELS.rising) return 'rising';
  return 'building';
}

const REGION_KEYS: (keyof FaceRegions)[] = ['brows', 'eyes', 'cheeks', 'nose', 'lips', 'corners', 'jaw'];

function signalsView(state: HudState, strings: HudStrings, now: number): HudView['signals'] {
  const s = state.signals;
  if (!s || state.signalsAt === null || now - state.signalsAt > HUD_FRESH_MS) return null;
  const tiles: HudTile[] = [];
  if (s.vocalizationsPerMin !== null) {
    tiles.push({
      key: 'vocalizations',
      label: strings.vocalizations,
      value: String(Math.round(s.vocalizationsPerMin)),
      unit: strings.perMin,
      detail: s.loudnessAboveBaselineDb !== null && s.loudnessAboveBaselineDb > 0 ? fill(strings.aboveBaseline, { db: String(Math.round(s.loudnessAboveBaselineDb)) }) : null,
    });
  }
  if (s.contractionsPerMin !== null) tiles.push({ key: 'contractions', label: strings.contractions, value: String(Math.round(s.contractionsPerMin)), unit: strings.perMin, detail: null });
  if (s.movement !== null) tiles.push({ key: 'movement', label: strings.movement, value: strings.movementWords[s.movement], unit: '', detail: null });
  const faceRegions = s.faceRegions ? REGION_KEYS.map((key) => ({ key, label: strings.regions[key], level: Math.max(0, Math.min(1, s.faceRegions![key])) })) : null;
  return tiles.length || faceRegions ? { tiles, faceRegions } : null;
}

/** What to show at `now` (the receiving clock, ms). */
export function hudView(state: HudState, now: number = Date.now(), strings: HudStrings = HUD_STRINGS): HudView {
  const fresh = state.receivedAt !== null && now - state.receivedAt <= HUD_FRESH_MS;
  const ended = state.status === 'ended';
  // Between events the clock runs on from the newest one, so it ticks every second.
  const carried = state.eventAt === null || ended ? 0 : Math.max(0, Math.min(CLOCK_CARRY_MS, now - state.eventAt)) / 1000;
  const nowS = state.streamTimeS === null ? null : state.streamTimeS + carried;
  const percent = state.p30 === null ? null : Math.round(state.p30 * 100);

  let phase: HudPhase;
  let detail: string;
  const call = state.lastCall;
  const callAge = call && nowS !== null ? nowS - call.calledAtS : Infinity;
  // A new approach outranks the afterglow of the last orgasm.
  const approaching = state.p30 !== null && state.p30 >= PHASE_LEVELS.close;
  const holding = call !== null && callAge >= 0 && callAge <= CALL_HOLD_S[call.kind] && !(call.kind === 'end' && approaching);
  if (ended) {
    phase = 'ended';
    detail = strings.endedDetail;
  } else if (state.streamTimeS === null) {
    phase = state.status === null ? 'waiting' : 'starting';
    detail = state.status === null ? strings.waitingDetail : strings.startingDetail;
  } else if (state.receivedAt !== null && !fresh) {
    phase = 'paused';
    detail = strings.pausedDetail;
  } else if (holding && call) {
    phase = call.kind === 'end' ? 'afterglow' : call.kind;
    detail = strings.callDetail[call.kind];
  } else if (!state.baselineReady || state.status === 'calibrating' || state.status === 'starting' || state.status === 'ready') {
    phase = 'calibrating';
    const remaining = nowS === null ? null : BASELINE_S - nowS;
    detail = remaining !== null && remaining > 0 ? fill(strings.baselineIn, { clock: clockText(remaining) }) : strings.baselineSoon;
  } else if (state.faceVisible === false) {
    phase = 'away';
    detail = strings.awayDetail;
  } else if (state.p30 === null) {
    phase = 'calibrating';
    detail = strings.baselineSoon;
  } else {
    phase = imminencePhase(state.p30);
    detail = fill(strings.within30, { percent: String(percent) });
  }
  const word = strings.phases[phase];

  const endS = nowS ?? 0;
  const startS = endS - TREND_WINDOW_S;
  const x = (atS: number) => Math.max(0, Math.min(1, (atS - startS) / TREND_WINDOW_S));
  const points = state.trend.filter((p) => p.atS >= startS - 1).map((p) => ({ x: x(p.atS), p30: p.p30, p60: p.p60 }));
  const marks = state.marks
    .filter((m) => m.atS >= startS && m.atS <= endS + 1)
    .map((m) => ({ id: m.id, x: x(m.atS), kind: m.kind, label: m.ruined ? `${strings.marks[m.kind]} · ${strings.ruinedMark}` : strings.marks[m.kind], ruined: m.ruined }));

  const kinds = Object.values(state.orgasms);
  const notices = (Object.keys(state.warnings) as WarningCode[])
    .filter((code) => !(code === 'baseline_pending' && phase === 'calibrating') && !(code === 'face_not_visible' && phase === 'away'))
    .map((code) => ({ code, text: strings.warnings[code] ?? state.warnings[code]!.message }));

  return {
    phase,
    word,
    detail,
    analysing: !ended && (state.status === 'calibrating' || state.status === 'analyzing' || (state.status === null && state.streamTimeS !== null)),
    stale: state.receivedAt !== null && !fresh && !ended,
    gauge: {
      p30: fresh && !ended ? state.p30 : null,
      p60: fresh && !ended ? state.p60 : null,
      percent: fresh && !ended ? percent : null,
      valueText: percent === null || !fresh || ended ? `${word}: ${strings.meterUnknown}` : fill(strings.meterText, { word, percent: String(percent) }),
    },
    trend: { endS, windowS: TREND_WINDOW_S, points, marks },
    counts: { orgasms: kinds.filter((k) => k === 'orgasm').length, ruins: kinds.filter((k) => k === 'ruin').length, edges: state.edges },
    clock: { seconds: nowS === null ? null : Math.floor(nowS), text: clockText(nowS) },
    notices,
    subject: state.subject ? { sex: state.subject.sex, text: strings.subject[state.subject.sex] } : null,
    signals: signalsView(state, strings, now),
  };
}
