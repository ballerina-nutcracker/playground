package compiler

import "github.com/ballerina-nutcracker/ballerina/ast"

func resourcePathExpressions(call ast.Invocable) []ast.BLangExpression {
	var exprs []ast.BLangExpression
	if resource, ok := call.(*ast.BLangClientResourceAccessAction); ok {
		for _, segment := range resource.Path {
			if segment.Expr != nil {
				exprs = append(exprs, segment.Expr)
			}
		}
	}
	return exprs
}
