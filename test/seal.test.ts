// The device's sealed requests (seal.ts), byte-compatible with the enclave:
// the shared vector is the one workload/tests/test_tee_mode.py of the
// enclave's source (https://github.com/Masseuse-ai/masseuse-video-tee) opens
// with the enclave's own SealKey.open.

import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, type SealKey } from '../src/attestation.ts';
import { sealRequest, slotCredential } from '../src/seal.ts';

const subtle = globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();
const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

const SEAL_JWK = { kty: 'EC', crv: 'P-256', d: 'dYVhKDEy4g6XZHcvlKa07u2BW-1htrS7Y9ZZwq9qQUc', x: 'u1CiJ88nt08ydEk7d036KKGGYNy9PvXmb8qeMC97FLc', y: '27FX5zFQ6lDxIgwHwadLkKgJUAMpmUTo8HzftTkLLUw' };
const SEAL_PUBLIC = 'BLtQoifPJ7dPMnRJO3dN-iihhmDcvT715m_KnjAvexS327FX5zFQ6lDxIgwHwadLkKgJUAMpmUTo8HzftTkLLUw';
const EPHEMERAL_JWK = { kty: 'EC', crv: 'P-256', d: 'QZ1N4fzKH7OLtWUz-K3vFhnWfLkSf5jEubv9ZKij4tY', x: 'niyPn5YnWBaDY3P5_NoLQzqqGYQLpUdOd17ZHU8M3Uo', y: 'GegcdHGYXuHVIYNlLWtvEKiSEPSEn9cuUOaNrsJq2q0' };
const VECTOR = {
  header: 'v1.BJ4sj5-WJ1gWg2Nz-fzaC0M6qhmEC6VHTnde2R1PDN1KGegcdHGYXuHVIYNlLWtvEKiSEPSEn9cuUOaNrsJq2q0'
    + '.ICEiIyQlJicoKSor.ChQzKw9wKd_NZ-eh0UzdO86z9K-12b_sBYxR-ks4YyaJtuG9FjCC40oXhhST2OAFBoonBEiT'
    + 'wkjXKl96-ahWEI7G-BDUqbw9EsLqtIoWAqPB9JR_H8eK0fOBoq20IiLvAecZK6YDI6dGV3-dAVw8C2veVSDk2BPz7wc'
    + 'C8ibyY0q6xZGJZML5NzSi5olwOn3FDjywIL4b9uhffX1RdBFSLyPvKSLAv7Auj_AAmuGTh6YTTiM_sH1JE5-Xlr40J5B'
    + 'CJWWCVueHUxc',
  body: 'MDEyMzQ1Njc4OTo7MhBoJ6ulDwt5wzeUdN2bYlixOwKvFzOVT7E2rQUR1WwAHBrzPlrGxwdA1dsnkBaGmZxu5k3JP-E9'
    + '37H9Z0Gk6ms2AhVD',
};

async function sealKey(): Promise<SealKey> {
  const raw = b64urlDecode(SEAL_PUBLIC);
  return { key: await subtle.importKey('raw', raw as BufferSource, ECDH, true, []), raw };
}

function scripted(...starts: number[]): (length: number) => Uint8Array {
  let call = 0;
  return (length) => {
    const start = starts[call++]!;
    return Uint8Array.from({ length }, (_, i) => (start + i) % 256);
  };
}

/** The enclave's SealKey.open, enough of it to read back what the device sealed. */
async function openSeal(header: string, body: Uint8Array | null): Promise<{ claims: Record<string, unknown>; body: string | null }> {
  const [, epk, iv, sealed] = header.split('.') as [string, string, string, string];
  const privateKey = await subtle.importKey('jwk', SEAL_JWK, ECDH, false, ['deriveBits']);
  const epkRaw = b64urlDecode(epk);
  const shared = await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', epkRaw as BufferSource, ECDH, true, []) }, privateKey, 256);
  const info = new Uint8Array([...epkRaw, ...b64urlDecode(SEAL_PUBLIC)]);
  const key = await subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode('masseuse-video-tee seal v1') as BufferSource, info: info as BufferSource },
    await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']),
    { name: 'AES-GCM', length: 256 }, false, ['decrypt'],
  );
  const claims = JSON.parse(utf8Decoder.decode(await subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlDecode(iv) as BufferSource, additionalData: utf8.encode('claims') as BufferSource }, key, b64urlDecode(sealed) as BufferSource,
  ))) as Record<string, unknown>;
  if (!body) return { claims, body: null };
  const opened = await subtle.decrypt(
    { name: 'AES-GCM', iv: body.slice(0, 12) as BufferSource, additionalData: utf8.encode('body') as BufferSource }, key, body.slice(12) as BufferSource,
  );
  return { claims, body: utf8Decoder.decode(opened) };
}

describe('sealRequest', () => {
  it('makes the seal the enclave opens: the shared vector', async () => {
    const ephemeral = {
      privateKey: await subtle.importKey('jwk', EPHEMERAL_JWK, ECDH, true, ['deriveBits']),
      publicKey: await subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: EPHEMERAL_JWK.x, y: EPHEMERAL_JWK.y }, ECDH, true, []),
    } as CryptoKeyPair;
    const sealed = await sealRequest({
      seal: await sealKey(),
      capability: b64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => i)),
      method: 'PUT',
      url: 'https://enclave.example/ingest/source',
      body: '{"url":"rtsps://viewer:s3cret@cam.example:7441/back"}',
      now: 1_800_000_000_000,
      ephemeral,
      random: scripted(0x01, 0x20, 0x30),
    });
    expect(sealed.header).toBe(VECTOR.header);
    expect(b64urlEncode(sealed.body!)).toBe(VECTOR.body);
  });

  it('binds the capability, the request, a request id and the client nonce; the body is sealed with them', async () => {
    const capability = b64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => 255 - i));
    const sealed = await sealRequest({
      seal: await sealKey(), capability, method: 'POST', url: 'https://enclave.example/ingest/whip?x=1',
      body: 'v=0\r\n', clientNonce: 'phone-nonce-0001', now: 1_800_000_123_456,
    });
    const opened = await openSeal(sealed.header, sealed.body);
    expect(opened.claims).toEqual({ v: 1, capability, method: 'POST', target: '/ingest/whip?x=1', iat: 1_800_000_123, rid: opened.claims.rid, clientNonce: 'phone-nonce-0001', body: true });
    expect(String(opened.claims.rid)).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(opened.body).toBe('v=0\r\n');
  });
});

describe('slotCredential', () => {
  it('is a bearer for an enclave that takes one, and seals for one that asks', async () => {
    const bearer = await slotCredential('cap-1', null).prepare({ method: 'GET', url: 'https://enclave.example/ingest/whip' });
    expect(bearer.headers.authorization).toBe('Bearer cap-1');

    const capability = b64urlEncode(Uint8Array.from({ length: 32 }, (_, i) => i * 3));
    const sealed = await slotCredential(capability, await sealKey()).prepare({
      method: 'POST', url: 'https://enclave.example/ingest/whip', headers: { 'content-type': 'application/sdp' }, body: 'v=0\r\noffer',
    });
    expect(sealed.headers.authorization).toBeUndefined();
    expect(sealed.headers['X-Masseuse-Seal']).toMatch(/^v1\./);
    expect(sealed.body).toBeInstanceOf(Uint8Array);
  });
});
