# orgasm.dev device SDK

The code that runs on the end user's device for an [orgasm.dev](https://orgasm.dev) live session: it verifies the enclave the session will be analysed in, seals every request to it, and publishes the front camera and microphone straight to it. orgasm.dev's servers never carry the media; only the numbers in the events leave the enclave.

It is the first place your users' video goes, so it is published for you to read: no runtime dependencies, about a thousand lines of TypeScript over the platform's WebCrypto, WebRTC, `fetch` and `EventSource`.

## Install

```sh
npm install @orgasm-dev/device
```

Each release is built and published from a tag of this repository by its [release workflow](.github/workflows/release.yml), with npm's provenance: `npm audit signatures` checks that the package you installed was built here, at that tag. Until the first release is on npm, install a tag straight from this repository, which builds it on install:

```sh
npm install github:Orgasm-dev/device-sdk#v0.1.0
```

## Use

```ts
import { newCapability, publishLiveSession } from '@orgasm-dev/device';

// 1. On the device: a capability only it holds. Your server gets its hash.
const { capability, capabilityHash } = await newCapability();

// 2. On your server, with your secret key: POST /v1/live-sessions { capabilityHash, consent, inputs }.
//    Hand the session (its `ingest` and `results.clientToken`) back to the device.
const session = await yourServer.createLiveSession(capabilityHash);

// 3. On the device: verify the enclave, then publish.
const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
const live = await publishLiveSession({ session, capability, stream });
const stop = live.events((event) => render(event)); // imminence, onset, peak, end, status
// later
stop();
await live.stop();
```

[Live sessions](https://orgasm.dev/docs/guides/live-sessions) walks through the whole flow.

## What it checks before a frame leaves the device

`publishLiveSession` throws `AttestationRefused`, and sends nothing, unless all of these hold ([`src/attestation.ts`](src/attestation.ts)):

1. The enclave's attestation token is signed by Google's Confidential Space attestation service (RS256, against Google's published keys), was minted for this enclave's origin, and has not expired.
2. Its claims match the [attestation policy](https://orgasm.dev/docs/api/trust/getAttestationPolicy) orgasm.dev publishes: Confidential Space on Intel TDX with Secure Boot, an NVIDIA H100 in confidential-computing mode, debugging disabled since boot, an image signed by a key the policy names, stamped with a release no older than its minimum, and its digest among the policy's when it lists any.
3. The enclave's Ed25519 evidence key is bound into the token.

Then every request under the device's capability is sealed to a key the attestation names ([`src/seal.ts`](src/seal.ts): ECDH P-256, HKDF-SHA256, AES-256-GCM), and the WHIP answer is applied only after its DTLS fingerprint verifies against the evidence key ([`src/publish.ts`](src/publish.ts)), so the media session can only end inside the attested enclave.

The enclave itself is open source as well: [its source](https://github.com/Masseuse-ai/masseuse-video-tee), and [Verify the enclave](https://orgasm.dev/docs/guides/verify) for checking a release's SLSA provenance and a session's attestation yourself.

## Develop

```sh
npm install
npm run check   # types, tests, the build and the wording policy
```

The tests run in Node on its WebCrypto; the seal's test vector is the one the enclave's own tests open, so the two stay byte-compatible.

## License

Apache-2.0 (`LICENSE`, `NOTICE`).
