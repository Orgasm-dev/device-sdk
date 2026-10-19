# orgasm.dev device SDK

The code that runs on the end user's device for an [orgasm.dev](https://orgasm.dev) live session: it verifies the enclave the session will be analysed in, seals every request to it, publishes the front camera and microphone straight to it, reads the session's events, and shows them in a heads-up display. orgasm.dev's servers never carry the media; only the numbers in the events leave the enclave.

It is the first place your users' video goes, so it is published for you to read, with no runtime dependencies: TypeScript over the platform's WebCrypto, WebRTC, `fetch` and custom elements. The part that touches the media and the enclave is the root entry point, about fourteen hundred lines; the camera prompt and the display are optional entry points of their own.

| Entry point | What it is |
| --- | --- |
| `@orgasm-dev/device` | Capability, attestation, sealing, publishing, and `subscribe` for the session's events |
| `@orgasm-dev/device/capture` | `requestCapture`: the camera and microphone, asked for well, with each refusal named and what to do about it |
| `@orgasm-dev/device/hud` | `<orgasm-hud>`, `<orgasm-capture-primer>`, and the model a game engine can draw from instead |

## Install

```sh
npm install @orgasm-dev/device
```

Each release is built from a tag of this repository by its [release workflow](.github/workflows/release.yml), with npm's provenance, and goes live only once a maintainer approves it with two-factor authentication: `npm audit signatures` checks that the package you installed was built here, at that tag.

## Use

```ts
import { newCapability, publishLiveSession } from '@orgasm-dev/device';
import { requestCapture } from '@orgasm-dev/device/capture';
import '@orgasm-dev/device/hud';

// 1. On the device: a capability only it holds. Your server gets its hash.
const { capability, capabilityHash } = await newCapability();

// 2. On your server, with your secret key: POST /v1/live-sessions { capabilityHash, consent, inputs }.
//    Hand the session (its `ingest` and `results`) back to the device.
const session = await yourServer.createLiveSession(capabilityHash);

// 3. On the device, from a click: the camera and microphone, then verify the enclave and publish.
const { stream } = await requestCapture();
const live = await publishLiveSession({ session, capability, stream });

// 4. Show it.
const hud = document.querySelector('orgasm-hud');
live.subscribe({ onEvent: (event) => hud.feed(event) });
hud.addEventListener('orgasm-hud-stop', () => live.stop({ releaseCamera: true }));
```

```html
<orgasm-hud layout="rail"></orgasm-hud>
```

[Live sessions](https://orgasm.dev/docs/guides/live-sessions) walks through the whole flow, and [Show the HUD](https://orgasm.dev/docs/guides/hud) every option of the display.

### Events without publishing

`subscribe` reads any session's events with a token for it: the session's client token on the device that publishes, or a read-only view token (`createViewToken`) for a second screen. It sends the token in a header, never in the URL, delivers each event once and in order, resumes after a dropped connection, and ends by itself after the session's final status. A sandbox session works the same way, so a HUD can be built without a camera.

```ts
import { subscribe, streamOf } from '@orgasm-dev/device';

const subscription = subscribe({ ...streamOf(session), onEvent: (event) => hud.feed(event) });
// later
subscription.close();
```

### The display

`<orgasm-hud>` has four layouts: `rail` (a side panel), `bar` (a strip across the page), `card` (a corner of a game) and `overlay` (a panel for a stream). It shows the phase (Calibrating, Building, Rising, Close, Very close; Onset, Peak, Afterglow), the chance of an orgasm within 30 seconds with the 60-second chance as a ghost mark, the last three minutes as a line with each call and edge marked where it happened, the counts of orgasms, ruins and edges, the session's clock, and what needs attention. On the person's device it always shows that analysis is on and a Stop control; only `stream` and the `overlay` layout, drawn into a video for others, leave them out.

- `show="phase gauge percent trend counts clock signals notices subject"` picks the parts; the subject read is never on by default.
- `theme="dark|light|auto"`, `size="sm|md|lg"`, `brand="off"`, and CSS custom properties (`--orgasm-hud-accent`, `--orgasm-hud-surface`, `--orgasm-hud-text`, `--orgasm-hud-font` and the rest) restyle it; `hud.strings = { phases: { close: '…' } }` rewords it.
- `hud.demo({ scenario: 'edge' })` plays a scripted session, with no network, for a design review or for placing an overlay.

To draw it yourself (a game engine, a canvas), use the model it draws:

```ts
import { hudReducer, hudView, initialHudState } from '@orgasm-dev/device/hud';

let state = initialHudState();
subscribe({ ...streamOf(session), onEvent: (event) => (state = hudReducer(state, event)) });
// every frame, or every second
const { phase, word, gauge, counts, clock } = hudView(state);
```

### Before the browser asks

`<orgasm-capture-primer>` tells the person, before the browser's prompt, what is measured, why the camera and why the microphone, that only numbers leave their device, who receives them and for how long, and that they can stop at any time. With `verify` set it checks the enclave first and says so; then it asks, and names any refusal with what to do about it in that browser. It explains; it is not the person's consent, which your product still asks for, records and attests.

```html
<orgasm-capture-primer developer="Lumen Games" retention-days="7"></orgasm-capture-primer>
<script type="module">
  const primer = document.querySelector('orgasm-capture-primer');
  primer.verify = () => verifyEnclave({ origin, policyUrl });
  primer.addEventListener('orgasm-capture', (e) => publish(e.detail.capture.stream));
</script>
```

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

The tests run in Node on its WebCrypto, and the elements under happy-dom; the seal's test vector is the one the enclave's own tests open, so the two stay byte-compatible. The display's model is held against the sandbox's scenarios (`test/fixtures`, each scenario's events as the sandbox sends them) by golden files in `test/golden`.

## License

Apache-2.0 (`LICENSE`, `NOTICE`).
