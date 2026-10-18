import { defineConfig } from 'vitest/config';

// The tests run in Node with its WebCrypto; publish.ts (RTCPeerConnection) is
// browser-only and is covered by the typecheck, not these tests.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
