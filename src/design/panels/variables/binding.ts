import type {DesignDocument, NodeId, VariableType} from '../../../../shared/design/types';
import {BINDABLE_FIELDS, bindPaintVariable, bindVariable} from '../../../../shared/design/variables';
import {chainEdits, runEdit} from '../../engine/commands/components';
import type {DesignStore} from '../../engine/store';
import {MIXED, type Mixed} from '../design/components/model';

// What a variable binding of the selection is, and binding one (VariableBindButton.tsx draws them).

export type VariableBindTarget = {field: string} | {paint: 'fills' | 'strokes'; index: number};

export type VariableBindingState = {
  type: VariableType;
  /** The bound variable, MIXED when the layers differ, null when none is bound. */
  variableId: string | Mixed | null;
  name: string | null;
};

export const VARIABLE_TYPE_LABELS: Record<VariableType, string> = {FLOAT: 'Number', BOOLEAN: 'Boolean', STRING: 'String', COLOR: 'Color'};
const targetType = (target: VariableBindTarget): VariableType | undefined => ('paint' in target ? 'COLOR' : BINDABLE_FIELDS[target.field]);

function boundId(doc: DesignDocument, id: NodeId, target: VariableBindTarget): string | null {
  const node = doc.nodes[id];
  if (!node) return null;
  if ('paint' in target) {
    const paint = node[target.paint][target.index];
    return paint?.type === 'SOLID' ? paint.boundVariables?.color?.id ?? null : null;
  }
  return node.boundVariables?.[target.field]?.id ?? null;
}

/** What the selected layers have bound to the target (null when the target takes no variables). */
export function bindingState(doc: DesignDocument, ids: readonly NodeId[], target: VariableBindTarget): VariableBindingState | null {
  const type = targetType(target);
  if (!type || !ids.length) return null;
  let variableId: string | Mixed | null | undefined;
  for (const id of ids) {
    const bound = boundId(doc, id, target);
    variableId = variableId === undefined ? bound : variableId === bound ? variableId : MIXED;
  }
  const name = typeof variableId === 'string' ? doc.variables[variableId]?.name ?? null : null;
  return {type, variableId: variableId ?? null, name};
}

/** Binds (or with null unbinds) the target of every layer in `ids` to a variable, as one undo step. */
export function bindVariableTo(store: DesignStore, ids: readonly NodeId[], target: VariableBindTarget, variableId: string | null): void {
  runEdit(store, variableId ? 'Bind variable' : 'Detach variable', doc => chainEdits(doc, ids, (current, id) => ('paint' in target
    ? bindPaintVariable(current, id, target.paint, target.index, variableId)
    : bindVariable(current, id, target.field, variableId))), {tracked: new Set(ids)});
}
