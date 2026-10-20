// The face part's drawing: a generic face (face-mesh.ts, the Momentum Human
// Rig's mean head, which is no one's) posed by a session's face channels and
// drawn as a wire on a canvas, each region lit as its channels rise. The
// mesh is a chunk of its own, loaded the first time a face is drawn, so a
// HUD without the face part never fetches it.
//
// Every point is its resting place plus each channel's displacement at the
// channel's value (0 to 1) times the channel's drawing gain; the head then
// turns about the neck by the reading's yaw, pitch and roll, and a point
// turned away from the viewer fades with its edges. Between readings the
// face glides from where it was drawn to the newest one over the time
// readings come apart, so a face read once a second moves slowly and one
// read five times a second follows the person.

import { FACE_EXPRESSION_CHANNELS, type FaceChannels, type FaceExpressionChannel } from '../events.ts';

export interface FaceMesh {
  count: number;
  headHeight: number;
  pivot: number[];
  points: number[];
  edges: number[];
  regions: string[];
  region: number[];
  weight: number[];
  normals: number[];
  gains: Record<string, number>;
  deltas: Record<string, { idx: number[]; d: number[] }>;
}

let meshPromise: Promise<FaceMesh> | null = null;

/** The mesh, loaded once per page; a failed load is not kept, so the next draw tries again. */
export function loadFaceMesh(): Promise<FaceMesh> {
  if (!meshPromise) {
    const attempt = import('./face-mesh.ts').then((module) => module.FACE_MESH);
    attempt.catch(() => {
      if (meshPromise === attempt) meshPromise = null;
    });
    meshPromise = attempt;
  }
  return meshPromise;
}

/** The box the head is fitted to, in the mesh's units (the head is 1000 tall), with a little air. */
export const FACE_BOX = Object.freeze({ width: 1000, height: 1140 });
/** The most the head is drawn turned, in degrees: the turns a neck makes, beyond which a reading is more likely wrong than the head. */
export const HEAD_LIMIT_DEG = Object.freeze({ yaw: 75, pitch: 60, roll: 45 });

const RAD = Math.PI / 180;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

type Matrix = [number, number, number, number, number, number, number, number, number];

const multiply = (a: Matrix, b: Matrix): Matrix => {
  const out = new Array<number>(9) as Matrix;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
  return out;
};

/**
 * The head's turn as one rotation, yaw first, then pitch, then roll, in the
 * mesh's frame (x right, y down, z toward the viewer): a positive yaw carries
 * the nose to the viewer's right, a positive pitch raises the chin, a
 * positive roll carries the crown to the viewer's right.
 */
export function headRotation(head: FaceChannels['head']): Matrix {
  const yaw = clamp(head.yawDeg, -HEAD_LIMIT_DEG.yaw, HEAD_LIMIT_DEG.yaw) * RAD;
  const pitch = clamp(head.pitchDeg, -HEAD_LIMIT_DEG.pitch, HEAD_LIMIT_DEG.pitch) * RAD;
  const roll = clamp(head.rollDeg, -HEAD_LIMIT_DEG.roll, HEAD_LIMIT_DEG.roll) * RAD;
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(yaw), Math.sin(yaw), Math.cos(pitch), Math.sin(pitch), Math.cos(roll), Math.sin(roll)];
  const ry: Matrix = [cy, 0, sy, 0, 1, 0, -sy, 0, cy];
  const rx: Matrix = [1, 0, 0, 0, cp, -sp, 0, sp, cp];
  const rz: Matrix = [cr, -sr, 0, sr, cr, 0, 0, 0, 1];
  return multiply(rz, multiply(rx, ry));
}

/**
 * Every point's place for `face`, x then y per point, into `out`; with
 * `facing`, each point's turned normal's depth too (1 facing the viewer, -1
 * facing away). The head is kept inside FACE_BOX: where its turned resting
 * face would leave the box it is shifted back, and drawn smaller only past
 * what a shift can do.
 */
export function poseFace(mesh: FaceMesh, face: FaceChannels, out: Float32Array = new Float32Array(mesh.count * 2), facing?: Float32Array): Float32Array {
  const n = mesh.count;
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const zs = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = mesh.points[3 * i];
    ys[i] = mesh.points[3 * i + 1];
    zs[i] = mesh.points[3 * i + 2];
  }
  for (const name of FACE_EXPRESSION_CHANNELS) {
    const value = face.expression[name];
    const delta = mesh.deltas[name];
    if (!value || !delta) continue;
    const w = clamp(value, 0, 1) * (mesh.gains[name] ?? 1);
    for (let k = 0; k < delta.idx.length; k++) {
      const i = delta.idx[k];
      xs[i] += w * delta.d[3 * k];
      ys[i] += w * delta.d[3 * k + 1];
      zs[i] += w * delta.d[3 * k + 2];
    }
  }

  const m = headRotation(face.head);
  const [px, py, pz] = mesh.pivot;
  const turnX = (x: number, y: number, z: number) => m[0] * (x - px) + m[1] * (y - py) + m[2] * (z - pz) + px;
  const turnY = (x: number, y: number, z: number) => m[3] * (x - px) + m[4] * (y - py) + m[5] * (z - pz) + py;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    out[2 * i] = turnX(xs[i], ys[i], zs[i]);
    out[2 * i + 1] = turnY(xs[i], ys[i], zs[i]);
    if (mesh.region[i] < 0) continue;
    // The resting face, turned: where the head is, whatever the face does.
    const rx = turnX(mesh.points[3 * i], mesh.points[3 * i + 1], mesh.points[3 * i + 2]);
    const ry = turnY(mesh.points[3 * i], mesh.points[3 * i + 1], mesh.points[3 * i + 2]);
    if (rx < minX) minX = rx;
    if (rx > maxX) maxX = rx;
    if (ry < minY) minY = ry;
    if (ry > maxY) maxY = ry;
  }
  if (facing) {
    for (let i = 0; i < n; i++) {
      facing[i] = (m[6] * mesh.normals[3 * i] + m[7] * mesh.normals[3 * i + 1] + m[8] * mesh.normals[3 * i + 2]) / 100;
    }
  }

  const halfW = FACE_BOX.width / 2;
  const halfH = FACE_BOX.height / 2;
  if (Number.isFinite(minX) && (minX < -halfW || maxX > halfW || minY < -halfH || maxY > halfH)) {
    const s = Math.min(1, (2 * halfW) / Math.max(1e-9, maxX - minX), (2 * halfH) / Math.max(1e-9, maxY - minY));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const back = (low: number, high: number, half: number) => (low < -half ? -half - low : high > half ? half - high : 0);
    const tx = back(cx + (minX - cx) * s, cx + (maxX - cx) * s, halfW);
    const ty = back(cy + (minY - cy) * s, cy + (maxY - cy) * s, halfH);
    for (let i = 0; i < n; i++) {
      out[2 * i] = cx + (out[2 * i] - cx) * s + tx;
      out[2 * i + 1] = cy + (out[2 * i + 1] - cy) * s + ty;
    }
  }
  return out;
}

export type FaceTone = 'accent' | 'on' | 'ghost';

/** The mesh's regions, the channels that light each (the largest of them), and the theme colour each lights in. */
export const FACE_LIGHTS: Readonly<Record<string, { channels: readonly FaceExpressionChannel[]; tone: FaceTone }>> = Object.freeze({
  eyeL: { channels: ['eyeBlinkL', 'eyeWideL'], tone: 'accent' },
  eyeR: { channels: ['eyeBlinkR', 'eyeWideR'], tone: 'accent' },
  browL: { channels: ['browDownL', 'browTogether', 'browInnerUp', 'browOuterUpL'], tone: 'accent' },
  browR: { channels: ['browDownR', 'browTogether', 'browInnerUp', 'browOuterUpR'], tone: 'accent' },
  jaw: { channels: ['jawOpen', 'chinRaise'], tone: 'accent' },
  lips: { channels: ['lipsPart', 'mouthStretch', 'mouthPucker'], tone: 'accent' },
  cornerL: { channels: ['mouthSmileL'], tone: 'on' },
  cornerR: { channels: ['mouthSmileR'], tone: 'on' },
  nose: { channels: ['noseWrinkle', 'noseSneer', 'noseFlare'], tone: 'ghost' },
  cheekL: { channels: ['cheekSquintL', 'lidTighten'], tone: 'ghost' },
  cheekR: { channels: ['cheekSquintR', 'lidTighten'], tone: 'ghost' },
});

/** How lit each of the mesh's regions is, 0 to 1. */
export function lightLevels(face: FaceChannels): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [region, { channels }] of Object.entries(FACE_LIGHTS)) out[region] = clamp(Math.max(0, ...channels.map((c) => face.expression[c] ?? 0)), 0, 1);
  return out;
}

/** The shortest and longest a glide takes: a face read fast still eases; one read slowly does not crawl for longer than a second. */
export const GLIDE_MIN_MS = 80;
export const GLIDE_MAX_MS = 1_000;

export interface FaceGlide {
  from: FaceChannels;
  to: FaceChannels;
  startedAt: number;
  durationMs: number;
  /** When the target arrived: the next glide lasts as long as the gap to the one after. */
  targetAt: number;
}

const easeOut = (t: number) => 1 - (1 - clamp(t, 0, 1)) ** 3;

/** Where the face is drawn at `now`. */
export function faceAt(glide: FaceGlide, now: number): FaceChannels {
  if (glide.durationMs <= 0 || now >= glide.startedAt + glide.durationMs) return glide.to;
  const k = easeOut((now - glide.startedAt) / glide.durationMs);
  const mix = (a: number, b: number) => a + (b - a) * k;
  const expression = { ...glide.to.expression };
  for (const name of Object.keys(expression)) expression[name] = mix(glide.from.expression[name] ?? 0, glide.to.expression[name] ?? 0);
  const { from, to } = glide;
  return {
    expression,
    head: { yawDeg: mix(from.head.yawDeg, to.head.yawDeg), pitchDeg: mix(from.head.pitchDeg, to.head.pitchDeg), rollDeg: mix(from.head.rollDeg, to.head.rollDeg) },
  };
}

/** A glide toward `target` from wherever the face is drawn now; with `instant` (reduced motion) it jumps there. */
export function glideTo(glide: FaceGlide | null, target: FaceChannels, now: number, instant = false): FaceGlide {
  if (!glide) return { from: target, to: target, startedAt: now, durationMs: 0, targetAt: now };
  const durationMs = instant ? 0 : clamp(now - glide.targetAt, GLIDE_MIN_MS, GLIDE_MAX_MS);
  return { from: faceAt(glide, now), to: target, startedAt: now, durationMs, targetAt: now };
}

export const gliding = (glide: FaceGlide | null, now: number): boolean => glide !== null && glide.durationMs > 0 && now < glide.startedAt + glide.durationMs;

/** The colours a face is drawn in, as [r, g, b]: the wire, and the three a region lights in. */
export interface FacePalette {
  wire: readonly [number, number, number];
  accent: readonly [number, number, number];
  on: readonly [number, number, number];
  ghost: readonly [number, number, number];
}

/** A CSS colour (`#rrggbb`, `rgb(…)`) as [r, g, b]; the fallback when it is neither. */
export function rgbOf(css: string, fallback: readonly [number, number, number]): readonly [number, number, number] {
  const value = css.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : fallback;
}

const rgba = ([r, g, b]: readonly [number, number, number], alpha: number) => `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
/** How finely a point's light and fade are stepped, so the wire strokes as a few paths rather than thousands. */
const STEPS = 4;
const fadeStep = (facing: number) => Math.ceil(clamp((facing + 0.5) / 0.35, 0, 1) * STEPS);

export interface DrawFaceOptions {
  width: number;
  height: number;
  dpr: number;
  palette: FacePalette;
  /** Reused between draws: 2 x the mesh's count. */
  buffer?: Float32Array;
  facing?: Float32Array;
}

/** The face into a 2D context: the wire faintly, the lit regions over it in their tones. */
export function drawFace(ctx: CanvasRenderingContext2D, mesh: FaceMesh, face: FaceChannels, options: DrawFaceOptions): void {
  const { width, height, dpr, palette } = options;
  const facing = options.facing ?? new Float32Array(mesh.count);
  const pos = poseFace(mesh, face, options.buffer, facing);
  const scale = Math.min(width / FACE_BOX.width, height / FACE_BOX.height);
  const cx = width / 2;
  const cy = height / 2;
  const x = (i: number) => cx + pos[2 * i] * scale;
  const y = (i: number) => cy + pos[2 * i + 1] * scale;
  const lights = lightLevels(face);
  const tones = mesh.regions.map((region) => palette[FACE_LIGHTS[region]?.tone ?? 'accent']);

  const lit = new Float32Array(mesh.count);
  const fade = new Uint8Array(mesh.count);
  for (let i = 0; i < mesh.count; i++) {
    const r = mesh.region[i];
    if (r >= 0) lit[i] = (lights[mesh.regions[r]] ?? 0) * (mesh.weight[i] / 100);
    fade[i] = fadeStep(facing[i]);
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const strokes = new Map<string, number[]>();
  const add = (key: string, a: number, b: number) => {
    let list = strokes.get(key);
    if (!list) strokes.set(key, (list = []));
    list.push(a, b);
  };
  for (let e = 0; e < mesh.edges.length; e += 2) {
    const a = mesh.edges[e];
    const b = mesh.edges[e + 1];
    const f = Math.min(fade[a], fade[b]);
    if (f === 0) continue;
    add(`w:${f}`, a, b);
    const light = Math.max(lit[a], lit[b]);
    if (light >= 0.04) add(`l:${mesh.region[lit[a] >= lit[b] ? a : b]}:${Math.min(STEPS, Math.ceil(light * STEPS))}:${f}`, a, b);
  }
  for (const [key, list] of strokes) {
    const parts = key.split(':');
    ctx.beginPath();
    for (let k = 0; k < list.length; k += 2) {
      ctx.moveTo(x(list[k]), y(list[k]));
      ctx.lineTo(x(list[k + 1]), y(list[k + 1]));
    }
    if (parts[0] === 'w') {
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = rgba(palette.wire, 0.24 * (Number(parts[1]) / STEPS));
    } else {
      const strength = Number(parts[2]) / STEPS;
      ctx.lineWidth = 0.8 + 0.7 * strength;
      ctx.strokeStyle = rgba(tones[Number(parts[1])] ?? palette.accent, (0.25 + 0.7 * strength) * (Number(parts[3]) / STEPS));
    }
    ctx.stroke();
  }

  const radius = Math.max(0.9, 1.3 * Math.min(1, scale * 3));
  const dots = new Map<string, number[]>();
  for (let i = 0; i < mesh.count; i++) {
    if (fade[i] === 0) continue;
    const key = lit[i] >= 0.04 ? `l:${mesh.region[i]}:${Math.min(STEPS, Math.ceil(lit[i] * STEPS))}:${fade[i]}` : `w:${fade[i]}`;
    let list = dots.get(key);
    if (!list) dots.set(key, (list = []));
    list.push(i);
  }
  for (const [key, list] of dots) {
    const parts = key.split(':');
    const strength = parts[0] === 'l' ? Number(parts[2]) / STEPS : 0;
    const f = Number(parts[parts.length - 1]) / STEPS;
    ctx.fillStyle = parts[0] === 'w' ? rgba(palette.wire, 0.42 * f) : rgba(tones[Number(parts[1])] ?? palette.accent, (0.45 + 0.55 * strength) * f);
    const r = radius * (1 + 0.4 * strength);
    ctx.beginPath();
    for (const i of list) {
      ctx.moveTo(x(i) + r, y(i));
      ctx.arc(x(i), y(i), r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
}
