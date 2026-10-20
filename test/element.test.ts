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

  it('shows the stimulation strip once a product reports, a bar per output', async () => {
    const { q } = await mount({ layout: 'rail' }, 'toy', 400);
    const strip = q('.strip')!;
    expect(strip.hidden).toBe(false);
    expect(q('.strip .name')!.textContent).toBe('Unit');
    expect(q('.strip .state')!.textContent).toMatch(/^(Waves|Pulse|Holding)/);
    const outputs = strip.querySelectorAll('.output');
    expect([...outputs].map((o) => o.firstElementChild!.textContent)).toEqual(['A', 'B']);
    expect(Number(outputs[0].getAttribute('aria-valuemax'))).toBe(60);
    expect(strip.getAttribute('aria-label')).toContain('A level');
    const plain = await mount({ layout: 'rail' }, 'finish', 400);
    expect(plain.q('.strip')!.hidden).toBe(true);
  });

  it('lays out the panel: the head over Signals, Face and Timeline pages, a tab for each', async () => {
    const { hud, q, text } = await mount({ layout: 'panel' }, 'toy', 500);
    const tabs = hud.shadowRoot!.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect([...tabs].map((t) => t.textContent)).toEqual(['Signals', 'Face', 'Timeline']);
    expect(q('.head .strip')).not.toBeNull();
    expect(q<HTMLElement>('[data-page="signals"].page')!.hidden).toBe(false);
    expect(q<HTMLElement>('[data-page="timeline"].page')!.hidden).toBe(true);
    tabs[2].click();
    await frame();
    expect(hud.page).toBe('timeline');
    expect(q<HTMLElement>('[data-page="timeline"].page')!.hidden).toBe(false);
    expect(tabs[2].getAttribute('aria-selected')).toBe('true');
    // Three lanes, the level drawn as steps per output, the mode changes labelled.
    expect(q('.timeline .area')!.getAttribute('d')).toMatch(/^M/);
    expect(hud.shadowRoot!.querySelectorAll('.timeline .out')).toHaveLength(2);
    expect(q('.timeline .out')!.getAttribute('d')).toMatch(/H/);
    expect(q('.timeline .vocal')!.getAttribute('d')).toMatch(/^M/);
    expect([...hud.shadowRoot!.querySelectorAll('.timeline .lane-title')].map((t) => t.textContent)).toEqual(['Imminence', 'Stimulation', 'Body']);
    expect(text()).toContain('Pulse');
    expect(hud.shadowRoot!.querySelectorAll('.timeline .mark.edge').length).toBeGreaterThan(0);

    tabs[1].click();
    await frame();
    expect(q('.face canvas')).not.toBeNull();
    expect(hud.shadowRoot!.querySelectorAll('.face .meters .region')).toHaveLength(7);
    expect(q<HTMLElement>('.face .away')!.hidden).toBe(true);
  });

  it('draws only the lanes it has, and says so before the first reading', async () => {
    const early = await mount({ layout: 'panel', page: 'timeline' }, 'finish', 30);
    expect(early.q<HTMLElement>('.timeline .empty')!.hidden).toBe(false);
    const later = await mount({ layout: 'panel', page: 'timeline' }, 'finish', 300);
    expect([...later.hud.shadowRoot!.querySelectorAll('.timeline .lane-title')].map((t) => t.textContent)).toEqual(['Imminence', 'Body']);
    expect(later.q('.timeline .out')).toBeNull();
  });

  it('in a stream, shows the panel’s pages side by side with nothing to press', async () => {
    const { hud, q } = await mount({ layout: 'panel', stream: '' }, 'toy', 500);
    expect(hud.shadowRoot!.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(q('.stop')).toBeNull();
    expect(hud.shadowRoot!.querySelectorAll('.page')).toHaveLength(3);
  });

  it('gives the bar the trend and the region meters it was asked for', async () => {
    const { q } = await mount({ layout: 'bar', show: 'phase gauge trend signals stimulation' }, 'toy', 400);
    expect(q('.trend .area')!.getAttribute('d')).toMatch(/^M/);
    expect(q('.regions')).not.toBeNull();
    expect(q<HTMLElement>('.regions')!.hidden).toBe(false);
    expect(q('.strip')).not.toBeNull();
  });

  it('asks for face frames when it shows the face, and moves the face with them', async () => {
    const events = fixture('toy').filter((e) => e.streamTimeS <= 200);
    const last = events[events.length - 1];
    const faceFrame = { type: 'face.frame', sessionId: last.sessionId, streamTimeS: 200.2, face: { expression: { jawOpen: 0.9 }, head: { yawDeg: 4, pitchDeg: 0, rollDeg: 0 } } };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(new TextEncoder().encode(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`));
        controller.enqueue(new TextEncoder().encode(`event: face.frame\ndata: ${JSON.stringify(faceFrame)}\n\n`));
      },
    });
    const hud = document.createElement('orgasm-hud');
    hud.setAttribute('layout', 'panel');
    document.body.append(hud);
    let asked = '';
    hud.connect({ streamUrl: 'https://orgasm.dev/v1/live-sessions/x/stream', token: 'vt_abc', fetchImpl: (async (url: string) => ((asked = url), new Response(body))) as unknown as typeof fetch });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(new URL(asked).searchParams.get('frames')).toBe('face');
    expect(hud.state.face).toMatchObject({ source: 'frame', channels: { expression: { jawOpen: 0.9 } } });
    expect(hud.view.face!.regions!.find((r) => r.key === 'jaw')!.level).toBe(0.9);
    hud.disconnect();
  });
});

