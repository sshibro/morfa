// Shared by the browser harnesses (harness.ts for Canvas2D, gpu-harness.ts for the GPU renderer): the page's
// painted area and the fixture listing.

import type {DesignDocument, NodeId} from '../../shared/design/types';
import type {Rect} from '../../shared/design/geometry';
import {renderBounds, unionRect} from '../../shared/design/bounds';
import type {FontRegistry} from '../../src/design/engine/contracts';
import {FIXTURES} from './fixtures';

/** Page bounds of a page's visible top-level content (what the editor's "zoom to fit" would frame). */
export function pageArea(doc: DesignDocument, pageId: NodeId, fonts: FontRegistry): Rect | null {
  let area: Rect | null = null;
  for (const id of doc.nodes[pageId]?.children ?? []) {
    const rect = renderBounds(doc, id, {measurer: fonts.measurer});
    if (rect) area = area ? unionRect(area, rect) : rect;
  }
  return area;
}

export function listFixtures(documentOf: (name: string) => DesignDocument): {name: string; source: string; pages: {id: NodeId; name: string; nodes: number}[]}[] {
  return FIXTURES.map(fixture => {
    const doc = documentOf(fixture.name);
    const count = (pageId: NodeId) => {
      let n = 0;
      const stack = [pageId];
      while (stack.length) {
        const node = doc.nodes[stack.pop()!];
        if (!node) continue;
        n++;
        if (node.children) stack.push(...node.children);
      }
      return n;
    };
    return {name: fixture.name, source: fixture.source, pages: doc.pages.map(id => ({id, name: doc.nodes[id].name, nodes: count(id)}))};
  });
}
