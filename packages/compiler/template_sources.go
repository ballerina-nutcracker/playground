package compiler

import (
	"sort"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/context"
	"github.com/ballerina-nutcracker/ballerina/st"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

// retainXMLTemplateSources runs at AST construction time, before semantic analysis.
// The frontend optimizes interpolation-free XML templates to XML literal nodes;
// retain which literal is the source template root, and its complete wrapper.
func retainXMLTemplateSources(cx *context.CompilerContext, tree *st.SyntaxTree, unit *ast.BLangCompilationUnit, templates map[ast.Node]bool) {
	type span struct{ start, end int }
	ranges := map[span]span{}
	wrappers := map[span]span{}
	delta := 0
	var quoteOffsets []int
	var visit func(st.Node)
	visit = func(node st.Node) {
		if node == nil {
			return
		}
		original := node.TextRange()
		corrected := span{original.StartOffset + delta, 0}
		if parent, ok := node.(st.NonTerminalNode); ok {
			for child := range parent.ChildNodes() {
				visit(child)
			}
		} else if node.Kind() == st.DOUBLE_QUOTE_TOKEN && !node.IsMissing() && original.StartOffset == original.EndOffset {
			// Pinned st DOUBLE_QUOTE_TOKEN has an empty spelling/zero width. Each
			// XML attribute quote otherwise shifts every subsequent source range.
			quoteOffsets = append(quoteOffsets, original.StartOffset)
			delta++
		}
		corrected.end = original.EndOffset + delta
		ranges[span{original.StartOffset, original.EndOffset}] = corrected
		if template, ok := node.(*st.TemplateExpressionNode); ok && template.Kind() == st.XML_TEMPLATE_EXPRESSION {
			key := span{original.StartOffset, original.EndOffset}
			// Singleton XML templates lose the wrapper when nodebuilder returns the
			// content directly. Multi-item/empty templates retain the wrapper range.
			var children []st.Node
			content := template.Content()
			for child := range content.Iterator() {
				children = append(children, child)
			}
			if len(children) == 1 {
				r := children[0].TextRange()
				key = span{r.StartOffset, r.EndOffset}
			}
			wrappers[key] = corrected
			wrappers[span{original.StartOffset, original.EndOffset}] = corrected
		}
	}
	visit(tree.RootNode)
	seen := map[ast.Node]bool{}
	ast.Walk(sourceVisitor(func(node ast.BLangNode) bool {
		if seen[node] {
			return false
		}
		seen[node] = true
		location := node.GetPosition()
		if !diagnostics.LocationHasSource(location) {
			return true
		}
		key := span{location.StartOffset(), location.EndOffset()}
		corrected, exists := ranges[key]
		if !exists {
			// Metadata-stripped declarations and synthetic AST spans need not
			// correspond to a syntax node. Correct their endpoints as well.
			beforeStart := sort.Search(len(quoteOffsets), func(i int) bool { return quoteOffsets[i] > key.start })
			beforeEnd := sort.SearchInts(quoteOffsets, key.end)
			corrected = span{key.start + beforeStart, key.end + beforeEnd}
			exists = true
		}
		// Only source XML roots are templates, not descendant XML literals.
		switch node.(type) {
		case *ast.BLangXMLSequenceLiteral, *ast.BLangXMLElementLiteral, *ast.BLangXMLTextLiteral, *ast.BLangXMLCommentLiteral, *ast.BLangXMLPILiteral, *ast.BLangXMLTemplateExpr:
			if wrapper, ok := wrappers[key]; ok {
				corrected, exists = wrapper, true
				templates[node] = true
			}
		}
		if exists {
			node.SetPosition(diagnostics.NewLocation(cx.DiagnosticEnv(), tree.FilePath(), corrected.start, corrected.end))
		}
		return true
	}), unit)
}
