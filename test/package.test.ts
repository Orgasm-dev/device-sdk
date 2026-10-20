// `import '@orgasm-dev/device/hud'` must still register the elements once a
// bundler honours `sideEffects`, which means listing the entry as well as the
// file it imports for the registration.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports: Record<string, { import: string }>;
  sideEffects: string[];
};

describe('package.json', () => {
  it('keeps the hud entry and its registration as side effects', () => {
    expect(pkg.sideEffects).toEqual(
      expect.arrayContaining([pkg.exports['./hud'].import, './dist/hud/register.js', './src/hud/index.ts', './src/hud/register.ts']),
    );
  });

  it('leaves every other module free to drop', () => {
    expect(pkg.sideEffects).toHaveLength(4);
  });
});
