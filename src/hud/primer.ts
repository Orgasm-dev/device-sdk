// <orgasm-capture-primer>: what to tell a person before the browser asks for
// their camera and microphone. It says what is measured, why each device is
// needed, that only numbers leave the device, who receives them and for how
// long, and that they can stop at any time; with `verify` set it checks the
// enclave first and says so; then, on the person's click, it asks.
//
//   <orgasm-capture-primer developer="Lumen Games" retention-days="7"></orgasm-capture-primer>
//   primer.verify = () => verifyEnclave({ origin, policyUrl });
//   primer.addEventListener('orgasm-capture', (e) => publish(e.detail.capture.stream));
//
// It explains; it is not the person's consent. Your product still asks for
// and records that, and attests it when it creates the session.

import { requestCapture, CaptureRefused, type Capture, type CaptureOptions, type CaptureRefusal } from '../capture.ts';
import { ElementBase, THEME_CSS, define, h, setText } from './dom.ts';

export interface PrimerStrings {
  title: string;
  /** {developer} is replaced. */
  lead: string;
  cameraTitle: string;
  cameraBody: string;
  microphoneTitle: string;
  microphoneBody: string;
  numbersTitle: string;
  /** {developer} is replaced. */
  numbersBody: string;
  /** {developer} is replaced. */
  receivesTitle: string;
  /** {days} is replaced. */
  keepsDays: string;
  keepsNone: string;
  keepsUnknown: string;
  controlTitle: string;
  controlBody: string;
  turnOn: string;
  turnOnCameraOnly: string;
  notNow: string;
  tryAgain: string;
  checking: string;
  /** {release} is replaced. */
  checked: string;
  checkFailed: string;
  asking: string;
  granted: string;
  grantedWithoutMicrophone: string;
  howChecked: string;
  privacy: string;
}

export const PRIMER_STRINGS: PrimerStrings = {
  title: 'Before your camera turns on',
  lead: '{developer} uses orgasm.dev to read, from your camera and microphone, how close you are to orgasm, and when one begins, peaks and ends.',
  cameraTitle: 'Your camera',
  cameraBody: 'Your face shows how close you are.',
  microphoneTitle: 'Your microphone',
  microphoneBody: 'Breath and voice mark when an orgasm begins, peaks and ends. Without it, those moments aren’t called.',
  numbersTitle: 'Only numbers leave your device',
  numbersBody: 'Your video and sound go to a sealed enclave your device checks first. They are analysed there and never stored; nobody can watch them, {developer} included.',
  receivesTitle: '{developer} receives the readings',
  keepsDays: 'They are kept for {days} days.',
  keepsNone: 'They arrive as they happen and are not kept.',
  keepsUnknown: 'Its privacy policy says how long it keeps them.',
  controlTitle: 'You’re in control',
  controlBody: 'A light shows whenever analysis is on, and you can stop it at any time.',
  turnOn: 'Turn on camera and microphone',
  turnOnCameraOnly: 'Turn on camera',
  notNow: 'Not now',
  tryAgain: 'Try again',
  checking: 'Checking the enclave on this device…',
  checked: 'Enclave checked on this device: release {release}, on confidential hardware.',
  checkFailed: 'The enclave didn’t check out on this device, so nothing was sent.',
  asking: 'Waiting for your browser…',
  granted: 'Camera and microphone on.',
  grantedWithoutMicrophone: 'Camera on. Without the microphone, onset, peak and end aren’t called.',
  howChecked: 'How your device checks it',
  privacy: 'Privacy policy',
};

const CSS = `
${THEME_CSS}
:host { display: block; max-width: 440px; }
.card { background: var(--hud-surface); border: 1px solid var(--hud-line); border-radius: var(--hud-radius); padding: 20px; backdrop-filter: blur(12px); }
h2 { margin: 0; font-size: 18px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; }
.lead { margin: 8px 0 0; font-size: 14px; line-height: 1.5; color: var(--hud-muted); }
.purpose { margin: 8px 0 0; font-size: 14px; line-height: 1.5; }
ul { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; }
li { display: grid; grid-template-columns: 22px 1fr; gap: 10px; align-items: start; }
li svg { width: 20px; height: 20px; margin-top: 1px; color: var(--hud-accent); }
li strong { display: block; font-size: 14px; font-weight: 600; }
li span { display: block; margin-top: 2px; font-size: 13px; line-height: 1.45; color: var(--hud-muted); }
.status { margin: 16px 0 0; font-size: 13px; line-height: 1.45; min-height: 1.45em; }
.status[data-tone="ok"] { color: var(--hud-on); }
.status[data-tone="warn"] { color: var(--hud-warn); }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.primary, .secondary { border-radius: 10px; padding: 10px 14px; font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
.primary { background: var(--hud-accent); color: #fff; }
.primary:disabled { opacity: 0.6; cursor: progress; }
.secondary { background: transparent; border-color: var(--hud-line); }
.links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; font-size: 12px; }
.links a { color: var(--hud-muted); }
`;

const ICON_PATHS: Record<string, string> = {
  camera: 'M3 7h3l2-2h8l2 2h3v12H3z M12 10a3.5 3.5 0 1 0 0 7a3.5 3.5 0 1 0 0-7',
  microphone: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z M5 11a7 7 0 0 0 14 0 M12 18v3',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9c-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5l4.5-5',
  inbox: 'M3 13l3-8h12l3 8v6H3z M3 13h5l1.5 2h5l1.5-2h5',
  stop: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18 M9 9h6v6H9z',
};

function icon(name: keyof typeof ICON_PATHS): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.6');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  el.append(path);
  return el;
}

export type PrimerState = 'idle' | 'checking' | 'asking' | 'granted' | 'refused' | 'declined' | 'failed';

export interface PrimerVerified {
  release: { version: string } | null;
}

export class OrgasmCapturePrimer extends ElementBase {
  static observedAttributes = ['developer', 'purpose', 'retention-days', 'audio', 'privacy-url'];

  /** Checks the enclave before asking (verifyEnclave); without it the primer asks straight away. */
  verify: (() => Promise<PrimerVerified>) | null = null;
  /** Passed to requestCapture (a camera from a picker, for example). */
  captureOptions: Omit<CaptureOptions, 'audio'> = {};
  private _strings: PrimerStrings = PRIMER_STRINGS;
  private _state: PrimerState = 'idle';
  private root: ShadowRoot | null = null;
  private status: HTMLElement | null = null;
  private primary: HTMLButtonElement | null = null;
  private secondary: HTMLButtonElement | null = null;

  get strings(): PrimerStrings {
    return this._strings;
  }
  /** Override any of the words: { title, lead, … }. */
  set strings(value: Partial<PrimerStrings>) {
    this._strings = { ...PRIMER_STRINGS, ...value };
    this.render();
  }

  get state(): PrimerState {
    return this._state;
  }

  get developer(): string {
    return this.getAttribute('developer') || 'This app';
  }

  get wantsAudio(): boolean {
    return this.getAttribute('audio') !== 'false';
  }

  connectedCallback(): void {
    if (!this.root) this.root = this.attachShadow({ mode: 'open' });
    this.render();
  }

  attributeChangedCallback(): void {
    if (this.root) this.render();
  }

  private say(name: keyof PrimerStrings, values: Record<string, string> = {}): string {
    return this._strings[name].replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '');
  }

  private keeps(): string {
    const raw = this.getAttribute('retention-days');
    if (raw === null || raw === '') return this.say('keepsUnknown');
    const days = Number(raw);
    if (!Number.isFinite(days) || days < 0) return this.say('keepsUnknown');
    return days === 0 ? this.say('keepsNone') : this.say('keepsDays', { days: String(days) });
  }

  private render(): void {
    if (!this.root) return;
    const developer = this.developer;
    const purpose = this.getAttribute('purpose');
    const privacy = this.getAttribute('privacy-url');
    const items: [keyof typeof ICON_PATHS, string, string][] = [
      ['camera', this.say('cameraTitle'), this.say('cameraBody')],
      ...(this.wantsAudio ? ([['microphone', this.say('microphoneTitle'), this.say('microphoneBody')]] as [keyof typeof ICON_PATHS, string, string][]) : []),
      ['shield', this.say('numbersTitle'), this.say('numbersBody', { developer })],
      ['inbox', this.say('receivesTitle', { developer }), this.keeps()],
      ['stop', this.say('controlTitle'), this.say('controlBody')],
    ];
    this.status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    this.primary = h('button', { class: 'primary', type: 'button' }, this.wantsAudio ? this.say('turnOn') : this.say('turnOnCameraOnly'));
    this.secondary = h('button', { class: 'secondary', type: 'button' }, this.say('notNow'));
    this.primary.addEventListener('click', () => void this.start());
    this.secondary.addEventListener('click', () => this.decline());
    const titleId = 'primer-title';
    const card = h(
      'section',
      { class: 'card', 'aria-labelledby': titleId },
      h('h2', { id: titleId }, this.say('title')),
      h('p', { class: 'lead' }, this.say('lead', { developer })),
      purpose ? h('p', { class: 'purpose' }, purpose) : null,
      h('ul', {}, ...items.map(([name, title, body]) => h('li', {}, icon(name), h('div', {}, h('strong', {}, title), h('span', {}, body))))),
      this.status,
      h('div', { class: 'actions' }, this.primary, this.secondary),
      h(
        'div',
        { class: 'links' },
        h('a', { href: 'https://orgasm.dev/docs/concepts/trust', target: '_blank', rel: 'noopener' }, this.say('howChecked')),
        privacy ? h('a', { href: privacy, target: '_blank', rel: 'noopener' }, this.say('privacy')) : null,
      ),
    );
    const style = h('style', {}, CSS);
    this.root.replaceChildren(style, card);
    this.paint();
  }

  private setState(state: PrimerState, message = '', tone: 'ok' | 'warn' | '' = ''): void {
    this._state = state;
    if (this.status) {
      setText(this.status, message);
      if (tone) this.status.dataset.tone = tone;
      else delete this.status.dataset.tone;
    }
    this.paint();
  }

  private paint(): void {
    if (!this.primary || !this.secondary) return;
    const busy = this._state === 'checking' || this._state === 'asking';
    this.primary.disabled = busy;
    this.primary.hidden = this._state === 'granted' || this._state === 'failed';
    this.secondary.hidden = this._state === 'granted' || busy;
    if (this._state === 'refused') setText(this.primary, this.say('tryAgain'));
  }

  /** Check the enclave (when `verify` is set), then ask; resolves with the capture or null. */
  async start(): Promise<Capture | null> {
    if (this._state === 'checking' || this._state === 'asking') return null;
    let checked = '';
    if (this.verify) {
      this.setState('checking', this.say('checking'));
      try {
        const enclave = await this.verify();
        checked = this.say('checked', { release: enclave.release?.version ?? 'unstamped' });
      } catch (error) {
        this.setState('failed', this.say('checkFailed'), 'warn');
        this.dispatchEvent(new CustomEvent('orgasm-capture-failed', { bubbles: true, composed: true, detail: { error } }));
        return null;
      }
    }
    this.setState('asking', checked ? `${checked} ${this.say('asking')}` : this.say('asking'), checked ? 'ok' : '');
    try {
      const capture = await requestCapture({ ...this.captureOptions, audio: this.wantsAudio });
      const words = capture.audio || !this.wantsAudio ? this.say('granted') : this.say('grantedWithoutMicrophone');
      this.setState('granted', checked ? `${checked} ${words}` : words, 'ok');
      this.dispatchEvent(new CustomEvent('orgasm-capture', { bubbles: true, composed: true, detail: { capture } }));
      return capture;
    } catch (error) {
      const refused = error instanceof CaptureRefused ? error : new CaptureRefused('aborted', error);
      this.setState('refused', refused.recovery, 'warn');
      this.dispatchEvent(new CustomEvent<{ reason: CaptureRefusal; recovery: string }>('orgasm-capture-refused', { bubbles: true, composed: true, detail: { reason: refused.reason, recovery: refused.recovery } }));
      return null;
    }
  }

  private decline(): void {
    this.setState('declined');
    this.dispatchEvent(new CustomEvent('orgasm-capture-declined', { bubbles: true, composed: true }));
  }
}

export function definePrimer(): void {
  define('orgasm-capture-primer', OrgasmCapturePrimer);
}

declare global {
  interface HTMLElementTagNameMap {
    'orgasm-capture-primer': OrgasmCapturePrimer;
  }
}
