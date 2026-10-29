import type { Compiler } from "@bal-bot/compiler";
import type { DiagnosticsResult, StorageState } from "@bal-bot/workspace";
import type {
	Workspace,
	Service,
	Endpoint,
	Diff,
	FlowUI,
	Files,
	Id,
	Revision,
	AnalysisState,
	HIRProgram,
	ScopeModel,
	EndpointModel,
	WorkspaceScope,
	Automation,
	WorkspaceAgent,
} from "@bal-bot/workspace";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createWorkspaceAgent } from "./agent.ts";
export type { Files } from "@bal-bot/workspace";

export interface BrowserWorkspaceOptions {
	streamFn: StreamFn;
	compiler?: Compiler;
	projectName?: string;
	files?: Files;
}
export interface Storage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}
export { initialFiles, validatePath } from "@bal-bot/workspace/files";
import {
	initialFiles,
	validatePath,
	validateFiles,
	validateChange,
	applyChange,
	type FileChange,
} from "@bal-bot/workspace/files";

export const STORAGE_KEY = "bal-bot.workspace.v1";

export class BrowserWorkspace implements Workspace {
	private readonly anchors = new Map<Id, BrowserAnchor>();
	private readonly retainedAnchors = new Set<BrowserAnchor>();
	private readonly metadata = new Map<
		Id,
		ScopeModel | (EndpointModel & { serviceId: Id })
	>();
	private program?: HIRProgram;
	private analysis: AnalysisState = { kind: "pending", revision: 0 };
	private revision = 0;
	private analysisController?: AbortController;
	private analysisListeners = new Set<() => void>();
	private files: Files;
	private listeners = new Set<() => void>();
	private storageListeners = new Set<() => void>();
	private storageState: StorageState = { writable: true };
	readonly projectName?: string;
	private storage: Storage;
	private readonly compiler?: Compiler;
	private readonly options?: BrowserWorkspaceOptions;
	private disposed = false;

	constructor(storage: Storage, options?: BrowserWorkspaceOptions) {
		this.options = options;
		this.storage = storage;
		this.compiler = options?.compiler;
		this.projectName = options?.projectName;
		this.files = { ...(options?.files ?? initialFiles) };
		try {
			const saved = storage.getItem(STORAGE_KEY);
			if (saved !== null) {
				const parsed: unknown = JSON.parse(saved);
				validateFiles(parsed);
				this.files = { ...parsed };
			} else {
				storage.setItem(STORAGE_KEY, JSON.stringify(this.files));
			}
		} catch (error) {
			this.failStorage(
				"Could not restore or initialize browser files. Saved storage has not been overwritten.",
				error,
			);
		}
		queueMicrotask(() => this.scheduleAnalysis());
	}

	async getServices(): Promise<readonly Service[]> {
		return (await this.getScopes()).filter(
			(scope): scope is Service => scope.scopeKind === "service",
		);
	}
	async getScopes(): Promise<readonly WorkspaceScope[]> {
		if (!this.program && this.analysis.kind === "pending")
			await new Promise<void>((resolve) => {
				const unsubscribe = this.subscribeAnalysis(() => {
					if (this.program || this.analysis.kind !== "pending") {
						unsubscribe();
						resolve();
					}
				});
				if (this.program || this.analysis.kind !== "pending") {
					unsubscribe();
					resolve();
				}
			});
		return (this.program?.scopes ?? []).map(
			(scope) =>
				this.anchors.get(scope.id) as BrowserService | BrowserAutomation,
		);
	}
	analysisSnapshot = (): AnalysisState => this.analysis;
	subscribeAnalysis = (listener: () => void): (() => void) => {
		this.analysisListeners.add(listener);
		return () => {
			this.analysisListeners.delete(listener);
		};
	};
	private publishAnalysis(state: AnalysisState): void {
		if (this.disposed) return;
		this.analysis = state;
		for (const listener of this.analysisListeners) listener();
	}
	private scheduleAnalysis(): void {
		if (this.disposed) return;
		this.analysisController?.abort();
		const controller = new AbortController();
		this.analysisController = controller;
		const revision = ++this.revision,
			files = this.files;
		this.publishAnalysis({
			kind: "pending",
			revision,
			...(this.program ? { previous: this.program } : {}),
		});
		void this.runAnalysis(files, revision, controller.signal);
	}
	private async runAnalysis(
		files: Files,
		revision: Revision,
		signal: AbortSignal,
	): Promise<void> {
		try {
			if (!this.compiler)
				throw new Error("A compiler is required to analyze saved source.");
			const result = await this.compiler.analyze(files, signal);
			if (signal.aborted || revision !== this.revision) return;
			if (result.kind === "valid") {
				this.reconcileAnchors(result.program);
				this.program = result.program;
				this.publishAnalysis({
					kind: "ready",
					revision,
					program: result.program,
					diagnostics: result.diagnostics,
				});
			} else
				this.publishAnalysis({
					kind: "invalid",
					revision,
					previous: this.program,
					diagnostics: result.diagnostics,
				});
		} catch (error) {
			if (signal.aborted || revision !== this.revision) return;
			this.publishAnalysis({
				kind: "failed",
				revision,
				previous: this.program,
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
	private reconcileAnchors(program: HIRProgram): void {
		const active = new Set(
			(this.program?.scopes ?? []).flatMap((scope) =>
				scope.kind === "service"
					? [scope.id, ...scope.endpoints.map((e) => e.id)]
					: [scope.id],
			),
		);
		// Source order disambiguates identical service signatures. An ambiguous edit
		// retires those sessions instead of assigning one declaration another's chat.
		const groups = new Map<string, ScopeModel[]>();
		for (const scope of program.scopes)
			if (scope.kind === "service") {
				const key = scope.id.slice(0, scope.id.lastIndexOf("/"));
				groups.set(key, [...(groups.get(key) ?? []), scope]);
			}
		for (const [key, scopes] of groups) {
			const previous = (this.program?.scopes ?? []).filter(
				(s) =>
					s.kind === "service" && s.id.slice(0, s.id.lastIndexOf("/")) === key,
			);
			if (
				Math.max(scopes.length, previous.length) > 1 &&
				JSON.stringify(scopes.map((s) => s.text)) !==
					JSON.stringify(previous.map((s) => s.text))
			) {
				for (const scope of scopes) {
					active.delete(scope.id);
					if (scope.kind === "service")
						for (const endpoint of scope.endpoints) active.delete(endpoint.id);
				}
			}
		}
		const retain = (id: Id, make: () => BrowserAnchor) => {
			if (!active.has(id) || !this.anchors.has(id)) {
				const anchor = make();
				this.anchors.set(id, anchor);
				this.retainedAnchors.add(anchor);
			}
		};
		for (const scope of program.scopes) {
			this.metadata.set(scope.id, scope);
			retain(scope.id, () =>
				scope.kind === "service"
					? new BrowserService(this, scope.id, this.options)
					: new BrowserAutomation(this, scope.id, this.options),
			);
			if (scope.kind === "service")
				for (const ep of scope.endpoints) {
					this.metadata.set(ep.id, { ...ep, serviceId: scope.id });
					retain(ep.id, () => new BrowserEndpoint(this, ep.id, this.options));
				}
		}
	}
	anchorMetadata(id: Id): ScopeModel | (EndpointModel & { serviceId: Id }) {
		const meta = this.metadata.get(id);
		if (!meta) throw new Error("Anchor metadata is unavailable.");
		return meta;
	}
	anchorEndpoints(id: Id): readonly Endpoint[] {
		const scope = this.program?.scopes.find((s) => s.id === id);
		return scope?.kind === "service"
			? scope.endpoints.map((e) => this.anchors.get(e.id) as BrowserEndpoint)
			: [];
	}
	async flowFor(id: Id, signal?: AbortSignal): Promise<FlowUI> {
		signal?.throwIfAborted();
		const meta = this.anchorMetadata(id);
		return {
			state: this.analysis,
			selection:
				meta.kind === "service"
					? { kind: "definitions", scopeId: id }
					: { kind: "function", functionId: meta.functionId },
		};
	}

	async getDiagnostics(signal?: AbortSignal): Promise<DiagnosticsResult> {
		signal?.throwIfAborted();
		if (this.disposed) throw new Error("The workspace has been disposed.");
		if (!this.compiler)
			throw new Error(
				"A compiler is required to request workspace diagnostics.",
			);
		const files = this.snapshot();
		const result = await this.compiler.check(files, signal);
		return {
			diagnostics: result.diagnostics,
			stale: this.snapshot() !== files,
		};
	}

	snapshot = (): Files => this.files;
	storageSnapshot = (): StorageState => this.storageState;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	subscribeStorage = (listener: () => void): (() => void) => {
		this.storageListeners.add(listener);
		return () => {
			this.storageListeners.delete(listener);
		};
	};
	list(): string[] {
		return Object.keys(this.files).sort();
	}
	read(path: string): string {
		validatePath(path);
		if (!Object.hasOwn(this.files, path))
			throw new Error(`File not found: ${path}`);
		return this.files[path];
	}
	write(path: string, content: string): void {
		validatePath(path);
		if (
			this.list().some(
				(p) => p.startsWith(`${path}/`) || path.startsWith(`${p}/`),
			)
		)
			throw new Error("A file conflicts with this directory path.");
		this.mutate({ kind: "write", path, content });
	}
	edit(path: string, oldText: string, newText: string): void {
		const content = this.read(path);
		if (!oldText || content.split(oldText).length !== 2)
			throw new Error(
				"oldText must match exactly once. Read the file and try again.",
			);
		this.write(
			path,
			content.replace(oldText, () => newText),
		);
	}
	remove(path: string): void {
		this.read(path);
		this.mutate({ kind: "delete", path });
	}
	private mutate(change: FileChange): void {
		if (!this.storageState.writable)
			throw new Error(
				this.storageState.error ?? "Browser storage is read-only.",
			);
		validateChange(change);
		const next = applyChange(this.files, change);
		// Persist the entire snapshot atomically before exposing a successful change.
		try {
			this.storage.setItem(STORAGE_KEY, JSON.stringify(next));
		} catch (error) {
			this.failStorage(
				"Could not save browser files. Workspace is read-only.",
				error,
			);
			throw error;
		}
		const changed =
			Object.keys(next).length !== Object.keys(this.files).length ||
			Object.keys(next).some((path) => this.files[path] !== next[path]);
		this.files = next;
		if (changed) this.scheduleAnalysis();
		for (const listener of this.listeners) listener();
	}
	/** Stops analysis and every retained agent and drops all listeners. Idempotent. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.analysisController?.abort();
		for (const anchor of this.retainedAnchors) anchor.abort();
		this.listeners.clear();
		this.storageListeners.clear();
		this.analysisListeners.clear();
	}
	private failStorage(message: string, error: unknown): void {
		this.storageState = {
			writable: false,
			error: `${message} ${error instanceof Error ? error.message : String(error)}`,
		};
		// Stop all retained agents, including conversations no longer selected.
		for (const anchor of this.retainedAnchors) anchor.abort();
		for (const listener of this.storageListeners) listener();
	}
}

class BrowserAnchor {
	private agent?: WorkspaceAgent;
	protected workspace: BrowserWorkspace;
	readonly id: Id;
	private options?: BrowserWorkspaceOptions;
	constructor(
		workspace: BrowserWorkspace,
		id: Id,
		options?: BrowserWorkspaceOptions,
	) {
		this.workspace = workspace;
		this.id = id;
		this.options = options;
	}
	get title(): string {
		return this.workspace.anchorMetadata(this.id).title;
	}
	abort(): void {
		this.agent?.abort();
	}
	async getAgent(): Promise<WorkspaceAgent> {
		if (!this.options)
			throw new Error(
				"A model stream transport is required to use the workspace agent.",
			);
		const meta = this.workspace.anchorMetadata(this.id);
		this.agent ??= createWorkspaceAgent(
			this.workspace,
			undefined,
			this.options.streamFn,
			{
				id: this.id,
				title: meta.title,
				kind:
					meta.kind === "service" || meta.kind === "automation"
						? meta.kind
						: "endpoint",
				source: meta.source,
			},
		);
		return this.agent;
	}
	async getDiff(): Promise<Diff> {
		throw new Error("Diff is not implemented yet.");
	}
	getFlowUI(signal?: AbortSignal): Promise<FlowUI> {
		return this.workspace.flowFor(this.id, signal);
	}
}
class BrowserService extends BrowserAnchor implements Service {
	readonly scopeKind = "service";
	get kind(): string | null {
		const meta = this.workspace.anchorMetadata(this.id);
		return meta.kind === "service" ? meta.serviceType : null;
	}
	getEndpoints(): readonly Endpoint[] {
		return this.workspace.anchorEndpoints(this.id);
	}
}
class BrowserEndpoint extends BrowserAnchor implements Endpoint {
	get kind(): "resource" | "remote" {
		const meta = this.workspace.anchorMetadata(this.id);
		if (meta.kind !== "resource" && meta.kind !== "remote")
			throw new Error("Invalid endpoint metadata.");
		return meta.kind;
	}
	get serviceId(): Id {
		const meta = this.workspace.anchorMetadata(this.id);
		if (!("serviceId" in meta)) throw new Error("Invalid endpoint metadata.");
		return meta.serviceId;
	}
}
class BrowserAutomation extends BrowserAnchor implements Automation {
	readonly scopeKind = "automation";
}
