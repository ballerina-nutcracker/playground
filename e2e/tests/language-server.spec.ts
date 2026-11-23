import { expect, test } from "@playwright/test";

import { loadFixture } from "../helpers/fixtures";
import { PlaygroundPage } from "../helpers/playground";

import type { Page } from "@playwright/test";

const ANALYSIS_TIMEOUT = 20_000;
const QUIET_WINDOW = 2_000;

function editor(page: Page) {
	return page.getByTestId("code-editor");
}

function errors(page: Page) {
	return editor(page).locator(".cm-lintRange-error");
}

function program(expression: string) {
	return `import ballerina/io;\n\npublic function main() {\n    io:println(${expression});\n}`;
}

async function openPackage(page: Page, name: string) {
	const playground = new PlaygroundPage(page);
	await playground.open();
	await playground.createPackage(name);
	await expect(page).toHaveURL(new RegExp(`/local/${name}/main\\.bal$`));
	await expect(editor(page).locator(".cm-content")).toContainText(
		"public function main()",
	);
	return playground;
}

async function openMain(page: Page, packageName: string) {
	// Scope by package, since every package has a file named main.bal.
	const packageTree = page
		.getByText(packageName, { exact: true })
		.locator("xpath=ancestor::*[@data-slot='collapsible'][1]");
	await packageTree.getByText("main.bal", { exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/local/${packageName}/main\\.bal$`));
}

async function expectDiagnostic(
	page: Page,
	symbol: string,
	rangeText = symbol,
) {
	const exactText = new RegExp(
		`^${rangeText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
	);
	const range = errors(page).filter({ hasText: exactText }).first();
	await expect(range).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
	await expect(range).toHaveText(rangeText);
	await range.hover();
	await expect(page.locator(".cm-tooltip-lint")).toContainText(symbol, {
		timeout: ANALYSIS_TIMEOUT,
	});
	// Leave the tooltip before editing or changing files.
	await page.mouse.move(0, 0);
}

async function expectErrorsStayCleared(page: Page) {
	await expect(errors(page)).toHaveCount(0, { timeout: ANALYSIS_TIMEOUT });
	// CodeMirror syncs after 500ms. Check a whole quiet window, not just the
	// instant when replacement text maps the old decorations out of the view.
	// This catches late publications from an older document version.
	const stale = await editor(page).evaluate((host, duration) => {
		return new Promise<string | null>((resolve) => {
			let stale: string | null = null;
			const check = () => {
				const error = host.querySelector(".cm-lintRange-error");
				if (error) stale = error.textContent ?? "unexpected diagnostic";
			};
			const observer = new MutationObserver(check);
			observer.observe(host, {
				subtree: true,
				childList: true,
				attributes: true,
			});
			check();
			setTimeout(() => {
				observer.disconnect();
				resolve(stale);
			}, duration);
		});
	}, QUIET_WINDOW);
	expect(stale, "a stale error reappeared after correction").toBeNull();
}

async function persistedFiles(page: Page) {
	// Read only: never seed storage, replace a transport, or fake diagnostics.
	return page.evaluate(() => localStorage.getItem("bfs"));
}

test("opens valid Hello World without phantom standard-library diagnostics", async ({
	page,
}) => {
	const playground = new PlaygroundPage(page);
	await playground.open();
	await expect(editor(page).locator(".cm-content")).toContainText(
		'io:println("Hello, World!")',
	);
	await expectErrorsStayCleared(page);
	await playground.runAndExpectOutput("Hello, World!");
	await expectErrorsStayCleared(page);
});

test("publishes diagnostics when the language-server WASM loads slowly", async ({
	page,
}) => {
	// Longer than CodeMirror's 3s request timeout: a cold download or a slow
	// device must not make the client abandon the initialize handshake.
	await page.route("**/ballerina-ls.wasm", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 4_500));
		await route.continue();
	});
	const playground = await openPackage(page, "ls_slow_start");
	await playground.replaceEditorContent(program("missingSlowStart"));
	await expectDiagnostic(page, "missingSlowStart");
});

test("shows real diagnostics for unsaved edits and clears them without saving", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_unsaved");
	const savedLines = await editor(page).locator(".cm-line").allTextContents();
	const savedFiles = await persistedFiles(page);
	expect(savedFiles).not.toBeNull();

	await playground.replaceEditorContent(program("missingDiagnostic"));
	await expectDiagnostic(page, "missingDiagnostic");
	expect(
		await persistedFiles(page),
		"analysis must not save invalid edits",
	).toBe(savedFiles);

	await playground.replaceEditorContent(program('"corrected, but unsaved"'));
	await expectErrorsStayCleared(page);
	expect(
		await persistedFiles(page),
		"analysis must not save corrected edits",
	).toBe(savedFiles);

	// A reload must restore the saved file, not either analyzed editor buffer.
	await page.reload();
	await expect(page.getByTestId("wasm-loading")).toBeHidden({
		timeout: 90_000,
	});
	await expect(editor(page).locator(".cm-line")).toHaveText(savedLines);
});

test("places a diagnostic at UTF-16 offsets after non-ASCII and astral text", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_utf16");
	const source = program('"😀é漢", missingUtf16');
	const lineText = source.split("\n")[3];
	const from = lineText.indexOf("missingUtf16");

	await playground.replaceEditorContent(source);
	await expectDiagnostic(page, "missingUtf16");
	const range = errors(page).filter({ hasText: "missingUtf16" }).first();
	const rendered = await range.evaluate((mark) => {
		const line = mark.closest(".cm-line");
		if (!line) throw new Error("Diagnostic is not in a CodeMirror line");
		const prefix = document.createRange();
		prefix.selectNodeContents(line);
		prefix.setEndBefore(mark);
		const from = prefix.toString().length;
		return {
			line: line.textContent,
			from,
			to: from + (mark.textContent?.length ?? 0),
		};
	});
	expect(rendered).toEqual({
		line: lineText,
		from,
		to: from + "missingUtf16".length,
	});

	await playground.replaceEditorContent(program('"😀é漢", 1'));
	await expectErrorsStayCleared(page);
});

test("rapid edits never restore diagnostics from an older version", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_rapid");
	await playground.replaceEditorContent(program("missingInitial"));
	await expectDiagnostic(page, "missingInitial");

	await playground.replaceEditorContent(program("missingInFlight"));
	// Cross CodeMirror's 500ms sync debounce once so this is not exclusively
	// a batch coalesced into one didChange. Do not wait for the analysis reply.
	await page.waitForTimeout(550);
	// Then send a burst of real edits while that version may still be analyzed.
	for (const expression of [
		"missingOlderOne",
		'"valid briefly"',
		"missingLatest",
	]) {
		await playground.replaceEditorContent(program(expression));
	}
	await expectDiagnostic(page, "missingLatest");
	await expect(errors(page).filter({ hasText: "missingOlderOne" })).toHaveCount(
		0,
	);
	await expect(errors(page).filter({ hasText: "missingInitial" })).toHaveCount(
		0,
	);
	await expect(errors(page).filter({ hasText: "missingInFlight" })).toHaveCount(
		0,
	);

	for (const expression of [
		"missingDiscarded",
		"missingDiscardedAgain",
		'"final valid text"',
	]) {
		await playground.replaceEditorContent(program(expression));
	}
	await expectErrorsStayCleared(page);
	await expect(editor(page).locator(".cm-content")).toContainText(
		"final valid text",
	);
});

test("isolates diagnostics for different URIs with the same filename", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_uri_first");
	await playground.createPackage("ls_uri_second");
	await openMain(page, "ls_uri_first");
	await playground.replaceEditorContent(program("missingFirstFile"));
	await expectDiagnostic(page, "missingFirstFile");

	// Sidebar switching explicitly saves the departing file. Only language
	// analysis must leave edits unsaved; this is the application's save action.
	await openMain(page, "ls_uri_second");
	await expectErrorsStayCleared(page);
	await playground.replaceEditorContent(program("missingSecondFile"));
	await expectDiagnostic(page, "missingSecondFile");
	await expect(
		errors(page).filter({ hasText: "missingFirstFile" }),
	).toHaveCount(0);

	await openMain(page, "ls_uri_first");
	await expectDiagnostic(page, "missingFirstFile");
	await expect(
		errors(page).filter({ hasText: "missingSecondFile" }),
	).toHaveCount(0);
	await playground.replaceEditorContent(program('"first file corrected"'));
	await expectErrorsStayCleared(page);

	await openMain(page, "ls_uri_second");
	await expectDiagnostic(page, "missingSecondFile");
	await openMain(page, "ls_uri_first");
	await expectErrorsStayCleared(page);
});

test("offers server completion for a symbol declared only in unsaved text", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_completion");
	const savedFiles = await persistedFiles(page);
	// A unique lexical variable cannot come from the saved hello-world file or
	// a keyword-only completion source. Use the server's supported typed-
	// initializer context (completion inside call arguments is not implemented).
	const suffix = `;\n    io:println(answer);\n}`;
	const source = `import ballerina/io;\n\npublic function main() {\n    int unsavedServerValue = 41;\n    int answer = unsavedServerV${suffix}`;
	await playground.replaceEditorContent(source);
	await expectDiagnostic(page, "unsavedServerV");
	// insertText leaves the cursor at EOF; move back to the initializer prefix.
	for (let i = 0; i < suffix.length; i++)
		await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Control+Space");
	const completion = page
		.getByRole("option")
		.filter({ hasText: "unsavedServerValue" });
	await expect(completion).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
	await completion.click();
	await expect(editor(page).locator(".cm-content")).toContainText(
		"int answer = unsavedServerValue;",
	);
	await expectErrorsStayCleared(page);
	expect(
		await persistedFiles(page),
		"completion must not save the buffer",
	).toBe(savedFiles);
});

test("automatically completes a unique lexical symbol from unsaved text while typing", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_auto_completion");
	const savedFiles = await persistedFiles(page);
	expect(savedFiles).not.toBeNull();
	const suffix = `;\n    io:println(answer);\n}`;
	const source = `import ballerina/io;\n\npublic function main() {\n    int unsavedAutomaticValue = 42;\n    int answer = unsavedAutomatic${suffix}`;
	await playground.replaceEditorContent(source);
	for (let i = 0; i < suffix.length; i++)
		await page.keyboard.press("ArrowLeft");
	// Real typing, with no Ctrl+Space and no wait for document synchronization:
	// the server source must sync the latest unsaved prefix before requesting.
	await editor(page)
		.locator(".cm-content")
		.pressSequentially("V", { delay: 30 });
	const completion = page
		.getByRole("option")
		.filter({ hasText: "unsavedAutomaticValue" });
	await expect(completion).toBeVisible({ timeout: ANALYSIS_TIMEOUT });
	await completion.click();
	await expect(editor(page).locator(".cm-line")).toHaveText(
		source
			.replace(
				"int answer = unsavedAutomatic;",
				"int answer = unsavedAutomaticValue;",
			)
			.split("\n"),
	);
	await expectErrorsStayCleared(page);
	expect(
		await persistedFiles(page),
		"automatic completion must not save the buffer",
	).toBe(savedFiles);
});

test("empty completion in an unsupported call argument leaves editing and diagnostics intact", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_empty_completion");
	const savedFiles = await persistedFiles(page);
	expect(savedFiles).not.toBeNull();
	const source = program("missingCallCompletion");
	await playground.replaceEditorContent(source);
	const suffix = ");\n}";
	for (let i = 0; i < suffix.length; i++)
		await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("Control+Space");
	// This pinned server does not implement completion inside call arguments.
	// Its empty result must neither insert text nor disrupt diagnostics.
	await expectDiagnostic(page, "missingCallCompletion");
	await page.waitForTimeout(QUIET_WINDOW);
	await expect(editor(page).locator(".cm-tooltip-autocomplete")).toHaveCount(0);
	await expect(editor(page).locator(".cm-line")).toHaveText(source.split("\n"));
	await playground.replaceEditorContent(program('"still editable"'));
	await expectErrorsStayCleared(page);
	expect(await persistedFiles(page)).toBe(savedFiles);
});

test("shows server signature help for a function declared only in unsaved text", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_signature_help");
	const savedFiles = await persistedFiles(page);
	expect(savedFiles).not.toBeNull();
	const suffix = `, 2);\n}`;
	const source = `import ballerina/io;\n\nfunction greetUnsaved(string name, int times) {\n    io:println(name, times);\n}\n\npublic function main() {\n    greetUnsaved("x"${suffix}`;
	await playground.replaceEditorContent(source);
	await expectErrorsStayCleared(page);
	// insertText leaves the cursor at EOF; move back inside the first argument.
	for (let i = 0; i < suffix.length; i++)
		await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ControlOrMeta+Shift+Space");
	const tooltip = page.locator(".cm-lsp-signature-tooltip");
	await expect(tooltip).toContainText("greetUnsaved(string name, int times)", {
		timeout: ANALYSIS_TIMEOUT,
	});
	await expect(tooltip.locator(".cm-lsp-active-parameter")).toHaveText(
		"string name",
	);
	// Move to the second argument: the active parameter follows the cursor.
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("ControlOrMeta+Shift+Space");
	await expect(tooltip.locator(".cm-lsp-active-parameter")).toHaveText(
		"int times",
		{ timeout: ANALYSIS_TIMEOUT },
	);
	await expect(editor(page).locator(".cm-line")).toHaveText(source.split("\n"));
	await expectErrorsStayCleared(page);
	expect(
		await persistedFiles(page),
		"signature help must not save the buffer",
	).toBe(savedFiles);
});

test("sanitizes untrusted HTML in signature documentation", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_signature_xss");
	const suffix = `);\n}`;
	const source = `import ballerina/io;\n\n# Greets <img src="x" onerror="window.lspXss = true">\nfunction greetDoc(string name) {\n    io:println(name);\n}\n\npublic function main() {\n    greetDoc("x"${suffix}`;
	await playground.replaceEditorContent(source);
	await expectErrorsStayCleared(page);
	for (let i = 0; i < suffix.length; i++)
		await page.keyboard.press("ArrowLeft");
	await page.keyboard.press("ControlOrMeta+Shift+Space");
	const docs = page.locator(".cm-lsp-signature-documentation");
	await expect(docs).toContainText("Greets", { timeout: ANALYSIS_TIMEOUT });
	await expect(docs.locator("[onerror]")).toHaveCount(0);
	expect(await page.evaluate(() => "lspXss" in window)).toBe(false);
});

test("continues publishing diagnostics while a listener program is running", async ({
	page,
}) => {
	const playground = await openPackage(page, "ls_running");
	const listener = await loadFixture("listener.bal");
	await playground.replaceEditorContent(listener);
	await playground.start();
	try {
		await expect(playground.runButton).toHaveText("Stop", {
			timeout: ANALYSIS_TIMEOUT,
		});
		await expect(playground.outputPane).toContainText("Listener started.", {
			timeout: ANALYSIS_TIMEOUT,
		});
		await playground.replaceEditorContent(
			listener.replace(
				"public function main() {}",
				"public function main() { missingRunning(); }",
			),
		);
		await expectDiagnostic(page, "missingRunning", "missingRunning()");
		await expect(playground.runButton).toHaveText("Stop");
		await playground.replaceEditorContent(listener);
		await expectErrorsStayCleared(page);
		await expect(playground.runButton).toHaveText("Stop");
	} finally {
		if ((await playground.runButton.textContent())?.trim() === "Stop") {
			await playground.stop();
		}
	}
});
