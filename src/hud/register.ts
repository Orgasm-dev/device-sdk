// The one side effect of '@orgasm-dev/device/hud': the elements' names, where
// there is a registry. package.json lists this file in `sideEffects`, so a
// bundler keeps it and may drop the rest of what is not used.

import { defineHud } from './element.ts';
import { definePrimer } from './primer.ts';

defineHud();
definePrimer();
