package compiler

import (
	"fmt"
	"slices"
	"unicode/utf8"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/model"
	"github.com/ballerina-nutcracker/ballerina/st"
)

type sourceVariableOccurrence struct {
	start, end int
	id         string
}

// Also accepts the WTF-8 isolated surrogate preserved by client summaries.
func utf16Length(text string) int {
	length := 0
	for i := 0; i < len(text); {
		if i+2 < len(text) && text[i] == 0xed && text[i+1] >= 0xa0 && text[i+1] <= 0xbf && text[i+2] >= 0x80 && text[i+2] <= 0xbf {
			i += 3
			length++
			continue
		}
		r, size := utf8.DecodeRuneInString(text[i:])
		i += size
		length++
		if r > 0xffff {
			length++
		}
	}
	return length
}

// Index only declarations and resolved variable references, never identifier-shaped
// source text. Source offsets stay in bytes until projected into a display string.
func (l *lowerer) collectVariables() {
	l.variables = map[string][]sourceVariableOccurrence{}
	ids := map[model.SymbolRef]string{}
	add := func(symbol model.SymbolRef, name ast.IdentifierNode) {
		if symbol.IsEmpty() || name == nil {
			return
		}
		pos := name.GetPosition()
		file := l.p.env.DiagnosticEnv().FileName(pos)
		id := fmt.Sprintf("variable/%s/%d", file, pos.StartOffset())
		ids[symbol] = id
		l.variables[file] = append(l.variables[file], sourceVariableOccurrence{pos.StartOffset(), pos.EndOffset(), id})
	}
	for _, mod := range l.p.modules {
		if !mod.workspace {
			continue
		}
		for _, v := range mod.pkg.GlobalVars {
			add(v.Symbol(), v.Name)
		}
		// Resource path segments retain only a semantic name in the AST. Index
		// their original CST identifier tokens, including quotes and escapes but
		// excluding comments/minutiae, by the segment's source position.
		resourceNames := map[string]map[int]st.TextRange{}
		var visitSyntax func(st.Node, string)
		visitSyntax = func(n st.Node, file string) {
			if n == nil {
				return
			}
			if segment, ok := n.(*st.ResourcePathParameterNode); ok {
				if name := segment.ParamName(); name != nil && !name.IsMissing() {
					resourceNames[file][segment.TextRange().StartOffset] = name.TextRange()
				}
			}
			if parent, ok := n.(st.NonTerminalNode); ok {
				for child := range parent.ChildNodes() {
					visitSyntax(child, file)
				}
			}
		}
		for _, docID := range mod.module.DocumentIDs() {
			tree := mod.module.Document(docID).SyntaxTree()
			file := tree.FilePath()
			resourceNames[file] = map[int]st.TextRange{}
			visitSyntax(tree.RootNode, file)
		}
		ast.Walk(sourceVisitor(func(n ast.BLangNode) bool {
			if fn, ok := n.(ast.InvokableNode); ok {
				for _, v := range fn.GetParameters() {
					add(v.Symbol(), v.Name)
				}
				if v := fn.GetRestParam(); v != nil {
					add(v.Symbol(), v.Name)
				}
			}
			if def, ok := n.(*ast.BLangVariableDef); ok {
				add(def.Var.Symbol(), def.Var.Name)
			}
			if fn, ok := n.(*ast.BLangResourceMethod); ok {
				for _, segment := range fn.ResourcePath {
					if segment.Kind == ast.ResourcePathSegmentName || segment.Name == "" {
						continue
					}
					symbol, ok := fn.Scope().GetSymbol(segment.Name)
					if !ok || symbol.IsEmpty() {
						continue
					}
					pos := segment.GetPosition()
					file := l.p.env.DiagnosticEnv().FileName(pos)
					name, ok := resourceNames[file][pos.StartOffset()]
					if !ok {
						continue
					}
					id := fmt.Sprintf("variable/%s/%d", file, name.StartOffset)
					ids[symbol] = id
					l.variables[file] = append(l.variables[file], sourceVariableOccurrence{name.StartOffset, name.EndOffset, id})
				}
			}
			return true
		}), mod.pkg)
	}
	for _, mod := range l.p.modules {
		if !mod.workspace {
			continue
		}
		ast.Walk(sourceVisitor(func(n ast.BLangNode) bool {
			if ref, ok := n.(*ast.BLangVarRef); ok {
				if id, ok := ids[ref.Symbol()]; ok && ref.VariableName != nil {
					pos := ref.VariableName.GetPosition()
					file := l.p.env.DiagnosticEnv().FileName(pos)
					l.variables[file] = append(l.variables[file], sourceVariableOccurrence{pos.StartOffset(), pos.EndOffset(), id})
				}
			}
			return true
		}), mod.pkg)
	}
	for file, values := range l.variables {
		slices.SortFunc(values, func(a, b sourceVariableOccurrence) int {
			if a.start != b.start {
				return a.start - b.start
			}
			return a.end - b.end
		})
		l.variables[file] = slices.Compact(values)
	}
}

func (l *lowerer) variablesIn(file string, start, end int) HIRList[HIRVariableOccurrence] {
	out := HIRList[HIRVariableOccurrence]{}
	source := l.p.files[file]
	for _, v := range l.variables[file] {
		if v.start < start || v.end > end || v.end <= v.start {
			continue
		}
		out = append(out, HIRVariableOccurrence{VariableID: v.id, Start: utf16Length(source[start:v.start]), End: utf16Length(source[start:v.end])})
	}
	return out
}

func (l *lowerer) locatedVariables(value LocatedModel) HIRList[HIRVariableOccurrence] {
	if l.variables == nil {
		return nil
	}
	// Source references use line/character coordinates; convert once at this
	// boundary rather than recovering source spans by searching display labels.
	source := l.p.files[value.Source.File]
	start := sourceByteOffset(source, value.Source.Range.Start)
	return l.variablesIn(value.Source.File, start, start+len(value.Text))
}

func sourceByteOffset(source string, p Position) int {
	line, column, offset := 1, 1, 0
	for offset < len(source) && (line < p.Line || column < p.Column) {
		r, size := utf8.DecodeRuneInString(source[offset:])
		offset += size
		if r == '\r' {
			line++
			column = 1
			if offset < len(source) && source[offset] == '\n' {
				offset++
			}
		} else if r == '\n' {
			line++
			column = 1
		} else {
			column++
		}
	}
	return offset
}

func shiftedVariables(values HIRList[HIRVariableOccurrence], offset int) HIRList[HIRVariableOccurrence] {
	out := HIRList[HIRVariableOccurrence]{}
	for _, v := range values {
		v.Start += offset
		v.End += offset
		out = append(out, v)
	}
	return out
}
