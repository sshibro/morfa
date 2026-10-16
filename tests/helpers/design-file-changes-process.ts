// A second app process for tests/postgresql-runtime-design-file-changes.test.ts: it saves layers of one design file through the files
// API with its own document cache, save queue and catch-up timer, as another process of the app would (docs/design-tool.md "Saving
// large files"). Arguments: file id, owner id, session hash, layer ids (comma-separated), saves, and `keep` to leave its changes
// waiting when it stops (as a process that crashed). Prints `ready`, then the x each layer was last saved with as JSON.
import type {SceneNode} from '../../shared/design/types';

const [fileId, ownerId, sessionHash, layerList, count, keep] = process.argv.slice(2);
const layers = layerList.split(',');
const files = await import('../../server/design/files');
const store = await import('../../server/design/document-store');
const {closeDatabase} = await import('../../server/db');
const actor = Object.freeze({ownerId, sessionHash});

const opened = await files.openDesignFile(actor, fileId);
const doc = JSON.parse(String(opened.documentText)) as {nodes: Record<string, SceneNode>};
let version = opened.file.version;
const mine: Record<string, SceneNode> = Object.fromEntries(layers.map(id => [id, doc.nodes[id]]));
console.log('ready');
for (let k = 0; k < Number(count); k++) {
  const id = layers[k % layers.length];
  const node = {...mine[id], x: 5000 + k};
  try {
    version = (await files.patchDesignDocument(actor, fileId, {baseVersion: version, patch: {nodes: {[id]: node}}, before: {[id]: mine[id]}, client: null})).version;
    mine[id] = node;
  } catch (error) {
    // Lost the race with the other process four times over: the editor would send the same change again.
    if ((error as {code?: string}).code !== 'version_conflict') throw error;
    k--;
  }
  await new Promise(resolve => setTimeout(resolve, Math.random() * 6));
}
if (keep !== 'keep') await store.flushDocumentWrites();
console.log(JSON.stringify(Object.fromEntries(layers.map(id => [id, mine[id].x]))));
await closeDatabase();
