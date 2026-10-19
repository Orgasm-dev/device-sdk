// A framework's server render imports the HUD without a DOM; that must not throw.
import { describe, expect, it } from 'vitest';

describe('importing without a DOM', () => {
  it('loads every entry point, defines nothing, and still models', async () => {
    expect(typeof globalThis.HTMLElement).toBe('undefined');
    const hud = await import('../src/hud/index.ts');
    const capture = await import('../src/capture.ts');
    const root = await import('../src/index.ts');
    expect(typeof hud.OrgasmHud).toBe('function');
    expect(typeof capture.requestCapture).toBe('function');
    expect(typeof root.subscribe).toBe('function');
    expect(hud.hudView(hud.initialHudState(), 0).phase).toBe('waiting');
  });
});
