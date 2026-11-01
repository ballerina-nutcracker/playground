import { dirname } from "@/lib/fs/core/path-utils";

export type FSWatchEvent =
	| { path: string; op: "create" | "modify" | "delete" }
	| { error: string };

export type FSWatchCallback = (event: FSWatchEvent) => void | Promise<void>;

type Subscription = {
	path: string;
	recursive: boolean;
	callback: FSWatchCallback;
	queue: FSWatchEvent[];
	active: boolean;
	accepting: boolean;
	inCallback: boolean;
	delivery?: Promise<void>;
};

export function cleanFSPath(path: string): string {
	const absolute = path.startsWith("/");
	const parts: string[] = [];
	for (const part of path.split("/")) {
		if (!part || part === ".") continue;
		if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
		else if (part !== ".." || !absolute) parts.push(part);
	}
	return `${absolute ? "/" : ""}${parts.join("/")}` || ".";
}

export function isDescendant(path: string, root: string): boolean {
	if (path === root) return false;
	if (root === ".") {
		return !path.startsWith("/") && path !== ".." && !path.startsWith("../");
	}
	return path.startsWith(root === "/" ? "/" : `${root}/`);
}

export class FSWatchRegistry {
	private readonly subscriptions = new Map<string, Subscription>();
	private nextId = 0;
	private disposed = false;

	watch(path: string, recursive: boolean, callback: FSWatchCallback): string {
		if (this.disposed) throw new Error("Filesystem watch registry is disposed");
		const id = String(++this.nextId);
		this.subscriptions.set(id, {
			path,
			recursive,
			callback,
			queue: [],
			active: true,
			accepting: true,
			inCallback: false,
		});
		return id;
	}

	publish(event: Exclude<FSWatchEvent, { error: string }>): void {
		for (const subscription of this.subscriptions.values()) {
			if (!subscription.active || !subscription.accepting) continue;
			if (event.op === "delete" && event.path === subscription.path) {
				subscription.accepting = false;
				subscription.queue.push(event);
				this.deliver(subscription);
			} else if (
				subscription.recursive
					? isDescendant(event.path, subscription.path)
					: cleanFSPath(dirname(event.path)) === subscription.path
			) {
				subscription.queue.push(event);
				this.deliver(subscription);
			}
		}
	}

	private deliver(subscription: Subscription): void {
		if (subscription.delivery) return;
		subscription.delivery = Promise.resolve()
			.then(async () => {
				while (subscription.active && subscription.queue.length) {
					const event = subscription.queue.shift();
					if (!event) continue;
					subscription.inCallback = true;
					let callbackResult: void | Promise<void>;
					try {
						callbackResult = subscription.callback(event);
					} finally {
						subscription.inCallback = false;
					}
					await callbackResult;
				}
			})
			.catch(() => {
				subscription.active = false;
				subscription.queue = [];
			})
			.finally(() => {
				subscription.delivery = undefined;
				if (subscription.active && subscription.queue.length) {
					this.deliver(subscription);
				}
			});
	}

	unwatch(id: string): Promise<void> {
		const subscription = this.subscriptions.get(id);
		if (!subscription) return Promise.resolve();
		subscription.active = false;
		subscription.accepting = false;
		subscription.queue = [];
		if (subscription.inCallback) {
			this.subscriptions.delete(id);
			return Promise.resolve();
		}
		return (subscription.delivery ?? Promise.resolve()).then(() => {
			this.subscriptions.delete(id);
		});
	}

	dispose(): void {
		this.disposed = true;
		for (const subscription of this.subscriptions.values()) {
			subscription.active = false;
			subscription.queue = [];
		}
		this.subscriptions.clear();
	}
}
