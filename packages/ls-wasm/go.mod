module playground/ls-wasm

go 1.27.0

toolchain go1.27.1

require (
	github.com/ballerina-nutcracker/ballerina v0.7.0
	github.com/ballerina-nutcracker/ballerina/platform v0.7.0
)

require (
	github.com/ballerina-nutcracker/ballerina/ast v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/bir v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/birgen v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/common v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/compilerplugin v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/compilerpluginregistry v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/context v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/decimal v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/desugar v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/lib v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/model v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/nodebuilder v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/parser v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/prettyprint v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/projects v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/runtime v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/semantics v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/semtypes v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/st v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/testplan v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/tools v0.7.0 // indirect
	github.com/ballerina-nutcracker/ballerina/values v0.7.0 // indirect
	github.com/cockroachdb/apd/v3 v3.2.3 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	golang.org/x/text v0.37.0 // indirect
)

replace github.com/ballerina-nutcracker/ballerina => ./.upstream

replace github.com/ballerina-nutcracker/ballerina/decimal => ./.upstream/decimal

replace github.com/ballerina-nutcracker/ballerina/tools => ./.upstream/tools

replace github.com/ballerina-nutcracker/ballerina/context => ./.upstream/context

replace github.com/ballerina-nutcracker/ballerina/bir => ./.upstream/bir

replace github.com/ballerina-nutcracker/ballerina/nodebuilder => ./.upstream/nodebuilder

replace github.com/ballerina-nutcracker/ballerina/projects => ./.upstream/projects

replace github.com/ballerina-nutcracker/ballerina/platform => ./.upstream/platform

replace github.com/ballerina-nutcracker/ballerina/runtime => ./.upstream/runtime

replace github.com/ballerina-nutcracker/ballerina/values => ./.upstream/values

replace github.com/ballerina-nutcracker/ballerina/birgen => ./.upstream/birgen

replace github.com/ballerina-nutcracker/ballerina/semantics => ./.upstream/semantics

replace github.com/ballerina-nutcracker/ballerina/cli => ./.upstream/cli

replace github.com/ballerina-nutcracker/ballerina/parser => ./.upstream/parser

replace github.com/ballerina-nutcracker/ballerina/st => ./.upstream/st

replace github.com/ballerina-nutcracker/ballerina/common => ./.upstream/common

replace github.com/ballerina-nutcracker/ballerina/desugar => ./.upstream/desugar

replace github.com/ballerina-nutcracker/ballerina/model => ./.upstream/model

replace github.com/ballerina-nutcracker/ballerina/lib => ./.upstream/lib

replace github.com/ballerina-nutcracker/ballerina/ast => ./.upstream/ast

replace github.com/ballerina-nutcracker/ballerina/semtypes => ./.upstream/semtypes

replace github.com/ballerina-nutcracker/ballerina/prettyprint => ./.upstream/prettyprint

replace github.com/ballerina-nutcracker/ballerina/compilerplugin => ./.upstream/compilerplugin

replace github.com/ballerina-nutcracker/ballerina/compilerpluginregistry => ./.upstream/compilerpluginregistry

replace github.com/ballerina-nutcracker/ballerina/testplan => ./.upstream/testplan
