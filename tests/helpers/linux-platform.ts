// Imported first by the tests that say «node is not a Mac» (design-align, design-boolean-commands, design-editor-commands).
//
// The design keyboard reads navigator.platform (src/design/engine/keyboard.ts and src/design/ui/shortcuts.ts isMacPlatform),
// some of it once, when a module loads: the off-Mac keys of src/design/engine/commands/align.ts and mask.ts. Node 22 reports
// the host there, «MacIntel» on a Mac, while these tests were written and verified on Linux. Evaluated before any design module
// of the test file, this pins Linux's value for the file's run and puts the host's back when the file's tests are done.
import {after} from 'node:test';

const LINUX_PLATFORM = 'Linux x86_64';
const own = Object.getOwnPropertyDescriptor(globalThis.navigator, 'platform');

Object.defineProperty(globalThis.navigator, 'platform', {value: LINUX_PLATFORM, configurable: true});

after(() => {
  if (own) Object.defineProperty(globalThis.navigator, 'platform', own);
  else Reflect.deleteProperty(globalThis.navigator, 'platform');
});
