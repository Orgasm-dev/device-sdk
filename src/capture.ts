// The camera and microphone, asked for once and well: the constraints the
// analysis wants (the front camera, a 1280-pixel long edge, 30 frames a
// second; the microphone unprocessed but for echo), a refusal named for what
// it is with what to do about it in this browser, and the microphone treated
// as optional: without it imminence and edges still work, and only the
// onset, peak and end of an orgasm are not called.
//
//   import { requestCapture, CaptureRefused } from '@orgasm-dev/device/capture';
//   try {
//     const { stream, audio } = await requestCapture();
//   } catch (error) {
//     if (error instanceof CaptureRefused) show(error.recovery);
//   }
//
// Call it from a user gesture (a click): browsers prompt only then, and
// <orgasm-capture-primer> ('@orgasm-dev/device/hud') says why before they do.

export type CaptureRefusal =
  /** The person, the browser or the system said no. */
  | 'denied'
  /** No camera (or not the one asked for). */
  | 'no_camera'
  /** Another app holds the camera. */
  | 'in_use'
  /** Not a secure page (https or localhost). */
  | 'insecure'
  /** This browser cannot share a camera with a page. */
  | 'unsupported'
  /** The camera did not start, for no reason the browser gave. */
  | 'aborted';

export class CaptureRefused extends Error {
  readonly reason: CaptureRefusal;
  /** What to do next, in this browser, as a sentence to show. */
  readonly recovery: string;
  constructor(reason: CaptureRefusal, cause?: unknown, userAgent?: string) {
    super(`camera refused: ${reason}`, cause === undefined ? undefined : { cause });
    this.name = 'CaptureRefused';
    this.reason = reason;
    this.recovery = recoveryFor(reason, userAgent);
  }
}

export interface CaptureOptions {
  /** Ask for the microphone too (default true). */
  audio?: boolean;
  /** A camera from listCaptureDevices, such as a virtual camera; the front camera otherwise. */
  videoDeviceId?: string;
  audioDeviceId?: string;
  /** For tests: the platform's media devices. */
  mediaDevices?: Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>;
}

export interface Capture {
  stream: MediaStream;
  /** Whether the stream has a microphone. */
  audio: boolean;
  video: MediaStreamTrack;
  /** What the camera actually gave (width, height, frame rate). */
  settings: MediaTrackSettings;
}

/** The constraints the analysis is built for. */
export function captureConstraints(options: Pick<CaptureOptions, 'audio' | 'videoDeviceId' | 'audioDeviceId'> = {}): MediaStreamConstraints {
  const video: MediaTrackConstraints = {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
    ...(options.videoDeviceId ? { deviceId: { exact: options.videoDeviceId } } : { facingMode: 'user' }),
  };
  const audio: MediaTrackConstraints | false =
    options.audio === false
      ? false
      : {
          // Echo cancellation keeps a game's or a video's sound out of the
          // microphone; the breath and voice the analysis reads survive it,
          // and not noise suppression or gain control.
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          ...(options.audioDeviceId ? { deviceId: { exact: options.audioDeviceId } } : {}),
        };
  return { video, audio };
}

const errorName = (error: unknown): string => (error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : '');

function refusalOf(error: unknown): CaptureRefusal {
  switch (errorName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'SecurityError':
      return globalThis.isSecureContext === false ? 'insecure' : 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'no_camera';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'in_use';
    case 'TypeError':
      return 'unsupported';
    default:
      return 'aborted';
  }
}

/** Ask for the camera (and the microphone); throws CaptureRefused. */
export async function requestCapture(options: CaptureOptions = {}): Promise<Capture> {
  const userAgent = globalThis.navigator?.userAgent;
  if (globalThis.isSecureContext === false) throw new CaptureRefused('insecure', undefined, userAgent);
  const devices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== 'function') throw new CaptureRefused('unsupported', undefined, userAgent);
  const wantAudio = options.audio !== false;

  let stream: MediaStream;
  try {
    stream = await devices.getUserMedia(captureConstraints(options));
  } catch (error) {
    const reason = refusalOf(error);
    // A missing or busy microphone is no reason to go without the camera.
    if (!wantAudio || reason === 'denied' || reason === 'insecure' || reason === 'unsupported') throw new CaptureRefused(reason, error, userAgent);
    try {
      stream = await devices.getUserMedia(captureConstraints({ ...options, audio: false }));
    } catch (videoError) {
      throw new CaptureRefused(refusalOf(videoError), videoError, userAgent);
    }
  }
  const video = stream.getVideoTracks()[0];
  if (!video) {
    for (const track of stream.getTracks()) track.stop();
    throw new CaptureRefused('no_camera', undefined, userAgent);
  }
  return { stream, audio: stream.getAudioTracks().some((t) => t.readyState === 'live'), video, settings: video.getSettings?.() ?? {} };
}

export interface CaptureDevice {
  deviceId: string;
  /** Empty until the person has allowed the camera once: browsers hide the names before. */
  label: string;
}

/** The cameras and microphones, for a picker (a virtual camera shows up here). */
export async function listCaptureDevices(options: Pick<CaptureOptions, 'mediaDevices'> = {}): Promise<{ cameras: CaptureDevice[]; microphones: CaptureDevice[] }> {
  const devices = options.mediaDevices ?? globalThis.navigator?.mediaDevices;
  if (!devices || typeof devices.enumerateDevices !== 'function') return { cameras: [], microphones: [] };
  const all = await devices.enumerateDevices();
  const pick = (kind: MediaDeviceKind) => all.filter((d) => d.kind === kind && d.deviceId).map((d) => ({ deviceId: d.deviceId, label: d.label }));
  return { cameras: pick('videoinput'), microphones: pick('audioinput') };
}

export type CaptureMissing = 'secure_page' | 'camera_access' | 'webrtc' | 'ed25519' | 'streams';

export interface CaptureSupport {
  ok: boolean;
  /** What this browser lacks for a live session. */
  missing: CaptureMissing[];
}

// RFC 8032's first test vector: a public key every Ed25519 implementation imports.
const ED25519_PUBLIC = Uint8Array.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'.match(/../g)!.map((h) => parseInt(h, 16)));

/** Whether this browser can run a live session: before asking for anything. */
export async function captureSupport(): Promise<CaptureSupport> {
  const missing: CaptureMissing[] = [];
  if (globalThis.isSecureContext === false) missing.push('secure_page');
  if (typeof globalThis.navigator?.mediaDevices?.getUserMedia !== 'function') missing.push('camera_access');
  if (typeof globalThis.RTCPeerConnection !== 'function') missing.push('webrtc');
  if (typeof globalThis.ReadableStream !== 'function' || typeof globalThis.TextDecoderStream !== 'function') missing.push('streams');
  try {
    await globalThis.crypto.subtle.importKey('raw', ED25519_PUBLIC, { name: 'Ed25519' }, false, ['verify']);
  } catch {
    missing.push('ed25519');
  }
  return { ok: missing.length === 0, missing };
}

type Browser = 'ios' | 'safari' | 'android' | 'firefox' | 'edge' | 'chrome' | 'other';

function browserOf(userAgent = ''): Browser {
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'ios';
  if (/Edg\//.test(userAgent)) return 'edge';
  if (/Firefox\//.test(userAgent)) return 'firefox';
  if (/Android/.test(userAgent)) return 'android';
  if (/Chrome\//.test(userAgent)) return 'chrome';
  if (/Safari\//.test(userAgent)) return 'safari';
  return 'other';
}

const ALLOW: Record<Browser, string> = {
  chrome: 'Click the camera icon at the right of the address bar, choose to always allow this site, then try again.',
  edge: 'Click the camera icon at the right of the address bar, choose to always allow this site, then try again.',
  safari: 'In the Safari menu, choose Settings for This Website, set Camera and Microphone to Allow, then try again.',
  ios: 'Tap the page settings button in the address bar, then Website Settings, set Camera and Microphone to Allow, then try again.',
  android: 'Tap the icon at the left of the address bar, then Permissions, allow Camera and Microphone, then try again.',
  firefox: 'Click the camera icon at the left of the address bar, remove the blocks on Camera and Microphone, then try again.',
  other: 'Allow this site to use your camera and microphone in your browser’s site settings, then try again.',
};

/** What to do about a refusal, in the browser this user agent names. */
export function recoveryFor(reason: CaptureRefusal, userAgent = globalThis.navigator?.userAgent): string {
  switch (reason) {
    case 'denied':
      return `${ALLOW[browserOf(userAgent)]} If it stays blocked, allow your browser in your system’s camera privacy settings.`;
    case 'no_camera':
      return 'No camera was found. Connect one, or open this page on your phone, then try again.';
    case 'in_use':
      return 'Another app is using the camera. Close it, then try again. Streaming with OBS? Start its Virtual Camera and choose it here.';
    case 'insecure':
      return 'The camera works only on a secure page: open this one over https.';
    case 'unsupported':
      return 'This browser can’t share a camera with a web page. Try a current Chrome, Safari, Edge or Firefox.';
    case 'aborted':
      return 'The camera didn’t start. Try again.';
  }
}
