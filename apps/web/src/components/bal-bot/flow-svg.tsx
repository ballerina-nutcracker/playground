import React from 'react';
import type { Id, Located, HIRVariableOccurrence, HIRCallSpan } from '@bal-bot/workspace';
import { VariableText, wrappedVariables, type VariableHover } from './variable-text';
import type { DiagramNode } from './hir-diagram';

export interface FunctionInteraction {
  readonly open: (id: Id) => void;
  readonly highlight: (id: Id | null) => void;
}
export interface FlowBox { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface FlowSvgNode {
  readonly calls?: readonly HIRCallSpan[];
  readonly id: Id; readonly kind: string; readonly selection: Located; readonly label: string; readonly box: FlowBox;
  readonly height: number; readonly selected: boolean; readonly container: boolean; readonly recursive?: boolean;
  readonly variables?: readonly HIRVariableOccurrence[];
  readonly rawVariables?: readonly HIRVariableOccurrence[];
  readonly template?: boolean;
  readonly client: boolean; readonly sections: readonly {readonly className: string; readonly text: string; readonly rawText?: string; readonly variables?: readonly HIRVariableOccurrence[]}[];
  readonly text: string; readonly context?: {readonly path: string; readonly expanded: boolean};
  readonly call?: {readonly path: string; readonly expanded: boolean; readonly unavailable?: string; readonly title: string; readonly ariaLabel: string; readonly glyph: string}; readonly unavailable?: string;
}
export interface FlowSvgData {
  readonly bounds: FlowBox;
  readonly nodes: readonly FlowSvgNode[];
  readonly edges: readonly {readonly kind: string; readonly label?: string; readonly route: readonly {readonly x: number; readonly y: number}[]}[];
  readonly iterations: readonly {readonly id: Id; readonly box: FlowBox}[];
}
let canvas: HTMLCanvasElement | undefined;
export function wrapLabel(label: string, width = 340): string[] {
  canvas ??= document.createElement('canvas'); const ctx = canvas.getContext('2d')!; ctx.font = '13px monospace';
  const lines = label.split('\n').flatMap(line => {
    const result = ['']; for (const char of line) { if (ctx.measureText(result[result.length - 1] + char).width > width) result.push(''); result[result.length - 1] += char; } return result;
  });
  return lines;
}
export function labelSize(label: string): {width: number; height: number} {
  const lines = wrapLabel(label), ctx = canvas!.getContext('2d')!;
  return {width: Math.max(200, ...lines.map(l => ctx.measureText(l).width)), height: lines.length * 19};
}
/** Matches the fixed columns in .template-header; label remains the full source. */
export const templateColumns = { type: 56, gap: 12, expression: 272 } as const;
export function templateSections(node: DiagramNode): {className: string; text: string; rawText: string; variables?: readonly HIRVariableOccurrence[]}[] | undefined {
  const p = node.presentation;
  if (p.kind !== 'plain' || p.style !== 'template' || p.sections.map(s => s.kind).join(',') !== 'template-type,template-expression') return undefined;
  return p.sections.map((section, index) => {
    const lines = wrapLabel(section.text, index === 0 ? templateColumns.type : templateColumns.expression);
    return {className: section.kind, text: lines.join('\n'), rawText: section.text, variables: wrappedVariables(section.text, lines, section.variables)};
  });
}
export function nodeLabelSize(label: string, node: DiagramNode): {width: number; height: number} {
  const sections = templateSections(node);
  return sections ? {width: templateColumns.type + templateColumns.gap + templateColumns.expression, height: Math.max(1, ...sections.map(s => s.text.split('\n').length)) * 19} : labelSize(label);
}
export function flowBounds(boxes: readonly FlowBox[], routes: FlowSvgData['edges'][number]['route'][]): FlowBox {
  const points = routes.flat();
  const left = Math.min(...points.map(p => p.x), ...boxes.map(b => b.x), 0 === boxes.length ? 0 : Infinity);
  const right = Math.max(1, ...points.map(p => p.x), ...boxes.map(b => b.x + b.width));
  const top = Math.min(...points.map(p => p.y), ...boxes.map(b => b.y), 0 === boxes.length ? 0 : Infinity);
  const bottom = Math.max(1, ...points.map(p => p.y), ...boxes.map(b => b.y + b.height + 48));
  return {x: left - 32, y: top, width: right - left + 64, height: bottom - top + 16};
}
function CallLabel({node, functions, ready, onSelect, activeVariable, onVariableHover}: VariableHover & {node: FlowSvgNode; functions: FunctionInteraction; ready: boolean; onSelect: (node: Located) => void}): React.JSX.Element {
  const content = (start: number, end: number) => {
  const spans: React.ReactNode[] = [];
  let offset = start;
  const text = (start: number, end: number) => {
    const variables = node.rawVariables?.filter(v => v.start >= start && v.end <= end).map(v => ({...v, start: v.start - start, end: v.end - start}));
    if (end > start) spans.push(<span key={`text-${start}`} onClick={() => ready && onSelect(node.selection)}><VariableText text={node.label.slice(start, end)} variables={variables} activeVariable={activeVariable} onVariableHover={onVariableHover}/></span>);
  };
  for (const call of node.calls ?? []) {
    if (call.start < start || call.end > end) continue;
    text(offset, call.start);
    const available = call.targetId !== null && call.unavailable === null;
    spans.push(<button key={call.start} className="function-call-name" disabled={!available} title={call.unavailable ?? 'Open function body'} aria-label={`Open ${node.label.slice(call.start, call.end)}`} onClick={() => available && functions.open(call.targetId!)} onMouseEnter={() => available && functions.highlight(call.targetId)} onMouseLeave={() => functions.highlight(null)} onFocus={() => available && functions.highlight(call.targetId)} onBlur={() => functions.highlight(null)}>{node.label.slice(call.start, call.end)}</button>);
    offset = call.end;
  }
  text(offset, end);
  return spans;
  };
  let offset = 0;
  const structured = node.client || node.kind === 'error-constructor' || node.template;
  return <div className="node-select call-label">{structured ? node.sections.map((section, i) => {
    // The type column is presentation metadata, not a prefix of the source label.
    // Source spans use UTF-16 offsets, so use raw source lengths (never wrapped text).
    if (node.template && section.className === 'template-type') return <span key={i} className={section.className}>{section.text}</span>;
    if (node.template && section.className === 'template-expression') offset = /^(?:string|xml)\s+/.exec(node.label)?.[0].length ?? 0;
    const start = offset;
    offset += (section.rawText ?? section.text).length;
    const result = <span key={i} className={section.className}>{content(start, offset)}</span>;
    if (node.client) offset++;
    return result;
  }) : content(0, node.label.length)}<button className="statement-reference" aria-pressed={node.selected} disabled={!ready} aria-label={`Reference ${node.label}`} onClick={() => onSelect(node.selection)}>↗</button></div>;
}
/** Presentation only: adapters supply all labels, disclosure state and geometry. */
export function FlowSvg({data: {bounds, nodes, edges, iterations}, ready, onSelect, onToggle, functions, activeVariable, onVariableHover}: VariableHover & {data: FlowSvgData; ready: boolean; onSelect: (node: Located) => void; onToggle: (path: string) => void; functions?: FunctionInteraction}): React.JSX.Element {
  const instanceId = React.useId();
  const arrowId = functions ? `flow-arrow-${instanceId}` : 'flow-arrow';
  return <><div className="flow-entry-connector" aria-hidden="true"/><svg className="diagram" width={bounds.width} height={bounds.height} viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} style={{maxWidth: bounds.width}} role="group" aria-label="Source flow diagram">
      <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10Z" fill="#7c8899" /></marker></defs>
      {nodes.filter(n => n.container).map(n => { const b = n.box; return <rect key={n.id} className={`container ${n.kind}`} x={b.x} y={b.y} width={b.width} height={b.height} rx="12" />; })}
      {edges.map((edge,i) => { const route = edge.route; return <g key={i} data-edge-kind={edge.kind}><polyline points={route.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke="#7c8899" strokeWidth="1.4" markerEnd={`url(#${arrowId})`} />{(edge.label || ['true','false'].includes(edge.kind)) && <text x={route[0].x + (edge.kind === 'true' ? -10 : 10)} y={route[0].y - 8} textAnchor={edge.kind === 'true' ? 'end' : 'start'} className="edge-label">{edge.label ?? edge.kind}</text>}</g>; })}
      {iterations.map(p => { const b = p.box; return <g key={p.id} className="iteration-marker"><circle cx={b.x + b.width / 2 - 70} cy={b.y + b.height - 28} r="4" fill="#7c8899"/><text x={b.x + b.width / 2 - 60} y={b.y + b.height - 24} className="edge-label">next iteration</text></g>; })}
      {nodes.map(n => {
        const b = n.box, height = n.height, selected = n.selected;
        return <g key={n.id} data-node-kind={n.kind} data-node-id={n.selection.id} data-recursive={n.recursive || undefined}>
          <rect x={b.x} y={b.y} width={b.width} height={height} className={`flow-node ${n.kind}${selected ? ' referenced' : ''}${activeVariable && (n.client || n.kind === 'error-constructor' || n.template ? n.sections.some(s => s.variables?.some(v => v.variableId === activeVariable)) : n.variables?.some(v => v.variableId === activeVariable)) ? ' variable-related' : ''}${n.recursive ? ' recursive' : ''}`} rx={n.kind === 'condition' ? 20 : 8}/>
          <foreignObject x={b.x+(b.width-Math.min(400,b.width))/2+10} y={b.y+8} width={Math.min(400,b.width)-20} height={height-(n.template ? 16 : 12)}><div className={`node-header${n.client ? ' client-header' : n.kind === 'error-constructor' ? ' error-header' : ''}${n.template ? ' template-header' : ''}${n.call || n.context ? ' has-disclosure' : ''}`}>{functions && n.calls?.length ? <CallLabel node={n} functions={functions} ready={ready} onSelect={onSelect} activeVariable={activeVariable} onVariableHover={onVariableHover}/> : <button className="node-select" aria-pressed={selected} disabled={!ready} onClick={() => onSelect(n.selection)} aria-label={`Reference ${n.label}`}>{n.client || n.kind === 'error-constructor' || n.template ? n.sections.map((section, i) => <span key={i} className={section.className}><VariableText text={section.text} variables={section.variables} activeVariable={activeVariable} onVariableHover={onVariableHover}/></span>) : <VariableText text={n.text} variables={n.variables} activeVariable={activeVariable} onVariableHover={onVariableHover}/>}</button>}</div></foreignObject>
          {n.context && <foreignObject x={b.x+b.width-38} y={b.y+8} width="30" height="30"><button className="node-disclosure" title="Show client initialization" aria-label={`${n.context.expanded ? 'Collapse' : 'Expand'} client initialization`} aria-expanded={n.context.expanded} onClick={() => onToggle(n.context!.path)}>{n.context.expanded ? '−' : '+'}</button></foreignObject>}
          {n.call && <foreignObject className="node-disclosure-slot" x={b.x+8} y={b.y+8} width="30" height="30"><button className="node-disclosure" disabled={!!n.call.unavailable} title={n.call.title} aria-label={n.call.ariaLabel} aria-expanded={!n.call.unavailable && n.call.expanded} onClick={() => onToggle(n.call!.path)}>{n.call.glyph}</button></foreignObject>}
          {n.unavailable && <foreignObject x={b.x} y={b.y+height+3} width={b.width} height="48"><div className="node-limitation">{n.unavailable}</div></foreignObject>}
        </g>;
      })}
    </svg></>;
}
