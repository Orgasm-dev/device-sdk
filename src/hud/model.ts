// The heads-up display's model: a session's events in, what to show out.
// Pure and framework-free, so a game engine can draw the same thing natively
// (feed it the events, read `hudView` once a frame or once a second) and
// <orgasm-hud> draws exactly this.
//
//   let state = initialHudState();
//   onEvent((event) => { state = hudReducer(state, event); });
//   onFaceFrame((frame) => { state = hudFrameReducer(state, frame); });
//   const view = hudView(state);   // phase, gauge, trend, counts, clock, notices, face, stimulation, timeline
//
// Imminence is a probability, not a countdown: the gauge is the chance of an
// orgasm within 30 seconds (`p30`), with the 60-second chance (`p60`) as a
// ghost mark. The phase words sit at the reference presets' levels (0.3,
// 0.6 and 0.75); a call (onset, peak, end) or a completed edge takes over the
// phase for a while after it arrives, which is a few seconds after the moment
// it names.
//
// The timeline keeps the whole session in five-second bins, three hours of
// them: imminence, the body's rates, the level of each of the device's
// outputs as your product reported it, its changes of mode, and the calls
// and edges. The face is the newest reading's, or the newest frame's while
// frames come: a frame outranks the readings' copy for FRAME_HOLD_MS.

import type {
  EndedReason, EventMode, FaceChannels, FaceFrame, FaceRegions, LiveSessionStatus, Movement, SessionEvent, SignalsData, StimulationData, SubjectSex, WarningCode,
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
/** The timeline's bins, in stream seconds, and how many are kept: three hours of them. */
export const HISTORY_BIN_S = 5;
export const HISTORY_CAP_BINS = 2160;
/** How long a face frame outranks the readings' once-a-second copy of the face, by the receiving clock. */
export const FRAME_HOLD_MS = 3_000;

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

/** Five stream seconds of the session. */
export interface HistoryBin {
  /** The bin's start, in stream seconds. */
  atS: number;
  /** The highest of each in the bin; null where none came. */
  p30: number | null;
  p60: number | null;
  vocalizations: number | null;
  contractions: number | null;
  /** Each output's highest level in the bin (`level` for a device with one), carried from the bin before until a report changes it. */
  levels: Record<string, number> | null;
}

export interface HudHistory {
  bins: HistoryBin[];
  /** The device's changes of mode: when, and its name. */
  modes: { atS: number; label: string }[];
  /** The level lane's scale: the highest level or maximum reported. */
  levelScale: number | null;
  /** The levels in force, carried into the bins that follow. */
  levels: Record<string, number> | null;
  /** The mode in force. */
  mode: string | null;
}

/** The newest face, from a reading or a frame. */
export interface HudFace {
  /** Null while the face is out of view. */
  channels: FaceChannels | null;
  atS: number;
  /** The receiving clock (ms). */
  receivedAt: number;
  source: 'reading' | 'frame';
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
  history: HudHistory;
  /** The stimulation as last reported, and when it arrived (ms). */
  stimulation: StimulationData | null;
  stimulationAt: number | null;
  face: HudFace | null;
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
    history: { bins: [], modes: [], levelScale: null, levels: null, mode: null },
    stimulation: null,
    stimulationAt: null,
    face: null,
  };
}

const KEEP_TREND_S = TREND_WINDOW_S + 30;
const KEEP_MARKS = 256;
const KEEP_MODES = 256;

const higher = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** The history with the bin `atS` falls in changed by `update`: a new bin carries the levels in force; a bin older than the oldest kept is dropped. */
function withBin(history: HudHistory, atS: number, update: (bin: HistoryBin) => HistoryBin): HudHistory {
  const start = Math.floor(atS / HISTORY_BIN_S) * HISTORY_BIN_S;
  const bins = history.bins;
  const empty = (levels: Record<string, number> | null): HistoryBin => ({ atS: start, p30: null, p60: null, vocalizations: null, contractions: null, levels: levels && { ...levels } });
  const last = bins[bins.length - 1];
  if (!last || start > last.atS) {
    const next = [...bins, update(empty(history.levels))];
    return { ...history, bins: next.length > HISTORY_CAP_BINS ? next.slice(next.length - HISTORY_CAP_BINS) : next };
  }
  for (let i = bins.length - 1; i >= 0; i--) {
    if (bins[i].atS > start) continue;
    const next = bins.slice();
    if (bins[i].atS === start) next[i] = update(bins[i]);
    else next.splice(i + 1, 0, update(empty(bins[i].levels)));
    return { ...history, bins: next };
  }
  return history;
}

/** Each output's level as reported, zero while stimulation is off; `level` for a device with one output, the intensity for one with neither. */
function levelsOf(d: StimulationData): Record<string, number> | null {
  const on = d.state === 'on';
  if (d.channels?.length) return Object.fromEntries(d.channels.map((c) => [c.id, on ? c.level : 0]));
  if (d.level !== null) return { level: on ? d.level : 0 };
  if (d.intensity !== null) return { level: on ? d.intensity : 0 };
  return null;
}

/** The largest level the lane must hold: the maxima and levels reported, or 1 for an intensity alone. */
function scaleOf(d: StimulationData, levels: Record<string, number> | null): number | null {
  if (!levels) return null;
  if (!d.channels?.length && d.level === null) return 1;
  return Math.max(0, d.levelMax ?? 0, ...(d.channels ?? []).map((c) => c.levelMax ?? 0), ...Object.values(levels)) || null;
}

/**
 * A mode as words: the first letter up, dashes and underscores as spaces, a
 * trailing number set apart (`phase1` → `Phase 1`). Null without one.
 */
export function modeWords(mode: string | null | undefined): string | null {
  if (typeof mode !== 'string') return null;
  const words = mode.trim().replace(/[-_]+/g, ' ').replace(/([a-zA-Z])(\d+)$/, '$1 $2').replace(/\s+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function withStimulation(history: HudHistory, d: StimulationData): HudHistory {
  const levels = levelsOf(d);
  const scale = scaleOf(d, levels);
  const label = d.modeLabel ?? modeWords(d.mode);
  const modes =
    label && d.mode !== history.mode && d.state === 'on' ? [...history.modes, { atS: d.changedAtS, label }].slice(-KEEP_MODES) : history.modes;
  const next: HudHistory = { ...history, levels, levelScale: higher(history.levelScale, scale), modes, mode: d.state === 'on' ? d.mode : history.mode };
  if (!levels) return next;
  return withBin(next, d.changedAtS, (bin) => ({
    ...bin,
    levels: Object.fromEntries(Object.entries(levels).map(([id, level]) => [id, Math.max(level, bin.levels?.[id] ?? 0)])),
  }));
}

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
      next.history = withBin(state.history, event.streamTimeS, (bin) => ({ ...bin, p30: higher(bin.p30, d.p30), p60: higher(bin.p60, d.p60) }));
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
    case 'signals.updated': {
      const d = event.data;
      next.signals = d;
      next.signalsAt = receivedAt;
      next.history = withBin(state.history, event.streamTimeS, (bin) => ({
        ...bin,
        vocalizations: higher(bin.vocalizations, d.vocalizationsPerMin),
        contractions: higher(bin.contractions, d.contractionsPerMin),
      }));
      // A server before the face channels sends no `face`; a fresh frame outranks the reading's copy.
      const frameHeld = state.face?.source === 'frame' && receivedAt - state.face.receivedAt < FRAME_HOLD_MS;
      if (d.face !== undefined && !frameHeld) next.face = { channels: d.face, atS: event.streamTimeS, receivedAt, source: 'reading' };
      break;
    }
    case 'stimulation.updated':
      next.stimulation = event.data;
      next.stimulationAt = receivedAt;
      next.history = withStimulation(state.history, event.data);
      break;
    default:
      return state;
  }
  return next;
}

/** The state after a face frame: the face between readings. A frame of another session is ignored. */
export function hudFrameReducer(state: HudState, frame: FaceFrame, receivedAt: number = Date.now()): HudState {
  if (state.sessionId !== null && frame.sessionId !== state.sessionId) return state;
  return { ...state, sessionId: frame.sessionId, face: { channels: frame.face, atS: frame.streamTimeS, receivedAt, source: 'frame' } };
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
  /** The strip's name when your product names no device. */
  stimulation: string;
  stimulationWords: { on: string; off: string; paused: string; holding: string; manual: string; lost: string };
  /** {level} */
  levelText: string;
  /** {level}, {max} */
  levelOfText: string;
  /** {percent} */
  intensityText: string;
  pages: { signals: string; face: string; timeline: string };
  lanes: { imminence: string; stimulation: string; body: string };
  faceAway: string;
  faceWaiting: string;
  timelineEmpty: string;
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
  stimulation: 'Stimulation',
  stimulationWords: { on: 'On', off: 'Off', paused: 'Paused', holding: 'Holding', manual: 'Manual', lost: 'Not reachable' },
  levelText: 'level {level}',
  levelOfText: 'level {level} of {max}',
  intensityText: '{percent}%',
  pages: { signals: 'Signals', face: 'Face', timeline: 'Timeline' },
  lanes: { imminence: 'Imminence', stimulation: 'Stimulation', body: 'Body' },
  faceAway: 'Face out of view',
  faceWaiting: 'The face shows once the baseline is in',
  timelineEmpty: 'The timeline starts with the first reading',
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
  signals: { tiles: HudTile[]; faceRegions: HudRegion[] | null } | null;
  /** Null until a face channel has come (a server before them, or a view token made without includeFace). */
  face: HudFaceView | null;
  /** Null until your product has reported stimulation. */
  stimulation: HudStimulationView | null;
  /** Null before the first reading. */
  timeline: HudTimelineView | null;
}

export interface HudRegion {
  key: keyof FaceRegions;
  label: string;
  level: number;
}

export interface HudFaceView {
  /** What to draw, or null while the face is out of view. */
  channels: FaceChannels | null;
  /** The seven regions, read from the channels. */
  regions: HudRegion[] | null;
  source: 'reading' | 'frame';
  /** No face has come for HUD_FRESH_MS. */
  stale: boolean;
  /** Words for when there is no face to draw; empty while there is. */
  detail: string;
}

export interface HudStimulationBar {
  id: string;
  /** The output's name to show (`A`, `B`), or empty for a device with one. */
  label: string;
  level: number;
  max: number;
  /** level / max, 0 to 1; 0 while stimulation is off. */
  fraction: number;
}

export interface HudStimulationView {
  /** The device's name, or the strip's. */
  label: string;
  /** Its state in a few words: the mode, who sets the level, or why it cannot be reached. */
  detail: string;
  tone: 'live' | 'neutral' | 'warn';
  connected: boolean;
  /** One per output with a maximum to fill toward; null without one. */
  bars: HudStimulationBar[] | null;
  /** The strip for a screen reader. */
  text: string;
}

/** A point on a lane: x and y 0 to 1 (y from the bottom); a null y breaks the line. */
export interface HudLanePoint {
  x: number;
  y: number | null;
}

export interface HudTimelineView {
  startS: number;
  endS: number;
  /** Minute labels along the bottom. */
  ticks: { x: number; text: string }[];
  /** Each lane is null until it has something to draw. */
  imminence: { p30: HudLanePoint[]; p60: HudLanePoint[] } | null;
  stimulation: { channels: { id: string; label: string; points: HudLanePoint[] }[]; modes: { x: number; label: string }[]; scale: number } | null;
  body: { vocalizations: HudLanePoint[] | null; contractions: HudLanePoint[] | null; scale: number } | null;
  /** The calls and edges, across the lanes. */
  marks: { id: string; x: number; kind: MarkKind; label: string; ruined: boolean }[];
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

/** The channels each region is the largest of, as orgasm.dev reads its regions. */
export const REGION_CHANNELS: Readonly<Record<keyof FaceRegions, readonly string[]>> = Object.freeze({
  brows: ['browDownL', 'browDownR', 'browTogether', 'browInnerUp', 'browOuterUpL', 'browOuterUpR'],
  eyes: ['eyeBlinkL', 'eyeBlinkR', 'eyeWideL', 'eyeWideR'],
  cheeks: ['cheekSquintL', 'cheekSquintR', 'lidTighten'],
  nose: ['noseWrinkle', 'noseSneer', 'noseFlare'],
  lips: ['lipsPart', 'mouthStretch', 'mouthPucker'],
  corners: ['mouthSmileL', 'mouthSmileR'],
  jaw: ['jawOpen', 'chinRaise'],
});

/** The seven regions from a face's channels: each the largest of its channels. */
export function faceRegionsOf(face: FaceChannels): FaceRegions {
  return Object.fromEntries(
    REGION_KEYS.map((key) => [key, Math.min(1, Math.max(0, ...REGION_CHANNELS[key].map((name) => face.expression[name] ?? 0)))]),
  ) as unknown as FaceRegions;
}

function faceView(state: HudState, strings: HudStrings, now: number): HudFaceView | null {
  const face = state.face;
  if (!face) return null;
  const stale = now - face.receivedAt > HUD_FRESH_MS;
  const channels = stale ? null : face.channels;
  const regions = channels ? faceRegionsOf(channels) : null;
  return {
    channels,
    regions: regions ? REGION_KEYS.map((key) => ({ key, label: strings.regions[key], level: regions[key] })) : null,
    source: face.source,
    stale,
    detail: channels ? '' : stale ? strings.pausedDetail : state.baselineReady ? strings.faceAway : strings.faceWaiting,
  };
}

function stimulationView(state: HudState, strings: HudStrings): HudStimulationView | null {
  const d = state.stimulation;
  if (!d) return null;
  const words = strings.stimulationWords;
  const label = d.device?.label || strings.stimulation;
  const on = d.state === 'on';
  if (d.device && !d.device.connected) return { label, detail: words.lost, tone: 'warn', connected: false, bars: null, text: `${label}: ${words.lost}` };

  const deviceMax = d.levelMax;
  let bars: HudStimulationBar[] | null = null;
  if (d.channels?.length) {
    const withMax = d.channels.filter((c) => (c.levelMax ?? deviceMax ?? 0) > 0);
    if (withMax.length) {
      bars = withMax.map((c) => {
        const max = (c.levelMax ?? deviceMax) as number;
        return { id: c.id, label: d.channels!.length > 1 ? c.id.toUpperCase() : '', level: c.level, max, fraction: on ? Math.min(1, c.level / max) : 0 };
      });
    }
  } else if (d.level !== null && deviceMax !== null && deviceMax > 0) {
    bars = [{ id: 'level', label: '', level: d.level, max: deviceMax, fraction: on ? Math.min(1, d.level / deviceMax) : 0 }];
  } else if (d.level === null && d.intensity !== null) {
    bars = [{ id: 'level', label: '', level: d.intensity, max: 1, fraction: on ? d.intensity : 0 }];
  }

  const level = d.channels?.length ? d.channels[0].level : d.level;
  const amount = bars
    ? ''
    : level !== null
      ? ` · ${deviceMax !== null ? fill(strings.levelOfText, { level: String(level), max: String(deviceMax) }) : fill(strings.levelText, { level: String(level) })}`
      : d.intensity !== null
        ? ` · ${fill(strings.intensityText, { percent: String(Math.round(d.intensity * 100)) })}`
        : '';
  let detail: string;
  let tone: HudStimulationView['tone'] = 'neutral';
  if (!on) detail = words.off;
  else if (d.drive === 'paused') detail = words.paused;
  else if (d.drive === 'hold') detail = `${words.holding}${amount}`;
  else {
    tone = 'live';
    const mode = d.modeLabel ?? modeWords(d.mode) ?? words.on;
    detail = `${d.drive === 'manual' ? `${words.manual} · ` : ''}${mode}${amount}`;
  }
  const levels = bars?.map((b) => `${b.label ? `${b.label} ` : ''}${b.max === 1 && b.id === 'level' && d.level === null ? fill(strings.intensityText, { percent: String(Math.round(b.level * 100)) }) : fill(strings.levelOfText, { level: String(b.level), max: String(b.max) })}`);
  return { label, detail, tone, connected: true, bars, text: [`${label}: ${detail}`, ...(on && levels ? levels : [])].join(', ') };
}

const TICK_STEPS_S = [60, 120, 300, 600, 900, 1800, 3600];
/** The narrowest the timeline spans, so its first minute is not drawn a second at a time. */
const TIMELINE_MIN_S = 60;

function timelineView(state: HudState, strings: HudStrings, endS: number): HudTimelineView | null {
  const { bins, modes, levelScale } = state.history;
  if (!bins.length) return null;
  const startS = bins[0].atS;
  const lastEnd = bins[bins.length - 1].atS + HISTORY_BIN_S;
  const end = Math.max(endS, lastEnd, startS + TIMELINE_MIN_S);
  const span = end - startS;
  const x = (atS: number) => Math.max(0, Math.min(1, (atS - startS) / span));

  /** A lane's points, one per bin at its middle, broken across a missing bin. */
  const lane = (value: (bin: HistoryBin) => number | null, scale: number): HudLanePoint[] => {
    const points: HudLanePoint[] = [];
    let previous: HistoryBin | null = null;
    for (const bin of bins) {
      if (previous && bin.atS - previous.atS > HISTORY_BIN_S) points.push({ x: x(previous.atS + HISTORY_BIN_S), y: null });
      const v = value(bin);
      points.push({ x: x(bin.atS + HISTORY_BIN_S / 2), y: v === null ? null : Math.max(0, Math.min(1, v / scale)) });
      previous = bin;
    }
    return points;
  };
  const any = (value: (bin: HistoryBin) => number | null) => bins.some((bin) => value(bin) !== null);

  const imminence = any((b) => b.p30) || any((b) => b.p60) ? { p30: lane((b) => b.p30, 1), p60: lane((b) => b.p60, 1) } : null;

  const ids: string[] = [];
  for (const bin of bins) for (const id of Object.keys(bin.levels ?? {})) if (!ids.includes(id)) ids.push(id);
  const scale = levelScale ?? 1;
  const stimulation = ids.length
    ? {
        channels: ids.map((id) => ({ id, label: ids.length > 1 ? id.toUpperCase() : '', points: lane((b) => b.levels?.[id] ?? null, scale) })),
        modes: modes.filter((m) => m.atS >= startS && m.atS <= end).map((m) => ({ x: x(m.atS), label: m.label })),
        scale,
      }
    : null;

  const hasVocal = any((b) => b.vocalizations);
  const hasContractions = any((b) => b.contractions);
  const highest = Math.max(30, ...bins.map((b) => Math.max(b.vocalizations ?? 0, b.contractions ?? 0)));
  const body =
    hasVocal || hasContractions
      ? { vocalizations: hasVocal ? lane((b) => b.vocalizations, highest) : null, contractions: hasContractions ? lane((b) => b.contractions, highest) : null, scale: highest }
      : null;

  const step = TICK_STEPS_S.find((s) => span / s <= 6) ?? 3600;
  const ticks: HudTimelineView['ticks'] = [];
  for (let t = Math.ceil(startS / step) * step; t <= end; t += step) ticks.push({ x: x(t), text: clockText(t) });

  const marks = state.marks
    .filter((m) => m.atS >= startS && m.atS <= end)
    .map((m) => ({ id: m.id, x: x(m.atS), kind: m.kind, label: m.ruined ? `${strings.marks[m.kind]} · ${strings.ruinedMark}` : strings.marks[m.kind], ruined: m.ruined }));
  return { startS, endS: end, ticks, imminence, stimulation, body, marks };
}

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
  const faceRegions: HudRegion[] | null = s.faceRegions ? REGION_KEYS.map((key) => ({ key, label: strings.regions[key], level: Math.max(0, Math.min(1, s.faceRegions![key])) })) : null;
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
    face: faceView(state, strings, now),
    stimulation: stimulationView(state, strings),
    timeline: timelineView(state, strings, nowS ?? 0),
  };
}
