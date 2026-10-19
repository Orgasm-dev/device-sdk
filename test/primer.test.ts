// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { OrgasmCapturePrimer, definePrimer } from '../src/hud/primer.ts';

definePrimer();

const stream = (kinds: string[]) => {
  const tracks = kinds.map((kind) => ({ kind, readyState: 'live', stop() {}, getSettings: () => ({}) }));
  return { getTracks: () => tracks, getVideoTracks: () => tracks.filter((t) => t.kind === 'video'), getAudioTracks: () => tracks.filter((t) => t.kind === 'audio') } as unknown as MediaStream;
};

function mount(attrs: Record<string, string>, answers: (MediaStream | Error)[] = []) {
  const primer = document.createElement('orgasm-capture-primer');
  for (const [k, v] of Object.entries(attrs)) primer.setAttribute(k, v);
  const asked: MediaStreamConstraints[] = [];
  primer.captureOptions = {
    mediaDevices: {
      async getUserMedia(constraints: MediaStreamConstraints) {
        asked.push(constraints);
        const next = answers.shift();
        if (!next || next instanceof Error) throw next ?? Object.assign(new Error('x'), { name: 'AbortError' });
        return next;
      },
      async enumerateDevices() {
        return [];
      },
    },
  };
  document.body.append(primer);
  const text = () => primer.shadowRoot!.textContent ?? '';
  const button = (label: string) => [...primer.shadowRoot!.querySelectorAll('button')].find((b) => b.textContent === label && !b.hidden);
  return { primer, asked, text, button };
}

describe('<orgasm-capture-primer>', () => {
  it('says what is measured, why each device, what leaves it, who keeps it and how to stop', () => {
    const { primer, text } = mount({ developer: 'Lumen Games', 'retention-days': '7', purpose: 'The game paces itself to you.' });
    expect(primer).toBeInstanceOf(OrgasmCapturePrimer);
    expect(text()).toContain('Lumen Games uses orgasm.dev to read');
    expect(text()).toContain('Breath and voice mark when an orgasm begins, peaks and ends');
    expect(text()).toContain('nobody can watch them, Lumen Games included');
    expect(text()).toContain('They are kept for 7 days.');
    expect(text()).toContain('The game paces itself to you.');
    expect(text()).toContain('you can stop it at any time');

    const cameraOnly = mount({ developer: 'Lumen Games', 'retention-days': '0', audio: 'false' });
    expect(cameraOnly.text()).not.toContain('Your microphone');
    expect(cameraOnly.text()).toContain('They arrive as they happen and are not kept.');
    expect(cameraOnly.button('Turn on camera')).toBeTruthy();
  });

  it('checks the enclave first, says so, then asks and hands over the stream', async () => {
    const { primer, asked, text, button } = mount({ developer: 'Lumen Games' }, [stream(['video', 'audio'])]);
    const order: string[] = [];
    primer.verify = async () => {
      order.push(`verify before ask: ${asked.length}`);
      return { release: { version: 'v0.12.4' } };
    };
    const granted = new Promise<CustomEvent>((resolve) => primer.addEventListener('orgasm-capture', (e) => resolve(e as CustomEvent), { once: true }));
    button('Turn on camera and microphone')!.click();
    const event = await granted;
    expect(order).toEqual(['verify before ask: 0']);
    expect(event.detail.capture.audio).toBe(true);
    expect(primer.state).toBe('granted');
    expect(text()).toContain('Enclave checked on this device: release v0.12.4');
    expect(text()).toContain('Camera and microphone on.');
  });

  it('asks for nothing when the enclave does not check out, and gives the way back after a refusal', async () => {
    const failed = mount({ developer: 'Lumen Games' }, [stream(['video'])]);
    failed.primer.verify = async () => {
      throw new Error('policy');
    };
    expect(await failed.primer.start()).toBeNull();
    expect(failed.asked).toHaveLength(0);
    expect(failed.primer.state).toBe('failed');
    expect(failed.text()).toContain('nothing was sent');

    const refused = mount({ developer: 'Lumen Games' }, [Object.assign(new Error('denied'), { name: 'NotAllowedError' })]);
    const reason = new Promise<string>((resolve) => refused.primer.addEventListener('orgasm-capture-refused', (e) => resolve((e as CustomEvent).detail.reason), { once: true }));
    await refused.primer.start();
    expect(await reason).toBe('denied');
    expect(refused.text()).toContain('then try again');
    expect(refused.button('Try again')).toBeTruthy();
  });
});
