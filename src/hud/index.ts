// '@orgasm-dev/device/hud': the heads-up display. Importing it registers
// <orgasm-hud> and <orgasm-capture-primer> (in a browser; on a server it is
// inert), and exports the model a game engine can draw from instead.
//
//   import '@orgasm-dev/device/hud';
//   <orgasm-hud layout="rail"></orgasm-hud>
//
//   import { hudReducer, hudView, initialHudState } from '@orgasm-dev/device/hud';

import './register.ts';

export {
  BASELINE_S,
  CALL_HOLD_S,
  HUD_FRESH_MS,
  HUD_STRINGS,
  PHASE_LEVELS,
  TREND_WINDOW_S,
  clockText,
  hudReducer,
  hudStrings,
  hudView,
  initialHudState,
} from './model.ts';
export type { HudMark, HudPhase, HudState, HudStrings, HudTile, HudView, MarkKind, TrendPoint } from './model.ts';
export { CONNECTION_STRINGS, DEFAULT_PARTS, HUD_LAYOUTS, HUD_PARTS, OrgasmHud, defineHud } from './element.ts';
export type { HudConnection, HudLayout, HudPart } from './element.ts';
export { OrgasmCapturePrimer, PRIMER_STRINGS, definePrimer } from './primer.ts';
export type { PrimerState, PrimerStrings, PrimerVerified } from './primer.ts';
export { DEMO_SCENARIOS, demoEvents, playDemo } from './demo.ts';
export type { DemoOptions, DemoScenario } from './demo.ts';
