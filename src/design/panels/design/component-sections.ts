import type {DesignSection} from './sections';
import {ComponentSection} from './components/ComponentSection';
import {InstanceSection} from './components/InstanceSection';
import {VariableModesSection} from './components/VariableModesSection';
import {variableModesApply} from './components/variable-modes';

// The "Design" panel sections owned by the component feature (see sections.ts for the order numbers):
// "Component" / "Component set" / "Components" (10), "Instance" (10) and the variable modes of
// frames, "Variables" (55).
export const componentSections: DesignSection[] = [
  {
    id: 'component',
    order: 10,
    applies: ({nodes}) => nodes.length > 0 && nodes.every(node => (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') && node.mainId === undefined),
    Component: ComponentSection,
  },
  {
    id: 'instance',
    order: 10,
    applies: ({nodes}) => nodes.some(node => node.type === 'INSTANCE'),
    Component: InstanceSection,
  },
  {
    id: 'variable-modes',
    order: 55,
    applies: variableModesApply,
    Component: VariableModesSection,
  },
];
