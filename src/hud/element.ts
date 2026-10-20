// <orgasm-hud>: a live session's readings as a heads-up display, in five
// shapes: `rail` (a side panel), `bar` (a strip across the page), `card` (a
// corner of a game), `overlay` (a panel for a stream) and `panel` (the whole
// display: the phase, the gauge and the stimulation strip over three pages,
// Signals, Face and Timeline). It draws hudView (model.ts) and nothing else.
//
//   <orgasm-hud layout="panel"></orgasm-hud>
//   hud.connect({ streamUrl, token });            // or hud.feed(event) yourself
//   hud.addEventListener('orgasm-hud-stop', () => live.stop({ releaseCamera: true }));
//
// On the person's device it always shows that analysis is on and a Stop
// control, as the consent rules require; only `stream` (and the `overlay`
// layout, which implies it), drawn into a video for others to watch, leaves
// them out. Theme it with CSS custom properties (--orgasm-hud-accent and
// the rest, dom.ts), and reword it with `strings`.
//
// The `face` part draws a generic face (no one's: the Momentum Human Rig's
// mean head) moved by the person's face channels, from a chunk loaded the
// first time it draws. The stimulation strip and the timeline's level lane
// show what your product reports (`reportStimulation`); the HUD never sets
// anything on a device.

import { subscribe, type StreamSource, type SubscribeOptions, type Subscription, type SubscriptionState } from '../subscribe.ts';
import type { FaceChannels, FaceFrame, SessionEvent } from '../events.ts';
import {
  HUD_STRINGS,
  hudFrameReducer,
  hudReducer,
  hudStrings,
  hudView,
  initialHudState,
  type HudLanePoint,
  type HudPhase,
  type HudState,
  type HudStrings,
  type HudTimelineView,
  type HudView,
} from './model.ts';
import { playDemo, type DemoOptions } from './demo.ts';
import { drawFace, faceAt, gliding, glideTo, loadFaceMesh, rgbOf, type FaceGlide, type FaceMesh, type FacePalette } from './face.ts';
import { ElementBase, THEME_CSS, define, h, setAttr, setText, svg } from './dom.ts';

export type HudLayout = 'rail' | 'bar' | 'card' | 'overlay' | 'panel';
export type HudPart = 'phase' | 'gauge' | 'percent' | 'trend' | 'counts' | 'clock' | 'signals' | 'notices' | 'subject' | 'stimulation' | 'face' | 'timeline';
export type HudPage = 'signals' | 'face' | 'timeline';
export type HudConnection = 'connecting' | 'waiting' | 'live' | 'reconnecting' | 'ended' | 'replaced' | 'refused' | 'unreachable';

export const HUD_LAYOUTS: readonly HudLayout[] = Object.freeze(['rail', 'bar', 'card', 'overlay', 'panel']);
export const HUD_PARTS: readonly HudPart[] = Object.freeze(['phase', 'gauge', 'percent', 'trend', 'counts', 'clock', 'signals', 'notices', 'subject', 'stimulation', 'face', 'timeline']);
export const HUD_PAGES: readonly HudPage[] = Object.freeze(['signals', 'face', 'timeline']);

/** What each layout shows unless `show` says otherwise. The subject read is never on by default; the strip shows only once your product reports. */
export const DEFAULT_PARTS: Readonly<Record<HudLayout, readonly HudPart[]>> = Object.freeze({
  rail: ['phase', 'gauge', 'percent', 'stimulation', 'trend', 'counts', 'clock', 'signals', 'notices'],
  bar: ['phase', 'gauge', 'percent', 'stimulation', 'counts', 'clock', 'notices'],
  card: ['phase', 'gauge', 'percent'],
  overlay: ['phase', 'gauge', 'percent', 'stimulation', 'trend', 'counts', 'clock'],
  panel: ['phase', 'gauge', 'percent', 'stimulation', 'counts', 'clock', 'signals', 'notices', 'face', 'timeline'],
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

/** The timeline's lanes, top to bottom, and their shares of its height when all three draw. */
const LANE_WEIGHTS = { imminence: 0.32, stimulation: 0.28, body: 0.32 } as const;
type LaneKey = keyof typeof LANE_WEIGHTS;
const LANE_GAP = 4;
/** The strip's and the level lane's colours, one per output. */
const OUTPUT_COLOURS = ['var(--hud-on)', 'var(--hud-ghost)', 'var(--hud-accent)', 'var(--hud-muted)'];

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
.trend .area, .timeline .area { fill: color-mix(in srgb, var(--hud-accent) 22%, transparent); stroke: var(--hud-accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.trend .p60, .timeline .p60 { fill: none; stroke: var(--hud-ghost); stroke-width: 1.2; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; opacity: 0.8; }
.trend .mark, .timeline .mark { stroke: var(--hud-accent); stroke-width: 1.2; vector-effect: non-scaling-stroke; }
.trend .mark.edge, .timeline .mark.edge { stroke: var(--hud-ghost); }
.trend .mark.ruined, .timeline .mark.ruined { stroke: var(--hud-warn); }
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

/* the stimulation strip: the device, its state, a bar per output */
.strip { display: grid; gap: 0.35em; min-width: 0; }
.strip .row { display: flex; align-items: baseline; gap: 0.55em; min-width: 0; }
.strip .name { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hud-muted); white-space: nowrap; flex: none; }
.strip .state { font-size: 0.9em; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.strip[data-tone="neutral"] .state { color: var(--hud-muted); }
.strip[data-tone="warn"] .state { color: var(--hud-warn); }
.strip .outputs { display: grid; gap: 0.25em; }
.strip .output { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: center; gap: 0.5em; font-size: 0.75em; color: var(--hud-muted); font-family: var(--hud-mono); font-variant-numeric: tabular-nums; }
.strip .output .rail { height: 0.45em; border-radius: 999px; background: var(--hud-track); overflow: hidden; }
.strip .output i { display: block; height: 100%; width: 0; border-radius: 999px; transition: width 0.25s linear; }

/* the face: the generic face moved by the person's channels, and the regions' meters */
.face { display: grid; grid-template-columns: minmax(0, 1fr) minmax(6.5em, 1fr); gap: 0.9em; align-items: center; }
.face .stage { position: relative; aspect-ratio: 1000 / 1140; max-height: 22em; width: 100%; margin: 0 auto; }
@container (max-width: 520px) { .face .stage { max-height: 13em; } .face .meters { gap: 0.3em; } }
.face canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.face .stage[data-dim] canvas { opacity: 0.35; }
.face .away { position: absolute; inset: auto 0 45% 0; text-align: center; font-size: 0.85em; color: var(--hud-muted); }
.face .meters { display: grid; gap: 0.4em; }
.face .meters .region { display: grid; grid-template-columns: 4.6em minmax(0, 1fr); align-items: center; gap: 0.5em; }
.face .meters .region span { margin: 0; font-size: 0.75em; }
.face .meters .region .bar { height: 0.4em; }
@container (max-width: 260px) { .face { grid-template-columns: minmax(0, 1fr); } }

/* the timeline: the whole session in three lanes on one time axis */
.timeline { position: relative; height: 11em; }
.timeline .plot { position: absolute; inset: 0 0 1.3em 0; }
.timeline svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.timeline .lane-line { stroke: var(--hud-line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.timeline .out { fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.timeline .vocal { fill: none; stroke: var(--hud-ghost); stroke-width: 1.3; vector-effect: non-scaling-stroke; }
.timeline .contractions { fill: none; stroke: var(--hud-accent); stroke-width: 1.3; vector-effect: non-scaling-stroke; opacity: 0.85; }
.timeline .mode { stroke: var(--hud-ghost); stroke-width: 1; stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; opacity: 0.7; }
.timeline .labels, .timeline .ticks { position: absolute; inset: 0; pointer-events: none; }
.timeline .ticks { inset: auto 0 0 0; height: 1.2em; }
.timeline .lane-title { position: absolute; left: 0; font-size: 0.66em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--hud-muted); }
.timeline .mode-label { position: absolute; font-size: 0.66em; color: var(--hud-ghost); white-space: nowrap; transform: translateX(3px); }
.timeline .ticks span { position: absolute; transform: translateX(-50%); font-size: 0.66em; color: var(--hud-muted); font-family: var(--hud-mono); }
.timeline .empty { position: absolute; inset: 0; display: grid; place-items: center; font-size: 0.85em; color: var(--hud-muted); }

/* bar: one strip, wrapping on a narrow page */
.hud[data-layout="bar"] { grid-template-columns: auto minmax(8em, 1fr) minmax(8em, 2fr) auto; align-items: center; gap: 0.6em 1.2em; padding: 0.7em 1em; }
.hud[data-layout="bar"] .top { order: 0; }
.hud[data-layout="bar"] .top .brand { display: none; }
.hud[data-layout="bar"] .phase { flex-direction: column; gap: 0.1em; }
.hud[data-layout="bar"] .word { font-size: 1.2em; }
.hud[data-layout="bar"] .counts { gap: 1em; }
.hud[data-layout="bar"] .notices, .hud[data-layout="bar"] .trend, .hud[data-layout="bar"] .regions, .hud[data-layout="bar"] .strip,
.hud[data-layout="bar"] .face, .hud[data-layout="bar"] .timeline, .hud[data-layout="bar"] .tiles { grid-column: 1 / -1; }
.hud[data-layout="bar"] .trend { height: 3em; }
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
.hud[data-layout="overlay"] .trend, .hud[data-layout="overlay"] .counts, .hud[data-layout="overlay"] .tiles, .hud[data-layout="overlay"] .regions,
.hud[data-layout="overlay"] .strip, .hud[data-layout="overlay"] .face, .hud[data-layout="overlay"] .timeline { grid-column: 1 / -1; }
.hud[data-layout="overlay"] .trend { height: 3.6em; }
.hud[data-stream][data-layout="bar"], .hud[data-stream][data-layout="card"] { font-size: calc(16px * var(--hud-scale)); }
@container (max-width: 560px) {
  .hud[data-layout="overlay"] { grid-template-columns: minmax(0, 1fr); }
}

/* panel: the head over three pages; wide, the head beside them, a band along the bottom of a scene */
.hud[data-layout="panel"] .head { display: grid; gap: 0.6em; align-content: start; }
@container (min-width: 760px) {
  .hud[data-layout="panel"] { grid-template-columns: minmax(15em, 0.42fr) minmax(0, 1fr); grid-template-rows: auto auto 1fr; column-gap: 1.4em; }
  .hud[data-layout="panel"] > .top { grid-column: 1 / -1; }
  .hud[data-layout="panel"] > .head { grid-column: 1; grid-row: 2 / 4; }
  .hud[data-layout="panel"] > .tabs { grid-column: 2; grid-row: 2; }
  .hud[data-layout="panel"] > .pages { grid-column: 2; grid-row: 3; }
  .hud[data-layout="panel"] .face .stage { max-height: 12em; }
  .hud[data-layout="panel"] .face { grid-template-columns: minmax(0, 0.8fr) minmax(8em, 1.2fr); }
  .hud[data-layout="panel"] .timeline { height: 9.5em; }
}
.tabs { display: flex; gap: 0.3em; border-bottom: 1px solid var(--hud-line); }
.tabs button { border: 0; background: none; padding: 0.45em 0.8em; margin-bottom: -1px; font-size: 0.85em; font-weight: 600; color: var(--hud-muted); border-bottom: 2px solid transparent; cursor: pointer; }
.tabs button[aria-selected="true"] { color: var(--hud-text); border-bottom-color: var(--hud-accent); }
.pages { display: grid; touch-action: pan-y; }
.page { display: grid; gap: 0.75em; align-content: start; min-width: 0; }
.hud[data-stream][data-layout="panel"] .pages { grid-template-columns: repeat(auto-fit, minmax(17em, 1fr)); gap: 1.2em; }
`;

interface StripRefs {
  root: HTMLElement;
  name: HTMLElement;
  state: HTMLElement;
  outputs: HTMLElement;
}

interface FaceRefs {
  root: HTMLElement;
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  away: HTMLElement;
  meters: HTMLElement;
}

interface TimelineRefs {
  root: HTMLElement;
  svg: SVGSVGElement;
  labels: HTMLElement;
  ticks: HTMLElement;
  empty: HTMLElement;
}

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
  strip: StripRefs | null;
  face: FaceRefs | null;
  timeline: TimelineRefs | null;
  tabs: Map<HudPage, HTMLButtonElement> | null;
  pages: Map<HudPage, HTMLElement> | null;
}

const parseParts = (raw: string | null, layout: HudLayout): Set<HudPart> => {
  if (!raw) return new Set(DEFAULT_PARTS[layout]);
  const parts = raw.split(/[\s,]+/).filter((p): p is HudPart => (HUD_PARTS as readonly string[]).includes(p));
  return new Set(parts);
};

/** A path through the points, broken where a value is missing; y runs 0 (bottom) to 1. */
function pathOf(points: { x: number; y: number | null }[], width: number, height: number, area: boolean, top = 0): string {
  let d = '';
  let run: { x: number; y: number }[] = [];
  const bottom = top + height;
  const flush = () => {
    if (run.length < 2) {
      run = [];
      return;
    }
    const line = run.map((p, i) => `${i ? 'L' : 'M'}${(p.x * width).toFixed(1)},${(bottom - p.y * height).toFixed(1)}`).join('');
    d += area ? `${line}L${(run[run.length - 1].x * width).toFixed(1)},${bottom}L${(run[0].x * width).toFixed(1)},${bottom}Z` : line;
    run = [];
  };
  for (const p of points) {
    if (p.y === null) flush();
    else run.push({ x: p.x, y: Math.max(0, Math.min(1, p.y)) });
  }
  flush();
  return d;
}

/** A level as steps: flat across each bin, straight up or down between them; broken where a value is missing. */
function stepsOf(points: HudLanePoint[], width: number, height: number, top: number): string {
  let d = '';
  let previous: { x: number; y: number } | null = null;
  const bottom = top + height;
  for (const p of points) {
    if (p.y === null) {
      previous = null;
      continue;
    }
    const x = (p.x * width).toFixed(1);
    const y = (bottom - Math.max(0, Math.min(1, p.y)) * height).toFixed(1);
    d += previous ? `H${x}V${y}` : `M${x},${y}`;
    previous = { x: p.x, y: p.y };
  }
  return d;
}

/** Each drawn lane's top and height, in the timeline's 0–100 units, sharing the height between the lanes that have something to draw. */
function laneBoxes(view: HudTimelineView): Partial<Record<LaneKey, { top: number; height: number }>> {
  const drawn = (Object.keys(LANE_WEIGHTS) as LaneKey[]).filter((lane) => view[lane] !== null);
  const total = drawn.reduce((sum, lane) => sum + LANE_WEIGHTS[lane], 0);
  const room = 100 - LANE_GAP * Math.max(0, drawn.length - 1);
  const boxes: Partial<Record<LaneKey, { top: number; height: number }>> = {};
  let top = 0;
  for (const lane of drawn) {
    const height = (room * LANE_WEIGHTS[lane]) / total;
    boxes[lane] = { top, height };
    top += height + LANE_GAP;
  }
  return boxes;
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export class OrgasmHud extends ElementBase {
  static observedAttributes = ['layout', 'theme', 'size', 'brand', 'show', 'stream', 'label', 'page'];

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
  private _page: HudPage | null = null;
  private mesh: FaceMesh | null = null;
  private meshLoading = false;
  private glide: FaceGlide | null = null;
  private faceTarget: FaceChannels | null = null;
  private faceFrame: number | null = null;
  private palette: FacePalette | null = null;
  private poseBuffer: Float32Array | null = null;
  private facingBuffer: Float32Array | null = null;

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

  /** The panel's pages that its parts give it, in order. */
  get pages(): HudPage[] {
    const parts = this.parts;
    return HUD_PAGES.filter((page) => (page === 'signals' ? parts.has('signals') || parts.has('counts') || parts.has('notices') || parts.has('clock') : parts.has(page)));
  }

  /** The panel's page on show (`page` attribute, or the first). */
  get page(): HudPage {
    const pages = this.pages;
    const asked = this._page ?? (this.getAttribute('page') as HudPage | null);
    return asked && pages.includes(asked) ? asked : (pages[0] ?? 'signals');
  }
  set page(value: HudPage) {
    this._page = value;
    this.showPage();
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
    if (typeof cancelAnimationFrame === 'function') {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      if (this.faceFrame !== null) cancelAnimationFrame(this.faceFrame);
    }
    this.frame = null;
    this.faceFrame = null;
  }

  attributeChangedCallback(name: string): void {
    if (!this.root) return;
    if (name === 'page') this.showPage();
    else this.build();
  }

  /** Show one event; `receivedAt` is when it arrived (ms), by default now. */
  feed(event: SessionEvent, receivedAt: number = Date.now()): void {
    this._state = hudReducer(this._state, event, receivedAt);
    this.schedule();
  }

  /** Show a face frame (`frames: ['face']` on your own subscription). */
  feedFrame(frame: FaceFrame, receivedAt: number = Date.now()): void {
    this._state = hudFrameReducer(this._state, frame, receivedAt);
    this.schedule();
  }

  /** Forget the session shown. */
  reset(): void {
    this._state = initialHudState();
    this.lastPhase = null;
    this.glide = null;
    this.faceTarget = null;
    this.schedule();
  }

  /** Read a session's events into the HUD, and its link state into `connection`; face frames too when it shows the face. */
  connect(source: StreamSource & Omit<Partial<SubscribeOptions>, 'streamUrl' | 'token'>): Subscription {
    this.disconnect();
    this.connection = 'connecting';
    const onState = source.onState;
    this.subscription = subscribe({
      ...source,
      frames: source.frames ?? (this.parts.has('face') ? ['face'] : undefined),
      onEvent: (event) => {
        this.feed(event);
        source.onEvent?.(event);
      },
      onFaceFrame: (frame) => {
        this.feedFrame(frame);
        source.onFaceFrame?.(frame);
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
    const stop = playDemo((event) => this.feed(event), { ...options, onFaceFrame: (frame) => this.feedFrame(frame) });
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

  private buildStrip(): StripRefs {
    const name = h('span', { class: 'name' });
    const state = h('span', { class: 'state' });
    const outputs = h('div', { class: 'outputs' });
    const root = h('div', { class: 'strip', part: 'stimulation', role: 'group', hidden: true }, h('div', { class: 'row' }, name, state), outputs);
    return { root, name, state, outputs };
  }

  private buildFace(): FaceRefs {
    const canvas = h('canvas', { 'aria-hidden': 'true' });
    const away = h('p', { class: 'away', hidden: true });
    const stage = h('div', { class: 'stage' }, canvas, away);
    const meters = h('div', { class: 'meters' });
    const root = h('div', { class: 'face', part: 'face', role: 'group', 'aria-label': this._strings.pages.face, hidden: true }, stage, meters);
    return { root, stage, canvas, away, meters };
  }

  private buildTimeline(): TimelineRefs {
    const plot = svg('svg', { viewBox: '0 0 300 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
    const labels = h('div', { class: 'labels' });
    const ticks = h('div', { class: 'ticks' });
    const empty = h('p', { class: 'empty' }, this._strings.timelineEmpty);
    const root = h('div', { class: 'timeline', part: 'timeline', role: 'img', 'aria-label': this._strings.pages.timeline }, h('div', { class: 'plot' }, plot, labels), ticks, empty);
    return { root, svg: plot as SVGSVGElement, labels, ticks, empty };
  }

  private build(): void {
    if (!this.root) return;
    const s = this._strings;
    const parts = this.parts;
    const stream = this.stream;
    const brand = this.getAttribute('brand') !== 'off';
    const layout = this.layout;

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
    // The face part's meters stand beside the face; without it the signals carry them.
    const regions = parts.has('signals') && !(layout === 'panel' && parts.has('face')) ? h('div', { class: 'regions', hidden: true }) : null;
    const subject = parts.has('subject') ? h('p', { class: 'subject' }) : null;
    const notices = parts.has('notices') ? h('ul', { class: 'notices' }) : null;
    const quiet = h('p', { class: 'quiet', hidden: true });
    const announce = h('span', { class: 'sr-only', 'aria-live': 'polite', 'aria-atomic': 'true' });
    const strip = parts.has('stimulation') ? this.buildStrip() : null;
    const face = parts.has('face') ? this.buildFace() : null;
    const timeline = parts.has('timeline') ? this.buildTimeline() : null;

    const phase = h('div', { class: 'phase' }, word, parts.has('percent') || layout !== 'overlay' ? detail : null);
    const top = on || brandMark || stop ? h('div', { class: 'top' }, on, brandMark, layout === 'bar' ? null : stop) : null;
    const gauge = parts.has('gauge') ? meter : null;
    let tabs: Refs['tabs'] = null;
    let pages: Refs['pages'] = null;
    let children: (Node | null)[];
    if (layout === 'bar') {
      children = [top, phase, gauge, h('div', { class: 'stop-slot' }, countsEl, stop), strip?.root ?? null, trend, tiles, regions, face?.root ?? null, timeline?.root ?? null, notices, subject, quiet, announce];
    } else if (layout === 'panel') {
      pages = new Map();
      const content: Record<HudPage, (Node | null)[]> = {
        signals: [countsEl, tiles, regions, trend, subject, notices],
        face: [face?.root ?? null],
        timeline: [timeline?.root ?? null],
      };
      for (const page of this.pages) pages.set(page, h('div', { class: 'page', 'data-page': page, role: stream ? null : 'tabpanel', 'aria-label': s.pages[page] }, ...content[page]));
      if (!stream && pages.size > 1) {
        tabs = new Map();
        for (const page of pages.keys()) {
          const tab = h('button', { type: 'button', role: 'tab', 'data-page': page }, s.pages[page]);
          tab.addEventListener('click', () => {
            this.page = page;
          });
          tabs.set(page, tab);
        }
      }
      const pagesEl = h('div', { class: 'pages' }, ...pages.values());
      if (!stream) this.swipe(pagesEl);
      children = [
        top,
        h('div', { class: 'head' }, phase, gauge, strip?.root ?? null),
        tabs ? h('div', { class: 'tabs', role: 'tablist' }, ...tabs.values()) : null,
        pagesEl,
        quiet,
        announce,
      ];
    } else {
      children = [top, phase, gauge, strip?.root ?? null, trend, timeline?.root ?? null, countsEl, tiles, regions, face?.root ?? null, subject, notices, quiet, announce];
    }
    const root = h('section', { class: 'hud', part: 'hud', 'data-layout': layout, 'data-stream': stream, role: 'group', 'aria-label': this.getAttribute('label') || 'Live readings' }, ...children);
    this.root.replaceChildren(h('style', {}, CSS), root);
    this.refs = { root, on, onText: on?.lastElementChild as HTMLElement | null, stop, word, detail, meter, fill, ghost, area, p60, marks, counts, clockOnly, tiles, regions, subject, notices, quiet, announce, strip, face, timeline, tabs, pages };
    this.lastPhase = null;
    this.palette = null;
    this.showPage();
    this.paint();
  }

  /** A sideways swipe across the pages turns them. */
  private swipe(el: HTMLElement): void {
    let start: { x: number; y: number } | null = null;
    el.addEventListener('pointerdown', (e) => {
      start = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener('pointerup', (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      start = null;
      if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      const pages = this.pages;
      const at = pages.indexOf(this.page);
      const next = pages[Math.max(0, Math.min(pages.length - 1, at + (dx < 0 ? 1 : -1)))];
      if (next && next !== this.page) this.page = next;
    });
  }

  private showPage(): void {
    const r = this.refs;
    if (!r?.pages) return;
    const page = this.page;
    // In a stream, with nothing to press, every page shows.
    for (const [name, el] of r.pages) el.hidden = !this.stream && name !== page;
    if (r.tabs) for (const [name, tab] of r.tabs) setAttr(tab, 'aria-selected', name === page ? 'true' : 'false');
    if (page === 'face') this.drawFaceNow();
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
    if (r.regions) this.paintRegions(r.regions, view.signals?.faceRegions ?? null);
    if (r.strip) this.paintStrip(r.strip, view);
    if (r.face) this.paintFace(r.face, view);
    if (r.timeline) this.paintTimeline(r.timeline, view);
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

  private paintRegions(el: HTMLElement, regions: { label: string; level: number }[] | null): void {
    el.hidden = regions === null;
    if (!regions) return;
    if (el.childElementCount !== regions.length) {
      el.replaceChildren(...regions.map((g) => h('div', { class: 'region', role: 'meter', 'aria-label': g.label, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { class: 'bar' }, h('i', {})), h('span', {}, g.label))));
    }
    regions.forEach((g, i) => {
      const meter = el.children[i] as HTMLElement;
      setAttr(meter, 'aria-valuenow', String(Math.round(g.level * 100)));
      (meter.querySelector('i') as HTMLElement).style.width = `${Math.round(g.level * 100)}%`;
    });
  }

  private paintStrip(strip: StripRefs, view: HudView): void {
    const st = view.stimulation;
    strip.root.hidden = st === null;
    if (!st) return;
    setAttr(strip.root, 'data-tone', st.tone);
    setAttr(strip.root, 'aria-label', st.text);
    setText(strip.name, st.label);
    setText(strip.state, st.detail);
    const bars = st.bars ?? [];
    const key = bars.map((b) => `${b.id}:${b.label}`).join('|');
    if (strip.outputs.dataset.key !== key) {
      strip.outputs.dataset.key = key;
      strip.outputs.replaceChildren(
        ...bars.map((b, i) =>
          h('div', { class: 'output', role: 'meter', 'aria-valuemin': 0 }, h('span', {}, b.label), h('div', { class: 'rail' }, h('i', { style: `background:${OUTPUT_COLOURS[i % OUTPUT_COLOURS.length]}` })), h('span', { class: 'value' })),
        ),
      );
    }
    strip.outputs.hidden = bars.length === 0;
    bars.forEach((b, i) => {
      const row = strip.outputs.children[i] as HTMLElement;
      setAttr(row, 'aria-label', b.label || st.label);
      setAttr(row, 'aria-valuemax', String(b.max));
      setAttr(row, 'aria-valuenow', String(b.level));
      (row.querySelector('i') as HTMLElement).style.width = `${Math.round(b.fraction * 1000) / 10}%`;
      setText(row.querySelector('.value')!, b.max === 1 && b.id === 'level' && this._state.stimulation?.level === null ? `${Math.round(b.level * 100)}%` : `${b.level}/${b.max}`);
    });
  }

  private paintFace(face: FaceRefs, view: HudView): void {
    const fv = view.face;
    const inPanel = this.layout === 'panel';
    face.root.hidden = fv === null && !inPanel;
    face.away.hidden = Boolean(fv?.channels);
    setText(face.away, fv ? fv.detail : this._strings.faceWaiting);
    setAttr(face.stage, 'data-dim', fv?.channels ? null : '');
    this.paintRegions(face.meters, fv?.regions ?? null);
    const target = fv?.channels ?? null;
    if (target && target !== this.faceTarget) {
      this.faceTarget = target;
      this.glide = glideTo(this.glide, target, Date.now(), reducedMotion());
      this.drawFaceNow();
    } else if (!target && this.faceTarget) {
      this.faceTarget = null;
      this.drawFaceNow();
    }
  }

  /** Draws the face, and keeps drawing while it glides; loads the mesh the first time. */
  private drawFaceNow(): void {
    const face = this.refs?.face;
    if (!face || face.root.hidden || face.root.closest('[hidden]')) return;
    if (!this.mesh) {
      if (!this.meshLoading) {
        this.meshLoading = true;
        loadFaceMesh()
          .then((mesh) => {
            this.mesh = mesh;
            this.drawFaceNow();
          })
          .catch(() => {})
          .finally(() => {
            this.meshLoading = false;
          });
      }
      return;
    }
    const ctx = face.canvas.getContext?.('2d') ?? null;
    if (!ctx) return;
    const dpr = Math.min(3, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1);
    const width = face.canvas.clientWidth;
    const height = face.canvas.clientHeight;
    if (!width || !height) return;
    if (face.canvas.width !== Math.round(width * dpr) || face.canvas.height !== Math.round(height * dpr)) {
      face.canvas.width = Math.round(width * dpr);
      face.canvas.height = Math.round(height * dpr);
    }
    const now = Date.now();
    // Out of view, the last face stays, dimmed (the stage's data-dim), under the words.
    const channels = this.glide ? faceAt(this.glide, now) : null;
    if (!channels) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, face.canvas.width, face.canvas.height);
      return;
    }
    drawFace(ctx, this.mesh, channels, this.faceOptions(width, height, dpr));
    if (gliding(this.glide, now) && typeof requestAnimationFrame === 'function' && this.faceFrame === null) {
      this.faceFrame = requestAnimationFrame(() => {
        this.faceFrame = null;
        this.drawFaceNow();
      });
    }
  }

  private faceOptions(width: number, height: number, dpr: number) {
    const mesh = this.mesh!;
    if (!this.palette) {
      const style = getComputedStyle(this);
      const read = (name: string, fallback: readonly [number, number, number]) => rgbOf(style.getPropertyValue(name), fallback);
      this.palette = { wire: read('--hud-text', [244, 238, 242]), accent: read('--hud-accent', [250, 127, 140]), on: read('--hud-on', [125, 226, 195]), ghost: read('--hud-ghost', [245, 194, 107]) };
    }
    if (!this.poseBuffer || this.poseBuffer.length !== mesh.count * 2) this.poseBuffer = new Float32Array(mesh.count * 2);
    if (!this.facingBuffer || this.facingBuffer.length !== mesh.count) this.facingBuffer = new Float32Array(mesh.count);
    return { width, height, dpr, palette: this.palette, buffer: this.poseBuffer, facing: this.facingBuffer };
  }

  private paintTimeline(t: TimelineRefs, view: HudView): void {
    const tl = view.timeline;
    t.empty.hidden = tl !== null;
    if (!tl) {
      t.svg.replaceChildren();
      t.labels.replaceChildren();
      t.ticks.replaceChildren();
      return;
    }
    const boxes = laneBoxes(tl);
    const s = this._strings;
    const nodes: SVGElement[] = [];
    const labels: HTMLElement[] = [];
    for (const [lane, box] of Object.entries(boxes) as [LaneKey, { top: number; height: number }][]) {
      nodes.push(svg('line', { class: 'lane-line', x1: 0, x2: 300, y1: (box.top + box.height).toFixed(1), y2: (box.top + box.height).toFixed(1) }));
      labels.push(h('span', { class: 'lane-title', style: `top:${box.top}%` }, s.lanes[lane]));
    }
    const im = boxes.imminence;
    if (im && tl.imminence) {
      nodes.push(svg('path', { class: 'area', d: pathOf(tl.imminence.p30, 300, im.height, true, im.top) }));
      nodes.push(svg('path', { class: 'p60', d: pathOf(tl.imminence.p60, 300, im.height, false, im.top) }));
    }
    const st = boxes.stimulation;
    if (st && tl.stimulation) {
      tl.stimulation.channels.forEach((channel, i) => {
        nodes.push(svg('path', { class: 'out', style: `stroke:${OUTPUT_COLOURS[i % OUTPUT_COLOURS.length]}`, d: stepsOf(channel.points, 300, st.height, st.top) }));
      });
      tl.stimulation.modes.forEach((mode, i) => {
        const x = (mode.x * 300).toFixed(1);
        nodes.push(svg('line', { class: 'mode', x1: x, x2: x, y1: st.top.toFixed(1), y2: (st.top + st.height).toFixed(1) }));
        labels.push(h('span', { class: 'mode-label', style: `left:${(mode.x * 100).toFixed(2)}%;bottom:${(100 - st.top - st.height + 1 + (i % 2) * 9).toFixed(1)}%` }, mode.label));
      });
    }
    const body = boxes.body;
    if (body && tl.body) {
      if (tl.body.vocalizations) nodes.push(svg('path', { class: 'vocal', d: pathOf(tl.body.vocalizations, 300, body.height, false, body.top) }));
      if (tl.body.contractions) nodes.push(svg('path', { class: 'contractions', d: pathOf(tl.body.contractions, 300, body.height, false, body.top) }));
    }
    for (const m of tl.marks) {
      const x = (m.x * 300).toFixed(1);
      nodes.push(svg('line', { class: `mark ${m.kind}${m.ruined ? ' ruined' : ''}`, x1: x, x2: x, y1: 0, y2: 100 }));
    }
    t.svg.replaceChildren(...nodes);
    t.labels.replaceChildren(...labels);
    const tickKey = tl.ticks.map((k) => `${k.text}@${k.x.toFixed(3)}`).join('|');
    if (t.ticks.dataset.key !== tickKey) {
      t.ticks.dataset.key = tickKey;
      t.ticks.replaceChildren(...tl.ticks.map((k) => h('span', { style: `left:${(k.x * 100).toFixed(2)}%` }, k.text)));
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
