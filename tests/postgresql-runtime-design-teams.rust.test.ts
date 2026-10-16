// tests/postgresql-runtime-design-teams.test.ts with DESIGN_COLLAB=rust and lane B1's collab binary (tests/helpers/collab-modes.ts).
import {collabModeSuite} from './helpers/collab-modes';

await collabModeSuite('rust', 'teams', () => import('./postgresql-runtime-design-teams.test'));
