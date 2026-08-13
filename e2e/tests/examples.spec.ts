import { expect, test } from "@playwright/test";

import { assertOrUpdateExampleOutput } from "../helpers/example-output";
import { PlaygroundPage } from "../helpers/playground";

import type { HttpRequest } from "../helpers/playground";

type ServiceExampleRequest = HttpRequest & {
	statusCode: number;
	expectedResponse: string;
};

const serviceExampleRequests: Record<string, ServiceExampleRequest[]> = {
	"/tmp/examples/03-http-service/Ballerina.toml": [
		{
			method: "GET",
			path: "/albums",
			statusCode: 200,
			expectedResponse: "Blue Train",
		},
		{
			method: "POST",
			path: "/albums",
			body: JSON.stringify({
				title: "Kind of Blue",
				artist: "Miles Davis",
			}),
			statusCode: 201,
			expectedResponse: "Kind of Blue",
		},
		{
			method: "GET",
			path: "/albums/Kind%20of%20Blue",
			statusCode: 200,
			expectedResponse: "Miles Davis",
		},
	],
};

test("runs every example", async ({ page }) => {
	const playground = new PlaygroundPage(page);
	await playground.open();

	for (const manifestPath of await playground.getExampleManifestPaths()) {
		await playground.openExampleMain(manifestPath);
		await playground.start();

		if (await playground.hasTryItPanel()) {
			const requests = serviceExampleRequests[manifestPath];
			if (!requests) {
				throw new Error(
					`Missing a Try It request for service example ${manifestPath}`,
				);
			}

			for (const request of requests) {
				const tryItPanel = await playground.sendHttpRequest(request);
				await expect(
					tryItPanel.getByText(String(request.statusCode), { exact: true }),
				).toBeVisible();
				await expect(
					tryItPanel.getByText(request.expectedResponse),
				).toBeVisible();
			}
			await playground.stop();
		} else {
			expect(serviceExampleRequests[manifestPath]).toBeUndefined();
			await expect(playground.runButton).toHaveText("Run", { timeout: 10_000 });
		}

		await assertOrUpdateExampleOutput(playground.outputPane, manifestPath);
	}
});
