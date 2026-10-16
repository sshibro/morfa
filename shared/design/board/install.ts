import {installBoardNormalize} from '../normalize';
import {connectorsIn, fitBoardObjects, routeConnectors} from './normalize';

// "Board" (docs/board.md §Objects): plugs the board's normalization steps (sticky text fit, connectors that follow their objects)
// into shared/design/normalize.ts. Called where boards open: the board editor's chunk (src/design/board/editor), the board
// templates and the tests. A design file's code never imports this, so it never carries the steps.

let installed = false;

export function installBoardSteps(): void {
  if (installed) return;
  installed = true;
  installBoardNormalize({fit: fitBoardObjects, connectorsIn, route: routeConnectors});
}
