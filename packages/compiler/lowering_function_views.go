package compiler

import (
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/ballerina-nutcracker/ballerina/ast"
)

// structuredFunctionCalls maps source-preserving invocation suffixes into
// constructor/client labels. Targets still come from resolved AST identities.
func (b *graphBuilder) structuredFunctionCalls(file string, start, end int, label string) HIRList[HIRCallSpan] {
	type candidate struct{ start, end int }
	var candidates []candidate
	for call := range b.l.p.sourceCallArgs {
		var name ast.IdentifierNode
		switch n := call.(type) {
		case *ast.BLangInvocation:
			name = n.Name
		case *ast.BLangRemoteMethodCallAction:
			name = n.Name
		}
		if name == nil {
			continue
		}
		pos, callPos := name.GetPosition(), call.GetPosition()
		a, z := pos.StartOffset(), callPos.EndOffset()
		if b.l.p.env.DiagnosticEnv().FileName(pos) == file && a >= start && z <= end && z > a {
			candidates = append(candidates, candidate{a, z})
		}
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].start < candidates[j].start })
	var result HIRList[HIRCallSpan]
	used := map[string]int{}
	for _, c := range candidates {
		suffix := b.l.p.files[file][c.start:c.end]
		from := used[suffix]
		i := strings.Index(label[from:], suffix)
		if i < 0 {
			continue
		}
		i += from
		used[suffix] = i + len(suffix)
		spans := b.functionCalls(file, c.start, "", suffix)
		for _, span := range spans {
			if span.Start != 0 {
				continue
			}
			offset := len(utf16.Encode([]rune(label[:i])))
			span.Start += offset
			span.End += offset
			result = append(result, span)
			break
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Start < result[j].Start })
	return result
}

// Invocation identities come from the resolved AST; token ranges come from the
// original parser identifiers, never from searching the rendered statement.
func (b *graphBuilder) functionCalls(file string, start int, prefix, label string) HIRList[HIRCallSpan] {
	var result HIRList[HIRCallSpan]
	source := b.l.p.files[file]
	end := start + len(label) - len(prefix)
	for call := range b.l.p.sourceCallArgs {
		var name ast.IdentifierNode
		switch n := call.(type) {
		case *ast.BLangInvocation:
			name = n.Name
		case *ast.BLangRemoteMethodCallAction:
			name = n.Name
		default:
			continue // Resource access paths are not function-name tokens.
		}
		if name == nil {
			continue
		}
		pos := name.GetPosition()
		a, z := pos.StartOffset(), pos.EndOffset()
		if b.l.p.env.DiagnosticEnv().FileName(pos) != file || a < start || z <= a || z > end || end > len(source) {
			continue
		}
		target, err := b.l.resolveCallTarget(call)
		span := HIRCallSpan{Start: len(utf16.Encode([]rune(prefix + source[start:a]))), End: len(utf16.Encode([]rune(prefix + source[start:z])))}
		if err == nil && target.kind == "workspace" && b.l.availableBodies[target.functionID] {
			id := target.functionID
			span.TargetID = &id
		} else {
			reason := "Function body is unavailable for visualization."
			if err != nil {
				reason = "Invocation target is not statically resolved."
			}
			span.Unavailable = &reason
		}
		result = append(result, span)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Start != result[j].Start {
			return result[i].Start < result[j].Start
		}
		return result[i].End < result[j].End
	})
	return result
}
