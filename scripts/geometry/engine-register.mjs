// Lane L1: `node --import ./scripts/geometry/engine-register.mjs` registers tsx and then the geometry engine hooks
// (engine-hooks.mjs), which therefore see each module after tsx compiled it.
import {register} from 'node:module';
import {register as registerTsx} from 'tsx/esm/api';

registerTsx();
register('./engine-hooks.mjs', import.meta.url);
