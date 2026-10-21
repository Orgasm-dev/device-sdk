// '@orgasm-dev/device/hud': the heads-up display. Importing it registers
// <orgasm-hud> and <orgasm-capture-primer> (in a browser; on a server it is
// inert), and exports the model a game engine can draw from instead.
//
//   import '@orgasm-dev/device/hud';
//   <orgasm-hud layout="panel"></orgasm-hud>
//
//   import { hudReducer, hudFrameReducer, hudView, initialHudState } from '@orgasm-dev/device/hud';
//   import { loadFaceMesh, poseFace } from '@orgasm-dev/device/hud';   // the face's points, to draw natively
//   import { headAt, headGlideTo } from '@orgasm-dev/device/hud';      // a frame's cameraHead, glided the short way round

import './register.ts';

export {
  BASELINE_S,
  CALL_HOLD_S,
  FRAME_HOLD_MS,
  HISTORY_BIN_S,
  HISTORY_CAP_BINS,
  HUD_FRESH_MS,
  HUD_STRINGS,
  PHASE_LEVELS,
  REGION_CHANNELS,
  TREND_WINDOW_S,
  clockText,
  faceRegionsOf,
  hudFrameReducer,
  hudReducer,
  hudStrings,
  hudView,
  initialHudState,
  modeWords,
} from './model.ts';
export type {
  HistoryBin,
  HudFace,
  HudFaceView,
  HudHistory,
  HudLanePoint,
  HudMark,
  HudPhase,
  HudRegion,
  HudState,
  HudStimulationBar,
  HudStimulationView,
  HudStrings,
  HudTile,
  HudTimelineView,
  HudView,
  MarkKind,
  TrendPoint,
} from './model.ts';
export { CONNECTION_STRINGS, DEFAULT_PARTS, HUD_LAYOUTS, HUD_PAGES, HUD_PARTS, OrgasmHud, defineHud } from './element.ts';
export type { HudConnection, HudLayout, HudPage, HudPart } from './element.ts';
export {
  CAMERA_HEAD_LIMIT_DEG,
  FACE_AT_REST,
  FACE_BOX,
  FACE_LIGHTS,
  GLIDE_MAX_MS,
  GLIDE_MIN_MS,
  HEAD_LIMIT_DEG,
  cameraRotation,
  drawFace,
  faceAt,
  glideTo,
  headAt,
  headGlideTo,
  headGliding,
  headRotation,
  lightLevels,
  loadFaceMesh,
  poseFace,
} from './face.ts';
export type { DrawFaceOptions, FaceGlide, FaceMesh, FacePalette, FaceTone, HeadGlide, PoseFaceOptions } from './face.ts';
export { OrgasmCapturePrimer, PRIMER_STRINGS, definePrimer } from './primer.ts';
export type { PrimerState, PrimerStrings, PrimerVerified } from './primer.ts';
export { DEMO_SCENARIOS, demoCameraHead, demoEvents, demoFace, playDemo } from './demo.ts';
export type { DemoOptions, DemoScenario } from './demo.ts';
