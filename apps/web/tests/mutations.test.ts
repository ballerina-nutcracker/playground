import { expect, test } from "bun:test";

import { serializeFileMutation } from "../src/lib/fs/mutations";

test("serialized file mutations run one at a time in call order", async () => {
	const order: string[] = [];
	const release = Promise.withResolvers<void>();
	const first = serializeFileMutation(async () => {
		order.push("first:start");
		await release.promise;
		order.push("first:end");
	});
	const second = serializeFileMutation(async () => {
		order.push("second");
		return 2;
	});
	await Promise.resolve();
	expect(order).toEqual(["first:start"]);
	release.resolve();
	await first;
	expect(await second).toBe(2);
	expect(order).toEqual(["first:start", "first:end", "second"]);
});

test("a failed file mutation rejects its caller without blocking the queue", async () => {
	const failed = serializeFileMutation(async () => {
		throw new Error("write failed");
	});
	const next = serializeFileMutation(async () => "applied");
	await expect(failed).rejects.toThrow("write failed");
	expect(await next).toBe("applied");
});
