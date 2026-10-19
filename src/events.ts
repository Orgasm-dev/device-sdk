// The events a live session sends, as the contract defines them
// (https://orgasm.dev/asyncapi.json): one envelope, and each type's `data`.
// New types can be added at any time; code that reads these ignores a type it
// does not know rather than failing.

export type EventMode = 'test' | 'live';
export type Confidence = 'high' | 'medium' | 'low' | null;
export type Sex = 'woman' | 'man';
export type SubjectSex = Sex | 'undetermined';
export type Detector = 'onset_end' | 'peak' | 'face_end';
export type CallType = 'orgasm.onset' | 'orgasm.peak' | 'orgasm.end';
export type LiveSessionStatus = 'starting' | 'ready' | 'calibrating' | 'analyzing' | 'ended';
export type EndedReason = 'client_ended' | 'media_ended' | 'media_timeout' | 'max_duration' | 'interrupted' | 'policy' | 'error';
export type WarningCode = 'face_not_visible' | 'multiple_faces' | 'audio_absent' | 'baseline_pending' | 'body_stream_absent' | 'low_confidence';

export interface RecentCall {
  id: string;
  type: CallType;
  eventAtS: number;
}

export interface ImminenceData {
  /** Probability of an orgasm within the next 30 seconds; null until the baseline is in and while the face is out of view. */
  p30: number | null;
  /** Within the next 60 seconds; never below `p30`. */
  p60: number | null;
  logit30: number | null;
  logit60: number | null;
  featuresPresent: number;
  faceVisible: boolean;
  baselineReady: boolean;
  stimulationAware: boolean;
  recentCalls: RecentCall[];
}

export interface OrgasmOnsetData {
  orgasmIndex: number;
  eventAtS: number;
  calledAtS: number;
  lagS: number;
  detector: 'onset_end';
  score: number | null;
  threshold: number | null;
}

export interface OrgasmPeakData {
  orgasmIndex: number;
  eventAtS: number;
  calledAtS: number;
  lagS: number;
  detector: 'peak';
  score: number | null;
  threshold: number | null;
}

export interface OrgasmEndData {
  orgasmIndex: number;
  eventAtS: number;
  startedAtS: number;
  durationS: number;
  calledAtS: number;
  lagS: number;
  detector: 'onset_end' | 'face_end';
  score: number | null;
  threshold: number | null;
  ruined: boolean;
}

export interface EdgeCompletedData {
  edgeIndex: number;
  startedAtS: number;
  eventAtS: number;
  durationS: number;
  peakP30: number;
}

export interface SubjectIdentifiedData {
  sex: SubjectSex;
  pWoman: number | null;
  secondsObserved: number;
  decidedAtS: number;
  hint: Sex | null;
  detectors: Detector[];
}

export interface InputsPresence {
  face: { present: boolean; baselineReady: boolean };
  audio: { declared: boolean; present: boolean };
  body: { declared: boolean; present: boolean };
}

export interface SessionStatusData {
  status: LiveSessionStatus;
  previousStatus: LiveSessionStatus | null;
  degraded: boolean;
  inputs: InputsPresence;
  endedReason: EndedReason | null;
}

export interface InputWarningData {
  code: WarningCode;
  state: 'raised' | 'cleared';
  message: string;
  sinceS: number;
}

/** How far each region of the face has moved from the person's own baseline, 0 to 1. */
export interface FaceRegions {
  brows: number;
  eyes: number;
  cheeks: number;
  nose: number;
  lips: number;
  corners: number;
  jaw: number;
}

export type Movement = 'settled' | 'shifting' | 'unsettled';

/** The body's other signals, once a second; each is null while its input is absent or still calibrating. */
export interface SignalsData {
  vocalizationsPerMin: number | null;
  loudnessAboveBaselineDb: number | null;
  /** From the body view only. */
  contractionsPerMin: number | null;
  /** From the body view only. */
  movement: Movement | null;
  faceRegions: FaceRegions | null;
}

export interface EventDataByType {
  'imminence.updated': ImminenceData;
  'signals.updated': SignalsData;
  'orgasm.onset': OrgasmOnsetData;
  'orgasm.peak': OrgasmPeakData;
  'orgasm.end': OrgasmEndData;
  'edge.completed': EdgeCompletedData;
  'subject.identified': SubjectIdentifiedData;
  'session.status': SessionStatusData;
  'input.warning': InputWarningData;
}

export type SessionEventType = keyof EventDataByType;

/** The envelope every event shares, on every channel. */
export interface SessionEventOf<T extends SessionEventType> {
  id: string;
  object: 'event';
  type: T;
  mode: EventMode;
  sessionId: string;
  sequence: number;
  /** Seconds on the media's own clock; for a call, when it was made (later than `data.eventAtS`). */
  streamTimeS: number;
  wallTime: string;
  confidence: Confidence;
  data: EventDataByType[T];
}

/** Any event a live session sends; narrow on `type`. */
export type SessionEvent = { [T in SessionEventType]: SessionEventOf<T> }[SessionEventType];

/** The live-session event types this SDK reads, in the contract's order. */
export const SESSION_EVENT_TYPES: readonly SessionEventType[] = Object.freeze([
  'imminence.updated',
  'signals.updated',
  'orgasm.onset',
  'orgasm.peak',
  'orgasm.end',
  'edge.completed',
  'subject.identified',
  'session.status',
  'input.warning',
]);

const KNOWN = new Set<string>(SESSION_EVENT_TYPES);

/** Whether a parsed frame is a live-session event this SDK knows. */
export function isSessionEvent(value: unknown): value is SessionEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Partial<SessionEvent>;
  return event.object === 'event' && typeof event.type === 'string' && KNOWN.has(event.type) && typeof event.id === 'string' && typeof event.sequence === 'number' && typeof event.data === 'object' && event.data !== null;
}

/** Whether this event ends its session's stream. */
export const isFinalEvent = (event: SessionEvent): boolean => event.type === 'session.status' && event.data.status === 'ended';
