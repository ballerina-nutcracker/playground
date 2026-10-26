import type { Id } from '@bal-bot/workspace';
import type { Diagram, DiagramNode } from './hir-diagram';
export type { Diagram, DiagramNode, DiagramPort, DiagramEdge, ExpansionPath } from './hir-diagram';
export { instantiateGraph } from './hir-flow.ts';
export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number; }
export interface DiagramLayout { readonly diagram: Diagram; readonly boxes: Readonly<Record<Id, Box>>; readonly routes: readonly (readonly { readonly x: number; readonly y: number }[])[]; readonly width: number; readonly height: number; }

export function layoutDiagram<D extends Diagram>(diagram: D, measure: (label: string, node: DiagramNode) => {width: number; height: number}): Omit<DiagramLayout, 'diagram'> & {readonly diagram: D} {
  const boxes: Record<Id, Box> = {}, exits = new Map<Id, number>(), sizes = new Map<Id, {width: number; height: number}>();
  const gap = 52, padding = 30, lane = 48;
  const measureNode = (node: DiagramNode) => measure(node.label, node);
  const renderNodes = new Map<Id, DiagramNode>();
  const collectNodes = (nodes: readonly DiagramNode[]) => { for (const node of nodes) { renderNodes.set(node.id, node); collectNodes(node.children); } };
  collectNodes(diagram.nodes);
  const geometryNodes = new Map(diagram.geometry?.nodes.map(node => [node.id, node]) ?? []);
  const ownership = diagram.geometry?.parents ?? new Map<Id, Id>();
  const owned = new Map<Id | undefined, Id[]>();
  for (const id of geometryNodes.keys()) { const parent = ownership.get(id), children = owned.get(parent) ?? []; children.push(id); owned.set(parent, children); }
  for (const [owner, group] of diagram.geometry?.groups ?? []) owned.set(owner, [...group.members]);
  // Visibility suppresses emission, not an explicit column arrangement. Retain
  // those owners only in the layout tree; sequence/root wrappers remain
  // transparent and the emitted hierarchy is never changed.
  const carriers = [...geometryNodes.values()].filter(node => !renderNodes.has(node.id) && node.layout.split !== undefined);
  let layoutNodes = diagram.nodes;
  if (carriers.length) {
    const retained = new Map([...renderNodes, ...carriers.map(node => [node.id, node] as const)]);
    const children = new Map<Id | undefined, DiagramNode[]>(), copies = new Map<Id, DiagramNode>();
    const retain = (id: Id): void => {
      if (copies.has(id)) return;
      let parent = ownership.get(id);
      while (parent && !retained.has(parent)) parent = ownership.get(parent);
      if (parent) retain(parent);
      const copy = { ...retained.get(id)!, children: [] };
      copies.set(id, copy);
      const siblings = children.get(parent) ?? []; siblings.push(copy); children.set(parent, siblings);
    };
    // Preserve emission order, inserting a non-rendering owner at its first
    // descendant. Empty column owners still use the existing numeric layout.
    for (const id of retained.keys()) retain(id);
    for (const [id, copy] of copies) {
      let members = children.get(id) ?? [];
      const left = diagram.geometry?.groups.get(id)?.left;
      if (left) {
        const isLeft = (child: DiagramNode) => {
          let member = child.id;
          while (ownership.has(member) && ownership.get(member) !== id) member = ownership.get(member)!;
          return left.has(member);
        };
        const leftChildren = members.filter(isLeft);
        members = [...leftChildren, ...members.filter(child => !isLeft(child))];
        (copy as { layout: DiagramNode['layout'] }).layout = { ...copy.layout, split: leftChildren.length };
      }
      (copy as { children: readonly DiagramNode[] }).children = members;
    }
    layoutNodes = children.get(undefined) ?? [];
  }
  for (const [id, node] of renderNodes) geometryNodes.set(id, node);
  const sequenceSize = (nodes: readonly DiagramNode[]) => { const dimensions = nodes.map(size); return {width: Math.max(240, ...dimensions.map(d => d.width)), height: dimensions.reduce((h, d) => h + d.height + gap, 0)}; };
  const size = (node: DiagramNode): {width: number; height: number} => {
    const label = measureNode(node), layout = node.layout, header = Math.max(52, label.height + 28), own = Math.max(240, Math.min(440, label.width + 72));
    let result: {width: number; height: number};
    if (layout.split !== undefined) {
      const left = sequenceSize(node.children.slice(0, layout.split)), right = sequenceSize(node.children.slice(layout.split));
      result = {width: Math.max(left.width + right.width + lane * 2, left.width + own + lane, right.width + own + lane), height: header + Math.max(left.height, right.height) + gap * 2};
    } else if (node.children.length) { const child = sequenceSize(node.children); result = {width: Math.max(own, child.width + padding * 2 + lane * 2), height: (layout.root ? 0 : header + gap) + child.height + padding + gap}; }
    else result = {width: own, height: header};
    sizes.set(node.id, result); return result;
  };
  layoutNodes.forEach(size);
  const placeSequence = (nodes: readonly DiagramNode[], x: number, y: number, width: number) => { for (const node of nodes) { const s = sizes.get(node.id)!; place(node, x + (width - s.width) / 2, y); y += s.height + gap; } };
  const place = (node: DiagramNode, x: number, y: number) => {
    const s = sizes.get(node.id)!, layout = node.layout, header = Math.max(52, measureNode(node).height + 28);
    const conditionWidth = Math.max(240, Math.min(440, measureNode(node).width + 72));
    boxes[node.id] = layout.split !== undefined ? {x: x + (s.width - conditionWidth) / 2, y, width: conditionWidth, height: header} : {x, y, ...s};
    exits.set(node.id, y + s.height);
    if (layout.split !== undefined) {
      const leftNodes = node.children.slice(0, layout.split), rightNodes = node.children.slice(layout.split), left = sequenceSize(leftNodes), right = sequenceSize(rightNodes);
      placeSequence(leftNodes, x, y + header + gap, left.width);
      placeSequence(rightNodes, x + s.width - right.width, y + header + gap, right.width);
    } else placeSequence(node.children, x + padding + lane, y + (layout.root ? 0 : header + gap), s.width - 2 * (padding + lane));
  };
  const total = sequenceSize(layoutNodes); placeSequence(layoutNodes, 40, 40, total.width);
  const portMap = new Map(diagram.ports.map(p => [p.id, p]));
  // Transparent sequences do not participate in sizing, placement or obstacles.
  // Their anchors span already placed descendants. A transparent leaf anchors
  // at its structural insertion point (next sibling's top, previous sibling's
  // bottom, or the owning sequence's start), without reserving display space.
  const placedBounds = (id: Id): Box | undefined => {
    if (boxes[id]) return boxes[id];
    const descendants = (owned.get(id) ?? []).map(placedBounds).filter((box): box is Box => box !== undefined);
    if (!descendants.length) return undefined;
    const x = Math.min(...descendants.map(box => box.x)), y = Math.min(...descendants.map(box => box.y));
    return { x, y, width: Math.max(...descendants.map(box => box.x + box.width)) - x, height: Math.max(...descendants.map(box => box.y + box.height)) - y };
  };
  const anchorBox = (id: Id): Box => {
    const bounds = placedBounds(id);
    if (bounds) return bounds;
    let current = id;
    for (;;) {
      const parent = ownership.get(current), siblings = owned.get(parent) ?? [], index = siblings.indexOf(current);
      for (const sibling of siblings.slice(index + 1)) { const next = placedBounds(sibling); if (next) return { x: next.x + next.width / 2, y: next.y, width: 0, height: 0 }; }
      for (const sibling of siblings.slice(0, index).reverse()) { const previous = placedBounds(sibling); if (previous) return { x: previous.x + previous.width / 2, y: previous.y + previous.height, width: 0, height: 0 }; }
      if (!parent) return { x: 40 + total.width / 2, y: 40, width: 0, height: 0 };
      const owner = renderNodes.get(parent), box = boxes[parent];
      if (owner && box) return { x: box.x + box.width / 2, y: box.y + (owner.layout.root ? 0 : Math.max(52, measureNode(owner).height + 28) + gap), width: 0, height: 0 };
      current = parent;
    }
  };
  // Resolve together against placed display nodes, never against other newly
  // synthesized anchors, so the result is independent of port first-use order.
  const hiddenBounds = new Map<Id, Box>();
  for (const port of diagram.ports) if (!boxes[port.nodeId]) {
    if (!geometryNodes.has(port.nodeId)) throw new Error(`Missing flow geometry owner ${port.nodeId}`);
    hiddenBounds.set(port.nodeId, anchorBox(port.nodeId));
  }
  for (const [id, box] of hiddenBounds) { boxes[id] = box; exits.set(id, box.y + box.height); }
  const point = (id: Id) => {
    const p = portMap.get(id)!; const b = boxes[p.nodeId], node = geometryNodes.get(p.nodeId)!;
    const header = renderNodes.has(node.id) ? Math.max(52, measureNode(node).height + 28) : 0;
    switch (p.anchor.kind) {
      case 'top-center': return {x: b.x + b.width / 2, y: b.y - (node.layout.root ? 24 : 0)};
      case 'iteration-marker': return {x: b.x + b.width / 2 - 70, y: b.y + b.height - 28};
      case 'header-left': return {x: b.x, y: b.y + header / 2};
      case 'header-right': return {x: b.x + b.width, y: b.y + header / 2};
      case 'header-bottom-center': return {x: b.x + b.width / 2, y: b.y + header};
      case 'group-bottom-center': return {x: b.x + b.width / 2, y: exits.get(p.nodeId)!};
      case 'bottom-center': return {x: b.x + b.width / 2, y: b.y + b.height};
    }
  };
  const parents = new Map<Id, Id>();
  const collectParents = (nodes: readonly DiagramNode[]) => { for (const node of nodes) { for (const child of node.children) parents.set(child.id, node.id); collectParents(node.children); } }; collectParents(diagram.nodes);
  for (const [id, parent] of ownership) if (!renderNodes.has(id)) parents.set(id, parent);
  const ancestor = (a: Id, id: Id) => { for (let p = parents.get(id); p; p = parents.get(p)) if (p === a) return true; return false; };
  const obstacles = [...sizes.keys()].filter(id => renderNodes.has(id)).map(id => {
    const node = findNode(diagram.nodes, id)!, box = boxes[id];
    return {id, box: {...box, height: Math.max(52, measureNode(node).height + 28)}, root: node.layout.root};
  }).filter(o => !o.root);
  const routes = diagram.edges.map(e => {
    const a = point(e.fromPort), b = point(e.toPort), from = portMap.get(e.fromPort)!, to = portMap.get(e.toPort)!, box = boxes[to.nodeId];
    let preferred: {x: number; y: number}[];
    const routing = e.routing;
    if (routing === 'back') { const x = box.x - lane / 2; preferred = [a, {x: a.x, y: a.y + 18}, {x, y: a.y + 18}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]; }
    else if (routing === 'branch-left' || routing === 'branch-right') {
      const outward = routing === 'branch-left' ? b.x < a.x : b.x > a.x;
      if (outward && b.y > a.y) preferred = [a, {x: b.x, y: a.y}, b];
      else { const x = a.x + (routing === 'branch-left' ? -24 : 24); preferred = [a, {x, y: a.y}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]; }
    }
    else if (a.x === b.x) preferred = [a, b];
    else preferred = [a, {x: a.x, y: a.y + Math.max(16, (b.y - a.y) / 2)}, {x: b.x, y: a.y + Math.max(16, (b.y - a.y) / 2)}, b];
    const blocked = obstacles.filter(o => o.id !== from.nodeId && o.id !== to.nodeId).map(o => ({...o, box: ancestor(o.id, from.nodeId) || ancestor(o.id, to.nodeId) ? o.box : boxes[o.id]}));
    const clear = (route: {x: number; y: number}[]) => route.every((p, i) => i === 0 || blocked.every(({box: r}) => {
      const prev = route[i - 1];
      return p.x === prev.x ? p.x <= r.x || p.x >= r.x + r.width || Math.max(prev.y, p.y) <= r.y || Math.min(prev.y, p.y) >= r.y + r.height : p.y <= r.y || p.y >= r.y + r.height || Math.max(prev.x, p.x) <= r.x || Math.min(prev.x, p.x) >= r.x + r.width;
    }));
    if (clear(preferred)) return preferred;
    const candidates = [a.y + 18, b.y - 18, ...blocked.flatMap(o => [o.box.y - 18, o.box.y + o.box.height + 18])].map(y => [a, {x: a.x, y}, {x: b.x, y}, b]);
    for (const x of [20, total.width + 70, ...blocked.flatMap(o => [o.box.x - 18, o.box.x + o.box.width + 18])]) candidates.push([a, {x: a.x, y: a.y + 18}, {x, y: a.y + 18}, {x, y: b.y - 18}, {x: b.x, y: b.y - 18}, b]);
    const length = (route: {x: number; y: number}[]) => route.reduce((sum, p, i) => i ? sum + Math.abs(p.x - route[i-1].x) + Math.abs(p.y - route[i-1].y) : sum, 0);
    return candidates.filter(clear).sort((a,b) => length(a) - length(b))[0] ?? routeAround(a, b, blocked.map(o => o.box), total.width + 88, total.height + 88);
  });
  const simplified = routes.map(route => route.filter((p, i) => i === 0 || p.x !== route[i-1].x || p.y !== route[i-1].y).filter((p, i, points) => i === 0 || i === points.length-1 || !(points[i-1].x === p.x && p.x === points[i+1].x || points[i-1].y === p.y && p.y === points[i+1].y)));
  return {diagram, boxes, routes: simplified, width: total.width + 100, height: total.height + 100};
}
function findNode(nodes: readonly DiagramNode[], id: Id): DiagramNode | undefined { for (const n of nodes) { if (n.id === id) return n; const child = findNode(n.children, id); if (child) return child; } return undefined; }

// Sparse orthogonal search is used when a route needs more than two bends.
function routeAround(start: {x: number; y: number}, end: {x: number; y: number}, obstacles: Box[], width: number, height: number): {x: number; y: number}[] {
  const axis = (points: number[]) => [...new Set(points)].sort((a,b) => a-b);
  const xs = axis([start.x,end.x,8,width,...obstacles.flatMap(b => [Math.max(8,b.x-18),b.x+b.width+18])]);
  const ys = axis([start.y,end.y,8,height,...obstacles.flatMap(b => [Math.max(8,b.y-18),b.y+b.height+18])]);
  const index = (x: number,y: number) => y*xs.length+x;
  const first = index(xs.indexOf(start.x),ys.indexOf(start.y)), target = index(xs.indexOf(end.x),ys.indexOf(end.y));
  const point = (i: number) => ({x:xs[i%xs.length],y:ys[Math.floor(i/xs.length)]});
  const clear = (a: {x:number;y:number},b: {x:number;y:number}) => obstacles.every(r => a.x === b.x ? a.x <= r.x || a.x >= r.x+r.width || Math.max(a.y,b.y) <= r.y || Math.min(a.y,b.y) >= r.y+r.height : a.y <= r.y || a.y >= r.y+r.height || Math.max(a.x,b.x) <= r.x || Math.min(a.x,b.x) >= r.x+r.width);
  const costs = new Map([[first,0]]), previous = new Map<number,number>(), pending=[{id:first,score:0}], done=new Set<number>();
  while (pending.length) {
    pending.sort((a,b) => b.score-a.score); const current = pending.pop()!.id;
    if (done.has(current)) continue; done.add(current);
    if (current === target) {
      const path=[end]; for(let at=target;at!==first;){at=previous.get(at)!;path.push(point(at));} path.reverse();
      return path.filter((p,i) => i===0 || i===path.length-1 || !(path[i-1].x===p.x&&p.x===path[i+1].x || path[i-1].y===p.y&&p.y===path[i+1].y));
    }
    const x=current%xs.length,y=Math.floor(current/xs.length),a=point(current);
    for (const [nx,ny] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]) {
      if(nx<0||ny<0||nx>=xs.length||ny>=ys.length)continue;
      const id=index(nx,ny),b=point(id);if(!clear(a,b))continue;
      const cost=costs.get(current)!+Math.abs(a.x-b.x)+Math.abs(a.y-b.y);
      if(cost >= (costs.get(id) ?? Infinity))continue;
      costs.set(id,cost);previous.set(id,current);pending.push({id,score:cost+Math.abs(b.x-end.x)+Math.abs(b.y-end.y)});
    }
  }
  throw new Error('The flow layout could not route an execution edge around source nodes.');
}
