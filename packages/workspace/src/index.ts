import type { Agent } from "@earendil-works/pi-agent-core";

export type { Agent, AgentMessage } from "@earendil-works/pi-agent-core";
export type { Files } from "./files.ts";
import type { Files } from "./files.ts";

export interface StorageState {
	readonly writable: boolean;
	readonly error?: string;
}

export type ServiceKind = string | null;
export type EndpointKind = "resource" | "remote";

declare const opaque: unique symbol;
export type Diff = { readonly [opaque]: "Diff" };
export type * from "./flow.ts";
import type { FlowUI, Id, AnalysisState } from "./flow.ts";

export type CompactionState = "idle" | "compacting" | "failed";
export interface WorkspaceAgent extends Agent {
	readonly compactionState: CompactionState;
	subscribeCompaction(listener: () => void): () => void;
}

export interface Anchor {
	readonly id: Id;
	readonly title: string;
	getAgent(): Promise<WorkspaceAgent>;
	getDiff(): Promise<Diff>;
	getFlowUI(signal?: AbortSignal): Promise<FlowUI>;
}
export interface Service extends Anchor {
	readonly scopeKind: "service";
	readonly kind: ServiceKind;
	getEndpoints(): readonly Endpoint[];
}
export interface Endpoint extends Anchor {
	readonly serviceId: Id;
	readonly kind: EndpointKind;
	readonly title: string;
}

export interface Automation extends Anchor {
	readonly scopeKind: "automation";
}
export type WorkspaceScope = Service | Automation;

// File operations already used by the source editor and workspace tools.
export interface Workspace {
	readonly projectName?: string;
	storageSnapshot(): StorageState;
	subscribeStorage(listener: () => void): () => void;
	getServices(): Promise<readonly Service[]>;
	getScopes(): Promise<readonly WorkspaceScope[]>;
	analysisSnapshot(): AnalysisState;
	subscribeAnalysis(listener: () => void): () => void;
	getDiagnostics(signal?: AbortSignal): Promise<DiagnosticsResult>;
	snapshot(): Files;
	subscribe(listener: () => void): () => void;
	list(): string[];
	read(path: string): string;
	write(path: string, content: string): void;
	edit(path: string, oldText: string, newText: string): void;
	remove(path: string): void;
}

export type DiagnosticSeverity =
	| "internal"
	| "hint"
	| "info"
	| "warning"
	| "error"
	| "fatal";
export interface Position {
	readonly line: number;
	readonly column: number;
}
export interface SourceRange {
	readonly start: Position;
	readonly end: Position;
}
export interface Diagnostic {
	readonly severity: DiagnosticSeverity;
	readonly code?: string;
	readonly message: string;
	readonly file?: string;
	readonly range?: SourceRange;
}
export interface CompilationResult {
	readonly diagnostics: readonly Diagnostic[];
}
export interface DiagnosticsResult extends CompilationResult {
	readonly stale: boolean;
}

export { sourceText } from "./source.ts";
