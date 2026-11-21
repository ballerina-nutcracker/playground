import { expect, test } from "@playwright/test";

import { PlaygroundPage } from "../helpers/playground";

// Reproducer for the PR #136 review comment on the agent-view disclaimer:
// the disclaimer must not claim the view runs entirely in the browser while
// the user's message and code are sent to the selected provider.
test("disclaimer does not claim everything stays in the browser", async ({
	page,
}) => {
	const bodies: string[] = [];
	const cors = {
		"access-control-allow-origin": "*",
		"access-control-allow-headers": "*",
		"access-control-allow-methods": "*",
	};
	await page.route(/https:\/\/api\.anthropic\.com\//, async (route) => {
		if (route.request().method() === "OPTIONS")
			return route.fulfill({ status: 204, headers: cors });
		bodies.push(route.request().postData() ?? "");
		const ev = (name: string, data: unknown) =>
			`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
		await route.fulfill({
			status: 200,
			headers: { ...cors, "content-type": "text/event-stream" },
			body: [
				ev("message_start", {
					type: "message_start",
					message: {
						id: "m1",
						type: "message",
						role: "assistant",
						content: [],
						model: "claude-sonnet-5-5",
						stop_reason: null,
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}),
				ev("content_block_start", {
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				}),
				ev("content_block_delta", {
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "ok" },
				}),
				ev("content_block_stop", { type: "content_block_stop", index: 0 }),
				ev("message_delta", {
					type: "message_delta",
					delta: { stop_reason: "end_turn" },
					usage: { output_tokens: 1 },
				}),
				ev("message_stop", { type: "message_stop" }),
			].join(""),
		});
	});

	const playground = new PlaygroundPage(page);
	await playground.open();
	await playground.openBalBot();
	const view = playground.balBotView;

	await view.getByRole("button", { name: /^Provider:/ }).click();
	await page.getByRole("menuitemradio", { name: /^Anthropic/ }).click();
	const panel = page.getByRole("dialog", { name: "Provider API key" });
	await panel.getByLabel("API key", { exact: true }).fill("sk-ant-test-key");
	await panel.getByRole("button", { name: "Use API key", exact: true }).click();
	await expect(panel).toBeHidden();

	await view.locator("[data-scope-id]").first().click();
	await view
		.getByRole("textbox", { name: "Message" })
		.fill("unique-user-message-42");
	await view.getByRole("button", { name: "Send message" }).click();
	await expect
		.poll(() => bodies.length, { timeout: 30_000 })
		.toBeGreaterThan(0);

	// The user's message leaves the browser for api.anthropic.com ...
	expect(bodies.join("\n")).toContain("unique-user-message-42");
	// ... so the disclaimer must say so.
	const disclaimer = view.getByText(/Agent view \(beta\)/).first();
	await expect(disclaimer).toContainText(
		"sends your code and messages to the selected provider",
	);
	await expect(disclaimer).not.toContainText("entirely in your browser");
});
