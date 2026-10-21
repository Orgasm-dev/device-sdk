# orgasm.dev device SDK

The code that runs on the end user's device for an [orgasm.dev](https://orgasm.dev) live session: it verifies the enclave the session will be analysed in, seals every request to it, publishes the front camera and microphone straight to it, reads the session's events, and shows them in a heads-up display. orgasm.dev's servers never carry the media; only the numbers in the events leave the enclave.

It is the first place your users' video goes, so it is published for you to read, with no runtime dependencies: TypeScript over the platform's WebCrypto, WebRTC, `fetch` and custom elements. The part that touches the media and the enclave is the root entry point, about fourteen hundred lines; the camera prompt and the display are optional entry points of their own.

| Entry point | What it is |
| --- | --- |
| `@orgasm-dev/device` | Capability, attestation, sealing, publishing, `subscribe` for the session's events, and `reportStimulation` for the device your product drives |
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
live.subscribe({ frames: ['face'], onEvent: (event) => hud.feed(event), onFaceFrame: (frame) => hud.feedFrame(frame) });
hud.addEventListener('orgasm-hud-stop', () => live.stop({ releaseCamera: true }));

// 5. If your product drives a device, say what it is doing; the HUD shows it beside the person's signals.
live.reportStimulation({ state: 'on', level: 31, levelMax: 60, mode: 'waves', device: { label: 'Unit' } });
```

```html
<orgasm-hud layout="panel"></orgasm-hud>
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

### Reporting the device

`live.reportStimulation(report)` tells orgasm.dev what the device your product drives is doing: whether stimulation is on, its `level` and `levelMax`, each output's level (`channels`, up to four), its `mode`, who sets the level (`drive`: `auto`, `manual`, `hold` or `paused`) and whether it is `connected`. A field you leave out keeps its last value, and `null` clears it. Reports are merged and sent at most four times a second, over the session's WebSocket while it is open and over HTTP while it is not, so a dial turned fast sends where it ended up. Each reaches every reader of the session as `stimulation.updated`. On your server, `stimulationReporter({ ...reporterOf(session), token: secretKey })` does the same over HTTP (a secret key never goes in a URL).

### The display

`<orgasm-hud>` has five layouts: `rail` (a side panel), `bar` (a strip across the page), `card` (a corner of a game), `overlay` (a panel for a stream) and `panel` (the whole display: the phase, the gauge and the stimulation strip over three pages, Signals, Face and Timeline, turned with tabs or a swipe). It shows the phase (Calibrating, Building, Rising, Close, Very close; Onset, Peak, Afterglow), the chance of an orgasm within 30 seconds with the 60-second chance as a ghost mark, the last three minutes as a line with each call and edge marked where it happened, the counts of orgasms, ruins and edges, the session's clock, and what needs attention. On the person's device it always shows that analysis is on and a Stop control; only `stream` and the `overlay` layout, drawn into a video for others, leave them out.

- `show="phase gauge percent trend counts clock signals notices subject stimulation face timeline"` picks the parts; the subject read is never on by default.
- `stimulation`: the device as your product reports it, its name, its mode in words, who sets the level, and a bar per output.
- `face`: a generic face (the Momentum Human Rig's mean head, which is no one's, its two sides each other's mirror) moved by the person's face channels, with the face's seven regions as meters beside it. It reads the channels once a second, and five times a second with `frames: ['face']` (`connect()` asks for them when the part is shown); a view token reads them only when it was made with `includeFace`. Where frames carry the head as the camera sees it (`cameraHead`), the head is drawn by that, past a neck's limits: a head held tilted, or lying on its side, is drawn as it is, and from before the baseline, a face at rest under the waiting words. The face is a separate chunk of about 37 KB, loaded the first time it is drawn.
- `timeline`: the whole session (up to three hours, in five-second bins) in three lanes on one time axis: imminence, each output's level with its changes of mode, and the body's rates; each lane draws only once it has something to show.
- `theme="dark|light|auto"`, `size="sm|md|lg"`, `brand="off"`, and CSS custom properties (`--orgasm-hud-accent`, `--orgasm-hud-surface`, `--orgasm-hud-text`, `--orgasm-hud-font` and the rest) restyle it; `hud.strings = { phases: { close: '…' } }` rewords it.
- `hud.demo({ scenario: 'edge' })` plays a scripted session, with no network, for a design review or for placing an overlay.

To draw it yourself (a game engine, a canvas), use the model it draws:

```ts
import { hudFrameReducer, hudReducer, hudView, initialHudState, loadFaceMesh, poseFace } from '@orgasm-dev/device/hud';

let state = initialHudState();
subscribe({
  ...streamOf(session),
  frames: ['face'],
  onEvent: (event) => (state = hudReducer(state, event)),
  onFaceFrame: (frame) => (state = hudFrameReducer(state, frame)),
});
// every frame, or every second
const { phase, word, gauge, counts, clock, stimulation, timeline, face } = hudView(state);
// the face's points, to draw the same face natively: its head as the camera sees it where a frame says so
const points = face?.channels ? poseFace(await loadFaceMesh(), face.channels, undefined, undefined, { cameraHead: face.cameraHead }) : null;
```

`headGlideTo` and `headAt` glide `cameraHead` between frames the short way round, beside `glideTo` and `faceAt` for the channels; `poseFace(…, { gains: false })` draws each channel at its value alone, for a face orgasm.dev did not measure.

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

The tests run in Node on its WebCrypto, and the elements under happy-dom; the seal's test vector is the one the enclave's own tests open, so the two stay byte-compatible. The display's model is held against the sandbox's scenarios (`test/fixtures`, each scenario's events as the sandbox sends them, and `toy`, a session with a reporting device) by golden files in `test/golden`. `scripts/face-mesh.mjs` writes `src/hud/face-mesh.ts` from a baked face.

## License

Apache-2.0 (`LICENSE`, `NOTICE`). The face (`src/hud/face-mesh.ts`) is derived from the Momentum Human Rig, Apache-2.0 too (`LICENSE-MHR`).
