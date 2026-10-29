import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const server = await createServer({
	configFile: false,
	server: { middlewareMode: true },
	appType: "custom",
});
after(() => server.close());
const { wrappedVariables, VariableText } = await server.ssrLoadModule(
	fileURLToPath(
		new URL("../../src/components/bal-bot/variable-text.tsx", import.meta.url),
	),
);
const occurrence = (start, end, variableId = "x") => ({
	start,
	end,
	variableId,
});

test("wrapping preserves identifier boundaries at line breaks and within tokens", () => {
	assert.deepEqual(
		wrappedVariables(
			"abcdefgh",
			["abcd", "efgh"],
			[occurrence(0, 4), occurrence(4, 8)],
		),
		[occurrence(0, 4), occurrence(5, 9)],
	);
	assert.deepEqual(
		wrappedVariables("abcdefgh", ["abcd", "efgh"], [occurrence(2, 6)]),
		[occurrence(2, 7)],
	);
	assert.deepEqual(
		wrappedVariables("a\n\nb", ["a", "", "b"], [occurrence(3, 4)]),
		[occurrence(3, 4)],
	);
	assert.deepEqual(
		wrappedVariables("😀variable", ["😀var", "iable"], [occurrence(2, 10)]),
		[occurrence(2, 11)],
	);
});

test("variable spans retain text and introduce no focus or click actions", () => {
	const element = VariableText({
		text: "x + x",
		variables: [occurrence(0, 1), occurrence(4, 5)],
		activeVariable: "x",
	});
	const spans = element.props.children.filter((child) =>
		React.isValidElement(child),
	);
	assert.equal(spans.length, 2);
	let active;
	const interactive = VariableText({
		text: "x",
		variables: [occurrence(0, 1)],
		onVariableHover: (id) => {
			active = id;
		},
	}).props.children.find((child) => React.isValidElement(child));
	assert.equal(interactive.props.onClick, undefined);
	assert.equal(interactive.props.tabIndex, undefined);
	assert.equal(interactive.props.onFocus, undefined);
	interactive.props.onPointerEnter({ pointerType: "touch" });
	assert.equal(active, undefined);
	interactive.props.onPointerEnter({ pointerType: "mouse" });
	assert.equal(active, "x");
	interactive.props.onPointerLeave({ pointerType: "mouse" });
	assert.equal(active, undefined);
	assert.equal(
		renderToStaticMarkup(React.createElement(VariableText, { text: "plain" })),
		"plain",
	);
	assert.match(renderToStaticMarkup(element), /variable-active/);
});
