import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered only for this file: happy-dom replaces global fetch, which other
// test files rely on.
beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const seen = new Set<object>();
const disposed = new Set<object>();

// Only these two modules are mocked: bun's mock.module is process-wide, and
// the other bal-bot suites import the real workspace and providers.
mock.module("@bal-bot/compiler", () => ({
	createCompiler: () => ({
		analyze: async () => ({ kind: "invalid", diagnostics: [] }),
		check: async () => ({ diagnostics: [] }),
	}),
}));
mock.module("../src/components/bal-bot/editor", () => ({
	Editor: ({ workspace }: { workspace: object }) => {
		seen.add(workspace);
		return <div data-testid="editor" />;
	},
}));

const { BrowserWorkspace } = await import("@bal-bot/browser-workspace");
const realDispose = BrowserWorkspace.prototype.dispose;
BrowserWorkspace.prototype.dispose = function (this: object) {
	disposed.add(this);
	realDispose.call(this);
};
const live = () => [...seen].filter((w) => !disposed.has(w));

const { StrictMode } = await import("react");
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { BalBotView } = await import("../src/components/bal-bot/bal-bot-view");

test("StrictMode leaves one live workspace and unmount disposes it", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const files = { "Ballerina.toml": '[package]\nname = "demo"\n' };

	await act(async () => {
		root.render(
			<StrictMode>
				<BalBotView files={files} onChange={async () => {}} onBack={() => {}} />
			</StrictMode>,
		);
	});

	expect(live()).toHaveLength(1);
	expect((live()[0] as InstanceType<typeof BrowserWorkspace>).list()).toEqual([
		"Ballerina.toml",
	]);
	expect(container.querySelector('[data-testid="editor"]')).not.toBeNull();

	await act(async () => root.unmount());
	expect(live()).toHaveLength(0);
	// StrictMode's throwaway first instance was disposed too.
	expect(disposed.size).toBe(2);
});

test("Back button calls onBack", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	let backs = 0;
	await act(async () => {
		root.render(
			<BalBotView
				files={{}}
				onChange={async () => {}}
				onBack={() => backs++}
			/>,
		);
	});
	await act(async () => {
		(
			container.querySelector('[data-testid="bal-bot-back"]') as HTMLElement
		).click();
	});
	expect(backs).toBe(1);
	await act(async () => root.unmount());
});

test("workspace edits reach onChange in order, with the snapshot before each", async () => {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const files = { "main.bal": "a" };
	const calls: [Record<string, string>, Record<string, string>][] = [];
	let release: () => void = () => {};
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const onChange = async (
		prev: Record<string, string>,
		next: Record<string, string>,
	) => {
		calls.push([prev, next]);
		// Holding the first change must hold back the next one.
		if (calls.length === 1) await blocked;
	};
	await act(async () => {
		root.render(
			<BalBotView files={files} onChange={onChange} onBack={() => {}} />,
		);
	});
	const workspace = live()[0] as InstanceType<typeof BrowserWorkspace>;

	await act(async () => {
		workspace.write("main.bal", "b");
		workspace.remove("main.bal");
	});
	// The constructor's initial save, unchanged from the files given.
	expect(calls).toEqual([[files, files]]);

	await act(async () => release());
	expect(calls).toEqual([
		[files, files],
		[files, { "main.bal": "b" }],
		[{ "main.bal": "b" }, {}],
	]);
	await act(async () => root.unmount());
});
