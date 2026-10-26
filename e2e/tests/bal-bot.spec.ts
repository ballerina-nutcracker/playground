import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

import type { Page, Route } from "@playwright/test";

const NESTED_PROJECT = {
	isDir: true,
	children: {
		"Ballerina.toml": {
			isDir: false,
			content: '[package]\norg = "o"\nname = "outer"\nversion = "0.1.0"\n',
		},
		"main.bal": {
			isDir: false,
			content: "public function main() {}\n",
		},
		inner: {
			isDir: true,
			children: {
				"Ballerina.toml": {
					isDir: false,
					content: '[package]\norg = "o"\nname = "inner"\nversion = "0.1.0"\n',
				},
				"inner.bal": { isDir: false, content: "public function f() {}\n" },
			},
		},
	},
};

type LocalNode = {
	isDir: boolean;
	content?: string;
	children?: Record<string, LocalNode>;
};

/** Seeds the persisted local file system once, before the app boots. */
async function seedLocal(page: Page, children: Record<string, LocalNode>) {
	await page.addInitScript((tree) => {
		if (!localStorage.getItem("bfs"))
			localStorage.setItem(
				"bfs",
				JSON.stringify({
					isDir: true,
					children: { local: { isDir: true, children: tree } },
				}),
			);
	}, children);
}

async function openLocalFile(page: Page, ...segments: string[]) {
	const local = page
		.locator("[data-sidebar=group]")
		.filter({ hasText: "Localspace" });
	for (const name of segments)
		await local.getByText(name, { exact: true }).first().click();
}

/** Anthropic SSE: first request edits main.bal, later ones just answer. */
async function mockAnthropic(
	page: Page,
	edit: { path: string; content: string },
) {
	let calls = 0;
	const sse = (events: [string, unknown][]) =>
		events
			.map(
				([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
			)
			.join("");
	const cors = {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "*",
		"access-control-allow-methods": "*",
	};
	await page.route(/https:\/\/api\.anthropic\.com\//, async (route: Route) => {
		if (route.request().method() === "OPTIONS")
			return route.fulfill({ status: 204, headers: cors });
		calls++;
		const start = [
			"message_start",
			{
				type: "message_start",
				message: {
					id: `m${calls}`,
					type: "message",
					role: "assistant",
					content: [],
					model: "claude-sonnet-5-5",
					stop_reason: null,
					usage: { input_tokens: 10, output_tokens: 1 },
				},
			},
		] as [string, unknown];
		const body =
			calls === 1
				? sse([
						start,
						[
							"content_block_start",
							{
								type: "content_block_start",
								index: 0,
								content_block: {
									type: "tool_use",
									id: "toolu_1",
									name: "write_file",
									input: {},
								},
							},
						],
						[
							"content_block_delta",
							{
								type: "content_block_delta",
								index: 0,
								delta: {
									type: "input_json_delta",
									partial_json: JSON.stringify(edit),
								},
							},
						],
						["content_block_stop", { type: "content_block_stop", index: 0 }],
						[
							"message_delta",
							{
								type: "message_delta",
								delta: { stop_reason: "tool_use" },
								usage: { output_tokens: 20 },
							},
						],
						["message_stop", { type: "message_stop" }],
					])
				: sse([
						start,
						[
							"content_block_start",
							{
								type: "content_block_start",
								index: 0,
								content_block: { type: "text", text: "" },
							},
						],
						[
							"content_block_delta",
							{
								type: "content_block_delta",
								index: 0,
								delta: { type: "text_delta", text: "Edit applied." },
							},
						],
						["content_block_stop", { type: "content_block_stop", index: 0 }],
						[
							"message_delta",
							{
								type: "message_delta",
								delta: { stop_reason: "end_turn" },
								usage: { output_tokens: 5 },
							},
						],
						["message_stop", { type: "message_stop" }],
					]);
		await route.fulfill({
			status: 200,
			headers: { ...cors, "content-type": "text/event-stream" },
			body,
		});
	});
	return () => calls;
}

test.describe("bal-bot view", () => {
	test("wand is enabled on every example and opens the project view", async ({
		page,
	}) => {
		const playground = new PlaygroundPage(page);
		await playground.open();
		await expect(playground.balBotButton).toBeVisible();

		for (const manifestPath of await playground.getExampleManifestPaths()) {
			await playground.openExampleMain(manifestPath);
			await expect(playground.balBotButton).toBeEnabled();
		}

		await playground.openExampleMain(
			"/tmp/examples/03-http-service/Ballerina.toml",
		);
		await playground.openBalBot();
		const view = playground.balBotView;
		await expect(
			view.getByRole("navigation", { name: "Workspace files" }),
		).toContainText("main.bal");
		await expect(
			view.getByRole("navigation", { name: "Workspace files" }),
		).toContainText("Ballerina.toml");
		await expect(view.locator("[data-scope-id]").first()).toBeVisible({
			timeout: 60_000,
		});
		await expect(view.getByRole("tab", { name: /diff/i })).toHaveCount(0);
		await expect(view.getByText(/^diff$/i)).toHaveCount(0);
	});

	test("wand is disabled on a loose file with an explanation", async ({
		page,
	}) => {
		await seedLocal(page, {
			"loose.bal": { isDir: false, content: "public function main() {}\n" },
		});
		const playground = new PlaygroundPage(page);
		await playground.open();
		await openLocalFile(page, "loose.bal");
		await expect(playground.balBotButton).toBeDisabled();
		await page.locator("[data-testid=bal-bot-button]").locator("..").hover();
		await expect(
			page.getByText("Not part of a Ballerina project (no Ballerina.toml)"),
		).toBeVisible();
	});

	test("compiler wasm is requested only after the first click", async ({
		page,
	}) => {
		const wasmRequests: string[] = [];
		page.on("request", (request) => {
			if (/compiler\/ballerina-compiler\.wasm|bal-bot-view/.test(request.url()))
				wasmRequests.push(request.url());
		});
		const playground = new PlaygroundPage(page);
		await playground.open();
		await page.waitForTimeout(1000);
		expect(wasmRequests).toEqual([]);
		await playground.openBalBot();
		await expect
			.poll(
				() => wasmRequests.some((u) => u.includes("ballerina-compiler.wasm")),
				{ timeout: 60_000 },
			)
			.toBe(true);
	});

	test("Back restores the editor, the active file, output and layout", async ({
		page,
	}) => {
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.run();
		const output = await playground.outputPane.innerText();
		const layoutBefore = await page.evaluate(() =>
			localStorage.getItem("editor-workspace"),
		);
		const title = await page.locator("span.truncate").first().innerText();

		await playground.openBalBot();
		await playground.closeBalBot();

		await expect(playground.outputPane).toHaveText(output);
		await expect(page.getByTestId("code-editor")).toBeVisible();
		expect(await page.locator("span.truncate").first().innerText()).toBe(title);
		expect(
			await page.evaluate(() => localStorage.getItem("editor-workspace")),
		).toBe(layoutBefore);
	});

	test("Run is inert while the view is open", async ({ page }) => {
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.openBalBot();
		await page.keyboard.press("ControlOrMeta+Enter");
		await page.keyboard.press("ControlOrMeta+Alt+v");
		await page.waitForTimeout(500);
		await playground.closeBalBot();
		await expect(playground.outputPane).toHaveText("");
		await expect(playground.runButton).toHaveText("Run");
	});

	test("a dirty edit appears in the snapshot", async ({ page }) => {
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.replaceEditorContent(
			'import ballerina/io;\npublic function main() { io:println("dirty-marker"); }',
		);
		await playground.openBalBot();
		await playground.balBotView
			.getByRole("navigation", { name: "Workspace files" })
			.getByText("main.bal")
			.click();
		await expect(
			playground.balBotView.getByLabel("Contents of main.bal"),
		).toContainText("dirty-marker");
	});

	test("agent edits never reach the playground files or storage", async ({
		page,
	}) => {
		const calls = await mockAnthropic(page, {
			path: "main.bal",
			content: "public function main() {}\n// agent-edit\n",
		});
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.openBalBot();
		const view = playground.balBotView;
		const before = await page.evaluate(() =>
			JSON.stringify({ ...localStorage }),
		);

		await view.getByRole("button", { name: /^Provider:/ }).click();
		await view.getByRole("button", { name: /^Anthropic/ }).click();
		const panel = view.getByRole("region", { name: "Provider API key" });
		await panel.getByLabel("API key", { exact: true }).fill("sk-ant-test-key");
		await panel
			.getByRole("button", { name: "Use API key", exact: true })
			.click();
		await expect(panel).toBeHidden();

		await view.locator("[data-scope-id]").first().click();
		await view.getByRole("textbox", { name: "Message" }).fill("add a comment");
		await view.getByRole("button", { name: "Send message" }).click();
		await expect.poll(calls, { timeout: 30_000 }).toBeGreaterThan(1);
		await view
			.getByRole("navigation", { name: "Workspace files" })
			.getByText("main.bal")
			.click();
		await expect(view.getByLabel("Contents of main.bal")).toContainText(
			"agent-edit",
			{ timeout: 15_000 },
		);

		expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).toBe(
			before,
		);
		expect(
			await page.evaluate(() =>
				JSON.stringify({ ...localStorage, ...sessionStorage }),
			),
		).not.toContain("sk-ant-test-key");
		await playground.closeBalBot();
		await expect(page.getByTestId("code-editor")).not.toContainText(
			"agent-edit",
		);
	});

	test("selecting a file or re-clicking the active file closes the view", async ({
		page,
	}) => {
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.getExampleManifestPaths();
		const second = page.locator(
			'[data-example-path$="02-http-client/main.bal"]',
		);
		const active = page.locator(
			'[data-example-path$="01-hello-world/main.bal"]',
		);

		await playground.openBalBot();
		await active.click();
		await expect(playground.balBotView).toHaveCount(0);

		await playground.openBalBot();
		await second.click();
		await expect(playground.balBotView).toHaveCount(0);
		await expect(page).toHaveURL(/02-http-client/);
		// The app replaces history entries on every file change, so URL
		// back/forward cannot be driven here; it reaches the view through the
		// same active-file change exercised above.
	});

	test("a project the compiler rejects still opens with diagnostics", async ({
		page,
	}) => {
		await seedLocal(page, { outer: NESTED_PROJECT });
		const errors: string[] = [];
		page.on("pageerror", (e) => errors.push(e.message));
		const playground = new PlaygroundPage(page);
		await playground.open();
		await openLocalFile(page, "outer", "main.bal");
		await playground.openBalBot();
		await expect(
			playground.balBotView.getByRole("navigation", {
				name: "Workspace files",
			}),
		).toContainText("inner");
		await expect(playground.balBotView.locator(".flow-notice")).not.toHaveText(
			"",
			{ timeout: 60_000 },
		);
		expect(errors).toEqual([]);
	});

	test("a snapshot failure toasts the path and stays in the editor", async ({
		page,
	}) => {
		await seedLocal(page, {
			broken: {
				isDir: true,
				children: {
					"Ballerina.toml": {
						isDir: false,
						content: '[package]\nname = "b"\n',
					},
					"main.bal": { isDir: false, content: "bad \ud800 surrogate" },
				},
			},
		});
		const playground = new PlaygroundPage(page);
		await playground.open();
		await openLocalFile(page, "broken", "main.bal");
		await expect(playground.balBotButton).toBeEnabled();
		await playground.balBotButton.click();
		await expect(
			page.getByText(/main\.bal: file contents must be valid UTF-8/),
		).toBeVisible();
		await expect(playground.balBotView).toHaveCount(0);
	});

	test("assets resolve and light and dark render without console errors", async ({
		page,
	}) => {
		const errors: string[] = [];
		page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
		const failed: string[] = [];
		page.on(
			"response",
			(r) =>
				/\.(svg|ico)$/.test(r.url()) &&
				r.status() >= 400 &&
				failed.push(r.url()),
		);
		const playground = new PlaygroundPage(page);
		await playground.open();
		await playground.openBalBot();
		await playground.balBotView
			.getByRole("button", { name: /^Provider:/ })
			.click();
		await expect(
			playground.balBotView.locator("img[src$='openai.svg']").first(),
		).toBeVisible();
		await expect(
			playground.balBotView.locator("img[src$='ballerina.ico']"),
		).toBeVisible();
		await page.evaluate(() => document.documentElement.classList.add("dark"));
		await page.waitForTimeout(300);
		await page.evaluate(() =>
			document.documentElement.classList.remove("dark"),
		);
		expect(failed).toEqual([]);
		expect(
			errors.filter((e) => !/Failed to load resource|externalized/.test(e)),
		).toEqual([]);
	});

	test("on mobile the toolbar fits Run and the wand", async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 700 });
		const playground = new PlaygroundPage(page);
		await playground.open();
		const wand = await playground.balBotButton.boundingBox();
		const run = await playground.runButton.boundingBox();
		expect(wand && run && wand.x >= 0 && run.x + run.width <= 375).toBe(true);
		expect(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= window.innerWidth,
			),
		).toBe(true);
	});
});
