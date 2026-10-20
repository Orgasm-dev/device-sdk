// The one side effect of '@orgasm-dev/device/hud': the elements' names, where
// there is a registry. package.json lists this file and the entry that imports
// it in `sideEffects`, so a bundler keeps both and may drop the rest of what is
// not used. With the entry left out, Next.js's bundler builds the entry's
// exports straight from the modules they come from and never runs this import.

import { defineHud } from './element.ts';
import { definePrimer } from './primer.ts';

defineHud();
definePrimer();
