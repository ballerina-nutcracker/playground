import { AbstractFS, type FSNode } from "@/lib/fs/core/abstract-fs";
import {
	base64ToBytes,
	bytesToBase64,
	encodeText,
	tryDecodeText,
} from "@/lib/fs/core/bytes";

/**
 * The persisted form of an FSNode. Text files keep their content as a string,
 * so storage written before files held bytes still loads; files that are not
 * valid UTF-8 are stored as base64 in `base64` instead.
 */
type StoredNode = {
	isDir: boolean;
	content?: string;
	base64?: string;
	modTime?: number;
	children?: Record<string, StoredNode>;
};

export class LocalStorageFS extends AbstractFS {
	constructor(private readonly key: string = "bfs") {
		super();
		this._load();
	}

	clear() {
		this.data = { isDir: true, children: {} };
		this._persist();
	}

	private _isValidRootDir(value: unknown): value is StoredNode {
		if (!value || typeof value !== "object" || Array.isArray(value))
			return false;
		const node = value as Record<string, unknown>;
		return (
			node.isDir === true &&
			!!node.children &&
			typeof node.children === "object" &&
			!Array.isArray(node.children)
		);
	}

	private _parse(raw: string): FSNode | null {
		try {
			const parsed = JSON.parse(raw);
			return this._isValidRootDir(parsed) ? fromStored(parsed) : null;
		} catch {
			return null;
		}
	}

	private _load(): void {
		const fallback: FSNode = { isDir: true, children: {} };
		const raw = localStorage.getItem(this.key);
		const parsed = raw ? this._parse(raw) : null;

		if (parsed) this.data = parsed;
		else {
			this.data = fallback;
			if (raw !== null)
				localStorage.setItem(this.key, JSON.stringify(toStored(fallback)));
		}
	}

	private _persist(): void {
		try {
			localStorage.setItem(this.key, JSON.stringify(toStored(this.data)));
		} catch (e) {
			console.warn("[LocalStorageFS]: Failed to persist to localStorage", e);
		}
	}

	protected override _onWrite(): void {
		this._persist();
	}
}

function toStored(node: FSNode): StoredNode {
	const stored: StoredNode = { isDir: node.isDir };
	if (node.modTime !== undefined) stored.modTime = node.modTime;
	if (node.content !== undefined) {
		const text = tryDecodeText(node.content);
		if (text !== null) stored.content = text;
		else stored.base64 = bytesToBase64(node.content);
	}
	if (node.children) {
		stored.children = {};
		for (const [name, child] of Object.entries(node.children))
			stored.children[name] = toStored(child);
	}
	return stored;
}

function fromStored(stored: StoredNode): FSNode {
	const node: FSNode = { isDir: stored.isDir };
	if (typeof stored.modTime === "number") node.modTime = stored.modTime;
	if (typeof stored.base64 === "string")
		node.content = base64ToBytes(stored.base64);
	else if (typeof stored.content === "string")
		node.content = encodeText(stored.content);
	if (stored.children && typeof stored.children === "object") {
		node.children = {};
		for (const [name, child] of Object.entries(stored.children))
			node.children[name] = fromStored(child);
	}
	return node;
}
