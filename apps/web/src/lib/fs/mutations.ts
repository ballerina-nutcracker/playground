import type { SnapshotFSMutation } from "@/lib/fs/snapshot";

type FileMutationListener = (mutation: SnapshotFSMutation) => void;

const listeners = new Set<FileMutationListener>();

let mutationTail: Promise<unknown> = Promise.resolve();

export function publishFileMutation(mutation: SnapshotFSMutation): void {
	for (const listener of listeners) listener(mutation);
}

export function subscribeFileMutations(
	listener: FileMutationListener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

// A task must not await another serialized task, or the queue deadlocks.
export function serializeFileMutation<T>(task: () => Promise<T>): Promise<T> {
	const result = mutationTail.then(task);
	mutationTail = result.catch(() => undefined);
	return result;
}
