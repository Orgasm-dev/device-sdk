import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FACE_EXPRESSION_CHANNELS, type CameraHeadPose, type FaceChannels } from '../src/events.ts';
import {
  FACE_AT_REST,
  FACE_BOX,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  cameraRotation,
  drawFace,
  faceAt,
  glideTo,
  gliding,
  headAt,
  headGlideTo,
  headGliding,
  headRotation,
  lightLevels,
  loadFaceMesh,
  poseFace,
  rgbOf,
} from '../src/hud/face.ts';

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
const inFace = mesh.region.map((r, i) => (r >= 0 ? i : -1)).filter((i) => i >= 0);
/** Each point's partner across the midline. */
const partner = (() => {
  const at = new Map<string, number>();
  for (let i = 0; i < mesh.count; i++) at.set(`${mesh.points[3 * i]},${mesh.points[3 * i + 1]},${mesh.points[3 * i + 2]}`, i);
  return Array.from({ length: mesh.count }, (_, i) => at.get(`${-mesh.points[3 * i] || 0},${mesh.points[3 * i + 1]},${mesh.points[3 * i + 2]}`));
})();
const side = (name: string) => name.replace(/L$/, '#').replace(/R$/, 'L').replace(/#$/, 'R');
const midline = [...Array(mesh.count).keys()].filter((i) => partner[i] === i);
const nose = midline.reduce((best, i) => (mesh.points[3 * i + 2] > mesh.points[3 * best + 2] ? i : best));
const crown = midline.reduce((best, i) => (mesh.points[3 * i + 1] < mesh.points[3 * best + 1] ? i : best));
const chin = midline.filter((i) => mesh.regions[mesh.region[i]] === 'jaw').reduce((best, i) => (mesh.points[3 * i + 1] > mesh.points[3 * best + 1] ? i : best));
/** The angle of the line from the chin up to the crown, clockwise from straight up, in degrees. */
const tilt = (at: Float32Array) => (Math.atan2(at[2 * crown] - at[2 * chin], at[2 * chin + 1] - at[2 * crown + 1]) * 180) / Math.PI;

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

  it('is its own mirror: every point, edge, region, weight and normal has its partner across the midline', () => {
    expect(partner.every((j) => j !== undefined)).toBe(true);
    const edges = new Set<string>();
    for (let e = 0; e < mesh.edges.length; e += 2) edges.add(`${Math.min(mesh.edges[e], mesh.edges[e + 1])}-${Math.max(mesh.edges[e], mesh.edges[e + 1])}`);
    for (const key of edges) {
      const [a, b] = key.split('-').map(Number);
      const [ma, mb] = [partner[a]!, partner[b]!];
      expect(edges.has(`${Math.min(ma, mb)}-${Math.max(ma, mb)}`), `edge ${key}`).toBe(true);
    }
    for (let i = 0; i < mesh.count; i++) {
      const j = partner[i]!;
      expect(mesh.weight[i]).toBe(mesh.weight[j]);
      expect([-mesh.normals[3 * i] || 0, mesh.normals[3 * i + 1], mesh.normals[3 * i + 2]]).toEqual([mesh.normals[3 * j], mesh.normals[3 * j + 1], mesh.normals[3 * j + 2]]);
      if (j === i) continue;
      const mine = mesh.region[i] < 0 ? '' : mesh.regions[mesh.region[i]];
      const theirs = mesh.region[j] < 0 ? '' : mesh.regions[mesh.region[j]];
      expect(side(mine), `point ${i}`).toBe(theirs);
    }
  });

  it('moves each side as the mirror of the other, to within a fiftieth of the head', () => {
    // The rig's own motions are a little uneven, and a displacement too small to keep on one side may be kept on the other.
    for (const name of FACE_EXPRESSION_CHANNELS) {
      const mine = mesh.deltas[name];
      const twin = mesh.deltas[side(name)];
      expect(mesh.gains[side(name)]).toBe(mesh.gains[name]);
      const theirs = new Map(twin.idx.map((i, k) => [i, [twin.d[3 * k], twin.d[3 * k + 1], twin.d[3 * k + 2]]]));
      mine.idx.forEach((i, k) => {
        const [dx, dy, dz] = theirs.get(partner[i]!) ?? [0, 0, 0];
        expect(Math.hypot(mine.d[3 * k] + dx, mine.d[3 * k + 1] - dy, mine.d[3 * k + 2] - dz), `${name} at ${i}`).toBeLessThanOrEqual(mesh.headHeight / 50);
      });
    }
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

  it('draws each channel at its gain, or at its value alone where gains are off', () => {
    const k = mesh.deltas.jawOpen.d.reduce((best, _, j, d) => (j % 3 === 1 && Math.abs(d[j]) > Math.abs(d[best]) ? j : best), 1);
    const i = mesh.deltas.jawOpen.idx[(k - 1) / 3];
    const dy = mesh.deltas.jawOpen.d[k];
    const y = (gains?: boolean) => poseFace(mesh, withExpression({ jawOpen: 1 }), undefined, undefined, { gains })[2 * i + 1];
    expect(y(false)).toBeCloseTo(mesh.points[3 * i + 1] + dy, 3);
    expect(y()).toBeCloseTo(mesh.points[3 * i + 1] + mesh.gains.jawOpen * dy, 3);
  });

  it('turns the head as someone facing the person sees it', () => {
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
    for (const i of inFace) {
      expect(Math.abs(tipped[2 * i])).toBeLessThanOrEqual(FACE_BOX.width / 2 + 1);
      expect(Math.abs(tipped[2 * i + 1])).toBeLessThanOrEqual(FACE_BOX.height / 2 + 1);
    }
  });

  it('turns the head as the camera sees it, past a neck’s limits, and lays a head on its side', () => {
    const camera = (cameraHead: CameraHeadPose) => poseFace(mesh, FACE_AT_REST, undefined, undefined, { cameraHead });
    // The channels stop at a neck's forty-five degrees of roll; the camera's head lies on its side, the crown at the viewer's right.
    expect(tilt(poseFace(mesh, withExpression({}, { rollDeg: 90 })))).toBeCloseTo(45, 0);
    expect(tilt(camera({ yawDeg: 0, pitchDeg: 0, rollDeg: 90 }))).toBeCloseTo(90, 0);
    expect(tilt(camera({ yawDeg: 0, pitchDeg: 0, rollDeg: -120 }))).toBeCloseTo(-120, 0);
    expect(camera({ yawDeg: 40, pitchDeg: 0, rollDeg: 0 })[2 * nose]).toBeGreaterThan(camera({ yawDeg: 0, pitchDeg: 0, rollDeg: 0 })[2 * nose] + 40);
    for (const cameraHead of [
      { yawDeg: 0, pitchDeg: 0, rollDeg: 180 },
      { yawDeg: 90, pitchDeg: 90, rollDeg: -90 },
      { yawDeg: -179, pitchDeg: -90, rollDeg: 135 },
    ]) {
      const at = camera(cameraHead);
      for (const i of inFace) {
        expect(Math.abs(at[2 * i])).toBeLessThanOrEqual(FACE_BOX.width / 2 + 1);
        expect(Math.abs(at[2 * i + 1])).toBeLessThanOrEqual(FACE_BOX.height / 2 + 1);
      }
    }
  });

  it('composes the camera’s angles roll first, then pitch, then yaw, about the head’s own centre', () => {
    const r = Math.PI / 180;
    const [y, p, z] = [20 * r, 10 * r, 15 * r];
    const ry = [Math.cos(y), 0, Math.sin(y), 0, 1, 0, -Math.sin(y), 0, Math.cos(y)];
    const rx = [1, 0, 0, 0, Math.cos(p), -Math.sin(p), 0, Math.sin(p), Math.cos(p)];
    const rz = [Math.cos(z), -Math.sin(z), 0, Math.sin(z), Math.cos(z), 0, 0, 0, 1];
    const mul = (a: number[], b: number[]) => [0, 1, 2].flatMap((row) => [0, 1, 2].map((col) => a[3 * row] * b[col] + a[3 * row + 1] * b[3 + col] + a[3 * row + 2] * b[6 + col]));
    const m = cameraRotation({ yawDeg: 20, pitchDeg: 10, rollDeg: 15 });
    mul(ry, mul(rx, rz)).forEach((value, k) => expect(m[k]).toBeCloseTo(value, 12));
    // The channels turn the other way round, so the two differ for the same angles.
    expect(Math.max(...headRotation({ yawDeg: 20, pitchDeg: 10, rollDeg: 15 }).map((value, k) => Math.abs(value - m[k])))).toBeGreaterThan(0.01);
    const at = poseFace(mesh, FACE_AT_REST, undefined, undefined, { cameraHead: { yawDeg: 20, pitchDeg: 10, rollDeg: 15 } });
    const pz = mesh.pivot[2];
    for (let i = 0; i < mesh.count; i += 41) {
      const [px, py, pzi] = [mesh.points[3 * i], mesh.points[3 * i + 1], mesh.points[3 * i + 2] - pz];
      expect(at[2 * i]).toBeCloseTo(m[0] * px + m[1] * py + m[2] * pzi, 2);
      expect(at[2 * i + 1]).toBeCloseTo(m[3] * px + m[4] * py + m[5] * pzi, 2);
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

  it('glides the camera’s head beside the face, the short way round, the pitch straight', () => {
    const a: CameraHeadPose = { yawDeg: 170, pitchDeg: -80, rollDeg: -175 };
    const b: CameraHeadPose = { yawDeg: -170, pitchDeg: 80, rollDeg: 175 };
    // From none, at once.
    let glide = headGlideTo(null, a, 1_000);
    expect(headGliding(glide, 1_000)).toBe(false);
    expect(headAt(glide, 1_000)).toBe(a);
    glide = headGlideTo(glide, b, 1_200);
    expect(glide.durationMs).toBe(200);
    expect(headGliding(glide, 1_250)).toBe(true);
    const mid = headAt(glide, 1_300)!;
    // Across 180 rather than back through 0.
    expect(Math.abs(mid.yawDeg)).toBeGreaterThan(170);
    expect(Math.abs(mid.rollDeg)).toBeGreaterThan(175);
    expect(Math.abs(mid.yawDeg)).toBeLessThanOrEqual(180);
    expect(mid.pitchDeg).toBeGreaterThan(-80);
    expect(mid.pitchDeg).toBeLessThan(80);
    expect(headAt(glide, 1_400)).toBe(b);
    // To none, at once: the face's own head turns it again.
    expect(headAt(headGlideTo(glide, null, 1_300), 1_300)).toBeNull();
    expect(headGlideTo(glide, a, 1_500, true).durationMs).toBe(0);
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
