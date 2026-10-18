// Verify the enclave before the device sends it any media.
//
// A live session's `ingest` names a WHIP endpoint on a confidential-computing
// enclave and the `attestationUrl` to check it by. This module fetches the
// enclave's Google Cloud Attestation token, verifies its RS256 signature
// against Google's JWKS, holds its claims to the attestation policy the API
// publishes (`GET /v1/attestation-policy?mode=live`), and checks that the
// enclave's Ed25519 evidence key is bound into the token. Then, on each
// WHIP/WHEP answer, it verifies the enclave's signature over the answer's
// DTLS fingerprint with that key; the browser's own DTLS handshake pins the
// media to the attested enclave from there.
//
// No framework and no dependencies beyond WebCrypto, so it runs in a browser,
// in a native WebView, and under a test runner. This is the device half of
// the enclave's wire protocol (workload/producer/tee_mode.py of the enclave's
// source, https://github.com/Masseuse-ai/masseuse-video-tee).

export interface AttestationPolicy {
  object: 'attestation_policy';
  mode: 'test' | 'live';
  version: string;
  enforced: boolean;
  issuer: string | null;
  hardware: string[];
  image: {
    source: string | null;
    minRelease: string | null;
    digests: string[];
    /** Fingerprints of the keys the image must be signed by; empty, none is required. */
    signers?: string[];
    repository?: string | null;
    releasesUrl?: string | null;
  };
  seal: { schemes: string[] };
  evidence: { algorithm: string };
  debugAllowed: boolean;
  note?: string;
  updatedAt: string;
}

export interface EvidenceKeyDescription {
  alg: string;
  publicKey: string;
  nonce: string;
}

export interface SealKeyDescription {
  alg: string;
  publicKey: string;
  statement: string;
}

/** What `GET /attestation` on an enclave answers. */
export interface AttestationDocument {
  token: string;
  nonces: string[];
  issuedAt: number;
  expiresAt?: number;
  tlsSpkiNonce: string | null;
  evidenceKey: EvidenceKeyDescription;
  sealKey?: SealKeyDescription;
}

/** The enclave's seal key, as `./seal` consumes it (an ECDH P-256 public key and its raw bytes). */
export interface SealKey {
  key: CryptoKey;
  raw: Uint8Array;
}

export interface VerifiedEnclave {
  origin: string;
  imageDigest: string;
  release: { version: string; commit: string } | null;
  instanceId: string;
  dbgstat: string;
  evidenceKey: CryptoKey;
  evidenceKeyRaw: string;
  evidenceKeyNonce: string;
  /** The enclave's seal key when it requires sealed requests, else null. */
  seal: SealKey | null;
  tlsSpkiNonce: string | null;
  tokenExpiresAt: number | null;
  verifiedAt: number;
}

export interface Evidence {
  v: number;
  role: 'whip' | 'whep';
  fingerprint: string;
  clientNonce: string;
  sessionSecret: string;
  sessionId: string;
  iat: number;
}

export const ATTESTATION_ISSUER = 'https://confidentialcomputing.googleapis.com';
export const ATTESTATION_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/metadata/jwk/signer@confidentialspace-sign.iam.gserviceaccount.com';
export const EXPECTED_SWNAME = 'CONFIDENTIAL_SPACE';
const JWKS_TTL_MS = 60 * 60_000;
const EVIDENCE_SKEW_S = 120;
const TOKEN_MIN_REMAINING_MS = 30_000;
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** The headers the enclave signs its answers with and the device seals under. */
export const EVIDENCE_HEADER = 'X-Masseuse-Evidence';
export const SEAL_HEADER = 'X-Masseuse-Seal';
export const CLIENT_NONCE_HEADER = 'X-Masseuse-Client-Nonce';

export class AttestationRefused extends Error {
  readonly reasons: string[];

  constructor(reasons: string[] | string) {
    const list = Array.isArray(reasons) ? reasons : [reasons];
    super(`attestation refused: ${list.join('; ')}`);
    this.name = 'AttestationRefused';
    this.reasons = list;
  }
}

// -- bytes --------------------------------------------------------------------

const subtle = (): SubtleCrypto => {
  const api = globalThis.crypto?.subtle;
  if (!api) throw new Error('WebCrypto is unavailable');
  return api;
};

export function b64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder();

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', bytes as BufferSource));
}

export async function sha256Nonce(bytes: Uint8Array): Promise<string> {
  return b64urlEncode(await sha256(bytes));
}

// -- the capability the device keeps ------------------------------------------

/**
 * The 32-byte secret the device keeps and presents (sealed) to the enclave;
 * only its hex SHA-256 goes to your server, as `capabilityHash`.
 */
export async function newCapability(): Promise<{ capability: string; capabilityHash: string }> {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  return { capability: b64urlEncode(raw), capabilityHash: hexEncode(await sha256(raw)) };
}

/** A per-offer nonce the enclave echoes inside its signed evidence. */
export function newClientNonce(): string {
  const raw = new Uint8Array(24);
  globalThis.crypto.getRandomValues(raw);
  return b64urlEncode(raw);
}

// -- Google's JWKS and the RS256 token ----------------------------------------

interface Jwk extends JsonWebKey {
  kid?: string;
}

let jwksCache: { url: string; keys: Jwk[]; fetchedAt: number } | null = null;

export function resetJwksCache(): void {
  jwksCache = null;
}

export async function fetchJwks(url: string, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<Jwk[]> {
  if (jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const response = await fetchImpl(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`JWKS ${response.status}`);
  const body = (await response.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error('JWKS carries no keys');
  jwksCache = { url, keys: body.keys, fetchedAt: now };
  return body.keys;
}

function decodeJson<T>(part: string): T {
  return JSON.parse(utf8Decoder.decode(b64urlDecode(part))) as T;
}

export async function verifyRs256(token: string, keys: Jwk[]): Promise<Record<string, unknown>> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new AttestationRefused('token is not a JWT');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson<{ alg?: string; kid?: string }>(headerPart);
  if (header.alg !== 'RS256') throw new AttestationRefused(`token alg is ${header.alg}, not RS256`);
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new AttestationRefused(`no JWKS key for kid ${header.kid}`);
  const key = await subtle().importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await subtle().verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(signaturePart) as BufferSource, utf8.encode(`${headerPart}.${payloadPart}`));
  if (!ok) throw new AttestationRefused('token signature does not verify');
  return decodeJson<Record<string, unknown>>(payloadPart);
}

// -- the claims ---------------------------------------------------------------

type Claims = Record<string, unknown> & {
  submods?: {
    container?: { image_digest?: string; env?: Record<string, string>; image_signatures?: { key_id?: string }[] };
    gce?: { instance_id?: string | number };
    nvidia_gpu?: { cc_mode?: string; gpus?: unknown[] };
  };
  eat_nonce?: string | string[];
};

function compareRelease(a: string, b: string): number {
  const parse = (tag: string) => {
    const body = tag.slice(1).split('+')[0]!;
    const dash = body.indexOf('-');
    const core = dash < 0 ? body : body.slice(0, dash);
    return { nums: core.split('.').map(Number), pre: dash < 0 ? '' : body.slice(dash + 1) };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (x.nums[i] !== y.nums[i]) return (x.nums[i] ?? 0) < (y.nums[i] ?? 0) ? -1 : 1;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === '') return 1;
  if (y.pre === '') return -1;
  return x.pre < y.pre ? -1 : 1;
}

/**
 * Hold verified claims to the published policy. Returns the summary (without
 * the imported keys); throws AttestationRefused listing every failed check.
 */
export async function checkAttestationClaims(
  claims: Claims,
  { origin, policy, document, now = Date.now() }: { origin: string; policy: AttestationPolicy; document: Pick<AttestationDocument, 'evidenceKey' | 'tlsSpkiNonce'>; now?: number },
): Promise<Omit<VerifiedEnclave, 'evidenceKey' | 'seal'>> {
  const reasons: string[] = [];
  const container = claims.submods?.container ?? {};
  const gce = claims.submods?.gce ?? {};
  const gpu = claims.submods?.nvidia_gpu ?? {};
  const issuer = policy.issuer ?? ATTESTATION_ISSUER;

  if (claims.iss !== issuer) reasons.push(`iss is ${String(claims.iss)}`);
  if (claims.aud !== origin) reasons.push(`aud is ${String(claims.aud)}, not ${origin}`);
  const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
  if (exp === null) reasons.push('token has no exp');
  else if (exp - now < TOKEN_MIN_REMAINING_MS) reasons.push('token has expired or is about to');
  if (claims.swname !== EXPECTED_SWNAME) reasons.push(`swname is ${String(claims.swname)}`);
  if (claims.secboot !== true) reasons.push('secure boot is not on');
  // The hardware the policy names (e.g. Intel TDX, an H100 in CC mode).
  if (policy.hardware.some((h) => /tdx/i.test(h)) && claims.hwmodel !== 'GCP_INTEL_TDX') reasons.push(`hwmodel is ${String(claims.hwmodel)}`);
  if (policy.hardware.some((h) => /h100|gpu|confidential computing/i.test(h))) {
    if (gpu.cc_mode !== 'ON') reasons.push(`GPU confidential computing is ${gpu.cc_mode ?? 'absent'}`);
    if (!Array.isArray(gpu.gpus) || !gpu.gpus.length) reasons.push('no GPU in the attestation');
  }

  const digest = container.image_digest ?? '';
  if (!digest) reasons.push('no image digest in the attestation');
  else if (policy.image.digests.length && !policy.image.digests.includes(digest)) reasons.push(`image ${digest} is not in the policy`);

  // The launcher verified the image's signature before it started it and
  // reports the key it verified with; the policy names the release key.
  const signers = (policy.image.signers ?? []).map((k) => k.toLowerCase());
  if (signers.length) {
    const keyIds = (container.image_signatures ?? []).map((s) => String(s?.key_id ?? '').toLowerCase());
    if (!keyIds.some((id) => signers.includes(id))) reasons.push('image carries none of the signatures the policy requires');
  }

  const env = container.env ?? {};
  const version = typeof env.TEE_IMAGE_VERSION === 'string' ? env.TEE_IMAGE_VERSION : '';
  const release = version ? { version, commit: typeof env.TEE_IMAGE_COMMIT === 'string' ? env.TEE_IMAGE_COMMIT : '' } : null;
  if (policy.image.minRelease) {
    if (!release) reasons.push(`image carries no release stamp, policy requires ${policy.image.minRelease} or later`);
    else if (!RELEASE_TAG.test(release.version)) reasons.push(`image release ${release.version} is not a release tag`);
    else if (compareRelease(release.version, policy.image.minRelease) < 0) reasons.push(`image release ${release.version} is older than the policy's minimum ${policy.image.minRelease}`);
  }

  if (claims.dbgstat === 'disabled-since-boot') {
    // production
  } else if (claims.dbgstat === 'enabled') {
    if (!policy.debugAllowed) reasons.push('debug image, policy does not allow debug');
  } else {
    reasons.push(`dbgstat is ${String(claims.dbgstat)}`);
  }

  const nonces = Array.isArray(claims.eat_nonce) ? claims.eat_nonce : claims.eat_nonce ? [claims.eat_nonce] : [];
  const key = document.evidenceKey;
  let evidenceKeyNonce = '';
  if (!key || key.alg !== (policy.evidence.algorithm ?? 'Ed25519') || typeof key.publicKey !== 'string') {
    reasons.push('no Ed25519 evidence key in the attestation document');
  } else {
    const raw = b64urlDecode(key.publicKey);
    if (raw.length !== 32) reasons.push('evidence key is not 32 bytes');
    else {
      evidenceKeyNonce = await sha256Nonce(raw);
      if (!nonces.includes(evidenceKeyNonce)) reasons.push('evidence key is not bound into the attestation');
    }
  }
  const tlsSpkiNonce = typeof document.tlsSpkiNonce === 'string' && nonces.includes(document.tlsSpkiNonce) ? document.tlsSpkiNonce : null;

  const instanceId = gce.instance_id !== undefined && gce.instance_id !== null ? String(gce.instance_id) : '';
  if (!instanceId) reasons.push('no GCE instance id');

  if (reasons.length) throw new AttestationRefused(reasons);
  return {
    origin,
    imageDigest: digest,
    release,
    instanceId,
    dbgstat: String(claims.dbgstat),
    evidenceKeyRaw: (key as EvidenceKeyDescription).publicKey,
    evidenceKeyNonce,
    tlsSpkiNonce,
    tokenExpiresAt: exp,
    verifiedAt: now,
  };
}

// -- the evidence and seal keys -----------------------------------------------

export async function importEvidenceKey(publicKeyB64url: string): Promise<CryptoKey> {
  return subtle().importKey('raw', b64urlDecode(publicKeyB64url) as BufferSource, { name: 'Ed25519' }, false, ['verify']);
}

export async function importSealKey(description: SealKeyDescription | undefined): Promise<SealKey | null> {
  if (!description || typeof description.publicKey !== 'string') return null;
  const raw = b64urlDecode(description.publicKey);
  const key = await subtle().importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  return { key, raw };
}

export async function verifyEvidence(evidence: string, key: CryptoKey): Promise<Evidence> {
  const [version, body, signature, ...rest] = evidence.split('.');
  if (version !== 'v1' || !body || !signature || rest.length) throw new AttestationRefused('evidence is malformed');
  const bodyBytes = b64urlDecode(body);
  const ok = await subtle().verify({ name: 'Ed25519' }, key, b64urlDecode(signature) as BufferSource, bodyBytes as BufferSource);
  if (!ok) throw new AttestationRefused('evidence signature does not verify');
  const payload = JSON.parse(utf8Decoder.decode(bodyBytes)) as Evidence;
  if (payload.v !== 1) throw new AttestationRefused(`evidence version ${String(payload.v)}`);
  return payload;
}

export function parseFingerprint(sdp: string): string | null {
  const match = /^a=fingerprint:\s*([A-Za-z0-9-]+)\s+([0-9A-Fa-f:]+)\s*$/m.exec(sdp);
  if (!match) return null;
  return `${match[1]!.toLowerCase()} ${match[2]!.toUpperCase()}`;
}

export function evidenceProblems(
  { evidence, role, answerSdp, clientNonce, location, now = Date.now() }:
  { evidence: Evidence; role: 'whip' | 'whep'; answerSdp: string; clientNonce: string; location: string | null; now?: number },
): string[] {
  const reasons: string[] = [];
  if (evidence.role !== role) reasons.push(`evidence is for ${evidence.role}, not ${role}`);
  const fingerprint = parseFingerprint(answerSdp);
  if (!fingerprint) reasons.push('answer carries no DTLS fingerprint');
  else if (evidence.fingerprint !== fingerprint) reasons.push("evidence fingerprint is not the answer's");
  if (evidence.clientNonce !== clientNonce) reasons.push("evidence nonce is not this offer's");
  const secret = location ? (location.split('/').filter(Boolean).pop() ?? '') : '';
  if (!secret) reasons.push('answer carries no Location');
  else if (evidence.sessionSecret !== secret) reasons.push('evidence is for another relay session');
  if (typeof evidence.iat !== 'number' || Math.abs(now / 1000 - evidence.iat) > EVIDENCE_SKEW_S) reasons.push('evidence is stale');
  return reasons;
}

// -- the whole check ----------------------------------------------------------

/**
 * Fetch the policy and the enclave's attestation, verify the token against
 * Google's JWKS, hold it to the policy, and import the evidence and seal
 * keys. Throws AttestationRefused (policy) or a plain Error (network, JWKS).
 */
export async function verifyEnclave(
  { origin, policyUrl, policy, fetchImpl = fetch, now = Date.now }:
  { origin: string; policyUrl?: string; policy?: AttestationPolicy; fetchImpl?: typeof fetch; now?: () => number },
): Promise<VerifiedEnclave> {
  const resolvedPolicy = policy ?? (await (async () => {
    if (!policyUrl) throw new Error('verifyEnclave needs a policy or a policyUrl');
    const response = await fetchImpl(policyUrl, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`attestation policy ${response.status}`);
    return (await response.json()) as AttestationPolicy;
  })());
  if (!resolvedPolicy.enforced) throw new AttestationRefused('the policy does not enforce attestation (test mode)');
  const response = await fetchImpl(`${origin}/attestation`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  if (response.status === 503) throw new Error('enclave attestation is not ready yet');
  if (!response.ok) throw new Error(`enclave /attestation ${response.status}`);
  const document = (await response.json()) as AttestationDocument;
  const keys = await fetchJwks(ATTESTATION_JWKS_URL, fetchImpl, now());
  const claims = (await verifyRs256(document.token, keys)) as Claims;
  const summary = await checkAttestationClaims(claims, { origin, policy: resolvedPolicy, document, now: now() });
  const evidenceKey = await importEvidenceKey(summary.evidenceKeyRaw);
  const seal = await importSealKey(document.sealKey);
  return { ...summary, evidenceKey, seal };
}

/** The gate a WHIP/WHEP peer runs before setRemoteDescription. Throws AttestationRefused. */
export async function verifyAnswerEvidence(
  { enclave, role, headers, answerSdp, clientNonce, now = Date.now() }:
  { enclave: VerifiedEnclave; role: 'whip' | 'whep'; headers: Headers; answerSdp: string; clientNonce: string; now?: number },
): Promise<Evidence> {
  const header = headers.get(EVIDENCE_HEADER);
  if (!header) throw new AttestationRefused('answer carries no evidence header');
  const evidence = await verifyEvidence(header, enclave.evidenceKey);
  const problems = evidenceProblems({ evidence, role, answerSdp, clientNonce, location: headers.get('location'), now });
  if (problems.length) throw new AttestationRefused(problems);
  return evidence;
}
