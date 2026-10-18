// The device's requests to the enclave, sealed.
//
// The enclave requires sealed requests (its attested TEE_REQUEST_SEAL=v1;
// SealKey in workload/producer/tee_mode.py of the enclave's source,
// https://github.com/Masseuse-ai/masseuse-video-tee). The browser cannot see which key its TLS connection
// reached, so whoever held a certificate for the enclave's hostname could
// read a bearer there. A sealed request carries no bearer: `X-Masseuse-Seal:
// v1.<epk>.<iv>.<ciphertext>` holds an ephemeral P-256 key and, under the key
// it and the enclave's seal key derive (ECDH, HKDF-SHA256), the capability,
// the method, the request target, the time, a request id and the client
// nonce (AES-256-GCM). The body goes as `<iv><ciphertext>` under the same key.
// The enclave opens each seal once, for the request it names.
//
// Byte-compatible with the enclave's own SealKey.open: its test vector opens
// here (test/seal.test.ts).

import { b64urlEncode, SEAL_HEADER, CLIENT_NONCE_HEADER, type SealKey } from './attestation.ts';

const SEAL_SALT = 'masseuse-video-tee seal v1';
const utf8 = new TextEncoder();

const subtle = (): SubtleCrypto => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('WebCrypto is unavailable');
  return api;
};

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

export interface SealInput {
  seal: SealKey;
  capability: string;
  method: string;
  /** Absolute: the enclave holds the seal to this path and query. */
  url: string;
  body?: string | Uint8Array | null;
  clientNonce?: string;
  now?: number;
  /** Tests: a fixed ephemeral key and random bytes. */
  ephemeral?: CryptoKeyPair;
  random?: (length: number) => Uint8Array;
}

/** One request, sealed: the X-Masseuse-Seal header and the body to send instead of the plain one. */
export async function sealRequest({
  seal, capability, method, url, body = null, clientNonce = '', now = Date.now(), ephemeral, random = randomBytes,
}: SealInput): Promise<{ header: string; body: Uint8Array | null }> {
  const pair = ephemeral ?? ((await subtle().generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const epk = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  const shared = await subtle().deriveBits({ name: 'ECDH', public: seal.key }, pair.privateKey, 256);
  const ikm = await subtle().importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8.encode(SEAL_SALT) as BufferSource, info: concat(epk, seal.raw) as BufferSource },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const plain = body === null ? null : typeof body === 'string' ? utf8.encode(body) : body;
  const target = new URL(url);
  const claims = {
    v: 1,
    capability,
    method,
    target: target.pathname + target.search,
    iat: Math.floor(now / 1000),
    rid: b64urlEncode(random(16)),
    clientNonce,
    body: Boolean(plain && plain.length),
  };
  const iv = random(12);
  const sealed = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource, additionalData: utf8.encode('claims') as BufferSource }, key, utf8.encode(JSON.stringify(claims)) as BufferSource,
  ));
  const header = `v1.${b64urlEncode(epk)}.${b64urlEncode(iv)}.${b64urlEncode(sealed)}`;
  if (!plain || !plain.length) return { header, body: null };
  const bodyIv = random(12);
  const sealedBody = new Uint8Array(await subtle().encrypt(
    { name: 'AES-GCM', iv: bodyIv as BufferSource, additionalData: utf8.encode('body') as BufferSource }, key, plain as BufferSource,
  ));
  return { header, body: concat(bodyIv, sealedBody) };
}

/** One request under the capability, as it goes on the wire. */
export interface SlotRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | null;
}

/**
 * How the device presents its capability to a verified enclave: sealed when
 * the enclave asks for that (it published a seal key), as a bearer to one
 * that does not.
 */
export interface SlotCredential {
  prepare(request: SlotRequest): Promise<{ headers: Record<string, string>; body?: BodyInit }>;
}

export function slotCredential(capability: string, seal: SealKey | null): SlotCredential {
  return {
    async prepare({ method, url, headers = {}, body = null }) {
      if (!seal) return { headers: { ...headers, authorization: `Bearer ${capability}` }, ...(body === null ? {} : { body }) };
      const sealed = await sealRequest({ seal, capability, method, url, body, clientNonce: headers[CLIENT_NONCE_HEADER.toLowerCase()] ?? '' });
      return { headers: { ...headers, [SEAL_HEADER]: sealed.header }, ...(sealed.body ? { body: sealed.body as BodyInit } : {}) };
    },
  };
}
