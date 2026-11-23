import { afterEach, expect, test } from "bun:test";

import { BallerinaWorkerClient } from "../src/workers/ballerina-worker-client";

const OriginalWorker = globalThis.Worker;

afterEach(() => {
	globalThis.Worker = OriginalWorker;
});

test("whenReady rejects when the worker cannot be created", async () => {
	globalThis.Worker = class {
		constructor() {
			throw new Error("worker unavailable");
		}
	} as unknown as typeof Worker;

	const client = new BallerinaWorkerClient();
	const ready = client.whenReady();

	await expect(client.init(() => {})).rejects.toThrow("worker unavailable");
	await expect(ready).rejects.toThrow("worker unavailable");
});
