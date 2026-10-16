import type {ViteDevServer} from 'vite';

// The e2e app is the Vite dev server, which transforms a module the first time a browser asks for it. The editor's
// module graph is hundreds of files, and the heavy parts of it (the design editor, boards, meetings, export) load
// only when a spec first opens them. On a two-core runner those first transforms took longer than
// a spec waits, and a spec passed only on a retry,
// which found everything already transformed. Walking the graph once before the first spec starts moves that cost
// out of the specs and into the server's start-up.

/** What the specs open in a browser: the application (index.html → src/main.tsx). */
export const WARM_ENTRIES: readonly string[] = ['/src/main.tsx'];
/** Transforms in flight at once; the server is one process, so more only queues. */
const WARM_CONCURRENCY = 6;
/** Pre-bundled dependencies are files already; nothing to transform. */
const PREBUNDLED = '/node_modules/.vite/';

export type WarmResult = {modules: number; failed: number; ms: number};

/** Transforms every module reachable from `entries` (static and dynamic imports alike) so the dev server holds each result. */
export async function warmModuleGraph(vite: ViteDevServer, entries: readonly string[] = WARM_ENTRIES): Promise<WarmResult> {
  const started = Date.now();
  const seen = new Set<string>();
  const queue = [...entries];
  let running = 0;
  let failed = 0;

  async function visit(url: string) {
    try {
      const result = await vite.transformRequest(url);
      if (!result) return;
      const module = await vite.moduleGraph.getModuleByUrl(url);
      for (const imported of module?.importedModules ?? []) {
        if (imported.url.startsWith('/') && !imported.url.startsWith(PREBUNDLED) && !seen.has(imported.url)) queue.push(imported.url);
      }
    } catch {
      // A module a spec never loads may not transform (a fixture-only import); the specs that need it report it themselves.
      failed += 1;
    }
  }

  await new Promise<void>(resolve => {
    const pump = () => {
      while (running < WARM_CONCURRENCY && queue.length) {
        const url = queue.pop()!;
        if (seen.has(url)) continue;
        seen.add(url);
        running += 1;
        void visit(url).finally(() => {
          running -= 1;
          pump();
        });
      }
      if (!running && !queue.length) resolve();
    };
    pump();
  });
  return {modules: seen.size, failed, ms: Date.now() - started};
}
