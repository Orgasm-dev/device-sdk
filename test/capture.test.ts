import { describe, expect, it } from 'vitest';
import { CaptureRefused, captureConstraints, captureSupport, listCaptureDevices, recoveryFor, requestCapture } from '../src/capture.ts';

const track = (kind: 'video' | 'audio') =>
  ({ kind, readyState: 'live', stop() {}, getSettings: () => (kind === 'video' ? { width: 1280, height: 720, frameRate: 30 } : {}) }) as unknown as MediaStreamTrack;

function fakeStream(kinds: ('video' | 'audio')[]): MediaStream {
  const tracks = kinds.map(track);
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

const domError = (name: string) => Object.assign(new Error(name), { name });

/** Media devices that answer each getUserMedia in turn and record the constraints. */
function devices(answers: (MediaStream | Error)[]) {
  const asked: MediaStreamConstraints[] = [];
  return {
    asked,
    mediaDevices: {
      async getUserMedia(constraints: MediaStreamConstraints) {
        asked.push(constraints);
        const answer = answers.shift();
        if (!answer || answer instanceof Error) throw answer ?? domError('AbortError');
        return answer;
      },
      async enumerateDevices() {
        return [
          { kind: 'videoinput', deviceId: 'cam-1', label: 'FaceTime HD Camera' },
          { kind: 'videoinput', deviceId: 'cam-2', label: 'OBS Virtual Camera' },
          { kind: 'audioinput', deviceId: 'mic-1', label: 'MacBook Microphone' },
          { kind: 'audiooutput', deviceId: 'out-1', label: 'Speakers' },
        ] as MediaDeviceInfo[];
      },
    } as Pick<MediaDevices, 'getUserMedia' | 'enumerateDevices'>,
  };
}

describe('requestCapture', () => {
  it('asks for the front camera at the analysis’s size, and the microphone unprocessed but for echo', async () => {
    const media = devices([fakeStream(['video', 'audio'])]);
    const capture = await requestCapture({ mediaDevices: media.mediaDevices });
    expect(capture.audio).toBe(true);
    expect(capture.settings).toEqual({ width: 1280, height: 720, frameRate: 30 });
    expect(media.asked[0].video).toMatchObject({ facingMode: 'user', width: { ideal: 1280 }, frameRate: { ideal: 30, max: 30 } });
    expect(media.asked[0].audio).toMatchObject({ echoCancellation: true, noiseSuppression: false, autoGainControl: false });
  });

  it('goes on without a microphone it cannot have, but not past a refusal', async () => {
    const busy = devices([domError('NotReadableError'), fakeStream(['video'])]);
    expect((await requestCapture({ mediaDevices: busy.mediaDevices })).audio).toBe(false);
    expect(busy.asked[1].audio).toBe(false);

    const denied = devices([domError('NotAllowedError')]);
    await expect(requestCapture({ mediaDevices: denied.mediaDevices })).rejects.toMatchObject({ name: 'CaptureRefused', reason: 'denied' });
    expect(denied.asked).toHaveLength(1);

    const noCamera = devices([domError('NotFoundError'), domError('NotFoundError')]);
    const error = await requestCapture({ mediaDevices: noCamera.mediaDevices }).catch((e) => e);
    expect(error).toBeInstanceOf(CaptureRefused);
    expect(error.reason).toBe('no_camera');
  });

  it('picks a named camera, such as a virtual one', async () => {
    const media = devices([fakeStream(['video', 'audio'])]);
    await requestCapture({ mediaDevices: media.mediaDevices, videoDeviceId: 'cam-2' });
    expect(media.asked[0].video).toMatchObject({ deviceId: { exact: 'cam-2' } });
    expect(media.asked[0].video).not.toHaveProperty('facingMode');
    expect(captureConstraints({ audio: false }).audio).toBe(false);
    expect(await listCaptureDevices({ mediaDevices: media.mediaDevices })).toEqual({
      cameras: [
        { deviceId: 'cam-1', label: 'FaceTime HD Camera' },
        { deviceId: 'cam-2', label: 'OBS Virtual Camera' },
      ],
      microphones: [{ deviceId: 'mic-1', label: 'MacBook Microphone' }],
    });
  });
});

describe('recoveryFor', () => {
  it('says what to do in the browser at hand', () => {
    expect(recoveryFor('denied', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toMatch(/Website Settings/);
    expect(recoveryFor('denied', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15')).toMatch(/Settings for This Website/);
    expect(recoveryFor('denied', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36')).toMatch(/right of the address bar/);
    expect(recoveryFor('in_use')).toMatch(/Virtual Camera/);
  });
});

describe('captureSupport', () => {
  it('names what a browser lacks; Node has Ed25519 and streams but no camera or WebRTC', async () => {
    const support = await captureSupport();
    expect(support.ok).toBe(false);
    expect(support.missing).toContain('camera_access');
    expect(support.missing).toContain('webrtc');
    expect(support.missing).not.toContain('ed25519');
    expect(support.missing).not.toContain('streams');
  });
});
