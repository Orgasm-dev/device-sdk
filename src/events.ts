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

/** The face's 24 expression channels, in the contract's order. */
export const FACE_EXPRESSION_CHANNELS = Object.freeze([
  'eyeBlinkL',
  'eyeBlinkR',
  'eyeWideL',
  'eyeWideR',
  'browDownL',
  'browDownR',
  'browInnerUp',
  'browOuterUpL',
  'browOuterUpR',
  'jawOpen',
  'lipsPart',
  'mouthSmileL',
  'mouthSmileR',
  'mouthStretch',
  'mouthPucker',
  'noseSneer',
  'noseFlare',
  'cheekSquintL',
  'cheekSquintR',
  'chinRaise',
  'lidTighten',
  'browTogether',
  'noseWrinkle',
  'lidRaise',
] as const);

export type FaceExpressionChannel = (typeof FACE_EXPRESSION_CHANNELS)[number];

/** How far the head has turned from the person's resting pose, in degrees, as someone facing them sees it. */
export interface HeadPose {
  /** Positive turns the face toward the viewer's right. */
  yawDeg: number;
  /** Positive raises the chin. */
  pitchDeg: number;
  /** Positive tips the top of the head toward the viewer's right. */
  rollDeg: number;
}

/** The face's expression (each channel 0 to 1 from the person's rest) and the head's turn. */
export interface FaceChannels {
  expression: Record<FaceExpressionChannel, number> & Record<string, number>;
  head: HeadPose;
}

/**
 * The head's own angles against a face square to the camera, in degrees, with
 * HeadPose's senses: not its turn from the resting pose, so a head held
 * tilted, or lying on its side, reads as it is.
 */
export interface CameraHeadPose {
  /** Positive turns the face toward the viewer's right; within 180 either way. */
  yawDeg: number;
  /** Positive raises the chin; within 90 either way. */
  pitchDeg: number;
  /** Positive tips the top of the head toward the viewer's right; within 180 either way, a head on its side about 90. */
  rollDeg: number;
}

/** The body's other signals, once a second; each is null while its input is absent or still calibrating. */
export interface SignalsData {
  vocalizationsPerMin: number | null;
  loudnessAboveBaselineDb: number | null;
  /** From the body view only. */
  contractionsPerMin: number | null;
  /** From the body view only. */
  movement: Movement | null;
  faceRegions: FaceRegions | null;
  /** The face's channels; null out of view, before the baseline, and for a view token made without includeFace. Absent from servers before 0.3. */
  face?: FaceChannels | null;
}

export type StimulationDrive = 'auto' | 'manual' | 'hold' | 'paused';

export interface StimulationChannel {
  id: string;
  level: number;
  levelMax: number | null;
}

/** The stimulation as your product reported it, each report merged over the ones before. */
export interface StimulationData {
  state: 'on' | 'off';
  intensity: number | null;
  level: number | null;
  levelMax: number | null;
  channels: StimulationChannel[] | null;
  mode: string | null;
  modeLabel: string | null;
  device: { label: string | null; connected: boolean } | null;
  drive: StimulationDrive | null;
  /** When the change happened, in stream seconds; the event's `streamTimeS` is when it was received. */
  changedAtS: number;
}

/** The face about five times a second, for readers that ask (`frames: ['face']`). Not an event: no id, never replayed. */
export interface FaceFrame {
  type: 'face.frame';
  sessionId: string;
  streamTimeS: number;
  /** Null out of view and before the baseline. */
  face: FaceChannels | null;
  /** The head as the camera sees it, whenever the face is in view, before the baseline too; null out of view. Absent from older servers. */
  cameraHead?: CameraHeadPose | null;
}

export interface EventDataByType {
  'imminence.updated': ImminenceData;
  'signals.updated': SignalsData;
  'stimulation.updated': StimulationData;
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
  'stimulation.updated',
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

/** Whether a parsed frame is a face frame. */
export function isFaceFrame(value: unknown): value is FaceFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<FaceFrame>;
  return frame.type === 'face.frame' && typeof frame.sessionId === 'string' && typeof frame.streamTimeS === 'number' && (frame.face === null || (typeof frame.face === 'object' && frame.face !== undefined));
}
