// tests/postgresql-runtime-design-libraries.test.ts with DESIGN_COLLAB=shadow and lane B1's collab binary (tests/helpers/collab-modes.ts).
import {collabModeSuite} from './helpers/collab-modes';

await collabModeSuite('shadow', 'libraries', () => import('./postgresql-runtime-design-libraries.test'));
