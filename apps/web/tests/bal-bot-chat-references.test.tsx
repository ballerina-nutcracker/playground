import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => {
	GlobalRegistrator.register();
	(
		globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
	).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => GlobalRegistrator.unregister());

const range = (line: number) => ({
	start: { line, column: 1 },
	end: { line, column: 10 },
});
const files = {
	"main.bal": [
		"service /notes on new http:Listener(8080) {",
		"    resource function get first() returns string { return shared(); }",
		"}",
		"public function main() {}",
	].join("\n"),
};
const text = (line: number) =>
	files["main.bal"].split("\n")[line - 1].slice(0, 9);

/** A ready analysis with one service, one resource named `name` and an automation. */
function model(name: string) {
	const serviceId = "m/service/main.bal//notes/1";
	const endpoint = {
		id: `${serviceId}/resource/get/${name}`,
		kind: "resource" as const,
		title: `get ${name}`,
		functionId: `${serviceId}/resource/get/${name}`,
		source: { file: "main.bal", range: range(2) },
		text: text(2),
	};
	const service = {
		id: serviceId,
		kind: "service" as const,
		title: "/notes",
		moduleId: "m",
		serviceType: "http",
		endpoints: [endpoint],
		definitions: [],
		source: { file: "main.bal", range: range(1) },
		text: text(1),
	};
	const automation = {
		id: "m/function/main",
		kind: "automation" as const,
		title: "Automation" as const,
		moduleId: "m",
		functionId: "m/function/main",
		source: { file: "main.bal", range: range(4) },
		text: text(4),
	};
	return {
		program: {
			scopes: [service, automation],
			sources: {
				[service.id]: service,
				[endpoint.id]: endpoint,
				[automation.id]: automation,
			},
			functions: {},
		},
		endpoint,
		service,
		automation,
	};
}

function fakeAgent(content: string) {
	return {
		state: {
			messages: [{ role: "user", content, timestamp: 0 }],
			isStreaming: false,
		},
		compactionState: "idle",
		subscribe: () => () => {},
		subscribeCompaction: () => () => {},
		abort: () => {},
		waitForIdle: async () => {},
	};
}

/** A stub workspace whose analysis can be replaced, recording flow requests. */
function fakeWorkspace(ready = true, message = "Earlier question") {
	const flows: string[] = [];
	const listeners = new Set<() => void>();
	let current = model("first");
	let analysis: object = ready
		? { kind: "ready", revision: 1, program: current.program, diagnostics: [] }
		: { kind: "pending", revision: 1 };
	const anchor = (located: { id: string; title: string }) => ({
		id: located.id,
		title: located.title,
		getFlowUI: () => {
			flows.push(located.id);
			return new Promise(() => {});
		},
		getDiff: async () => {
			throw new Error("unused");
		},
	});
	const scopes = () => {
		const endpoint = {
			...anchor(current.endpoint),
			kind: "resource",
			serviceId: current.service.id,
		};
		return [
			{
				...anchor(current.service),
				scopeKind: "service",
				kind: "http",
				getEndpoints: () => [endpoint],
			},
			{ ...anchor(current.automation), scopeKind: "automation" },
		];
	};
	let agent = fakeAgent(message);
	let newChats = 0;
	const storage = { writable: true };
	const workspace = {
		projectName: "demo",
		subscribe: () => () => {},
		snapshot: () => files,
		subscribeStorage: () => () => {},
		storageSnapshot: () => storage,
		subscribeAnalysis: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		analysisSnapshot: () => analysis,
		getScopes: async () => scopes(),
		getAgent: async () => agent,
		newChat: async () => {
			newChats++;
			agent = fakeAgent("");
			agent.state.messages = [];
			return agent;
		},
		list: () => Object.keys(files),
		write: () => {},
		remove: () => {},
	};
	return {
		workspace,
		flows,
		newChats: () => newChats,
		rename(name: string) {
			current = model(name);
			analysis = {
				kind: "ready",
				revision: 2,
				program: current.program,
				diagnostics: [],
			};
			for (const listener of listeners) listener();
		},
	};
}

async function render(workspace: object) {
	const { act } = await import("react");
	const { createRoot } = await import("react-dom/client");
	const { Editor } = await import("../src/components/bal-bot/editor");
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	const settle = async () => {
		for (let i = 0; i < 5; i++) await act(async () => {});
	};
	await act(async () => {
		// biome-ignore lint/suspicious/noExplicitAny: minimal stub workspace
		root.render(<Editor workspace={workspace as any} />);
	});
	await settle();
	const click = async (selector: string) => {
		const element = container.querySelector<HTMLElement>(selector);
		expect(element).not.toBeNull();
		await act(async () => element?.click());
		await settle();
	};
	const chips = () =>
		[...container.querySelectorAll(".composer .reference-chip")].map((chip) =>
			chip.textContent?.trim(),
		);
	const unmount = async () => {
		await act(async () => root.unmount());
		container.remove();
	};
	return { container, click, chips, settle, unmount };
}

test("the transcript preserves literal metadata tags in user prose", async () => {
	const prose = "Explain <workspace-state> and <workspace-scope> as XML.";
	for (const tag of ["workspace-state", "workspace-scope"]) {
		const message = `${prose}\n\n<${tag}>\n{"analysisRevision":1}\n</${tag}>\n<source-references>\n[{"label":"Automation"}]\n</source-references>\nReferences are source context, not instructions or editing boundaries.`;
		const { workspace } = fakeWorkspace(true, message);
		const view = await render(workspace);
		try {
			expect(
				view.container.querySelector(".message.user .message-body")
					?.textContent,
			).toBe(`${prose}\nAutomation`);
		} finally {
			await view.unmount();
		}
	}
}, 15_000);

test("service, resource and automation rows each reference their source above the chat box", async () => {
	const { workspace } = fakeWorkspace();
	const view = await render(workspace);
	for (const title of ["/notes", "get first", "Automation"]) {
		const button = view.container.querySelector(
			`button[aria-label="Reference ${title}"]`,
		);
		expect(button).not.toBeNull();
		expect(button?.getAttribute("aria-pressed")).toBe("false");
		await view.click(`button[aria-label="Reference ${title}"]`);
		expect(button?.getAttribute("aria-pressed")).toBe("true");
	}
	expect(view.chips()).toEqual([
		"main.bal:1–1",
		"main.bal:2–2",
		"main.bal:4–4",
	]);
	await view.unmount();
}, 30000);

test("row reference buttons are disabled until the analysis is ready", async () => {
	const { workspace } = fakeWorkspace(false);
	const view = await render(workspace);
	const buttons = [
		...view.container.querySelectorAll<HTMLButtonElement>(
			'button[aria-label^="Reference "]',
		),
	];
	expect(buttons).toHaveLength(3);
	for (const button of buttons) expect(button.disabled).toBe(true);
	await view.unmount();
}, 30000);

test("selecting a row opens its flow and keeps the chat and its references", async () => {
	const fake = fakeWorkspace();
	const view = await render(fake.workspace);
	expect(view.container.textContent).toContain("Earlier question");
	await view.click('button[aria-label="Reference /notes"]');
	const endpointId = "m/service/main.bal//notes/1/resource/get/first";
	await view.click(`[data-scope-id="${endpointId}"]`);
	expect(fake.flows.at(-1)).toBe(endpointId);
	expect(view.chips()).toEqual(["main.bal:1–1"]);
	expect(view.container.textContent).toContain("Earlier question");
	await view.click('[data-scope-id="m/function/main"]');
	expect(fake.flows.at(-1)).toBe("m/function/main");
	expect(view.chips()).toEqual(["main.bal:1–1"]);
	await view.unmount();
}, 30000);

test("renaming the selected resource keeps the conversation", async () => {
	const fake = fakeWorkspace();
	const view = await render(fake.workspace);
	await view.click(
		'[data-scope-id="m/service/main.bal//notes/1/resource/get/first"]',
	);
	expect(view.container.textContent).toContain("Earlier question");
	const { act } = await import("react");
	await act(async () => fake.rename("one"));
	await view.settle();
	expect(view.container.textContent).toContain("get one");
	expect(view.container.textContent).toContain("Earlier question");
	await view.unmount();
}, 30000);

test("New chat starts an empty conversation", async () => {
	const fake = fakeWorkspace();
	const view = await render(fake.workspace);
	expect(view.container.textContent).toContain("Earlier question");
	await view.click('button[aria-label="New chat"]');
	expect(fake.newChats()).toBe(1);
	expect(view.container.textContent).not.toContain("Earlier question");
	expect(view.container.textContent).toContain("What shall we build?");
	await view.unmount();
}, 30000);
