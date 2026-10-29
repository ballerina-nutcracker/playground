import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { instantiateGraph } from "../../src/components/bal-bot/hir-flow.ts";
import {
	buildDiagram,
	layoutDiagram as layoutLegacyDiagram,
} from "./legacy-flow.ts";
import { layoutDiagram } from "../../src/components/bal-bot/flow.ts";
import { syntheticHIR } from "./hir-synthetic-fixtures.mjs";
import { validateHIR } from "../../../../packages/compiler/src/protocol.ts";
const fixtures = new URL(
	"../../../../packages/compiler/testdata/upstream/tests/fixtures/",
	import.meta.url,
);
const json = async (path) =>
	JSON.parse(await readFile(new URL(path, fixtures), "utf8"));
const flatten = (nodes) =>
	nodes.flatMap((node) => [node, ...flatten(node.children)]);
function freeze(value) {
	if (value && typeof value === "object") {
		Object.values(value).forEach(freeze);
		Object.freeze(value);
	}
	return value;
}
function allExpanded(program, id) {
	const expanded = new Set();
	function visit(graph, occurrence, ancestors) {
		for (const node of graph.nodes)
			if (node.body.kind === "reference") {
				const ref = node.body.reference;
				if (
					ref.availability.kind === "available" &&
					!ancestors.includes(ref.graphId)
				) {
					const path = occurrence + ref.occurrenceKey;
					expanded.add(path);
					visit(program.functions[ref.graphId], path, [
						...ancestors,
						ref.graphId,
					]);
				}
			}
	}
	visit(program.functions[id], id, [id]);
	return expanded;
}
function structural(diagram) {
	const nodes = flatten(diagram.nodes),
		ids = new Set(nodes.map((n) => n.id)),
		ports = new Set(diagram.ports.map((p) => p.id));
	assert.equal(ids.size, nodes.length);
	assert.equal(ports.size, diagram.ports.length);
	for (const port of diagram.ports)
		assert.ok(ids.has(port.nodeId), `missing node ${port.nodeId}`);
	for (const edge of diagram.edges) {
		assert.ok(ports.has(edge.fromPort), edge.fromPort);
		assert.ok(ports.has(edge.toPort), edge.toPort);
	}
}
test("deserialized HIR uses literal node/port recipes, independent from source and roles", async () => {
	const p = await json("hir-contract/minimal.json");
	p.functions.main.nodes[0].occurrenceKey = " arbitrary /main";
	p.functions.main.ports[0].occurrenceKey = ":not-the-node-or-role";
	validateHIR(p);
	const d = instantiateGraph(freeze(p), "main", new Set());
	assert.equal(d.nodes[0].id, "main arbitrary /main");
	assert.equal(d.nodes[0].selection.id, "source-a");
	assert.equal(d.ports[0].id, "main:not-the-node-or-role");
	assert.equal(d.ports[0].nodeId, d.nodes[0].id);
	assert.equal(d.edges[0].fromPort, d.ports[0].id);
});
test("explicit columns, anchors and routing do not depend on presentation profiles or port roles", () => {
	const program = syntheticHIR("a9456a30");
	const original = instantiateGraph(program, "main", new Set());
	const measure = () => ({ width: 300, height: 20 });
	const numeric = (diagram) => {
		const { diagram: ignored, ...layout } = layoutDiagram(diagram, measure);
		return layout;
	};
	const expected = numeric(original);
	const changed = structuredClone(original);
	for (const node of flatten(changed.nodes))
		node.layout.profile = node.layout.split === undefined ? "if" : "sequence";
	for (const port of changed.ports) port.role = "panic";
	for (const edge of changed.edges) edge.kind = "back";
	assert.deepEqual(numeric(changed), expected);
	const columns = flatten(changed.nodes).find(
		(node) => node.layout.split !== undefined,
	);
	delete columns.layout.split;
	assert.notDeepEqual(
		numeric(changed).boxes,
		expected.boxes,
		"arrangement, not profile, chooses columns geometry",
	);
});
test("columns count effective visible members, including transparent and nested ownership", async () => {
	const base = await json("hir-contract/nested-group.json");
	const cases = [
		{ name: "hidden left", hidden: ["b"], children: ["c"], split: 0 },
		{ name: "hidden right", hidden: ["c"], children: ["b"], split: 1 },
		{ name: "no visible children", hidden: ["b", "c"], children: [], split: 0 },
		{
			name: "promoted left descendants",
			hidden: ["b"],
			leftGroup: true,
			children: ["d", "e", "c"],
			split: 2,
		},
		{
			name: "promoted right descendants",
			hidden: ["c"],
			rightGroup: true,
			children: ["b", "f", "h"],
			split: 1,
		},
		{
			name: "nested columns",
			hidden: ["d"],
			leftGroup: true,
			children: ["b", "c"],
			split: 1,
			nestedSplit: 0,
		},
		{
			name: "nested columns promoted through right",
			hidden: ["c", "f", "i"],
			rightGroup: true,
			nestedRight: true,
			children: ["b", "h"],
			split: 1,
			nestedSplit: 0,
		},
	];
	for (const scenario of cases) {
		const p = structuredClone(base),
			g = p.functions.main;
		const leaf = structuredClone(g.nodes[1]);
		const makeNode = (id) => ({
			...structuredClone(leaf),
			id,
			occurrenceKey: `/${id}`,
		});
		g.nodes = [
			"a",
			"b",
			...(scenario.leftGroup ? ["d", "e"] : []),
			"c",
			...(scenario.rightGroup
				? ["f", "h", ...(scenario.nestedRight ? ["i", "j"] : [])]
				: []),
		].map(makeNode);
		g.nodes[0].body = { kind: "group", groupId: "inner" };
		g.groups[1].arrangement = { kind: "columns", left: ["b"], right: ["c"] };
		for (const [owner, members] of [
			["b", ["d", "e"]],
			["c", ["f", "h"]],
			["h", ["i", "j"]],
		]) {
			if (
				!(owner === "b"
					? scenario.leftGroup
					: owner === "c"
						? scenario.rightGroup
						: scenario.nestedRight)
			)
				continue;
			g.nodes.find((n) => n.id === owner).body = {
				kind: "group",
				groupId: `${owner}-group`,
			};
			g.groups.push({
				id: `${owner}-group`,
				arrangement: {
					kind: "columns",
					left: [members[0]],
					right: [members[1]],
				},
				style: structuredClone(g.groups[1].style),
			});
		}
		for (const id of scenario.hidden)
			g.nodes.find((n) => n.id === id).presentation = { kind: "hidden" };
		g.ports = [];
		g.edges = [];
		g.interfaces = [];
		for (const mode of ["root", "inline"])
			g.emission[mode] = {
				nodes: g.nodes
					.filter((n) => n.presentation.kind !== "hidden")
					.map((n) => ({
						kind: "local",
						itemId: n.id,
						when: { kind: "constant", value: true },
					})),
				ports: [],
				edges: [],
			};
		validateHIR(p);
		const before = JSON.stringify(p);
		freeze(p);
		const diagram = instantiateGraph(p, "main", new Set()),
			columns = diagram.nodes[0];
		assert.deepEqual(
			columns.children.map((n) => n.id),
			scenario.children.map((id) => `main/${id}`),
			scenario.name,
		);
		assert.equal(columns.layout.split, scenario.split, scenario.name);
		if (scenario.nestedSplit !== undefined) {
			const nested = columns.children.find((n) => n.children.length);
			assert.equal(nested.layout.split, scenario.nestedSplit, scenario.name);
		}
		assert.equal(JSON.stringify(p), before, scenario.name);

		// Re-emitting an expanded child must retain its own column metadata rather
		// than restoring declared splits at the enclosing ownership pass.
		const wrapped = structuredClone(p),
			target = wrapped.functions.main;
		target.id = "target";
		wrapped.functions.target = target;
		wrapped.sources.target = {
			...structuredClone(wrapped.sources.main),
			id: "target",
		};
		const wrapper = makeNode("wrapper");
		wrapper.body = {
			kind: "reference",
			reference: {
				graphId: "target",
				occurrenceKey: "/child",
				availability: { kind: "available" },
				container: structuredClone(g.groups[1].style),
				collapsed: { interfaces: [], edges: [] },
				inline: [],
			},
		};
		const emission = {
			nodes: [
				{
					kind: "local",
					itemId: "wrapper",
					when: { kind: "constant", value: true },
				},
				{
					kind: "child",
					referenceNodeId: "wrapper",
					when: { kind: "constant", value: true },
				},
			],
			ports: [
				{
					kind: "child",
					referenceNodeId: "wrapper",
					when: { kind: "constant", value: true },
				},
			],
			edges: [
				{
					kind: "child",
					referenceNodeId: "wrapper",
					when: { kind: "constant", value: true },
				},
			],
		};
		wrapped.functions.main = {
			...structuredClone(target),
			id: "main",
			nodes: [wrapper],
			groups: [
				{
					...structuredClone(g.groups[0]),
					arrangement: { kind: "sequence", members: ["wrapper"] },
				},
			],
			emission: { root: emission, inline: structuredClone(emission) },
		};
		validateHIR(wrapped);
		freeze(wrapped);
		const inlineColumns = instantiateGraph(
			wrapped,
			"main",
			new Set(["main/child"]),
		).nodes[0].children[0];
		assert.equal(
			inlineColumns.layout.split,
			scenario.split,
			`${scenario.name} expanded child`,
		);
		assert.deepEqual(
			inlineColumns.children.map((n) => n.id),
			scenario.children.map((id) => `main/child/${id}`),
			`${scenario.name} expanded child order`,
		);
	}
});
test("call reference/disclosure keys agree without overwriting node identity", async () => {
	const p = await json("hir-contract/call-disclosure-reference-agreement.json");
	p.functions.main.nodes[0].occurrenceKey = "/evaluation";
	validateHIR(p);
	const d = instantiateGraph(p, "main", new Set(["maina"]));
	assert.equal(d.nodes[0].id, "main/evaluation");
	assert.equal(d.nodes[0].layout.reference.path, "maina");
	assert.equal(d.nodes[0].layout.reference.expanded, true);
});
test("one expansion set independently controls call and client-context occurrence paths", async () => {
	const p = freeze(await json("hir-contract/client-long-call.json"));
	validateHIR(p);
	for (const callExpanded of [false, true]) {
		for (const contextExpanded of [false, true]) {
			const expanded = new Set([
				...(callExpanded ? ["maina"] : []),
				...(contextExpanded ? ["maina/context"] : []),
			]);
			const before = [...expanded];
			const node = flatten(instantiateGraph(p, "main", expanded).nodes).find(
				(n) => n.id === "maina",
			);
			assert.equal(node.layout.reference.expanded, callExpanded);
			assert.equal(node.contextPath, "maina/context");
			assert.equal(node.contextExpanded, contextExpanded);
			assert.deepEqual([...expanded], before);
		}
	}
});
test("recursive disclosure selects a complete presentation without collapsing expanded client context", async () => {
	for (const fixture of [
		"client-short-call",
		"client-short-unavailable",
		"client-long-call",
		"client-long-unavailable",
	]) {
		const p = await json(`hir-contract/${fixture}.json`);
		const source = p.functions.main.nodes[0];
		source.body.reference.graphId = "main";
		for (const contextExpanded of [false, true])
			for (const requestedExpansion of [false, true]) {
				const expanded = new Set([
					...(contextExpanded ? ["maina/context"] : []),
					...(requestedExpansion ? ["maina"] : []),
				]);
				const node = flatten(instantiateGraph(p, "main", expanded).nodes).find(
					(n) => n.id === "maina",
				);
				const d = source.presentation.disclosure;
				const expected =
					d.kind === "client-context"
						? contextExpanded
							? d.expandedRecursive
							: d.call.recursive
						: d.recursive;
				assert.equal(node.layout.reference.recursive, true);
				assert.equal(node.layout.reference.expanded, false);
				assert.equal(node.label, expected.label);
				assert.deepEqual(node.presentation.sections, expected.sections);
				assert.deepEqual(node.layout.reference.recursivePresentation, expected);
			}
	}
});
test("nested context paths use their call occurrence prefix from the same expansion set", async () => {
	const p = await json("hir-contract/client-long-call.json");
	const presentation = structuredClone(p.functions.main.nodes[0].presentation);
	presentation.disclosure.call = null;
	presentation.disclosure.expandedRecursive = null;
	p.functions.target.nodes[0].presentation = presentation;
	const childId = `maina${p.functions.target.nodes[0].occurrenceKey}`;
	freeze(p);
	for (const contextExpanded of [false, true]) {
		const expanded = new Set([
			"maina",
			"maina/context",
			...(contextExpanded ? ["mainaa/context"] : []),
		]);
		const nodes = flatten(instantiateGraph(p, "main", expanded).nodes);
		assert.equal(nodes.find((n) => n.id === "maina").contextExpanded, true);
		const child = nodes.find((n) => n.id === childId);
		assert.equal(child.contextPath, "mainaa/context");
		assert.equal(child.contextExpanded, contextExpanded);
	}
});
test("missing selection is empty; missing referenced graph is a model failure, including collapsed references", async () => {
	const p = await json("hir-contract/entry-binding.json");
	const empty = {
		nodes: [],
		ports: [],
		edges: [],
		interfaces: new Map(),
		bindings: new Map(),
	};
	for (const id of [
		"missing",
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
	]) {
		assert.deepEqual(
			instantiateGraph(freeze(structuredClone(p)), id, new Set()),
			empty,
			id,
		);
	}
	p.functions.main.nodes[0].body.reference.graphId = "missing";
	assert.throws(() => instantiateGraph(p, "main", new Set()), /missing/);
	assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
	for (const id of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
		p.functions.main.nodes[0].body.reference.graphId = id;
		assert.throws(() => validateHIR(p), /Invalid compiler HIR/, id);
	}
});
test("own prototype-named graph IDs instantiate and render; inherited selections have no entry", async (t) => {
	const server = await createServer({
		configFile: false,
		server: { middlewareMode: true },
		appType: "custom",
	});
	t.after(() => server.close());
	const { FlowView } = await server.ssrLoadModule(
		fileURLToPath(
			new URL("../../src/components/bal-bot/flow-view.tsx", import.meta.url),
		),
	);
	// SSR has no canvas; deterministic text metrics suffice for this lookup test.
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	globalThis.document = {
		createElement: () => ({
			getContext: () => ({
				measureText: (text) => ({ width: text.length * 8 }),
			}),
		}),
	};
	t.after(() => {
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else delete globalThis.document;
	});
	const render = (program, functionId) =>
		renderToStaticMarkup(
			React.createElement(FlowView, {
				flow: {
					state: { kind: "ready", revision: 1, program, diagnostics: [] },
					selection: { kind: "function", functionId },
				},
				references: [],
				expanded: new Set(),
				onToggle() {},
				onSelect() {},
				onOpenFunction() {},
			}),
		);
	const missing = freeze(await json("hir-contract/minimal.json"));
	for (const id of [
		"missing",
		"toString",
		"constructor",
		"__proto__",
		"hasOwnProperty",
	]) {
		const html = render(missing, id);
		assert.match(html, /No statements in this function/);
		assert.doesNotMatch(html, /flow-entry/);
	}
	for (const id of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
		const p = await json("hir-contract/minimal.json");
		const graph = { ...p.functions.main, id };
		// Computed keys preserve __proto__ as an own data property, as JSON does.
		p.functions = { [id]: graph };
		p.sources = { ...p.sources, [id]: { ...p.sources.main, id } };
		validateHIR(p);
		freeze(p);
		const before = JSON.stringify(p);
		const diagram = instantiateGraph(p, id, new Set());
		assert.equal(diagram.nodes.length, graph.nodes.length, id);
		assert.equal(diagram.nodes[0].id, id + graph.nodes[0].occurrenceKey);
		const html = render(p, id);
		assert.match(html, /flow-entry/);
		assert.doesNotMatch(html, /No statements in this function/);
		assert.equal(JSON.stringify(p), before);
	}
});
test("canonical view honors explicit container visibility even for the if spacing profile", async (t) => {
	const server = await createServer({
		configFile: false,
		server: { middlewareMode: true },
		appType: "custom",
	});
	t.after(() => server.close());
	const { FlowView } = await server.ssrLoadModule(
		fileURLToPath(
			new URL("../../src/components/bal-bot/flow-view.tsx", import.meta.url),
		),
	);
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	globalThis.document = {
		createElement: () => ({
			getContext: () => ({
				measureText: (text) => ({ width: text.length * 8 }),
			}),
		}),
	};
	t.after(() => {
		if (previousDocument)
			Object.defineProperty(globalThis, "document", previousDocument);
		else delete globalThis.document;
	});
	const program = structuredClone(syntheticHIR("a9456a30"));
	const group = program.functions.main.groups.find(
		(group) => group.arrangement.kind === "columns",
	);
	assert.equal(group.style.profile, "if");
	const render = () =>
		renderToStaticMarkup(
			React.createElement(FlowView, {
				flow: {
					state: { kind: "ready", revision: 1, program, diagnostics: [] },
					selection: { kind: "function", functionId: "main" },
				},
				references: [],
				expanded: new Set(),
				onToggle() {},
				onSelect() {},
				onOpenFunction() {},
			}),
		);
	assert.equal(
		group.style.root.container,
		false,
		"compiler fixture carries the visibility explicitly",
	);
	assert.doesNotMatch(render(), /class="container condition"/);
	group.style.root.container = true;
	assert.match(render(), /class="container condition"/);
});
test("collapsed interfaces resolve later siblings lazily without interface-name semantics", async () => {
	const p = await json("hir-contract/minimal.json");
	const g = p.functions.main,
		yes = { kind: "constant", value: true };
	const query = {
		kind: "nonempty",
		referenceNodeId: "b",
		interfaceId: "uninterpreted",
	};
	for (const node of g.nodes)
		node.body = {
			kind: "reference",
			reference: {
				graphId: "main",
				occurrenceKey: `${node.id}/reference`,
				availability: { kind: "available" },
				container: g.groups[0].style,
				collapsed: {
					interfaces: [
						{
							id: "uninterpreted",
							members: [
								{
									portId: node.id === "a" ? "out" : "in",
									when: node.id === "a" ? query : yes,
								},
							],
							exports: [],
							root: { kind: "terminal" },
						},
					],
					edges: [],
				},
				inline: [],
			},
		};
	g.interfaces[0].members[0].when = {
		kind: "nonempty",
		referenceNodeId: "a",
		interfaceId: "uninterpreted",
	};
	assert.deepEqual(
		instantiateGraph(p, "main", new Set()).interfaces.get("entry"),
		["mainport/in"],
	);
	g.nodes[1].body.reference.collapsed.interfaces[0].members[0].when = {
		kind: "constant",
		value: false,
	};
	assert.deepEqual(
		instantiateGraph(p, "main", new Set()).interfaces.get("entry"),
		[],
	);
	g.nodes[1].body.reference.collapsed.interfaces[0].members[0].when = {
		kind: "nonempty",
		referenceNodeId: "a",
		interfaceId: "uninterpreted",
	};
	assert.throws(() => instantiateGraph(p, "main", new Set()), /cyclic/);
});
test("port recipes are required and unique across occurrence identities", async () => {
	const p = await json("hir-contract/minimal.json");
	delete p.functions.main.ports[0].occurrenceKey;
	assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
	p.functions.main.ports[0].occurrenceKey =
		p.functions.main.nodes[0].occurrenceKey;
	assert.throws(() => validateHIR(p), /Invalid compiler HIR/);
});
test("compiler HIR preserves legacy construction edge order across flattened blocks and expanded calls", async () => {
	// The legacy builder is a test-only oracle, never an input to HIR lowering.
	let graphs = 0;
	for (const name of await readdir(new URL("hir-projects/", fixtures))) {
		let hir, legacy;
		try {
			hir = await json(`hir-projects/${name}/hir.golden.json`);
			legacy = await json(`hir-projects/${name}/legacy-model.json`);
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
			throw error;
		}
		validateHIR(hir);
		for (const id of Object.keys(hir.functions)) {
			for (const expanded of [new Set(), allExpanded(hir, id)]) {
				const actual = instantiateGraph(hir, id, expanded);
				const expected = buildDiagram(legacy, id, expanded);
				// Legacy edges carry no routing field; compare semantic edges in their
				// original order, without sorting either side.
				const scenario = `${name}/${id}: ${expanded.size} expanded occurrences`;
				assert.deepEqual(
					actual.edges.map(({ routing, ...edge }) => edge),
					expected.edges,
					scenario,
				);
				const measure = (label) => ({
					width: Math.min(340, label.length * 8),
					height: 20,
				});
				const { diagram: actualDiagram, ...actualLayout } = layoutDiagram(
					actual,
					measure,
				);
				const { diagram: expectedDiagram, ...expectedLayout } =
					layoutLegacyDiagram(expected, measure);
				assert.deepEqual(actualLayout, expectedLayout, scenario);
			}
			graphs++;
		}
	}
	assert.ok(graphs >= 119);
});
test("resolved nested presence preserves ordered emission and independent continuations", async () => {
	const directory = "hir-projects/targeted-nested-presence/";
	const p = freeze(await json(`${directory}hir.golden.json`));
	const legacy = await json(`${directory}legacy-model.json`);
	validateHIR(p);
	const before = JSON.stringify(p);
	const functionId = (name) =>
		Object.keys(p.functions).find((id) => p.functions[id].entry.name === name);
	const references = (id) =>
		p.functions[id].nodes.filter((n) => n.body.kind === "reference");
	const hierarchy = (nodes) =>
		nodes.map(({ id, label, children }) => ({
			id,
			label,
			children: hierarchy(children),
		}));
	const check = (id, expanded) => {
		const requested = [...expanded];
		const actual = instantiateGraph(p, id, expanded),
			expected = buildDiagram(legacy, id, expanded);
		structural(actual);
		assert.deepEqual(
			actual.edges.map(({ routing, ...edge }) => edge),
			expected.edges,
		);
		assert.deepEqual(
			actual.ports.map(({ anchor, ...port }) => port),
			expected.ports,
		);
		assert.deepEqual(hierarchy(actual.nodes), hierarchy(expected.nodes));
		assert.deepEqual([...expanded], requested);
		assert.equal(
			JSON.stringify(p),
			before,
			"deep-frozen stored HIR bytes remain unchanged",
		);
		return actual;
	};
	for (const name of ["main", "emptyMain"]) {
		const id = functionId(name),
			refs = references(id);
		assert.equal(refs.length, 2);
		const outer = refs.map((n) => id + n.body.reference.occurrenceKey);
		const child = references(refs[0].body.reference.graphId)[0].body.reference;
		const inner = outer.map((path) => path + child.occurrenceKey);
		// Include inner requests under collapsed parents and each mixed sibling state.
		for (const paths of [
			[],
			inner,
			[outer[0]],
			[outer[1]],
			outer,
			[...outer, inner[0]],
			[...outer, inner[1]],
			[...outer, ...inner],
		]) {
			check(id, new Set(paths));
		}
		const statement = (i) => `${id}/${id}/statement/${i}`;
		for (const firstOpen of [false, true])
			for (const secondOpen of [false, true]) {
				const d = check(
					id,
					new Set([
						...outer,
						...(firstOpen ? [inner[0]] : []),
						...(secondOpen ? [inner[1]] : []),
					]),
				);
				const hasEdge = (fromPort, toPort) =>
					d.edges.some((e) => e.fromPort === fromPort && e.toPort === toPort);
				// Panic is currently an unsupported terminal body, not a normal continuation.
				// An empty expanded body, by contrast, connects its entry directly to exit.
				const continues =
					name === "emptyMain" ? [true, true] : [!firstOpen, !secondOpen];
				assert.equal(
					hasEdge(`${outer[0]}:normal-exit`, `${statement(1)}:entry`),
					continues[0],
				);
				assert.equal(
					hasEdge(`${outer[1]}:normal-exit`, `${statement(3)}:entry`),
					continues[1],
				);
				assert.equal(
					hasEdge(`${statement(1)}:normal-exit`, `${statement(2)}:entry`),
					true,
					"legacy preserves the intervening caller edge even after a terminal predecessor",
				);
				assert.deepEqual(
					d.nodes[0].children.map((n) => n.id),
					Array.from({ length: name === "main" ? 6 : 4 }, (_, i) =>
						statement(i),
					),
				);
				const exit = name === "main" ? "returns" : "normal";
				for (const [i, open] of [firstOpen, secondOpen].entries()) {
					assert.equal(d.bindings.get(`${outer[i]}/enter`).length, 1);
					assert.equal(
						d.bindings.get(`${outer[i]}/exit/${exit}`).length,
						Number(continues[i]),
					);
					if (name === "emptyMain" && open) {
						assert.equal(
							hasEdge(`${inner[i]}:entry`, `${inner[i]}:normal-exit`),
							true,
						);
					}
					const bindingEdges = d.bindings.get(`${outer[i]}/exit/${exit}`);
					assert.deepEqual(
						d.edges.filter((edge) => bindingEdges.includes(edge)),
						bindingEdges,
						"binding edges retain their emission order",
					);
					if (name === "main") {
						const returnPort = `${outer[i]}/${functionId("helper")}/statement/0:return`;
						assert.equal(
							d.ports.some((port) => port.id === returnPort),
							!open,
						);
					}
				}
				assert.equal(d.edges.at(-2).fromPort, `${id}/root:entry`);
				assert.equal(d.edges.at(-1).toPort, `${id}/root:normal-exit`);
			}
	}
	for (const name of [
		"helper",
		"emptyHelper",
		"emptyBody",
		"nestedReturns",
		"returningHelper",
		"unsupportedBody",
	]) {
		const id = functionId(name);
		for (const expanded of [new Set(), allExpanded(p, id)]) {
			const d = check(id, expanded);
			if (name === "nestedReturns") {
				const call = id + references(id)[0].body.reference.occurrenceKey;
				const returned = `${id}/${id}/statement/0:return`;
				assert.equal(
					d.ports.some((port) => port.id === returned),
					true,
				);
				assert.equal(
					d.edges.some(
						(edge) =>
							edge.fromPort === `${call}:normal-exit` &&
							edge.toPort === returned &&
							edge.kind === "return",
					),
					true,
				);
				// Root returns remain terminal in the legacy oracle; only inline
				// return bindings connect the child return to its caller's exit.
				assert.equal(
					d.edges.some(
						(edge) =>
							edge.fromPort === returned &&
							edge.toPort === `${id}/root:normal-exit`,
					),
					false,
				);
				assert.equal(d.edges.at(-1).fromPort, `${id}/root:entry`);
			}
		}
	}
});
test("post-baseline HIR corpus instantiates frozen round trips with isolated occurrences", async () => {
	let graphs = 0;
	for (const name of await readdir(new URL("hir-projects/", fixtures))) {
		let p;
		try {
			p = freeze(await json(`hir-projects/${name}/hir.golden.json`));
		} catch (error) {
			if (error.code === "ENOENT" || error.code === "ENOTDIR") continue;
			throw error;
		}
		const before = JSON.stringify(p);
		for (const id of Object.keys(p.functions)) {
			for (const expanded of [new Set(), allExpanded(p, id)]) {
				const first = instantiateGraph(p, id, expanded);
				structural(first);
				assert.deepEqual(first, instantiateGraph(p, id, expanded));
				for (const node of flatten(first.nodes))
					assert.ok(Object.hasOwn(p.sources, node.selection.id));
			}
			graphs++;
		}
		assert.equal(JSON.stringify(p), before);
	}
	assert.ok(graphs >= 100);
});
