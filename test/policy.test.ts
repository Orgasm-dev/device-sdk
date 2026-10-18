import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const policy = (...args: string[]) => spawnSync(process.execPath, ['scripts/policy.mjs', ...args], { encoding: 'utf8' });

describe('the wording policy', () => {
  it('finds nothing in the repository', () => {
    const result = policy('tree');
    expect(result.stdout + result.stderr).toContain('no findings');
    expect(result.status).toBe(0);
  });

  it('permits only the enclave’s references and its protocol’s literals', () => {
    const source = readFileSync('scripts/policy.mjs', 'utf8');
    const listed = /const PERMITTED = (\[[^\]]*\]);/.exec(source)?.[1];
    expect(listed && JSON.parse(listed.replaceAll("'", '"').replace(/,\s*\]/, ']'))).toEqual([
      'github.com/Masseuse-ai/masseuse-video-tee',
      'ghcr.io/masseuse-ai/masseuse-video-tee',
      'X-Masseuse-Evidence',
      'X-Masseuse-Seal',
      'X-Masseuse-Client-Nonce',
      'x-masseuse-',
      'masseuse-video-tee seal v1',
    ]);
  });
});
