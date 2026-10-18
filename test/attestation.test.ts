// The device's attestation check (attestation.ts checkAttestationClaims): the
// policy the API publishes, held against an enclave's token claims. The RS256
// signature path is Google's (verifyRs256); this exercises the claim rules.

import { describe, expect, it } from 'vitest';
import { AttestationRefused, type AttestationPolicy, b64urlEncode, checkAttestationClaims, evidenceProblems, sha256Nonce } from '../src/attestation.ts';

const ORIGIN = 'https://enclave.example';

const POLICY: AttestationPolicy = {
  object: 'attestation_policy', mode: 'live', version: '2026-10-16', enforced: true,
  issuer: 'https://confidentialcomputing.googleapis.com',
  hardware: ['Intel TDX', 'NVIDIA H100 confidential computing'],
  image: { source: 'https://github.com/Masseuse-ai/masseuse-video-tee', minRelease: 'v0.17.0', digests: [] },
  seal: { schemes: ['v1'] }, evidence: { algorithm: 'Ed25519' }, debugAllowed: false, updatedAt: '2026-10-16T00:00:00Z',
};

async function evidenceKeyDescription() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = b64urlEncode(raw);
  return { alg: 'Ed25519', publicKey, nonce: await sha256Nonce(raw) };
}

async function claimsFor(key: { nonce: string }, overrides: Record<string, unknown> = {}) {
  return {
    iss: 'https://confidentialcomputing.googleapis.com',
    aud: ORIGIN,
    exp: Math.floor(Date.now() / 1000) + 3600,
    swname: 'CONFIDENTIAL_SPACE',
    hwmodel: 'GCP_INTEL_TDX',
    secboot: true,
    dbgstat: 'disabled-since-boot',
    eat_nonce: [key.nonce],
    submods: {
      container: { image_digest: 'sha256:' + 'ab'.repeat(32), env: { TEE_IMAGE_VERSION: 'v0.17.0', TEE_IMAGE_COMMIT: 'c'.repeat(40) } },
      gce: { instance_id: '8895410255757640001' },
      nvidia_gpu: { cc_mode: 'ON', gpus: [{ hwmodel: 'GCP_NVIDIA_H100' }] },
    },
    ...overrides,
  };
}

describe('checkAttestationClaims', () => {
  it('accepts a production enclave the policy describes', async () => {
    const key = await evidenceKeyDescription();
    const summary = await checkAttestationClaims(await claimsFor(key), { origin: ORIGIN, policy: POLICY, document: { evidenceKey: key, tlsSpkiNonce: null } });
    expect(summary.imageDigest).toBe('sha256:' + 'ab'.repeat(32));
    expect(summary.release?.version).toBe('v0.17.0');
    expect(summary.instanceId).toBe('8895410255757640001');
    expect(summary.evidenceKeyNonce).toBe(key.nonce);
  });

  it('refuses a token for another audience, an old release, a debug image, and an unbound key', async () => {
    const key = await evidenceKeyDescription();
    const reasons = async (claims: Record<string, unknown>, document = { evidenceKey: key, tlsSpkiNonce: null }) => {
      try {
        await checkAttestationClaims(claims, { origin: ORIGIN, policy: POLICY, document });
        return [] as string[];
      } catch (error) {
        return error instanceof AttestationRefused ? error.reasons : [String(error)];
      }
    };
    expect((await reasons(await claimsFor(key, { aud: 'https://evil.example' }))).some((r) => r.includes('aud'))).toBe(true);
    const old = await claimsFor(key, { submods: { container: { image_digest: 'sha256:' + 'ab'.repeat(32), env: { TEE_IMAGE_VERSION: 'v0.12.0' } }, gce: { instance_id: '1' }, nvidia_gpu: { cc_mode: 'ON', gpus: [{}] } } });
    expect((await reasons(old)).some((r) => r.includes('older than'))).toBe(true);
    expect((await reasons(await claimsFor(key, { dbgstat: 'enabled' }))).some((r) => r.includes('debug'))).toBe(true);
    const otherKey = await evidenceKeyDescription();
    expect((await reasons(await claimsFor(key), { evidenceKey: otherKey, tlsSpkiNonce: null })).some((r) => r.includes('not bound'))).toBe(true);
  });
});

describe('the release signature', () => {
  const SIGNER = 'cfb085b950e93abb8332cede62fa50df662ef9aebb1533b2ae0bf1403ea4f811';
  const signed = { ...POLICY, image: { ...POLICY.image, signers: [SIGNER] } };
  const withSignatures = async (key: { nonce: string }, signatures: { key_id: string }[]) => {
    const claims = await claimsFor(key);
    (claims.submods.container as { image_signatures?: unknown }).image_signatures = signatures;
    return claims;
  };

  it('accepts an image the launcher verified with the key the policy names', async () => {
    const key = await evidenceKeyDescription();
    const claims = await withSignatures(key, [{ key_id: SIGNER.toUpperCase() }]);
    const summary = await checkAttestationClaims(claims, { origin: ORIGIN, policy: signed, document: { evidenceKey: key, tlsSpkiNonce: null } });
    expect(summary.release?.version).toBe('v0.17.0');
  });

  it('refuses an image signed by another key, or by none', async () => {
    const key = await evidenceKeyDescription();
    for (const signatures of [[{ key_id: 'ab'.repeat(32) }], []]) {
      const claims = await withSignatures(key, signatures);
      await expect(checkAttestationClaims(claims, { origin: ORIGIN, policy: signed, document: { evidenceKey: key, tlsSpkiNonce: null } }))
        .rejects.toThrow(/signatures the policy requires/);
    }
  });
});

describe('evidenceProblems', () => {
  const evidence = { v: 1 as const, role: 'whip' as const, fingerprint: 'sha-256 AB:CD', clientNonce: 'n1', sessionSecret: 'sec', sessionId: 's', iat: Math.floor(Date.now() / 1000) };
  const answer = 'v=0\r\na=fingerprint:sha-256 AB:CD\r\n';

  it('accepts the enclave\u2019s answer for this offer and relay session', () => {
    expect(evidenceProblems({ evidence, role: 'whip', answerSdp: answer, clientNonce: 'n1', location: '/ingest/whip/sec' })).toEqual([]);
  });

  it('refuses a mismatched fingerprint, nonce or session', () => {
    expect(evidenceProblems({ evidence, role: 'whip', answerSdp: 'v=0\r\na=fingerprint:sha-256 FF:EE\r\n', clientNonce: 'n1', location: '/ingest/whip/sec' }).length).toBeGreaterThan(0);
    expect(evidenceProblems({ evidence, role: 'whip', answerSdp: answer, clientNonce: 'other', location: '/ingest/whip/sec' }).length).toBeGreaterThan(0);
    expect(evidenceProblems({ evidence, role: 'whip', answerSdp: answer, clientNonce: 'n1', location: '/ingest/whip/other' }).length).toBeGreaterThan(0);
  });
});
