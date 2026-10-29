import type {
	Files,
	CompilationResult,
	AnalysisResult,
} from "@bal-bot/workspace";
import {
	validateResponse,
	validateAnalysisFiles,
	type CompilerRequest,
	type CompilerResponse,
} from "./protocol.ts";

export interface Compiler {
	check(files: Files, signal?: AbortSignal): Promise<CompilationResult>;
	analyze(files: Files, signal?: AbortSignal): Promise<AnalysisResult>;
}

export function createCompiler(): Compiler {
	async function request(
		request: CompilerRequest,
		signal?: AbortSignal,
	): Promise<CompilerResponse> {
		signal?.throwIfAborted();
		const worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});
		return new Promise<CompilerResponse>((resolve, reject) => {
			let settled = false;
			const finish = (
				outcome: { result: CompilerResponse } | { error: unknown },
			) => {
				if (settled) return;
				settled = true;
				signal?.removeEventListener("abort", abort);
				worker.removeEventListener("message", message);
				worker.removeEventListener("error", failure);
				worker.removeEventListener("messageerror", failure);
				worker.terminate();
				if ("error" in outcome) reject(outcome.error);
				else resolve(outcome.result);
			};
			const abort = () =>
				finish({
					error: new DOMException("Compilation aborted.", "AbortError"),
				});
			const failure = (event: Event) =>
				finish({
					error: new Error(
						"Compiler worker failed." +
							("message" in event ? ` ${event.message}` : ""),
					),
				});
			const message = (event: MessageEvent<unknown>) => {
				try {
					const response = validateResponse(event.data);
					if (response.kind === "failure")
						finish({ error: new Error(response.message) });
					else {
						if (response.operation !== request.operation)
							throw new Error("Mismatched compiler response operation.");
						if (response.operation === "analyze")
							validateAnalysisFiles(response.result, request.files);
						finish({ result: response });
					}
				} catch (error) {
					finish({ error });
				}
			};
			worker.addEventListener("message", message);
			worker.addEventListener("error", failure);
			worker.addEventListener("messageerror", failure);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) {
				abort();
				return;
			}
			try {
				worker.postMessage(request);
			} catch (error) {
				finish({ error });
			}
		});
	}
	return {
		async check(files, signal) {
			const response = await request({ operation: "check", files }, signal);
			if (response.kind !== "result" || response.operation !== "check")
				throw new Error("Mismatched compiler response.");
			return response.result;
		},
		async analyze(files, signal) {
			const response = await request({ operation: "analyze", files }, signal);
			if (response.kind !== "result" || response.operation !== "analyze")
				throw new Error("Mismatched compiler response.");
			return response.result;
		},
	};
}
