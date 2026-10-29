package compiler

import (
	"fmt"
	"github.com/ballerina-nutcracker/ballerina/ast"
)

func (b *graphBuilder) lowerStatementAt(id, path string, statement ast.StatementNode) (fragment, error) {
	previous := b.statementContext
	b.statementContext = evaluationContext{kind: evaluationStatement, sourceID: id, occurrencePath: path}
	defer func() { b.statementContext = previous }()
	return b.lowerStatement(path, statement)
}

func (b *graphBuilder) lowerStatement(path string, statement ast.StatementNode) (result fragment, err error) {
	if b.constructionErr != nil {
		return fragment{}, b.constructionErr
	}
	defer func() {
		if err == nil {
			err = b.constructionErr
		}
	}()
	id := path
	if b.statementContext.kind == evaluationStatement {
		id = b.statementContext.sourceID
	}
	loc, err := b.source(id, statement)
	if err != nil {
		return fragment{}, err
	}
	kind := "simple"
	style := HIRNodeStyleStep
	var expr ast.BLangActionOrExpression
	var lhs ast.BLangExpression
	var thenNodes, elseNodes, bodyNodes []ast.StatementNode
	reason := ""
	label := loc.Text
	binding := ""
	operation := ""
	var foreachHeader LocatedModel
	switch n := statement.(type) {
	case *ast.BLangVariableDef:
		expr = n.Var.Expr
		operation = "declare"
	case *ast.BLangAssignment:
		expr = n.Expr
		lhs = n.VarRef
		operation = "assign"
	case *ast.BLangCompoundAssignment:
		expr = n.Expr
		lhs = n.VarRef
		operation = "assign"
	case *ast.BLangExpressionStmt:
		expr = n.Expr
		operation = "expression"
	case *ast.BLangReturn:
		kind = "return"
		style = HIRNodeStyleReturn
		expr = n.Expr
	case *ast.BLangBreak:
		kind = "break"
	case *ast.BLangContinue:
		kind = "continue"
	case *ast.BLangIf:
		kind = "if"
		style = HIRNodeStyleCondition
		expr = n.Expr
		thenNodes = n.Body.Stmts
		if n.ElseStmt != nil {
			if block, ok := n.ElseStmt.(*ast.BLangBlockStmt); ok {
				elseNodes = block.Stmts
			} else {
				elseNodes = []ast.StatementNode{n.ElseStmt}
			}
		}
	case *ast.BLangWhile:
		kind = "while"
		style = HIRNodeStyleLoop
		expr = n.Expr
		bodyNodes = n.Body.Stmts
		if n.OnFailClause.Body != nil {
			reason = "Loop on-fail behavior is not modeled."
		}
	case *ast.BLangForeach:
		kind = "foreach"
		style = HIRNodeStyleLoop
		expr = n.Collection
		bodyNodes = n.Body.Stmts
		if n.OnFailClause != nil {
			reason = "Loop on-fail behavior is not modeled."
		}
		if n.VariableDef == nil || n.Collection == nil {
			return fragment{}, fmt.Errorf("%s: missing foreach header position", id)
		}
		variablePosition, collectionPosition := n.VariableDef.GetPosition(), n.Collection.GetPosition()
		start, end := variablePosition.StartOffset(), collectionPosition.EndOffset()
		text := b.l.p.files[loc.Source.File]
		if start > end {
			return fragment{}, fmt.Errorf("%s: reversed foreach header range", id)
		}
		headerStart, err := position(text, start)
		if err != nil {
			return fragment{}, fmt.Errorf("%s: foreach header start: %w", id, err)
		}
		headerEnd, err := position(text, end)
		if err != nil {
			return fragment{}, fmt.Errorf("%s: foreach header end: %w", id, err)
		}
		foreachHeader = LocatedModel{ID: id + "/header", Source: SourceReferenceModel{File: loc.Source.File, Range: SourceRange{Start: headerStart, End: headerEnd}}, Text: text[start:end]}
		label = "foreach " + foreachHeader.Text
	default:
		kind = "unsupported"
		reason = fmt.Sprintf("Visualization of %T is not modeled; later source may still execute.", statement)
	}
	sourceID := id
	callID := id
	if kind == "if" || kind == "while" {
		callID = id + "/condition"
	}
	if kind == "foreach" {
		callID = id + "/header"
	}
	safe := kind == "simple" || kind == "return"
	prefix, lhsReason, err := b.scanCalls(id+"/lhs", lhs, false)
	if err != nil {
		return fragment{}, err
	}
	calls, exprReason, err := b.scanCalls(callID, expr, safe && len(prefix) == 0)
	if err != nil {
		return fragment{}, err
	}
	calls = append(prefix, calls...)
	if lhsReason != "" {
		reason = lhsReason
	} else if exprReason != "" {
		reason = exprReason
	}
	if kind == "if" || kind == "while" {
		sourceID = id + "/condition"
		condition, err := b.source(sourceID, expr)
		if err != nil {
			return fragment{}, err
		}
		label = condition.Text
	}
	if kind == "foreach" {
		sourceID = id + "/header"
		if !b.statementView {
			_, err := b.source(sourceID, expr)
			if err != nil {
				return fragment{}, err
			}
			b.l.sources[sourceID] = foreachHeader
		}
	}
	if reason != "" {
		kind = "unsupported"
		style = HIRNodeStyleUnsupported
		sourceID = id
		label = loc.Text
	}
	if _, ok := expr.(*ast.BLangMappingConstructorExpr); ok && kind == "simple" {
		style = HIRNodeStyleMapping
	}
	presentation := plain(style, label)
	if kind == "foreach" {
		p := presentation.Value.(HIRPlainPresentation)
		p.Variables = shiftedVariables(b.l.locatedVariables(foreachHeader), utf16Length("foreach "))
		presentation.Value = p
	}
	if kind == "unsupported" {
		p := presentation.Value.(HIRPlainPresentation)
		p.Limitation = &reason
		presentation.Value = p
	}
	node := b.allocNode(path, path, sourceID, presentation)
	if b.statementView {
		position := statement.GetPosition()
		start := position.StartOffset()
		prefix := ""
		if kind == "if" || kind == "while" {
			position := expr.GetPosition()
			start = position.StartOffset()
		}
		if kind == "foreach" {
			position := statement.(*ast.BLangForeach).VariableDef.GetPosition()
			start = position.StartOffset()
			prefix = "foreach "
		}
		b.node(node).Calls = b.functionCalls(loc.Source.File, start, prefix, label)
	}
	entry := b.allocPort(node, HIRPortRoleEntry)
	f := fragment{nodes: []string{node}, entry: member(entry)}
	if kind == "unsupported" {
		return f, nil
	}
	if kind == "break" {
		f.breaks = member(b.allocPort(node, HIRPortRoleBreak))
		return f, nil
	}
	if kind == "continue" {
		f.continues = member(b.allocPort(node, HIRPortRoleContinue))
		return f, nil
	}
	evaluated := fragment{}
	if b.hasEvaluation(expr) || b.hasEvaluation(lhs) {
		var err error
		if lhs != nil && b.evaluationExists(lhs) {
			target, e := b.evaluate(id+"/target", path+"/evaluation/part/0", lhs, calls, false)
			if e != nil {
				return f, e
			}
			nested := fragment{}
			b.appendEvaluation(&nested, target, true)
			if b.evaluationExists(expr) {
				value, e := b.evaluate(id+"/value", path+"/evaluation/part/1", expr, calls, false)
				if e != nil {
					return f, e
				}
				b.appendEvaluation(&nested, value, false)
			}
			wrapperSource, err := b.source(id+"/evaluation", statement)
			if err != nil {
				return fragment{}, err
			}
			wrapper := b.allocNode(path+"/evaluation", path+"/evaluation", wrapperSource.ID, plain(HIRNodeStyleStep, wrapperSource.Text))
			if b.statementView {
				position := statement.GetPosition()
				b.node(wrapper).Calls = b.functionCalls(loc.Source.File, position.StartOffset(), "", wrapperSource.Text)
			}
			wrapperEntry := b.allocPort(wrapper, HIRPortRoleEntry)
			b.connect(nested.normal, member(wrapperEntry), HIREdgeKindSequence)
			evaluated = nested
			evaluated.nodes = append(evaluated.nodes, wrapper)
			if len(evaluated.entry) == 0 {
				evaluated.entry = member(wrapperEntry)
			}
			evaluated.normal = member(b.allocPort(wrapper, HIRPortRoleNormalExit))
			evaluated.panics = append(evaluated.panics, member(b.allocPort(wrapper, HIRPortRolePanic))...)
		} else {
			sid := id + "/value"
			if kind == "if" || kind == "while" || kind == "foreach" {
				sid = sourceID + "/value"
			}
			evaluated, err = b.evaluate(sid, path+"/evaluation", expr, calls, false)
			if err != nil {
				return f, err
			}
		}
		b.connect(evaluated.normal, member(entry), HIREdgeKindSequence)
		f.nodes = append(evaluated.nodes, node)
		if len(evaluated.entry) > 0 {
			f.entry = evaluated.entry
		}
		f.returns = evaluated.returns
		appendPanics(&f, evaluated)
		if kind == "simple" || kind == "return" {
			completionLabel := loc.Text
			if kind == "return" {
				completionLabel = "Return value"
			} else if operation != "expression" && expr != nil {
				statementPosition, expressionPosition := statement.GetPosition(), expr.GetPosition()
				start, end := statementPosition.StartOffset(), expressionPosition.StartOffset()
				binding = trimBinding(b.l.p.files[loc.Source.File][start:end])
				if lhs != nil {
					location, err := b.source(id+"/binding", lhs)
					if err != nil {
						return fragment{}, err
					}
					binding = location.Text
				}
				completionLabel = "Result → " + binding
			}
			completion := plain(style, completionLabel)
			p := completion.Value.(HIRPlainPresentation)
			if operation != "expression" && kind != "return" && expr != nil {
				position := statement.GetPosition()
				start := position.StartOffset()
				if lhs != nil {
					position := lhs.GetPosition()
					start = position.StartOffset()
				}
				p.Variables = shiftedVariables(b.l.variablesIn(loc.Source.File, start, start+len(binding)), utf16Length("Result → "))
			} else if completionLabel == loc.Text {
				p.Variables = b.l.locatedVariables(loc)
			}
			completion.Value = p
			b.node(node).Presentation = completion
			if b.statementView {
				// Completion labels are synthetic, not the original source text.
				b.node(node).Calls = nil
			}
			if kind == "return" {
				ret := b.allocPort(node, HIRPortRoleReturn)
				when := membersPresence(evaluated.normal)
				b.setPortPresenceIfNeeded(ret, when)
				f.returns = append(f.returns, guarded(member(ret), when)...)
			} else {
				f.normal = member(b.allocPort(node, HIRPortRoleNormalExit))
			}
			return f, nil
		}
	}
	if kind == "if" {
		a, err := b.lowerBlockAt(id+"/then", path+"/then", thenNodes)
		if err != nil {
			return f, err
		}
		c, err := b.lowerBlockAt(id+"/else", path+"/else", elseNodes)
		if err != nil {
			return f, err
		}
		join := b.allocPort(node, HIRPortRoleNormalExit)
		ap := a.entry
		if len(ap) == 0 {
			ap = member(join)
		}
		cp := c.entry
		if len(cp) == 0 {
			cp = member(join)
		}
		b.connect(member(b.allocPort(node, HIRPortRoleTrue)), ap, HIREdgeKindTrue)
		b.connect(member(b.allocPort(node, HIRPortRoleFalse)), cp, HIREdgeKindFalse)
		b.connect(a.normal, member(join), HIREdgeKindSequence)
		b.connect(c.normal, member(join), HIREdgeKindSequence)
		pa := membersPresence(a.normal)
		if len(a.entry) == 0 {
			pa = present()
		}
		pc := membersPresence(c.normal)
		if len(c.entry) == 0 {
			pc = present()
		}
		f.normal = guarded(member(join), anyPresence(pa, pc))
		f.returns = append(f.returns, append(a.returns, c.returns...)...)
		appendPanics(&f, a)
		appendPanics(&f, c)
		f.breaks = append(a.breaks, c.breaks...)
		f.continues = append(a.continues, c.continues...)
		b.group(node, HIRSpacingProfileIf, a.nodes, c.nodes, true)
		return f, nil
	}
	if kind == "while" || kind == "foreach" {
		body, err := b.lowerBlockAt(id+"/loop", path+"/loop", bodyNodes)
		if err != nil {
			return f, err
		}
		exit := b.allocPort(node, HIRPortRoleNormalExit)
		f.normal = member(exit)
		iteration := f.entry
		profile := HIRSpacingProfileWhile
		if kind == "foreach" {
			iteration = member(b.allocPort(node, HIRPortRoleNextIteration))
			profile = HIRSpacingProfileForeach
		}
		bodyEntry := body.entry
		if len(bodyEntry) == 0 {
			bodyEntry = iteration
		}
		edgeKind := HIREdgeKindTrue
		backKind := HIREdgeKindBack
		if kind == "foreach" {
			edgeKind = HIREdgeKindSequence
			backKind = HIREdgeKindSequence
		}
		b.connect(member(b.allocPort(node, HIRPortRoleTrue)), bodyEntry, edgeKind)
		if kind == "while" {
			b.connect(member(b.allocPort(node, HIRPortRoleFalse)), member(exit), HIREdgeKindFalse)
		}
		b.connect(body.normal, iteration, backKind)
		continueStart := len(b.graph.Edges)
		b.connect(body.continues, iteration, HIREdgeKindContinue)
		if kind == "foreach" {
			// The iteration marker lies below the body, so continue uses the
			// forward obstacle route, not the while loop's backward route.
			for i := continueStart; i < len(b.graph.Edges); i++ {
				b.graph.Edges[i].Routing = HIRRoutingDirect
			}
		}
		b.connect(body.breaks, member(exit), HIREdgeKindBreak)
		f.returns = append(f.returns, body.returns...)
		appendPanics(&f, body)
		b.group(node, profile, body.nodes, nil, false)
		return f, nil
	}
	normal := member(b.allocPort(node, HIRPortRoleNormalExit))
	children := []string{}
	for _, call := range calls {
		if b.statementView || call.target == "" {
			continue
		}
		callPath := path + "/expand/" + call.id
		callNode := b.allocNode(callPath, callPath, call.id, plain(HIRNodeStyleFunction, b.l.sources[call.id].Text))
		children = append(children, callNode)
		if call.supported {
			b.connect(normal, member(b.allocPort(callNode, HIRPortRoleEntry)), HIREdgeKindSequence)
			normal = b.bindCall(callNode, callPath, call, false)
		} else {
			b.bindCall(callNode, callPath, call, false)
		}
	}
	if len(children) > 0 {
		b.group(node, HIRSpacingProfileSequence, children, nil, false)
		for i := range b.graph.Ports {
			if b.graph.Ports[i].NodeID == node && b.graph.Ports[i].Role == HIRPortRoleNormalExit {
				b.graph.Ports[i].Anchor.Kind = HIRAnchorKindHeaderBottomCenter
			}
		}
	}
	if kind == "return" {
		ret := b.allocPort(node, HIRPortRoleReturn)
		if len(children) > 0 {
			b.connect(normal, member(ret), HIREdgeKindReturn)
		}
		when := membersPresence(normal)
		b.setPortPresenceIfNeeded(ret, when)
		f.returns = guarded(member(ret), when)
	} else {
		f.normal = normal
	}
	return f, nil
}
