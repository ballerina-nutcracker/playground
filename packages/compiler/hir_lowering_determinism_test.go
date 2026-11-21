package compiler

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoweringTemplateInsertionSourceIdentities(t *testing.T) {
	files := project("function identity(int value) returns int => value;\npublic function main() {\n int plain = 7;\n string value = string `before ${plain} middle ${identity(plain)} after ${plain}`;\n _ = value;\n}\n")
	checkHIRLegacySourceIndexParity(t, files)
	p, items, err := resolveProgram(files)
	if err != nil || p == nil {
		t.Fatalf("resolve: %v: %+v", err, items)
	}
	var before string
	for repeat := 0; repeat < 100; repeat++ {
		hir, err := lowerProgram(p)
		if err != nil {
			t.Fatal(err)
		}
		for i, text := range []string{"plain", "identity(plain)", "plain"} {
			suffix := fmt.Sprintf("/statement/1/value/insertion/%d", i)
			found := false
			for id, loc := range hir.Sources {
				if strings.HasSuffix(id, suffix) {
					found = true
					if loc.Text != text {
						t.Errorf("%s: text %q, want %q", id, loc.Text, text)
					}
					if i != 1 {
						for _, graph := range hir.Functions {
							for _, node := range graph.Nodes {
								if node.SourceID == id {
									t.Errorf("plain insertion %s emitted an evaluation node", id)
								}
							}
						}
					}
				}
			}
			if !found {
				t.Errorf("missing insertion source %s", suffix)
			}
		}
		after := checkLoweredHIR(t, files, hir)
		if repeat > 0 && before != after {
			t.Fatalf("template identities changed at iteration %d", repeat)
		}
		before = after
	}
}

func TestLoweringRepeatedReceiverIdentities(t *testing.T) {
	files := readHIRSources(t, filepath.Join(hirProjectsRoot, "targeted-provenance", "source"))
	p, items, err := resolveProgram(files)
	if err != nil || p == nil {
		t.Fatalf("resolve: %v: %+v", err, items)
	}
	first, err := lowerProgram(p)
	if err != nil {
		t.Fatal(err)
	}
	before := checkLoweredHIR(t, files, first)
	for i := 0; i < 100; i++ {
		next, err := lowerProgram(p)
		if err != nil {
			t.Fatal(err)
		}
		after := checkLoweredHIR(t, files, next)
		if before != after {
			if err := os.WriteFile("/tmp/stage4-lowering-before.json", []byte(before), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile("/tmp/stage4-lowering-after.json", []byte(after), 0600); err != nil {
				t.Fatal(err)
			}
			t.Fatalf("repeated lowering changed HIR at iteration %d; JSON in /tmp/stage4-lowering-{before,after}.json", i)
		}
	}
}
