import { test } from "node:test";
import assert from "node:assert/strict";
import {
	addReference,
	removeReference,
	refreshReferences,
	serializePrompt,
	formatReference,
} from "../../src/components/bal-bot/references.ts";
const files = { "main.bal": "😀é\r\nx\n" },
	source = {
		file: "main.bal",
		range: { start: { line: 1, column: 1 }, end: { line: 2, column: 1 } },
	},
	node = { id: "node", source, text: "😀é\r\n" };
const state = {
	kind: "ready",
	revision: 1,
	diagnostics: [],
	program: {
		scopes: [],
		sources: { node, fn: { id: "fn", source, text: "😀é\r\n" } },
		functions: {
			fn: {
				id: "fn",
				source,
				text: "😀é\r\n",
				moduleId: "m",
				entry: {
					kind: "function",
					owner: null,
					operation: null,
					name: "fn",
					signature: "",
					parameters: [],
					returnType: "()",
				},
				nodes: [],
				ports: [],
				edges: [],
				groups: [
					{
						id: "fn/root",
						arrangement: { kind: "sequence", members: [] },
						style: {
							profile: "root",
							root: { node: false, header: false, container: false },
							inline: { node: false, header: false, container: false },
						},
					},
				],
				rootGroup: "fn/root",
				interfaces: [],
				emission: {
					root: { nodes: [], ports: [], edges: [] },
					inline: { nodes: [], ports: [], edges: [] },
				},
			},
		},
	},
};
const scope = { id: "fn", kind: "automation", title: "Automation", source };
test("references preserve prose, deduplicate source identity, format occupied rows and serialize exact Unicode text", () => {
	let draft = { text: "keep prose", references: [] };
	draft = addReference(draft, node, 1);
	draft = addReference(draft, node, 1);
	assert.equal(draft.references.length, 1);
	assert.equal(draft.text, "keep prose");
	assert.equal(formatReference(source), "main.bal:1–1");
	assert.equal(
		formatReference({
			...source,
			range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } },
		}),
		"main.bal:2–2",
	);
	assert.match(serializePrompt(draft, state, files, scope), /😀é\\r\\n/);
	assert.equal(removeReference(draft, node.id).references.length, 0);
	assert.equal(draft.references.length, 1);
	const chipsOnly = { ...draft, text: "" };
	assert.match(
		serializePrompt(chipsOnly, state, files, scope),
		/source-references/,
	);
});
test("saved revisions invalidate chips; only identical identity/range/text refresh, and serialization rejects stale revisions", () => {
	const draft = addReference({ text: "prose", references: [] }, node, 1),
		pending = { kind: "pending", revision: 2, previous: state.program };
	assert.ok(refreshReferences(draft, pending, files).references[0].stale);
	assert.throws(() => serializePrompt(draft, pending, files, scope), /Wait/);
	const next = { ...state, revision: 2 };
	assert.throws(() => serializePrompt(draft, next, files, scope), /stale/);
	const fresh = refreshReferences(draft, next, files);
	assert.equal(fresh.references[0].revision, 2);
	assert.equal(fresh.references[0].stale, false);
	const moved = structuredClone(next);
	moved.program.sources.node.source.range.end.column = 2;
	assert.ok(refreshReferences(draft, moved, files).references[0].stale);
	assert.ok(
		refreshReferences(draft, next, { "main.bal": "changed" }).references[0]
			.stale,
	);
	assert.equal(draft.text, "prose");
});
test("plain prose remains sendable for repairs while old source is stale", () => {
	const prompt = serializePrompt(
		{ text: "Fix the saved source", references: [] },
		{
			kind: "invalid",
			revision: 2,
			previous: state.program,
			diagnostics: [{ severity: "error", message: "bad source" }],
		},
		files,
		scope,
	);
	assert.match(prompt, /Fix the saved source/);
	assert.match(prompt, /stale; read current saved files/);
});
