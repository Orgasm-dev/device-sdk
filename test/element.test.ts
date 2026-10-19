// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '../src/events.ts';
import { OrgasmHud, defineHud } from '../src/hud/element.ts';

defineHud();

const fixture = (name: string): SessionEvent[] => JSON.parse(readFileSync(resolve('test/fixtures', `${name}.json`), 'utf8'));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A HUD fed a scenario up to `untilS`, as though each event had just arrived. */
async function mount(attrs: Record<string, string>, scenario = 'finish', untilS = 540) {
  const hud = document.createElement('orgasm-hud');
  for (const [k, v] of Object.entries(attrs)) hud.setAttribute(k, v);
  document.body.append(hud);
  const now = Date.now();
  for (const event of fixture(scenario).filter((e) => e.streamTimeS <= untilS)) hud.feed(event, now - (untilS - event.streamTimeS) * 1000);
  await frame();
  const q = <T extends Element = HTMLElement>(selector: string) => hud.shadowRoot!.querySelector<T & Element>(selector);
  return { hud, q, text: () => hud.shadowRoot!.textContent ?? '' };
}

describe('<orgasm-hud>', () => {
  it('draws the phase, the chance, the counts and the clock, with the gauge for a screen reader', async () => {
    const { hud, q, text } = await mount({ layout: 'rail' });
    expect(hud).toBeInstanceOf(OrgasmHud);
    expect(q('.word')!.textContent).toBe('Very close');
    expect(q('.detail')!.textContent).toBe('87% within 30 s');
    const meter = q('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('87');
    expect(meter.getAttribute('aria-valuetext')).toBe('Very close: a 87% chance of an orgasm within 30 seconds');
    expect(q<HTMLElement>('.fill')!.style.width).toBe('86.7%');
    expect(text()).toContain('Orgasms');
    expect(text()).toContain('9:00');
    expect(q('.trend .area')!.getAttribute('d')).toMatch(/^M/);
  });

  it('always shows that analysis is on and a Stop on the device, and neither in a stream', async () => {
    const { hud, q } = await mount({ layout: 'card' });
    expect(q('.on')!.textContent).toBe('Analysis on');
    const stopped = new Promise<boolean>((resolve) => hud.addEventListener('orgasm-hud-stop', () => resolve(true), { once: true }));
    q<HTMLButtonElement>('.stop')!.click();
    expect(await stopped).toBe(true);
    // The card shows only its parts: no trend, no counts.
    expect(q('.trend')).toBeNull();
    expect(q('.counts')).toBeNull();

    const stream = await mount({ layout: 'overlay' });
    expect(stream.q('.on')).toBeNull();
    expect(stream.q('.stop')).toBeNull();
    expect(stream.q('.hud')!.hasAttribute('data-stream')).toBe(true);
    const bar = await mount({ layout: 'bar', stream: '' });
    expect(bar.q('.stop')).toBeNull();
  });

  it('shows only the parts asked for, keeps the subject read off unless asked, and rewords', async () => {
    const plain = await mount({ layout: 'rail' });
    expect(plain.q('.subject')).toBeNull();
    const chosen = await mount({ layout: 'rail', show: 'phase gauge subject' });
    expect(chosen.q('.subject')!.textContent).toBe('Face reads as a woman’s');
    expect(chosen.q('.counts')).toBeNull();
    // Without `percent` the gauge carries the chance; the line under the word keeps only words.
    expect(chosen.q('.detail')!.textContent).toBe('');
    chosen.hud.strings = { phases: { very_close: 'Nearly' } };
    await frame();
    expect(chosen.q('.word')!.textContent).toBe('Nearly');
  });

  it('says when the phase changes, politely, and counts a ruin as a ruin', async () => {
    const { hud, q } = await mount({ layout: 'rail' }, 'ruin', 600);
    const changes: string[] = [];
    hud.addEventListener('orgasm-hud-phase', (e) => changes.push((e as CustomEvent).detail.phase));
    for (const event of fixture('ruin').filter((e) => e.streamTimeS > 600 && e.streamTimeS <= 660)) hud.feed(event);
    await frame();
    expect(changes).toContain('afterglow');
    expect(q('[aria-live="polite"]')!.textContent).toMatch(/^Afterglow\./);
    expect(q('.counts')!.textContent).toContain('Ruins1');
  });

  it('keeps its frame and says the link’s state with nothing to show', async () => {
    const hud = document.createElement('orgasm-hud');
    hud.setAttribute('layout', 'overlay');
    document.body.append(hud);
    hud.connection = 'waiting';
    await frame();
    expect(hud.shadowRoot!.querySelector('.detail')!.textContent).toBe('Waiting for the next session');
    hud.connection = 'replaced';
    await frame();
    expect(hud.shadowRoot!.querySelector('.detail')!.textContent).toBe('This link was replaced');
  });

  it('reads a stream with connect()', async () => {
    const events = fixture('edge').filter((e) => e.streamTimeS <= 200);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(new TextEncoder().encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
      },
    });
    const hud = document.createElement('orgasm-hud');
    document.body.append(hud);
    const seen: string[] = [];
    hud.connect({ streamUrl: 'https://orgasm.dev/v1/live-sessions/x/stream', token: 'vt_abc', fetchImpl: (async () => new Response(body)) as typeof fetch, onEvent: (e) => seen.push(e.type) });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(hud.connection).toBe('live');
    expect(hud.state.trend.length).toBeGreaterThan(100);
    expect(seen).toHaveLength(events.length);
    hud.disconnect();
  });
});
