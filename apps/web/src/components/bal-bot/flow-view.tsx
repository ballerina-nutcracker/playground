import React, { useEffect, useMemo, useState } from 'react';
import type { FlowUI, Id, Located } from '@bal-bot/workspace';
import { instantiateGraph } from './hir-flow';
import type { DiagramNode, ExpansionPath } from './hir-diagram';
import { layoutDiagram } from './flow';
import { FlowSvg, flowBounds, nodeLabelSize, templateSections, wrapLabel, type FlowSvgData, type FunctionInteraction } from './flow-svg';
import { FlowEntry } from './flow-entry';
import { wrappedVariables } from './variable-text';
import { FunctionCards } from './function-cards';

export interface FlowViewProps {readonly flow: FlowUI; readonly references: readonly Located[]; readonly expanded: ReadonlySet<ExpansionPath>; readonly onToggle: (path: ExpansionPath) => void; readonly onSelect: (node: Located) => void; readonly onOpenFunction: (id: Id) => void;}

export function FlowView(props: FlowViewProps): React.JSX.Element {
  const state = props.flow.state;
  const program = state.kind === 'ready' ? state.program : state.previous;
  const selection = props.flow.selection;
  if (program?.functionViews && selection.kind === 'function') {
    const views = {...program, functions: program.functionViews};
    const viewState = state.kind === 'ready' ? {...state, program: views} : {...state, previous: views};
    return <FunctionCards key={selection.functionId} entryId={selection.functionId} graphs={program.functionViews} render={(id, functions) => <FlowDiagram {...props} flow={{state: viewState, selection: {kind: 'function', functionId: id}}} expanded={EMPTY_EXPANSION} functions={functions}/>}/>;
  }
  return <FlowDiagram {...props}/>;
}
const EMPTY_EXPANSION: ReadonlySet<ExpansionPath> = new Set();
function FlowDiagram({flow, references, expanded, onToggle, onSelect, onOpenFunction, functions}: FlowViewProps & {functions?: FunctionInteraction}): React.JSX.Element {
  const isReferenced = (node: Located) => references.some(reference => reference.id === node.id && reference.text === node.text && JSON.stringify(reference.source) === JSON.stringify(node.source));
  const state = flow.state, program = state.kind === 'ready' ? state.program : state.previous, ready = state.kind === 'ready';
  const selection = flow.selection;
  const [hover, setHover] = useState<{id: string; state: typeof state; selection: typeof selection} | undefined>();
  const activeVariable = ready && hover?.state === state && hover.selection === selection ? hover.id : undefined;
  const onVariableHover = (id: string | undefined) => setHover(ready && id ? {id, state, selection} : undefined);
  useEffect(() => { setHover(undefined); }, [state, selection, expanded]);
  const entryFunction = program && selection.kind === 'function' && Object.hasOwn(program.functions, selection.functionId) ? program.functions[selection.functionId] : undefined;
  const layout = useMemo(() => program && selection.kind === 'function' ? layoutDiagram(instantiateGraph(program, selection.functionId, expanded), nodeLabelSize) : undefined, [program, selection.kind, selection.kind === 'function' ? selection.functionId : selection.scopeId, expanded]);
  const nodes: DiagramNode[] = [];
  const collect = (items: readonly DiagramNode[]) => { for (const n of items) {nodes.push(n); collect(n.children);} }; if (layout) collect(layout.diagram.nodes);
  const visible = nodes.filter(n => n.layout.visibility.node && n.layout.visibility.header && n.presentation.kind !== 'hidden');
  const data: FlowSvgData | undefined = layout && {
    bounds: flowBounds(visible.map(n => layout.boxes[n.id]), [...layout.routes]),
    nodes: visible.map(n => {
      const presentation = n.presentation;
      if (presentation.kind === 'hidden') throw new Error('Hidden HIR node in visible presentation.');
      const reference = n.layout.reference, recursive = reference?.recursive, recursivePresentation = recursive ? reference?.recursivePresentation : undefined;
      const disclosure = presentation.disclosure;
      const context = disclosure.kind === 'client-context' ? {path: n.contextPath!, expanded: !!n.contextExpanded} : undefined;
      const callDisclosure = disclosure.kind === 'call' ? disclosure : disclosure.kind === 'client-context' ? disclosure.call : null;
      const content = recursivePresentation ?? (disclosure.kind === 'client-context' ? (n.contextExpanded ? disclosure.expanded : disclosure.collapsed) : presentation);
      const sections = content.sections;
      const lines = wrapLabel(n.label);
      const unavailable = recursivePresentation?.limitation ?? reference?.unavailable ?? presentation.limitation ?? undefined;
      const call = callDisclosure && reference ? {
        path: reference.path, expanded: reference.expanded, unavailable,
        title: recursivePresentation?.title ?? unavailable ?? 'Expand workspace function',
        ariaLabel: recursivePresentation?.ariaLabel ?? `${reference.expanded ? 'Collapse' : 'Expand'} ${n.label}`,
        glyph: recursivePresentation?.glyph ?? (reference.expanded ? '−' : '+'),
      } : undefined;
      const template = templateSections(n);
      return {calls: n.calls, id: n.id, kind: n.kind, selection: n.selection, label: n.label, box: layout.boxes[n.id], height: Math.max(52, nodeLabelSize(n.label, n).height + 28), selected: isReferenced(n.selection), container: n.layout.visibility.container && n.children.length > 0, recursive, client: presentation.kind === 'client', template: !!template,
        text: lines.join('\n'), rawVariables: content.variables, variables: wrappedVariables(n.label, lines, content.variables), sections: template ?? sections.map(section => { const wrapped = wrapLabel(section.text); return {className: section.kind.startsWith('error-') ? section.kind : `client-${section.kind}`, text: wrapped.join('\n'), rawText: section.text, variables: wrappedVariables(section.text, wrapped, section.variables)}; }), context, call, unavailable};
    }),
    edges: layout.diagram.edges.map((edge, i) => ({kind: edge.kind, label: edge.label, route: layout.routes[i]})),
    iterations: layout.diagram.ports.filter(p => p.anchor.kind === 'iteration-marker').map(p => ({id: p.id, box: layout.boxes[p.nodeId]})),
  };
  return <div className="flow-view" data-analysis={state.kind} onPointerLeave={() => setHover(undefined)} onPointerCancel={() => setHover(undefined)}>
    {!ready && <div className="flow-notice" role="status">{state.kind === 'pending' ? 'Analyzing saved source…' : state.kind === 'failed' ? state.message : 'Fix the source errors to refresh this flow.'}{program && ' Displayed flow is stale. Source references are disabled.'}</div>}
    {(state.kind === 'invalid' || state.kind === 'ready') && state.diagnostics.length > 0 && <ul className="flow-diagnostics">{state.diagnostics.map((d,i) => <li key={i}>{d.file}{d.range ? `:${d.range.start.line}` : ''}: {d.message}</li>)}</ul>}
    {!program && state.kind !== 'pending' && <p className="flow-notice">No valid source analysis is available.</p>}
    {program && selection.kind === 'definitions' && (() => {
      const scope = program.scopes.find(s => s.id === selection.scopeId); if (scope?.kind !== 'service') return null;
      return <div className="definitions">{(['function','type','connector','configurable'] as const).map(kind => {
        const defs = scope.definitions.filter(d => d.kind === kind); if (!defs.length) return null;
        return <section key={kind}><h2>{({function:'Functions',type:'Types',connector:'Connectors',configurable:'Configurables'})[kind]}</h2>{defs.map(def => <div className="definition" key={def.id}><button disabled={!ready && def.kind !== 'function'} onClick={() => def.kind === 'function' ? onOpenFunction(def.functionId) : onSelect(def)}>{def.label}</button></div>)}</section>;
      })}</div>;
    })()}
    {layout && data && <div className="diagram-scroll">
      {entryFunction && <FlowEntry key={entryFunction.id} entry={entryFunction.entry} activeVariable={activeVariable} onVariableHover={onVariableHover}/>}
      {data.nodes.length > 0 ? <FlowSvg data={data} ready={ready} onSelect={onSelect} onToggle={onToggle} functions={functions} activeVariable={activeVariable} onVariableHover={onVariableHover}/> : <p className="flow-empty">No statements in this function.</p>}
    </div>}
  </div>;
}
