package compiler

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/ballerina-nutcracker/ballerina/ast"
	"github.com/ballerina-nutcracker/ballerina/context"
	"github.com/ballerina-nutcracker/ballerina/lib/langlibs"
	"github.com/ballerina-nutcracker/ballerina/lib/stdlibs"
	"github.com/ballerina-nutcracker/ballerina/model"
	"github.com/ballerina-nutcracker/ballerina/nodebuilder"
	"github.com/ballerina-nutcracker/ballerina/parser"
	"github.com/ballerina-nutcracker/ballerina/projects"
	"github.com/ballerina-nutcracker/ballerina/semantics"
	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

var implicitLibraries = []string{"lang.__internal", "lang.int", "lang.boolean", "lang.decimal", "lang.error", "lang.float", "lang.string", "lang.value", "lang.xml", "lang.array", "lang.map", "lang.object", "lang.runtime"}

// sourceVisitor is shared frontend traversal support, independent of flow extraction.
type sourceVisitor func(ast.BLangNode) bool

func (v sourceVisitor) Visit(n ast.BLangNode) ast.Visitor {
	if n != nil && v(n) {
		return v
	}
	return nil
}
func (v sourceVisitor) VisitTypeData(*ast.TypeData) ast.Visitor { return nil }

type resolvedModule struct {
	// units and documentNames are parallel, in source document order.
	units         []*ast.BLangCompilationUnit
	documentNames []string
	module        *projects.Module
	ctx           *context.CompilerContext
	pkg           *ast.BLangPackage
	imports       map[string]model.ExportedSymbolSpace
	workspace     bool
}

type resolvedProgram struct {
	// Original argument snapshots are populated during resolution and read-only afterwards.
	sourceCallArgs map[ast.Invocable][]ast.BLangExpression
	sourceNewArgs  map[*ast.BLangNewExpression][]ast.BLangExpression
	xmlTemplates   map[ast.Node]bool
	files          Files
	env            *context.CompilerEnvironment
	modules        []*resolvedModule
}

// resolveProgram resolves captured source through local types, retaining no state between calls.
func resolveProgram(files Files) (program *resolvedProgram, items []Diagnostic, err error) {
	defer func() {
		if p := recover(); p != nil {
			program = nil
			err = fmt.Errorf("analysis panic: %v", p)
		}
	}()
	sources, input, err := projectInput(files)
	if err != nil || len(input.Diagnostics) > 0 {
		return nil, input.Diagnostics, err
	}
	loaded, err := projects.Load(sources, ".", projects.ProjectLoadConfig{Repositories: []projects.Repository{
		projects.NewFileSystemRepository(langlibs.FS, "."), projects.NewFileSystemRepository(stdlibs.FS, "."),
	}})
	if err != nil {
		var projectErr *projects.ProjectError
		if errors.As(err, &projectErr) {
			return nil, []Diagnostic{{Severity: Error, Code: "PROJECT_INPUT", Message: err.Error()}}, nil
		}
		return nil, nil, err
	}
	if loaded.Project() == nil {
		return nil, nil, fmt.Errorf("compiler loader returned no project")
	}
	root := loaded.Project().CurrentPackage()
	resolution := root.Resolution()
	env := loaded.Project().Environment().CompilerEnvironment()
	cache := loaded.Project().Environment().PackageCache()
	normalizedSources, err := diagnosticSources(files)
	if err != nil {
		return nil, nil, err
	}
	all := append([]diagnostics.Diagnostic{}, loaded.Diagnostics().Diagnostics()...)
	all = append(all, resolution.DiagnosticResult().Diagnostics()...)
	contexts := []*context.CompilerContext{}
	finish := func(p *resolvedProgram) (*resolvedProgram, []Diagnostic, error) {
		items := append([]diagnostics.Diagnostic{}, all...)
		for _, cx := range contexts {
			items = append(items, cx.Diagnostics()...)
		}
		normalized, err := normalizeDiagnostics(items, env.DiagnosticEnv(), normalizedSources)
		return p, normalized, err
	}
	if projects.NewDiagnosticResult(all).HasErrors() {
		return finish(nil)
	}
	program = &resolvedProgram{files: files, env: env, sourceCallArgs: map[ast.Invocable][]ast.BLangExpression{}, sourceNewArgs: map[*ast.BLangNewExpression][]ast.BLangExpression{}, xmlTemplates: map[ast.Node]bool{}}
	public := map[semantics.PackageIdentifier]model.ExportedSymbolSpace{}
	visibility := map[semantics.PackageIdentifier]semantics.ModuleVisibility{}
	var packages []*projects.Package
	for _, name := range implicitLibraries {
		pkg := cache.Get("ballerina", name, "0.0.1")
		if pkg == nil {
			return nil, nil, fmt.Errorf("missing embedded library %s", name)
		}
		packages = append(packages, pkg)
	}
	for _, desc := range resolution.DependencyGraph().ToTopologicallySortedList() {
		pkg := root
		if !desc.Equals(root.Descriptor()) {
			pkg = cache.Get(desc.Org().Value(), desc.Name().Value(), desc.Version().String())
		}
		if pkg == nil {
			return nil, nil, fmt.Errorf("missing resolved package %v", desc)
		}
		packages = append(packages, pkg)
	}
	seen := map[semantics.PackageIdentifier]bool{}
	for _, pkg := range packages {
		for _, desc := range pkg.Resolution().ModuleDependencyGraph().ToTopologicallySortedList() {
			id := semantics.PackageIdentifier{OrgName: desc.Org().Value(), ModuleName: desc.Name().String()}
			if seen[id] {
				continue
			}
			seen[id] = true
			mod := pkg.ModuleByName(desc.Name())
			if mod == nil {
				return nil, nil, fmt.Errorf("missing module %s", id.ModuleName)
			}
			cx := context.NewCompilerContext(env)
			contexts = append(contexts, cx)
			var units []*ast.BLangCompilationUnit
			var documentNames []string
			ids := mod.DocumentIDs()
			slices.SortFunc(ids, func(a, b projects.DocumentID) int {
				return strings.Compare(mod.Document(a).Name(), mod.Document(b).Name())
			})
			for _, docID := range ids {
				doc := mod.Document(docID)
				key := doc.SyntaxTree().FilePath()
				tree, parseErr := parser.GetSyntaxTree(cx, key, doc.TextDocument().String())
				if parseErr != nil {
					return nil, nil, parseErr
				}
				unit := nodebuilder.GetCompilationUnit(cx, tree)
				if pkg == root && !cx.HasErrors() {
					retainXMLTemplateSources(cx, tree, unit, program.xmlTemplates)
				}
				units = append(units, unit)
				documentNames = append(documentNames, key)
			}
			if cx.HasErrors() {
				return finish(nil)
			}
			parts := []model.Name{}
			for _, part := range strings.Split(id.ModuleName, ".") {
				parts = append(parts, model.Name(part))
			}
			pid := cx.NewPackageID(model.Name(id.OrgName), parts, model.Name(desc.Version().String()))
			for _, unit := range units {
				unit.SetPackageID(pid)
			}
			implicit := map[string]model.ExportedSymbolSpace{}
			for _, name := range implicitLibraries {
				if space, ok := public[semantics.PackageIdentifier{OrgName: "ballerina", ModuleName: name}]; ok {
					implicit[name] = space
				}
			}
			scope, exported, imports := semantics.ResolveSymbols(cx, *pid, units, implicit, public, visibility, id.OrgName, pkg.PackageName().Value())
			astPkg := nodebuilder.ToPackageFromCompilationUnits(cx, units)
			astPkg.Imports = nil
			astPkg.PackageID, astPkg.Scope = pid, scope
			if cx.HasErrors() {
				return finish(nil)
			}
			if pkg == root {
				ast.Walk(sourceVisitor(func(n ast.BLangNode) bool {
					if call, ok := n.(ast.Invocable); ok {
						program.sourceCallArgs[call] = append([]ast.BLangExpression{}, call.CallArgs()...)
					}
					if expr, ok := n.(*ast.BLangNewExpression); ok {
						program.sourceNewArgs[expr] = append([]ast.BLangExpression{}, expr.ArgsExprs...)
					}
					return true
				}), astPkg)
			}
			semantics.ResolvePublicNodeTypes(cx, astPkg, imports)
			if cx.HasErrors() {
				return finish(nil)
			}
			public[id] = exported
			visibility[id] = semantics.ModuleVisibility{PackageOrg: id.OrgName, PackageName: pkg.PackageName().Value(), Exported: slices.Contains(pkg.Manifest().ExportedModules(), id.ModuleName)}
			program.modules = append(program.modules, &resolvedModule{units: units, documentNames: documentNames, module: mod, ctx: cx, pkg: astPkg, imports: imports, workspace: pkg == root})
		}
	}
	for _, mod := range program.modules {
		semantics.ResolvePrivateNodesTypes(mod.ctx, mod.pkg, mod.imports)
		if mod.ctx.HasErrors() {
			return finish(nil)
		}
	}
	return finish(program)
}
