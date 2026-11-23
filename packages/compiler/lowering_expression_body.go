package compiler

import "github.com/ballerina-nutcracker/ballerina/ast"

func (b *graphBuilder) lowerExpressionReturn(id, path string, expr ast.BLangActionOrExpression) (fragment, error) {
	loc, err := b.source(id, expr)
	if err != nil {
		return fragment{}, err
	}
	calls, reason, err := b.scanCalls(id, expr, true)
	if err != nil {
		return fragment{}, err
	}
	if reason != "" {
		p := plain(HIRNodeStyleUnsupported, loc.Text)
		v := p.Value.(HIRPlainPresentation)
		v.Limitation = &reason
		p.Value = v
		n := b.allocNode(path, path, id, p)
		if b.statementView {
			position := expr.GetPosition()
			b.node(n).Calls = b.functionCalls(loc.Source.File, position.StartOffset(), "", loc.Text)
		}
		return fragment{nodes: []string{n}, entry: member(b.allocPort(n, HIRPortRoleEntry))}, nil
	}
	label := loc.Text
	evaluated := fragment{}
	if b.hasEvaluation(expr) {
		var err error
		evaluated, err = b.evaluate(id+"/value", path+"/evaluation", expr, calls, false)
		if err != nil {
			return fragment{}, err
		}
		label = "Return value"
	}
	n := b.allocNode(path, path, id, plain(HIRNodeStyleReturn, label))
	if b.statementView && label == loc.Text {
		position := expr.GetPosition()
		b.node(n).Calls = b.functionCalls(loc.Source.File, position.StartOffset(), "", label)
	}
	entry := b.allocPort(n, HIRPortRoleEntry)
	f := evaluated
	f.nodes = append(f.nodes, n)
	if len(f.entry) == 0 {
		f.entry = member(entry)
	}
	b.connect(evaluated.normal, member(entry), HIREdgeKindSequence)
	if b.hasEvaluation(expr) {
		f.normal = nil
		ret := b.allocPort(n, HIRPortRoleReturn)
		when := membersPresence(evaluated.normal)
		b.setPortPresenceIfNeeded(ret, when)
		f.returns = append(f.returns, guarded(member(ret), when)...)
		return f, nil
	}
	normal := member(b.allocPort(n, HIRPortRoleNormalExit))
	children := []string{}
	for _, call := range calls {
		if b.statementView || call.target == "" {
			continue
		}
		cp := path + "/expand/" + call.id
		cn := b.allocNode(cp, cp, call.id, plain(HIRNodeStyleFunction, b.l.sources[call.id].Text))
		children = append(children, cn)
		if call.supported {
			b.connect(normal, member(b.allocPort(cn, HIRPortRoleEntry)), HIREdgeKindSequence)
			normal = b.bindCall(cn, cp, call, false)
		} else {
			b.bindCall(cn, cp, call, false)
		}
	}
	if len(children) > 0 {
		b.group(n, HIRSpacingProfileSequence, children, nil, false)
		for i := range b.graph.Ports {
			if b.graph.Ports[i].NodeID == n && b.graph.Ports[i].Role == HIRPortRoleNormalExit {
				b.graph.Ports[i].Anchor.Kind = HIRAnchorKindHeaderBottomCenter
			}
		}
	}
	ret := b.allocPort(n, HIRPortRoleReturn)
	if len(children) > 0 {
		b.connect(normal, member(ret), HIREdgeKindReturn)
	}
	f.normal = nil
	when := membersPresence(normal)
	b.setPortPresenceIfNeeded(ret, when)
	f.returns = guarded(member(ret), when)
	return f, nil
}
