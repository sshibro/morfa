// The layers' names the canvas tools read and write: short aliases ("L12") the caller maps to the document's own layer ids.
import type {NodeId} from '../../../shared/design/types';

export type CanvasAliases = {
  /** The layer's alias, given now if it has none. */
  alias(id: NodeId): string;
  /** The alias a layer already has, or null (nothing is given). */
  known(id: NodeId): string | null;
  /** The layer an alias names, or null for an alias never given (or not an alias at all, or a layer the tools may not touch). */
  resolve(alias: string): NodeId | null;
};
