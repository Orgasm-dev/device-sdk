import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACE_EXPRESSION_CHANNELS, type FaceChannels } from '../src/events.ts';
import { FACE_BOX, GLIDE_MAX_MS, GLIDE_MIN_MS, drawFace, faceAt, glideTo, gliding, lightLevels, loadFaceMesh, poseFace, rgbOf } from '../src/hud/face.ts';

const rest = (): FaceChannels => ({
  expression: Object.fromEntries(FACE_EXPRESSION_CHANNELS.map((name) => [name, 0])) as FaceChannels['expression'],
  head: { yawDeg: 0, pitchDeg: 0, rollDeg: 0 },
});
const withExpression = (values: Partial<Record<string, number>>, head: Partial<FaceChannels['head']> = {}): FaceChannels => {
  const face = rest();
  return { expression: { ...face.expression, ...values } as FaceChannels['expression'], head: { ...face.head, ...head } };
};

const mesh = await loadFaceMesh();
const region = (name: string) => mesh.region.map((r, i) => (mesh.regions[r] === name ? i : -1)).filter((i) => i >= 0);
const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;

describe('the face mesh', () => {
  it('has a displacement and a gain for each of the contract’s 24 channels, and stays a small chunk', () => {
    for (const name of FACE_EXPRESSION_CHANNELS) {
      expect(mesh.deltas[name]?.idx.length, name).toBeGreaterThan(0);
      expect(mesh.deltas[name].d.length).toBe(mesh.deltas[name].idx.length * 3);
      expect(mesh.gains[name], name).toBeGreaterThan(0);
    }
    expect(mesh.points).toHaveLength(mesh.count * 3);
    expect(mesh.normals).toHaveLength(mesh.count * 3);
    expect(Math.max(...mesh.edges)).toBeLessThan(mesh.count);
    expect(readFileSync(new URL('../src/hud/face-mesh.ts', import.meta.url)).length).toBeLessThan(160_000);
  });
});

describe('posing the face', () => {
  it('draws the resting face where the mesh has it, and a channel moves only its own points', () => {
    const at = poseFace(mesh, rest());
    for (let i = 0; i < mesh.count; i += 97) expect([at[2 * i], at[2 * i + 1]]).toEqual([mesh.points[3 * i], mesh.points[3 * i + 1]]);
    const open = poseFace(mesh, withExpression({ jawOpen: 1 }));
    const jaw = region('jaw');
    expect(mean(jaw.map((i) => open[2 * i + 1]))).toBeGreaterThan(mean(jaw.map((i) => at[2 * i + 1])) + 10);
    const moved = new Set(mesh.deltas.jawOpen.idx);
    const still = [...Array(mesh.count).keys()].filter((i) => !moved.has(i));
    expect(still.every((i) => open[2 * i] === at[2 * i] && open[2 * i + 1] === at[2 * i + 1])).toBe(true);
  });

  it('turns the head as someone facing the person sees it', () => {
    const nose = [...Array(mesh.count).keys()].reduce((best, i) => (mesh.points[3 * i + 2] > mesh.points[3 * best + 2] ? i : best), 0);
    const crown = [...Array(mesh.count).keys()].reduce((best, i) => (mesh.points[3 * i + 1] < mesh.points[3 * best + 1] ? i : best), 0);
    const chin = [...region('jaw')].reduce((best, i) => (mesh.points[3 * i + 1] > mesh.points[3 * best + 1] ? i : best));
    const at = (head: Partial<FaceChannels['head']>) => poseFace(mesh, withExpression({}, head));
    const still = at({});
    expect(at({ yawDeg: 20 })[2 * nose]).toBeGreaterThan(still[2 * nose] + 20);
    expect(at({ pitchDeg: 20 })[2 * chin + 1]).toBeLessThan(still[2 * chin + 1]);
    expect(at({ rollDeg: 15 })[2 * crown]).toBeGreaterThan(still[2 * crown] + 20);
  });

  it('fades the side turned away, and keeps a far-turned head inside its box', () => {
    const facing = new Float32Array(mesh.count);
    poseFace(mesh, withExpression({}, { yawDeg: 60 }), undefined, facing);
    expect(Math.min(...facing)).toBeLessThan(-0.2);
    const tipped = poseFace(mesh, withExpression({}, { rollDeg: 90, pitchDeg: 60 }));
    const inFace = mesh.region.map((r, i) => (r >= 0 ? i : -1)).filter((i) => i >= 0);
    for (const i of inFace) {
      expect(Math.abs(tipped[2 * i])).toBeLessThanOrEqual(FACE_BOX.width / 2 + 1);
      expect(Math.abs(tipped[2 * i + 1])).toBeLessThanOrEqual(FACE_BOX.height / 2 + 1);
    }
  });

  it('lights each region by the largest of its channels', () => {
    const lights = lightLevels(withExpression({ jawOpen: 0.3, chinRaise: 0.7, mouthSmileL: 0.5 }));
    expect([lights.jaw, lights.cornerL, lights.cornerR, lights.eyeL]).toEqual([0.7, 0.5, 0, 0]);
  });
});

describe('the glide', () => {
  it('eases from where the face was drawn to the newest reading, over the gap between readings', () => {
    const a = withExpression({ jawOpen: 0 });
    const b = withExpression({ jawOpen: 1 }, { yawDeg: 10 });
    let glide = glideTo(null, a, 1_000);
    expect(gliding(glide, 1_000)).toBe(false);
    glide = glideTo(glide, b, 1_200);
    expect(glide.durationMs).toBe(200);
    const mid = faceAt(glide, 1_300);
    expect(mid.expression.jawOpen).toBeGreaterThan(0.5);
    expect(mid.expression.jawOpen).toBeLessThan(1);
    expect(faceAt(glide, 1_400)).toBe(b);
    expect(glideTo(glide, a, 1_210).durationMs).toBe(GLIDE_MIN_MS);
    expect(glideTo(glide, a, 9_000).durationMs).toBe(GLIDE_MAX_MS);
    expect(glideTo(glide, a, 1_500, true).durationMs).toBe(0);
  });
});

describe('drawing the face', () => {
  it('strokes the wire and fills the points in a handful of paths, in the theme’s colours', () => {
    const calls: string[] = [];
    const styles = new Set<string>();
    const ctx = new Proxy(
      {},
      {
        get: (_target, name: string) => (name === 'canvas' ? {} : (...args: unknown[]) => calls.push(`${name}:${args.length}`)),
        set: (_target, name: string, value: unknown) => {
          if (name === 'strokeStyle' || name === 'fillStyle') styles.add(String(value));
          return true;
        },
      },
    ) as CanvasRenderingContext2D;
    drawFace(ctx, mesh, withExpression({ jawOpen: 0.8, mouthSmileL: 0.6, noseWrinkle: 0.5 }), {
      width: 300,
      height: 342,
      dpr: 2,
      palette: { wire: [244, 238, 242], accent: rgbOf('#fa7f8c', [0, 0, 0]), on: rgbOf('rgb(125 226 195)', [0, 0, 0]), ghost: [245, 194, 107] },
    });
    expect(calls.filter((c) => c.startsWith('stroke:')).length).toBeLessThan(80);
    expect([...styles].some((s) => s.startsWith('rgba(250,127,140'))).toBe(true);
    expect([...styles].some((s) => s.startsWith('rgba(125,226,195'))).toBe(true);
    expect([...styles].some((s) => s.startsWith('rgba(245,194,107'))).toBe(true);
  });
});
