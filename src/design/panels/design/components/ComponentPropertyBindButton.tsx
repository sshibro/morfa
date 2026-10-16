import {useCallback} from 'react';
import type {NodeId} from '../../../../../shared/design/types';
import {propertyDefinitionsOf, propertyName, type BindableProperty} from '../../../../../shared/design/components';
import {useEditorServices} from '../../../editor/services';
import {IconButton} from '../../../ui/Button';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {IconInstance} from '../../../ui/icons';
import {bindLayer, createPropertyFor} from './actions';
import {useDocValue} from './hooks';
import {bindableField, mainOfLayer, TYPE_FOR_FIELD} from './model';
import '../../../styles/panel-components.css';

// "◇" next to a field of a layer inside a main component: bind the field to a property of the
// component, create a property from it, or unbind. Visibility (the eye) takes BOOLEAN properties, a
// text's content TEXT ones, a nested instance's component INSTANCE_SWAP ones. The layer and text
// panels drop it beside their fields; it renders nothing for layers outside a main component.
//
//   <ComponentPropertyBindButton nodeId={id} field="visible" />

export type ComponentPropertyBindButtonProps = {
  nodeId: NodeId;
  field: BindableProperty;
  className?: string;
};

type BindState = {componentId: NodeId; bound: string | null; boundName: string | null} | null;

export function ComponentPropertyBindButton({nodeId, field, className = ''}: ComponentPropertyBindButtonProps) {
  const services = useEditorServices();
  const store = services.store;
  const state = useDocValue(services, (doc): BindState => {
    const node = doc.nodes[nodeId];
    const componentId = mainOfLayer(doc, nodeId);
    if (!componentId || !bindableField(node, field)) return null;
    const bound = node.componentPropertyReferences?.[field] ?? null;
    return {componentId, bound, boundName: bound ? propertyName(bound) : null};
  });
  const menu = useMenuTrigger({
    label: 'Component property',
    minWidth: 200,
    items: useCallback((): MenuItem[] => {
      if (!state) return [];
      const doc = store.getState().doc;
      const type = TYPE_FOR_FIELD[field];
      const options = Object.entries(propertyDefinitionsOf(doc, state.componentId)).filter(([, def]) => def.type === type);
      return [
        {type: 'label', label: 'Bind to property'},
        ...(options.length
          ? options.map(([key]): MenuItem => ({id: key, label: propertyName(key), checked: key === state.bound, onSelect: () => bindLayer(store, nodeId, field, key === state.bound ? null : key)}))
          : [{id: 'none', label: 'No matching properties', disabled: true, onSelect: () => {}} satisfies MenuItem]),
        {type: 'separator'},
        {id: 'create', label: 'Create property', onSelect: () => void createPropertyFor(store, state.componentId, nodeId, field)},
        ...(state.bound ? [{id: 'unbind', label: 'Unbind', onSelect: () => bindLayer(store, nodeId, field, null)} satisfies MenuItem] : []),
      ];
    }, [state, store, nodeId, field]),
  });
  if (!state) return null;
  const label = state.boundName ? `Component property: ${state.boundName}` : 'Bind to component property';
  return (
    <>
      <IconButton label={label} className={`dz-cmp-bind ${state.bound ? 'is-bound' : ''} ${className}`.trim()} {...menu.triggerProps}><IconInstance size={14} /></IconButton>
      {menu.element}
    </>
  );
}
