// tests/postgresql-runtime-design-file-changes.test.ts with DESIGN_COLLAB=shadow and lane B1's collab binary (tests/helpers/collab-modes.ts).
import {collabModeSuite} from './helpers/collab-modes';

await collabModeSuite('shadow', 'file-changes', () => import('./postgresql-runtime-design-file-changes.test'));
