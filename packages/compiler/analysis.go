package compiler

import (
	"fmt"
	"maps"
	"unicode/utf8"

	"github.com/ballerina-nutcracker/ballerina/tools/diagnostics"
)

type SourceReferenceModel struct {
	File  string      `json:"file"`
	Range SourceRange `json:"range"`
}
type LocatedModel struct {
	ID     string               `json:"id"`
	Source SourceReferenceModel `json:"source"`
	Text   string               `json:"text"`
}
type DefinitionModel struct {
	LocatedModel
	Kind       string `json:"kind"`
	Label      string `json:"label"`
	FunctionID string `json:"functionId,omitempty"`
}
type EndpointModel struct {
	LocatedModel
	Kind       string `json:"kind"`
	Title      string `json:"title"`
	FunctionID string `json:"functionId"`
}
type ScopeModel struct {
	LocatedModel
	Kind        string             `json:"kind"`
	Title       string             `json:"title"`
	ModuleID    string             `json:"moduleId"`
	ServiceType *string            `json:"serviceType"`
	FunctionID  string             `json:"functionId,omitempty"`
	Endpoints   *[]EndpointModel   `json:"endpoints,omitempty"`
	Definitions *[]DefinitionModel `json:"definitions,omitempty"`
}
type AnalysisResult struct {
	Kind        string       `json:"kind"`
	Program     *HIRProgram  `json:"program,omitempty"`
	Diagnostics []Diagnostic `json:"diagnostics"`
}

// Analyze resolves saved workspace source without semantic analysis or desugaring.
func Analyze(files Files) (result AnalysisResult, err error) {
	defer func() {
		if p := recover(); p != nil {
			result = AnalysisResult{}
			err = fmt.Errorf("analysis extraction panic: %v", p)
		}
	}()
	capturedFiles := maps.Clone(files)
	program, items, err := resolveProgram(capturedFiles)
	if err != nil {
		return AnalysisResult{}, err
	}
	if items == nil {
		items = []Diagnostic{}
	}
	for _, item := range items {
		if item.Severity == Error || item.Severity == Fatal || item.Severity == Internal {
			return AnalysisResult{Kind: "invalid", Diagnostics: items}, nil
		}
	}
	if program == nil {
		return AnalysisResult{}, fmt.Errorf("resolution returned no program without an error diagnostic")
	}
	exported, err := lowerProgramMode(program, true)
	if err != nil {
		return AnalysisResult{}, err
	}
	if err := ValidateHIR(exported); err != nil {
		return AnalysisResult{}, fmt.Errorf("invalid lowered HIR: %w", err)
	}
	if err := validateHIRSources(exported, capturedFiles); err != nil {
		return AnalysisResult{}, err
	}
	return AnalysisResult{Kind: "valid", Program: &exported, Diagnostics: items}, nil
}

// validateHIRSources checks source associations before publishing a lowered program.
func validateHIRSources(program HIRProgram, files Files) error {
	check := func(located LocatedModel) error {
		text, ok := files[located.Source.File]
		if !ok {
			return fmt.Errorf("HIR source %q references missing file %q", located.ID, located.Source.File)
		}
		start, err := sourcePositionOffset(text, located.Source.Range.Start)
		if err != nil {
			return fmt.Errorf("HIR source %q start: %w", located.ID, err)
		}
		end, err := sourcePositionOffset(text, located.Source.Range.End)
		if err != nil {
			return fmt.Errorf("HIR source %q end: %w", located.ID, err)
		}
		if end < start || text[start:end] != located.Text {
			return fmt.Errorf("HIR source %q does not match captured source", located.ID)
		}
		return nil
	}
	for _, source := range program.Sources {
		if err := check(source); err != nil {
			return err
		}
	}
	for _, graph := range program.Functions {
		if err := check(graph.LocatedModel); err != nil {
			return err
		}
	}
	for _, scope := range program.Scopes {
		if err := check(scope.LocatedModel); err != nil {
			return err
		}
		if scope.Endpoints != nil {
			for _, endpoint := range *scope.Endpoints {
				if err := check(endpoint.LocatedModel); err != nil {
					return err
				}
			}
		}
		if scope.Definitions != nil {
			for _, definition := range *scope.Definitions {
				if err := check(definition.LocatedModel); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// sourcePositionOffset maps one-based Unicode code-point coordinates to an
// exclusive byte boundary. CRLF is a single newline, never a source column.
func sourcePositionOffset(text string, want Position) (int, error) {
	if want.Line < 1 || want.Column < 1 || !utf8.ValidString(text) {
		return 0, fmt.Errorf("invalid source position %+v", want)
	}
	current := Position{Line: 1, Column: 1}
	for offset := 0; ; {
		if current == want {
			return offset, nil
		}
		if offset == len(text) {
			break
		}
		r, size := utf8.DecodeRuneInString(text[offset:])
		offset += size
		if r == '\r' || r == '\n' {
			if r == '\r' && offset < len(text) && text[offset] == '\n' {
				offset++
			}
			current.Line++
			current.Column = 1
		} else {
			current.Column++
		}
	}
	return 0, fmt.Errorf("source position outside captured text: %+v", want)
}

func sourceReference(files Files, env *diagnostics.DiagnosticEnv, location diagnostics.Location) (SourceReferenceModel, error) {
	file := env.FileName(location)
	text, exists := files[file]
	if !exists || !diagnostics.LocationHasSource(location) {
		return SourceReferenceModel{}, fmt.Errorf("missing workspace source for %q", file)
	}
	if location.EndOffset() < location.StartOffset() {
		return SourceReferenceModel{}, fmt.Errorf("reversed source range in %q", file)
	}
	start, err := position(text, location.StartOffset())
	if err != nil {
		return SourceReferenceModel{}, err
	}
	end, err := position(text, location.EndOffset())
	if err != nil {
		return SourceReferenceModel{}, err
	}
	return SourceReferenceModel{File: file, Range: SourceRange{Start: start, End: end}}, nil
}
