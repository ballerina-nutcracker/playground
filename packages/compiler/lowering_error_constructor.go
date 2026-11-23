package compiler

import (
	"fmt"
	"strings"

	"github.com/ballerina-nutcracker/ballerina/ast"
)

// errorConstructorPresentation preserves argument source spelling, not inferred
// runtime values. Prefixes and indentation are part of sections too, so their
// concatenation is exactly the full selection/measurement label.
func (b *graphBuilder) errorConstructorPresentation(id string, expr *ast.BLangErrorConstructorExpr) (HIRPresentation, error) {
	sections, err := b.errorConstructorSections(id, expr, "")
	if err != nil {
		return HIRPresentation{}, err
	}
	var label strings.Builder
	variables := HIRList[HIRVariableOccurrence]{}
	offset := 0
	for _, section := range sections {
		label.WriteString(string(section.Text))
		variables = append(variables, shiftedVariables(section.Variables, offset)...)
		offset += utf16Length(string(section.Text))
	}
	p := plain(HIRNodeStyleErrorConstructor, label.String()).Value.(HIRPlainPresentation)
	p.Sections = sections
	p.Variables = variables
	return HIRPresentation{Value: p}, nil
}

func (b *graphBuilder) errorConstructorSections(id string, expr *ast.BLangErrorConstructorExpr, indent string) (HIRList[HIRLabelSection], error) {
	sections := HIRList[HIRLabelSection]{}
	text := func(sid string, e ast.BLangActionOrExpression, kind HIRLabelSectionKind, prefix string) (HIRLabelSection, error) {
		loc, err := b.source(sid, e)
		if err != nil {
			return HIRLabelSection{}, err
		}
		variables := b.l.locatedVariables(loc)
		lines := strings.Split(loc.Text, "\n")
		padding := utf16Length(indent + "  ")
		for i := range variables {
			start, end := variables[i].Start, variables[i].End
			offset := 0
			for _, line := range lines[:len(lines)-1] {
				offset += utf16Length(line) + 1
				if start >= offset {
					variables[i].Start += padding
				}
				if end >= offset {
					variables[i].End += padding
				}
			}
		}
		return HIRLabelSection{
			Kind:      kind,
			Text:      HIRText(prefix + strings.ReplaceAll(loc.Text, "\n", "\n"+indent+"  ")),
			Variables: shiftedVariables(variables, utf16Length(prefix)),
		}, nil
	}
	for i, arg := range expr.PositionalArgs {
		sid := fmt.Sprintf("%s/error-argument/%d", id, i)
		if i == 0 {
			value, err := text(sid, arg, HIRLabelSectionKindErrorMessage, indent+"Error: ")
			if err != nil {
				return nil, err
			}
			sections = append(sections, value)
			continue
		}
		cause := ast.BLangActionOrExpression(arg)
		for {
			group, ok := cause.(*ast.BLangGroupExpr)
			if !ok {
				break
			}
			cause = group.Expression
		}
		if nested, ok := cause.(*ast.BLangErrorConstructorExpr); ok {
			sections = append(sections, HIRLabelSection{Kind: HIRLabelSectionKindErrorCause, Text: HIRText("\n" + indent + "Cause:\n")})
			children, err := b.errorConstructorSections(sid, nested, indent+"  ")
			if err != nil {
				return nil, err
			}
			sections = append(sections, children...)
		} else {
			value, err := text(sid, arg, HIRLabelSectionKindErrorCause, "\n"+indent+"Cause: ")
			if err != nil {
				return nil, err
			}
			sections = append(sections, value)
		}
	}
	for i := range expr.NamedArgs {
		arg := &expr.NamedArgs[i]
		prefix := "\n"
		if i == 0 {
			prefix += indent + "Details:\n"
		}
		value, err := text(fmt.Sprintf("%s/error-detail/%d", id, i), arg.Expr, HIRLabelSectionKindErrorDetail, prefix+indent+"  "+arg.GetName().GetValue()+": ")
		if err != nil {
			return nil, err
		}
		sections = append(sections, value)
	}
	return sections, nil
}
