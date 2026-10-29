package compiler

import (
	"fmt"
	"github.com/ballerina-nutcracker/ballerina/ast"
	"strings"
)

// fragment is temporary construction state, never part of the wire model.
type fragment struct {
	nodes                                      []string
	entry                                      []HIRInterfaceMember
	normal, returns, breaks, continues, panics []HIRInterfaceMember
	panicExports                               []panicExport
}

func (f fragment) empty() bool {
	return len(f.nodes) == 0 && len(f.entry) == 0 && len(f.normal) == 0 &&
		len(f.returns) == 0 && len(f.breaks) == 0 && len(f.continues) == 0 &&
		len(f.panics) == 0 && len(f.panicExports) == 0
}

type panicExport struct {
	reference string
	before    int
}

func appendPanics(dst *fragment, src fragment) {
	offset := len(dst.panics)
	for _, e := range src.panicExports {
		e.before += offset
		dst.panicExports = append(dst.panicExports, e)
	}
	dst.panics = append(dst.panics, src.panics...)
}

type graphBuilder struct {
	statementView    bool
	l                *lowerer
	graph            HIRGraph
	ports            map[string]bool
	rootOnly         bool
	constructionErr  error
	finalFragment    fragment
	statementContext evaluationContext
}

func present() HIRPresence              { return HIRPresence{Value: HIRConstantPresence{Value: true}} }
func absent() HIRPresence               { return HIRPresence{Value: HIRConstantPresence{Value: false}} }
func all(ps ...HIRPresence) HIRPresence { return HIRPresence{Value: HIRAllPresence{Operands: ps}} }
func anyPresence(ps ...HIRPresence) HIRPresence {
	return HIRPresence{Value: HIRAnyPresence{Operands: ps}}
}
func not(p HIRPresence) HIRPresence { return HIRPresence{Value: HIRNotPresence{Operand: p}} }
func nonempty(node, iface string) HIRPresence {
	return HIRPresence{Value: HIRNonemptyPresence{ReferenceNodeID: node, InterfaceID: iface}}
}
func membersPresence(ms []HIRInterfaceMember) HIRPresence {
	ps := []HIRPresence{}
	for _, m := range ms {
		ps = append(ps, m.When)
	}
	return anyPresence(ps...)
}
func member(p string) []HIRInterfaceMember { return []HIRInterfaceMember{{PortID: p, When: present()}} }
func guarded(ms []HIRInterfaceMember, p HIRPresence) []HIRInterfaceMember {
	out := make([]HIRInterfaceMember, 0, len(ms))
	for _, m := range ms {
		m.When = all(m.When, p)
		out = append(out, m)
	}
	return out
}
func plain(style HIRNodeStyle, label string) HIRPresentation {
	return HIRPresentation{Value: HIRPlainPresentation{Style: style, Label: HIRText(label), Sections: HIRList[HIRLabelSection]{}, Disclosure: HIRDisclosure{Value: HIRNoDisclosure{}}}}
}
func groupStyle(profile HIRSpacingProfile) HIRGroupStyle {
	v := HIRGroupVisibility{Node: true, Header: true, Container: profile != HIRSpacingProfileIf}
	return HIRGroupStyle{Profile: profile, Root: v, Inline: v}
}
func local(id string) HIREmission {
	return HIREmission{Value: HIRLocalEmission{ItemID: id, When: present()}}
}
func (b *graphBuilder) emit(kind string, e HIREmission) {
	apply := func(p *HIREmissionPlan) {
		switch kind {
		case "nodes":
			p.Nodes = append(p.Nodes, e)
		case "ports":
			p.Ports = append(p.Ports, e)
		case "edges":
			p.Edges = append(p.Edges, e)
		}
	}
	apply(&b.graph.Emission.Root)
	if !b.rootOnly {
		apply(&b.graph.Emission.Inline)
	}
}
func (b *graphBuilder) source(id string, n ast.Node) (LocatedModel, error) {
	return b.l.located(id, n)
}
func (b *graphBuilder) recordError(err error) {
	if b.constructionErr == nil {
		b.constructionErr = err
	}
}

// Primitives validate before mutation; allocation helpers preserve first-use order
// and retain failures for the enclosing lowering boundary.
func (b *graphBuilder) addNode(node HIRNode) error {
	if node.ID == "" {
		return fmt.Errorf("empty node identity")
	}
	for _, existing := range b.graph.Nodes {
		if existing.ID == node.ID {
			return fmt.Errorf("duplicate node identity %q", node.ID)
		}
	}
	b.graph.Nodes = append(b.graph.Nodes, node)
	b.emit("nodes", local(node.ID))
	return nil
}
func (b *graphBuilder) addPort(port HIRPort) error {
	if port.ID == "" {
		return fmt.Errorf("empty port identity")
	}
	for _, existing := range b.graph.Ports {
		if existing.ID == port.ID {
			return fmt.Errorf("duplicate port identity %q", port.ID)
		}
	}
	found := false
	for _, node := range b.graph.Nodes {
		if node.ID == port.NodeID {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("port %q targets missing node %q", port.ID, port.NodeID)
	}
	if b.ports == nil {
		b.ports = map[string]bool{}
	}
	b.ports[port.ID] = true
	b.graph.Ports = append(b.graph.Ports, port)
	b.emit("ports", local(port.ID))
	return nil
}
func (b *graphBuilder) addEdge(edge HIREdge) error {
	if edge.ID == "" {
		return fmt.Errorf("empty edge identity")
	}
	for _, existing := range b.graph.Edges {
		if existing.ID == edge.ID {
			return fmt.Errorf("duplicate edge identity %q", edge.ID)
		}
	}
	for _, target := range []string{edge.FromPort, edge.ToPort} {
		found := false
		for _, port := range b.graph.Ports {
			if port.ID == target {
				found = true
				break
			}
		}
		if !found {
			return fmt.Errorf("edge %q targets missing port %q", edge.ID, target)
		}
	}
	b.graph.Edges = append(b.graph.Edges, edge)
	b.emit("edges", HIREmission{Value: HIRLocalEmission{ItemID: edge.ID, When: edge.When}})
	return nil
}
func (b *graphBuilder) allocNode(id, occ, source string, p HIRPresentation) string {
	if plain, ok := p.Value.(HIRPlainPresentation); ok && b.l != nil && b.l.p != nil {
		if located, exists := b.l.sources[source]; exists && string(plain.Label) == located.Text {
			plain.Variables = b.l.locatedVariables(located)
			p.Value = plain
		}
	}
	b.recordError(b.addNode(HIRNode{ID: id, OccurrenceKey: strings.TrimPrefix(occ, b.graph.ID), SourceID: source, Presentation: p, Body: HIRNodeBody{Value: HIRLeafBody{}}}))
	return id
}
func (b *graphBuilder) node(id string) *HIRNode {
	for i := range b.graph.Nodes {
		if b.graph.Nodes[i].ID == id {
			return &b.graph.Nodes[i]
		}
	}
	b.recordError(fmt.Errorf("missing node %q", id))
	// Keep ergonomic construction safe until its enclosing error boundary returns.
	return &HIRNode{}
}
func (b *graphBuilder) allocPort(node string, role HIRPortRole) string {
	id := node + ":" + string(role)
	if b.ports[id] {
		return id
	}
	anchor := HIRAnchorKindBottomCenter
	switch role {
	case HIRPortRoleEntry:
		anchor = HIRAnchorKindTopCenter
	case HIRPortRoleTrue:
		anchor = HIRAnchorKindHeaderLeft
	case HIRPortRoleFalse, HIRPortRolePanic:
		anchor = HIRAnchorKindHeaderRight
	case HIRPortRoleNextIteration:
		anchor = HIRAnchorKindIterationMarker
	}
	b.recordError(b.addPort(HIRPort{ID: id, OccurrenceKey: b.node(node).OccurrenceKey + ":" + string(role), NodeID: node, Role: role, Anchor: HIRAnchor{Kind: anchor}}))
	return id
}

// setPortPresenceIfNeeded keeps first-use port ordering while suppressing ports
// whose continuation is unavailable in a particular disclosure state.
func (b *graphBuilder) setPortPresenceIfNeeded(port string, when HIRPresence) {
	for _, plan := range []*HIREmissionPlan{&b.graph.Emission.Root, &b.graph.Emission.Inline} {
		for i := range plan.Ports {
			switch slot := plan.Ports[i].Value.(type) {
			case HIRLocalEmission:
				if slot.ItemID == port {
					slot.When = when
					plan.Ports[i].Value = slot
				}
			case *HIRLocalEmission:
				if slot.ItemID == port {
					slot.When = when
				}
			}
		}
	}
}

func edgeStyle(kind HIREdgeKind, label string) HIREdgeStyle {
	s := HIREdgeStyle{Kind: kind, Routing: HIRRoutingDirect}
	if label != "" {
		s.Label = &label
	}
	switch kind {
	case HIREdgeKindTrue:
		s.Routing = HIRRoutingBranchLeft
	case HIREdgeKindFalse, HIREdgeKindError:
		s.Routing = HIRRoutingBranchRight
	case HIREdgeKindBack, HIREdgeKindContinue:
		s.Routing = HIRRoutingBack
	}
	return s
}
func (b *graphBuilder) allocEdge(from, to string, kind HIREdgeKind, label string, when HIRPresence) {
	id := fmt.Sprintf("edge/%d", len(b.graph.Edges))
	b.recordError(b.addEdge(HIREdge{ID: id, FromPort: from, ToPort: to, HIREdgeStyle: edgeStyle(kind, label), When: when}))
}
func (b *graphBuilder) connect(from, to []HIRInterfaceMember, kind HIREdgeKind) {
	for _, f := range from {
		for _, t := range to {
			b.allocEdge(f.PortID, t.PortID, kind, "", all(f.When, t.When))
		}
	}
}
func (b *graphBuilder) group(node string, profile HIRSpacingProfile, left, right []string, columns bool) {
	id := node + "/group"
	var a HIRArrangementValue = HIRSequenceArrangement{Members: append(HIRList[string]{}, left...)}
	if columns {
		a = HIRColumnsArrangement{Left: append(HIRList[string]{}, left...), Right: append(HIRList[string]{}, right...)}
	}
	b.graph.Groups = append(b.graph.Groups, HIRGroup{ID: id, Arrangement: HIRArrangement{Value: a}, Style: groupStyle(profile)})
	b.node(node).Body = HIRNodeBody{Value: HIRGroupBody{GroupID: id}}
	// Group layout is explicit lowering input: foreach enters its body from
	// the header's bottom center, unlike the left branch of if/while.
	for i := range b.graph.Ports {
		port := &b.graph.Ports[i]
		if port.NodeID != node {
			continue
		}
		if profile == HIRSpacingProfileIf && port.Role == HIRPortRoleNormalExit {
			port.Anchor.Kind = HIRAnchorKindGroupBottomCenter
		}
		if profile == HIRSpacingProfileForeach && port.Role == HIRPortRoleTrue {
			port.Anchor.Kind = HIRAnchorKindHeaderBottomCenter
		}
	}
}
func (b *graphBuilder) lowerBlock(path string, nodes []ast.StatementNode) (fragment, error) {
	return b.lowerBlockAt(path, path, nodes)
}
func (b *graphBuilder) lowerBlockAt(sourcePath, occPath string, nodes []ast.StatementNode) (fragment, error) {
	f := fragment{}
	err := b.appendBlock(&f, sourcePath, occPath, nodes)
	return f, err
}

// Source blocks are flattened into their containing sequence. Construct and
// connect each statement before visiting the next one, even across block
// boundaries, so child edges and caller continuations remain interleaved.
func (b *graphBuilder) appendBlock(f *fragment, sourcePath, occPath string, nodes []ast.StatementNode) error {
	for i, n := range nodes {
		id := fmt.Sprintf("%s/statement/%d", sourcePath, i)
		if block, ok := n.(*ast.BLangBlockStmt); ok {
			if err := b.appendBlock(f, id+"/block", occPath, block.Stmts); err != nil {
				return err
			}
			continue
		}
		part, err := b.lowerStatementAt(id, occPath+"/"+id, n)
		if err != nil {
			return err
		}
		// A flattened empty block contributes no control-flow region. In
		// particular it must not erase its predecessor's normal completion.
		// Do not use entry alone: unsupported regions can have no incoming
		// members while still contributing nodes or terminal effects.
		if part.empty() {
			continue
		}
		if f.empty() {
			f.entry = part.entry
		}
		b.connect(f.normal, part.entry, HIREdgeKindSequence)
		f.normal = part.normal
		f.nodes = append(f.nodes, part.nodes...)
		f.returns = append(f.returns, part.returns...)
		f.breaks = append(f.breaks, part.breaks...)
		f.continues = append(f.continues, part.continues...)
		appendPanics(f, part)
	}
	return nil
}
func (l *lowerer) lowerFunction(fn sourceFunctionEntry) (HIRGraph, error) {
	return l.lowerFunctionMode(fn, false)
}

func (l *lowerer) lowerFunctionMode(fn sourceFunctionEntry, statementView bool) (HIRGraph, error) {
	b := &graphBuilder{l: l, ports: map[string]bool{}, statementView: statementView}
	location, locationError := l.located(fn.id, fn.node)
	if locationError != nil {
		return HIRGraph{}, locationError
	}
	b.graph = HIRGraph{LocatedModel: location, ModuleID: fn.moduleID}
	entryMetadata, entryError := l.lowerEntry(fn)
	if entryError != nil {
		return HIRGraph{}, entryError
	}
	b.graph.Entry = entryMetadata
	var f fragment
	var err error
	switch body := fn.node.GetBody().(type) {
	case *ast.BLangBlockFunctionBody:
		f, err = b.lowerBlock(fn.id, body.Stmts)
	case *ast.BLangExprFunctionBody:
		f, err = b.lowerExpressionReturn(fn.id+"/expression", fn.id+"/"+fn.id+"/expression", body.Expr)
	default:
		sid := fn.id + "/body"
		if _, err := b.source(sid, fn.node); err != nil {
			return HIRGraph{}, err
		}
		node := b.allocNode(fn.id+"/"+sid, fn.id+"/"+sid, sid, plain(HIRNodeStyleUnsupported, "Function body is unavailable for visualization."))
		f = fragment{nodes: []string{node}, entry: member(b.allocPort(node, HIRPortRoleEntry))}
	}
	if err != nil {
		return HIRGraph{}, err
	}
	b.finalFragment = f
	return b.finish()
}
func (b *graphBuilder) finish() (HIRGraph, error) {
	if b.constructionErr != nil {
		return HIRGraph{}, b.constructionErr
	}
	id, f := b.graph.ID, b.finalFragment
	b.rootOnly = true
	root := id + "/root"
	b.allocNode(root, root, id, plain(HIRNodeStyleFunction, ""))
	b.group(root, HIRSpacingProfileRoot, f.nodes, nil, false)
	gid := root + "/group"
	for i := range b.graph.Groups {
		if b.graph.Groups[i].ID == gid {
			b.graph.Groups[i].Style.Root = HIRGroupVisibility{Node: true, Container: true}
			b.graph.Groups[i].Style.Inline = HIRGroupVisibility{}
		}
	}
	b.graph.RootGroup = id + "/graph"
	b.graph.Groups = append(b.graph.Groups, HIRGroup{ID: b.graph.RootGroup, Arrangement: HIRArrangement{Value: HIRSequenceArrangement{Members: HIRList[string]{root}}}, Style: groupStyle(HIRSpacingProfileSequence)})
	entry := b.allocPort(root, HIRPortRoleEntry)
	exit := b.allocPort(root, HIRPortRoleNormalExit)
	rootConnect := func(name string, from []HIRInterfaceMember, to string) {
		binding := root + "/binding/" + name
		b.graph.Interfaces = append(b.graph.Interfaces, HIRInterface{ID: "root/" + name, Members: append(HIRList[HIRInterfaceMember]{}, from...), Exports: HIRList[HIRInterfaceExport]{}, Root: HIRRootTreatment{Value: HIRConnectRoot{BindingID: binding, ToPort: to, Edge: edgeStyle(HIREdgeKindSequence, "")}}})
		b.emit("edges", HIREmission{Value: HIRBindingEmission{BindingID: binding, When: present()}})
	}
	if len(f.entry) == 0 {
		rootConnect("entry", member(entry), exit)
	} else {
		for i, m := range f.entry {
			rootConnect(fmt.Sprintf("entry/%d", i), guarded(member(entry), m.When), m.PortID)
		}
	}
	rootConnect("normal", f.normal, exit)
	for _, v := range []struct {
		id string
		ms []HIRInterfaceMember
	}{{"entry", f.entry}, {"normal", f.normal}, {"returns", f.returns}, {"panics", f.panics}} {
		found := false
		for i := range b.graph.Interfaces {
			if b.graph.Interfaces[i].ID == v.id {
				b.graph.Interfaces[i].Members = append(HIRList[HIRInterfaceMember]{}, v.ms...)
				found = true
			}
		}
		if !found {
			b.graph.Interfaces = append(b.graph.Interfaces, HIRInterface{ID: v.id, Members: append(HIRList[HIRInterfaceMember]{}, v.ms...), Exports: HIRList[HIRInterfaceExport]{}, Root: HIRRootTreatment{Value: HIRTerminalRoot{}}})
		}
	}
	for _, exp := range f.panicExports {
		b.addPanicExport(exp.reference, exp.before)
	}
	b.orderNodes(root)
	if b.constructionErr != nil {
		return HIRGraph{}, b.constructionErr
	}
	return b.graph, nil
}

// Node streams follow explicit ownership, while port and edge streams retain
// their construction/first-use ordering.
func (b *graphBuilder) orderNodes(root string) {
	b.graph.Emission.Root.Nodes = HIRList[HIREmission]{}
	b.graph.Emission.Inline.Nodes = HIRList[HIREmission]{}
	var walk func(string, bool)
	walk = func(id string, include bool) {
		n := b.node(id)
		if include {
			b.graph.Emission.Root.Nodes = append(b.graph.Emission.Root.Nodes, local(id))
			if id != root {
				b.graph.Emission.Inline.Nodes = append(b.graph.Emission.Inline.Nodes, local(id))
			}
		}
		switch body := n.Body.Value.(type) {
		case HIRGroupBody:
			for _, g := range b.graph.Groups {
				if g.ID == body.GroupID {
					var children []string
					switch a := g.Arrangement.Value.(type) {
					case HIRSequenceArrangement:
						children = a.Members
					case HIRColumnsArrangement:
						children = append(append([]string{}, a.Left...), a.Right...)
					case HIRContainerArrangement:
						children = a.Members
					}
					for _, child := range children {
						walk(child, true)
					}
					break
				}
			}
		case HIRReferenceBody:
			e := HIREmission{Value: HIRChildEmission{ReferenceNodeID: id, When: present()}}
			b.graph.Emission.Root.Nodes = append(b.graph.Emission.Root.Nodes, e)
			b.graph.Emission.Inline.Nodes = append(b.graph.Emission.Inline.Nodes, e)
		}
	}
	walk(root, true)
}
func trimBinding(text string) string {
	return strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(text), "="))
}
