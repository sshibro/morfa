// tests/postgresql-runtime-design-teams.test.ts with DESIGN_COLLAB=shadow and lane B1's collab binary (tests/helpers/collab-modes.ts).
import {collabModeSuite} from './helpers/collab-modes';

await collabModeSuite('shadow', 'teams', () => import('./postgresql-runtime-design-teams.test'));
