// <orgasm-hud>: a live session's readings as a heads-up display, in four
// shapes: `rail` (a side panel), `bar` (a strip across the page), `card` (a
// corner of a game) and `overlay` (a panel for a stream). It draws hudView
// (model.ts) and nothing else.
//
//   <orgasm-hud layout="rail"></orgasm-hud>
//   hud.connect({ streamUrl, token });            // or hud.feed(event) yourself
//   hud.addEventListener('orgasm-hud-stop', () => live.stop({ releaseCamera: true }));
//
// On the person's device it always shows that analysis is on and a Stop
// control, as the consent rules require; only `stream` (and the `overlay`
// layout, which implies it), drawn into a video for others to watch, leaves
// them out. Theme it with CSS custom properties (--orgasm-hud-accent and
// the rest, dom.ts), and reword it with `strings`.

import { subscribe, type StreamSource, type SubscribeOptions, type Subscription, type SubscriptionState } from '../subscribe.ts';
import type { SessionEvent } from '../events.ts';
import { HUD_STRINGS, hudReducer, hudStrings, hudView, initialHudState, type HudPhase, type HudState, type HudStrings, type HudView } from './model.ts';
import { playDemo, type DemoOptions } from './demo.ts';
import { ElementBase, THEME_CSS, define, h, setAttr, setText, svg } from './dom.ts';

export type HudLayout = 'rail' | 'bar' | 'card' | 'overlay';
export type HudPart = 'phase' | 'gauge' | 'percent' | 'trend' | 'counts' | 'clock' | 'signals' | 'notices' | 'subject';
export type HudConnection = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'ended' | 'replaced' | 'refused' | 'unreachable';

export const HUD_LAYOUTS: readonly HudLayout[] = Object.freeze(['rail', 'bar', 'card', 'overlay']);
export const HUD_PARTS: readonly HudPart[] = Object.freeze(['phase', 'gauge', 'percent', 'trend', 'counts', 'clock', 'signals', 'notices', 'subject']);

/** What each layout shows unless `show` says otherwise. The subject read is never on by default. */
export const DEFAULT_PARTS: Readonly<Record<HudLayout, readonly HudPart[]>> = Object.freeze({
  rail: ['phase', 'gauge', 'percent', 'trend', 'counts', 'clock', 'signals', 'notices'],
  bar: ['phase', 'gauge', 'percent', 'counts', 'clock', 'notices'],
  card: ['phase', 'gauge', 'percent'],
  overlay: ['phase', 'gauge', 'percent', 'trend', 'counts', 'clock'],
});

export const CONNECTION_STRINGS: Record<HudConnection, string> = {
  connecting: 'Connecting…',
  waiting: 'Waiting for the next session',
  live: '',
  reconnecting: 'Reconnecting…',
  ended: '',
  replaced: 'This link was replaced',
  refused: 'This link no longer works',
  unreachable: 'orgasm.dev can’t be reached; still trying',
};

const CSS = `
${THEME_CSS}
:host { display: block; --hud-scale: 1; container-type: inline-size; }
:host([size="sm"]) { --hud-scale: 0.875; }
:host([size="lg"]) { --hud-scale: 1.25; }
.hud { position: relative; font-size: calc(14px * var(--hud-scale)); line-height: 1.35; background: var(--hud-surface); border: 1px solid var(--hud-line); border-radius: var(--hud-radius); padding: 1em 1.1em; display: grid; gap: 0.75em; backdrop-filter: blur(14px) saturate(1.3); -webkit-backdrop-filter: blur(14px) saturate(1.3); }
.hud[data-stream] { backdrop-filter: none; -webkit-backdrop-filter: none; }
.top { display: flex; align-items: center; gap: 0.6em; min-height: 1.9em; }
.on { display: inline-flex; align-items: center; gap: 0.45em; font-size: 0.82em; font-weight: 600; color: var(--hud-muted); white-space: nowrap; }
.on .dot { width: 0.55em; height: 0.55em; border-radius: 50%; background: var(--hud-muted); flex: none; }
.hud[data-analysing] .on { color: var(--hud-text); }
.hud[data-analysing] .on .dot { background: var(--hud-on); box-shadow: 0 0 0 0 var(--hud-on); animation: pulse 2.2s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.brand { margin-left: auto; font-size: 0.78em; font-weight: 650; letter-spacing: -0.01em; color: var(--hud-muted); white-space: nowrap; }
.brand b { color: var(--hud-accent); font-weight: inherit; }
.stop { margin-left: 0.25em; border: 1px solid var(--hud-line); background: transparent; border-radius: 999px; padding: 0.3em 0.85em; font-size: 0.85em; font-weight: 650; cursor: pointer; white-space: nowrap; }
.stop:hover { border-color: var(--hud-accent); color: var(--hud-accent); }
.brand + .stop { margin-left: 0.5em; }
.phase { display: flex; align-items: baseline; gap: 0.6em; flex-wrap: wrap; min-width: 0; }
.word { font-size: 1.55em; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; white-space: nowrap; transition: color 0.4s; }
.hud[data-phase="close"] .word, .hud[data-phase="very_close"] .word, .hud[data-phase="onset"] .word, .hud[data-phase="peak"] .word { color: var(--hud-accent); }
.hud[data-phase="edge"] .word { color: var(--hud-ghost); }
.hud[data-phase="paused"] .word, .hud[data-phase="away"] .word, .hud[data-phase="waiting"] .word, .hud[data-phase="ended"] .word { color: var(--hud-muted); }
.detail { font-size: 0.9em; color: var(--hud-muted); font-variant-numeric: tabular-nums; min-width: 0; }
.meter { position: relative; height: 0.7em; }
.track { position: absolute; inset: 0; border-radius: 999px; background: var(--hud-track); overflow: hidden; }
.fill { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 999px; background: linear-gradient(90deg, color-mix(in srgb, var(--hud-accent) 55%, transparent), var(--hud-accent)); transition: width 0.9s linear; }
.ghost { position: absolute; top: -0.2em; bottom: -0.2em; width: 2px; left: 0; border-radius: 2px; background: var(--hud-ghost); opacity: 0; transition: left 0.9s linear, opacity 0.3s; }
.meter[data-known] .ghost { opacity: 0.9; }
.tick { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--hud-surface); opacity: 0.9; }
.hud[data-phase="close"] .fill, .hud[data-phase="very_close"] .fill { box-shadow: 0 0 1em color-mix(in srgb, var(--hud-accent) 60%, transparent); }
.trend { display: block; width: 100%; height: 4.2em; overflow: visible; }
.trend .area { fill: color-mix(in srgb, var(--hud-accent) 22%, transparent); stroke: var(--hud-accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.trend .p60 { fill: none; stroke: var(--hud-ghost); stroke-width: 1.2; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; opacity: 0.8; }
.trend .mark { stroke: var(--hud-accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.trend .mark.edge { stroke: var(--hud-ghost); }
.trend .mark.ruined { stroke: var(--hud-warn); }
.trend .level { stroke: var(--hud-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.counts { display: flex; gap: 1.2em; margin: 0; flex-wrap: wrap; }
.counts div { min-width: 0; }
.counts dt { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hud-muted); }
.counts dd { margin: 0.1em 0 0; font-size: 1.2em; font-weight: 650; font-family: var(--hud-mono); font-variant-numeric: tabular-nums; }
.tiles { display: flex; gap: 1.2em; flex-wrap: wrap; }
.tile { min-width: 0; }
.tile .label { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hud-muted); }
.tile .value { font-size: 1.15em; font-weight: 650; font-variant-numeric: tabular-nums; }
.tile .unit { font-size: 0.75em; color: var(--hud-muted); margin-left: 0.15em; font-weight: 500; }
.tile .sub { font-size: 0.75em; color: var(--hud-muted); font-family: var(--hud-mono); }
.regions { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 0.4em; }
.region .bar { height: 0.3em; border-radius: 999px; background: var(--hud-track); overflow: hidden; }
.region .bar i { display: block; height: 100%; width: 0; background: var(--hud-accent); transition: width 0.9s linear; }
.region span { display: block; margin-top: 0.25em; font-size: 0.68em; color: var(--hud-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.subject { margin: 0; font-size: 0.82em; color: var(--hud-muted); }
.notices { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.25em; }
.notices li { font-size: 0.85em; color: var(--hud-warn); }
.quiet { margin: 0; font-size: 0.9em; color: var(--hud-muted); }
.hud[data-stale] .fill, .hud[data-stale] .trend { opacity: 0.45; }

/* bar: one strip, wrapping on a narrow page */
.hud[data-layout="bar"] { grid-template-columns: auto minmax(8em, 1fr) minmax(8em, 2fr) auto; align-items: center; gap: 0.6em 1.2em; padding: 0.7em 1em; }
.hud[data-layout="bar"] .top { order: 0; }
.hud[data-layout="bar"] .top .brand { display: none; }
.hud[data-layout="bar"] .phase { flex-direction: column; gap: 0.1em; }
.hud[data-layout="bar"] .word { font-size: 1.2em; }
.hud[data-layout="bar"] .counts { gap: 1em; }
.hud[data-layout="bar"] .notices { grid-column: 1 / -1; }
.hud[data-layout="bar"] .stop-slot { display: flex; align-items: center; gap: 0.6em; justify-self: end; }
@container (max-width: 640px) {
  .hud[data-layout="bar"] { grid-template-columns: minmax(0, 1fr) auto; }
  .hud[data-layout="bar"] .meter { grid-column: 1 / -1; order: 3; }
}

/* card: small, for a corner */
.hud[data-layout="card"] { gap: 0.55em; padding: 0.8em 0.9em; max-width: 20em; }
.hud[data-layout="card"] .word { font-size: 1.3em; }

/* overlay: a panel for a stream, read from across a room */
.hud[data-layout="overlay"] { font-size: calc(16px * var(--hud-scale)); grid-template-columns: minmax(10em, auto) minmax(0, 1fr); align-items: center; gap: 0.6em 1.4em; padding: 1em 1.3em; }
.hud[data-layout="overlay"] .top { grid-column: 1 / -1; min-height: 0; }
.hud[data-layout="overlay"] .word { font-size: 2em; }
.hud[data-layout="overlay"] .phase { flex-direction: column; gap: 0.15em; }
.hud[data-layout="overlay"] .meter { height: 0.9em; }
.hud[data-layout="overlay"] .trend, .hud[data-layout="overlay"] .counts, .hud[data-layout="overlay"] .tiles { grid-column: 1 / -1; }
.hud[data-layout="overlay"] .trend { height: 3.6em; }
.hud[data-stream][data-layout="bar"], .hud[data-stream][data-layout="card"] { font-size: calc(16px * var(--hud-scale)); }
@container (max-width: 560px) {
  .hud[data-layout="overlay"] { grid-template-columns: minmax(0, 1fr); }
}
`;

interface Refs {
  root: HTMLElement;
  on: HTMLElement | null;
  onText: HTMLElement | null;
  stop: HTMLButtonElement | null;
  word: HTMLElement;
  detail: HTMLElement;
  meter: HTMLElement;
  fill: HTMLElement;
  ghost: HTMLElement;
  area: SVGPathElement | null;
  p60: SVGPathElement | null;
  marks: SVGGElement | null;
  counts: { orgasms: HTMLElement; ruins: HTMLElement; ruinsRow: HTMLElement; edges: HTMLElement; clock: HTMLElement | null } | null;
  clockOnly: HTMLElement | null;
  tiles: HTMLElement | null;
  regions: HTMLElement | null;
  subject: HTMLElement | null;
  notices: HTMLElement | null;
  quiet: HTMLElement;
  announce: HTMLElement;
}

const parseParts = (raw: string | null, layout: HudLayout): Set<HudPart> => {
  if (!raw) return new Set(DEFAULT_PARTS[layout]);
  const parts = raw.split(/[\s,]+/).filter((p): p is HudPart => (HUD_PARTS as readonly string[]).includes(p));
  return new Set(parts);
};

/** A path through the points, broken where a value is missing; y runs 0 (bottom) to 1. */
function pathOf(points: { x: number; y: number | null }[], width: number, height: number, area: boolean): string {
  let d = '';
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const line = run.map((p, i) => `${i ? 'L' : 'M'}${(p.x * width).toFixed(1)},${(height - p.y * height).toFixed(1)}`).join('');
    d += area ? `${line}L${(run[run.length - 1].x * width).toFixed(1)},${height}L${(run[0].x * width).toFixed(1)},${height}Z` : line;
    run = [];
  };
  for (const p of points) {
    if (p.y === null) flush();
    else run.push({ x: p.x, y: Math.max(0, Math.min(1, p.y)) });
  }
  flush();
  return d;
}

export class OrgasmHud extends ElementBase {
  static observedAttributes = ['layout', 'theme', 'size', 'brand', 'show', 'stream', 'label'];

  private _state: HudState = initialHudState();
  private _strings: HudStrings = HUD_STRINGS;
  private _connectionStrings: Record<HudConnection, string> = CONNECTION_STRINGS;
  private _connection: HudConnection | null = null;
  private root: ShadowRoot | null = null;
  private refs: Refs | null = null;
  private frame: number | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastPhase: HudPhase | null = null;
  private subscription: Subscription | null = null;
  private stopDemo: (() => void) | null = null;

  get layout(): HudLayout {
    const value = this.getAttribute('layout') as HudLayout | null;
    return value && HUD_LAYOUTS.includes(value) ? value : 'rail';
  }

  /** Drawn into a video for others: no indicator, no Stop, nothing to focus. */
  get stream(): boolean {
    return this.layout === 'overlay' || this.hasAttribute('stream');
  }

  get parts(): Set<HudPart> {
    return parseParts(this.getAttribute('show'), this.layout);
  }

  get state(): HudState {
    return this._state;
  }

  get view(): HudView {
    return hudView(this._state, Date.now(), this._strings);
  }

  get strings(): HudStrings {
    return this._strings;
  }
  /** Reword any of it: `{ phases: { close: 'Nearly' }, stop: 'End' }`; `connection` rewords the link states. */
  set strings(value: Parameters<typeof hudStrings>[0] & { connection?: Partial<Record<HudConnection, string>> }) {
    const { connection, ...rest } = value ?? {};
    this._strings = hudStrings(rest);
    this._connectionStrings = { ...CONNECTION_STRINGS, ...(connection ?? {}) };
    this.build();
  }

  get connection(): HudConnection | null {
    return this._connection;
  }
  /** The link's state, for a HUD fed by your own subscription (connect() sets it itself). */
  set connection(value: HudConnection | null) {
    if (this._connection === value) return;
    this._connection = value;
    this.schedule();
  }

  connectedCallback(): void {
    if (!this.root) this.root = this.attachShadow({ mode: 'open' });
    this.build();
    this.ticker = setInterval(() => this.schedule(), 1000);
  }

  disconnectedCallback(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
    if (this.frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.frame);
    this.frame = null;
  }

  attributeChangedCallback(): void {
    if (this.root) this.build();
  }

  /** Show one event; `receivedAt` is when it arrived (ms), by default now. */
  feed(event: SessionEvent, receivedAt: number = Date.now()): void {
    this._state = hudReducer(this._state, event, receivedAt);
    this.schedule();
  }

  /** Forget the session shown. */
  reset(): void {
    this._state = initialHudState();
    this.lastPhase = null;
    this.schedule();
  }

  /** Read a session's events into the HUD, and its link state into `connection`. */
  connect(source: StreamSource & Omit<Partial<SubscribeOptions>, 'streamUrl' | 'token'>): Subscription {
    this.disconnect();
    this.connection = 'connecting';
    const onState = source.onState;
    this.subscription = subscribe({
      ...source,
      onEvent: (event) => {
        this.feed(event);
        source.onEvent?.(event);
      },
      onState: (state: SubscriptionState, detail) => {
        const map: Partial<Record<SubscriptionState, HudConnection>> = { connecting: this._state.sessionId ? 'reconnecting' : 'connecting', open: 'live', reconnecting: 'reconnecting', ended: 'ended', refused: 'refused' };
        if (state === 'closed') this.connection = null;
        else if (map[state]) this.connection = map[state]!;
        onState?.(state, detail);
      },
    });
    return this.subscription;
  }

  disconnect(): void {
    this.subscription?.close();
    this.subscription = null;
    this.stopDemo?.();
    this.stopDemo = null;
  }

  /** Play a scripted session (no network, no camera); returns a function that stops it. */
  demo(options: DemoOptions = {}): () => void {
    this.disconnect();
    this.reset();
    this.connection = 'live';
    const stop = playDemo((event) => this.feed(event), options);
    this.stopDemo = stop;
    return () => {
      stop();
      if (this.stopDemo === stop) this.stopDemo = null;
    };
  }

  private schedule(): void {
    if (!this.root || this.frame !== null) return;
    if (typeof requestAnimationFrame === 'function') {
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.paint();
      });
    } else {
      this.paint();
    }
  }

  private build(): void {
    if (!this.root) return;
    const s = this._strings;
    const parts = this.parts;
    const stream = this.stream;
    const brand = this.getAttribute('brand') !== 'off';

    const on = stream ? null : h('span', { class: 'on', part: 'indicator' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', {}, s.analysisOff));
    const stop = stream ? null : h('button', { class: 'stop', part: 'stop', type: 'button' }, s.stop);
    stop?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('orgasm-hud-stop', { bubbles: true, composed: true, cancelable: true }));
    });
    const brandMark = brand ? h('span', { class: 'brand', 'aria-hidden': 'true' }, 'orgasm', h('b', {}, '.'), 'dev') : null;
    const word = h('span', { class: 'word', part: 'phase' });
    const detail = h('span', { class: 'detail' });
    const fill = h('div', { class: 'fill' });
    const ghost = h('div', { class: 'ghost' });
    const track = h('div', { class: 'track' }, fill, ...[0.3, 0.6, 0.75].map((level) => h('i', { class: 'tick', style: `left:${level * 100}%` })));
    const meter = h('div', { class: 'meter', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': s.meterLabel, part: 'gauge' }, track, ghost);

    let area: SVGPathElement | null = null;
    let p60: SVGPathElement | null = null;
    let marks: SVGGElement | null = null;
    let trend: SVGSVGElement | null = null;
    if (parts.has('trend')) {
      area = svg('path', { class: 'area' });
      p60 = svg('path', { class: 'p60' });
      marks = svg('g', {});
      const levels = [0.3, 0.6].map((level) => svg('line', { class: 'level', x1: 0, x2: 300, y1: (64 - level * 64).toFixed(1), y2: (64 - level * 64).toFixed(1) }));
      trend = svg('svg', { class: 'trend', viewBox: '0 0 300 64', preserveAspectRatio: 'none', 'aria-hidden': 'true', part: 'trend' }, ...levels, area, p60, marks);
    }

    let counts: Refs['counts'] = null;
    let countsEl: HTMLElement | null = null;
    let clockOnly: HTMLElement | null = null;
    const clockDd = parts.has('clock') ? h('dd', {}) : null;
    if (parts.has('counts')) {
      const orgasms = h('dd', {});
      const ruins = h('dd', {});
      const edges = h('dd', {});
      const ruinsRow = h('div', { hidden: true }, h('dt', {}, s.ruins), ruins);
      countsEl = h(
        'dl',
        { class: 'counts', part: 'counts' },
        h('div', {}, h('dt', {}, s.orgasms), orgasms),
        ruinsRow,
        h('div', {}, h('dt', {}, s.edges), edges),
        clockDd ? h('div', {}, h('dt', {}, s.session), clockDd) : null,
      );
      counts = { orgasms, ruins, ruinsRow, edges, clock: clockDd };
    } else if (clockDd) {
      clockOnly = clockDd;
      countsEl = h('dl', { class: 'counts', part: 'counts' }, h('div', {}, h('dt', {}, s.session), clockDd));
    }
    const tiles = parts.has('signals') ? h('div', { class: 'tiles', part: 'signals' }) : null;
    const regions = parts.has('signals') ? h('div', { class: 'regions', hidden: true }) : null;
    const subject = parts.has('subject') ? h('p', { class: 'subject' }) : null;
    const notices = parts.has('notices') ? h('ul', { class: 'notices' }) : null;
    const quiet = h('p', { class: 'quiet', hidden: true });
    const announce = h('span', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });

    const layout = this.layout;
    const phase = h('div', { class: 'phase' }, word, parts.has('percent') || layout !== 'overlay' ? detail : null);
    const top = on || brandMark || stop ? h('div', { class: 'top' }, on, brandMark, layout === 'bar' ? null : stop) : null;
    const children: (Node | null)[] =
      layout === 'bar'
        ? [top, phase, parts.has('gauge') ? meter : null, h('div', { class: 'stop-slot' }, countsEl, stop), tiles, notices, subject, quiet, announce]
        : [top, phase, parts.has('gauge') ? meter : null, trend, countsEl, tiles, regions, subject, notices, quiet, announce];
    const root = h('section', { class: 'hud', part: 'hud', 'data-layout': layout, 'data-stream': stream, role: 'group', 'aria-label': this.getAttribute('label') || 'Live readings' }, ...children);
    this.root.replaceChildren(h('style', {}, CSS), root);
    this.refs = { root, on, onText: on?.lastElementChild as HTMLElement | null, stop, word, detail, meter, fill, ghost, area, p60, marks, counts, clockOnly, tiles, regions, subject, notices, quiet, announce };
    this.lastPhase = null;
    this.paint();
  }

  private paint(): void {
    const r = this.refs;
    if (!r) return;
    const view = hudView(this._state, Date.now(), this._strings);
    const s = this._strings;
    const parts = this.parts;
    const hasSession = this._state.sessionId !== null;
    const quietWords = this._connection && (!hasSession || this._connection === 'replaced' || this._connection === 'refused') ? this._connectionStrings[this._connection] : '';

    setAttr(r.root, 'data-phase', view.phase);
    setAttr(r.root, 'data-analysing', view.analysing ? '' : null);
    setAttr(r.root, 'data-stale', view.stale ? '' : null);
    if (r.onText) setText(r.onText, view.analysing ? s.analysisOn : s.analysisOff);

    setText(r.word, view.word);
    // Without `percent` the gauge carries the chance, and the line under the word only words.
    const percentLine = view.gauge.percent !== null && view.detail.includes(`${view.gauge.percent}%`);
    setText(r.detail, !hasSession && quietWords ? quietWords : !parts.has('percent') && percentLine ? '' : view.detail);

    const known = view.gauge.p30 !== null;
    setAttr(r.meter, 'data-known', known ? '' : null);
    setAttr(r.meter, 'aria-valuenow', known ? String(view.gauge.percent) : null);
    setAttr(r.meter, 'aria-valuetext', view.gauge.valueText);
    r.fill.style.width = `${known ? Math.round((view.gauge.p30 as number) * 1000) / 10 : 0}%`;
    r.ghost.style.left = `calc(${known && view.gauge.p60 !== null ? Math.round(view.gauge.p60 * 1000) / 10 : 0}% - 1px)`;

    if (r.area && r.p60 && r.marks) {
      const pts = view.trend.points;
      r.area.setAttribute('d', pathOf(pts.map((p) => ({ x: p.x, y: p.p30 })), 300, 64, true));
      r.p60.setAttribute('d', pathOf(pts.map((p) => ({ x: p.x, y: p.p60 })), 300, 64, false));
      const key = view.trend.marks.map((m) => `${m.id}@${m.x.toFixed(3)}`).join('|');
      if (r.marks.dataset.key !== key) {
        r.marks.dataset.key = key;
        r.marks.replaceChildren(...view.trend.marks.map((m) => svg('line', { class: `mark ${m.kind}${m.ruined ? ' ruined' : ''}`, x1: (m.x * 300).toFixed(1), x2: (m.x * 300).toFixed(1), y1: 0, y2: 64 })));
      }
    }

    if (r.counts) {
      setText(r.counts.orgasms, String(view.counts.orgasms));
      setText(r.counts.ruins, String(view.counts.ruins));
      r.counts.ruinsRow.hidden = view.counts.ruins === 0;
      setText(r.counts.edges, String(view.counts.edges));
      if (r.counts.clock) setText(r.counts.clock, view.clock.text);
    } else if (r.clockOnly) setText(r.clockOnly, view.clock.text);

    if (r.tiles) {
      const tiles = view.signals?.tiles ?? [];
      const key = tiles.map((t) => `${t.key}:${t.value}:${t.detail}`).join('|');
      if (r.tiles.dataset.key !== key) {
        r.tiles.dataset.key = key;
        r.tiles.hidden = tiles.length === 0;
        r.tiles.replaceChildren(
          ...tiles.map((t) =>
            h('div', { class: 'tile', role: 'group', 'aria-label': `${t.label}: ${t.value}${t.unit ? ` ${t.unit}` : ''}` }, h('div', { class: 'label' }, t.label), h('div', { class: 'value' }, t.value, t.unit ? h('span', { class: 'unit' }, t.unit) : null), t.detail ? h('div', { class: 'sub' }, t.detail) : null),
          ),
        );
      }
    }
    if (r.regions) {
      const regions = view.signals?.faceRegions ?? null;
      r.regions.hidden = regions === null;
      if (regions) {
        if (r.regions.childElementCount !== regions.length) {
          r.regions.replaceChildren(...regions.map((g) => h('div', { class: 'region', role: 'meter', 'aria-label': g.label, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: 'bar' }, h('i', {})), h('span', {}, g.label))));
        }
        regions.forEach((g, i) => {
          const el = r.regions!.children[i] as HTMLElement;
          setAttr(el, 'aria-valuenow', String(Math.round(g.level * 100)));
          (el.querySelector('i') as HTMLElement).style.width = `${Math.round(g.level * 100)}%`;
        });
      }
    }
    if (r.subject) {
      r.subject.hidden = !view.subject;
      setText(r.subject, view.subject?.text ?? '');
    }
    if (r.notices) {
      const notices = [...view.notices.map((n) => n.text), ...(this._connection === 'reconnecting' || (this._connection === 'unreachable' && hasSession) ? [this._connectionStrings[this._connection]] : [])];
      const key = notices.join('|');
      if (r.notices.dataset.key !== key) {
        r.notices.dataset.key = key;
        r.notices.hidden = notices.length === 0;
        r.notices.replaceChildren(...notices.map((text) => h('li', {}, text)));
      }
    }
    r.quiet.hidden = !(quietWords && hasSession);
    setText(r.quiet, quietWords && hasSession ? quietWords : '');

    if (view.phase !== this.lastPhase) {
      const previous = this.lastPhase;
      this.lastPhase = view.phase;
      setText(r.announce, `${view.word}. ${view.detail}`);
      if (previous !== null) this.dispatchEvent(new CustomEvent('orgasm-hud-phase', { bubbles: true, composed: true, detail: { phase: view.phase, previous, view } }));
    }
  }
}

export function defineHud(): void {
  define('orgasm-hud', OrgasmHud);
}

declare global {
  interface HTMLElementTagNameMap {
    'orgasm-hud': OrgasmHud;
  }
}
