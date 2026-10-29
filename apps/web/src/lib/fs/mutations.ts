import type { SnapshotFSMutation } from "@/lib/fs/snapshot";

type FileMutationListener = (mutation: SnapshotFSMutation) => void;

const listeners = new Set<FileMutationListener>();

export function publishFileMutation(mutation: SnapshotFSMutation): void {
	for (const listener of listeners) listener(mutation);
}

export function subscribeFileMutations(
	listener: FileMutationListener,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
