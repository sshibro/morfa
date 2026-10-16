import {memo, useMemo, useState} from 'react';
import type {InteractiveState} from '../../../../shared/design/codegen/model';
import type {ComponentInfo, Framework, PropInfo} from '../../../../shared/design/codegen/react';
import {Button} from '../../ui/Button';
import {IconComponent, IconInstance} from '../../ui/icons';
import {PanelSection} from '../../ui/PanelSection';
import {Select, type SelectEntry} from '../../ui/Select';
import {TextInput} from '../../ui/TextInput';
import {Toggle} from '../../ui/Toggle';
import {CodeView} from './CodeView';
import {CopyButton} from './CopyButton';
import {propsOfUsage, usageFor, type PlaygroundValue} from './inspect';

// A component in "Code": its props as the code takes them (types, defaults, the designer's names), the interaction
// states that became CSS, and a playground (Figma's "Explore component behavior"): any props, the usage that gives
// them, without touching the design.

const STATES: Record<InteractiveState, {selector: string; label: string}> = {
  hover: {selector: ':hover', label: 'hover'},
  active: {selector: ':active', label: 'active'},
  focus: {selector: ':focus-visible', label: 'focus'},
  disabled: {selector: ':disabled', label: 'disabled'},
};

export const ComponentSection = memo(function ComponentSection({info, instance, onGoToMain, framework = 'react'}: {info: ComponentInfo; instance: boolean; onGoToMain?: () => void; framework?: Framework}) {
  return (
    <PanelSection title={instance ? 'Component instance' : 'Component'} className="dz-code-component">
      <div className="dz-code-component-head">
        <span className="dz-code-component-icon" aria-hidden="true">{instance ? <IconInstance /> : <IconComponent />}</span>
        <code className="dz-code-component-name">{`<${info.name}>`}</code>
        {info.element && <span className="dz-code-component-element" title={framework === 'vue' ? 'Attributes and handlers that are not in props go to this element: @click, aria-*…' : 'Accepts the properties of this element: onClick, aria-*, ref…'}>{info.element === 'svg' ? 'svg' : `<${info.element}>`}</span>}
        {onGoToMain && <Button variant="ghost" size={24} onClick={onGoToMain}>Go to main</Button>}
      </div>
      {info.props.length > 0 && (
        <dl className="dz-code-props">
          {info.props.map(prop => <PropRow key={prop.name} prop={prop} />)}
        </dl>
      )}
      {!!info.states?.length && (
        <div className="dz-code-states">
          <span className="dz-code-states-title">States in CSS, not in properties</span>
          <ul>{info.states.map(state => <li key={state}><code>{info.stateSelectors?.[state] ?? STATES[state].selector}</code> {STATES[state].label}</li>)}</ul>
        </div>
      )}
      {/* Another component or instance starts from its own props; the same one keeps what was set as the file changes. */}
      <Playground key={`${framework}|${info.nodeId}|${info.usage ?? info.examples?.[0] ?? ''}`} info={info} framework={framework} />
    </PanelSection>
  );
});

function PropRow({prop}: {prop: PropInfo}) {
  return (
    <div className="dz-code-prop" title={prop.comment}>
      <dt className="dz-code-prop-head">
        <code className="dz-code-prop-name">{prop.name}{prop.required ? '' : '?'}</code>
        <span className="dz-code-prop-original">{prop.native ? 'element property' : prop.original}</span>
        {prop.defaultValue !== null && <code className="dz-code-prop-default" title={`Default: ${prop.defaultValue}`}>{prop.defaultValue}</code>}
      </dt>
      <dd><code className="dz-code-prop-type">{prop.type}</code></dd>
    </div>
  );
}

/** The props a playground can set: variants, switches, texts. A swapped icon keeps its default. */
const editable = (prop: PropInfo) => prop.kind !== 'slot';

const Playground = memo(function Playground({info, framework}: {info: ComponentInfo; framework: Framework}) {
  const initial = useMemo(() => propsOfUsage(info, info.usage ?? info.examples?.[0]), [info]);
  const [values, setValues] = useState<Record<string, PlaygroundValue>>(initial);
  const props = info.props.filter(editable);
  if (!props.length) return null;
  const usage = usageFor(info, values, framework);
  const set = (name: string, value: PlaygroundValue) => setValues(current => ({...current, [name]: value}));
  return (
    <PanelSection title="Playground" collapsible defaultOpen={false} className="dz-code-playground">
      <div className="dz-code-playground-fields">
        {props.map(prop => <PlaygroundField key={prop.name} prop={prop} value={values[prop.name]} onChange={value => set(prop.name, value)} />)}
      </div>
      <div className="dz-code-block">
        <div className="dz-code-bar">
          <span className="dz-code-bar-title">Usage</span>
          <Button variant="ghost" size={24} onClick={() => setValues(initial)} disabled={usage === usageFor(info, initial, framework)}>Reset</Button>
          <CopyButton text={usage} label="Copy usage" />
        </div>
        <CodeView code={usage} language={framework === 'vue' ? 'html' : 'tsx'} maxLines={4} label="Component usage with the selected properties" />
      </div>
    </PanelSection>
  );
});

function PlaygroundField({prop, value, onChange}: {prop: PropInfo; value: PlaygroundValue | undefined; onChange: (value: PlaygroundValue) => void}) {
  const label = prop.name === 'children' ? 'children (label)' : prop.name === 'default' && prop.native ? 'default slot (label)' : prop.name;
  if (prop.kind === 'variant' && prop.options) {
    const options: SelectEntry<string>[] = prop.options.map((option, i) => ({value: option, label: `${option.replace(/^'|'$/g, '')}${prop.labels?.[i] && prop.labels[i] !== option.replace(/^'|'$/g, '') ? ` — ${prop.labels[i]}` : ''}`}));
    return (
      <label className="dz-code-playground-field">
        <span className="dz-code-playground-label">{label}</span>
        <Select value={String(value ?? prop.defaultValue ?? '')} options={options} onChange={onChange} aria-label={`Property ${prop.name}`} />
      </label>
    );
  }
  if (prop.kind === 'variantBool' || prop.kind === 'boolean' || prop.kind === 'disabled') {
    return (
      <div className="dz-code-playground-field is-toggle">
        <Toggle checked={value === true} onChange={onChange} aria-label={`Property ${prop.name}`}>
          <code>{prop.name}</code>
        </Toggle>
      </div>
    );
  }
  return (
    <label className="dz-code-playground-field">
      <span className="dz-code-playground-label">{label}</span>
      <TextInput value={String(value ?? '')} onChange={onChange} aria-label={`Property ${prop.name}`} placeholder={prop.required ? 'Required' : 'Not set'} />
    </label>
  );
}
