import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { cn } from "@/lib/utils";

import type {
	HttpRequestSpec,
	HttpResponse,
} from "@/workers/ballerina-worker-api";

const HTTP_METHODS = [
	"GET",
	"POST",
	"PUT",
	"DELETE",
	"PATCH",
	"HEAD",
	"OPTIONS",
] as const;

type RequestTab = "query" | "headers" | "body";

interface KVRow {
	id: string;
	name: string;
	value: string;
}

let rowSeq = 0;
function newRow(): KVRow {
	rowSeq += 1;
	return { id: `r${rowSeq}`, name: "", value: "" };
}

function countFilled(rows: KVRow[]): number {
	return rows.filter((r) => r.name.trim() !== "").length;
}

// splitAddr splits a "host:port" listener address into its host and numeric port.
function splitAddr(addr: string): { host: string; port: number } {
	const idx = addr.lastIndexOf(":");
	if (idx < 0) return { host: addr, port: 0 };
	return {
		host: addr.slice(0, idx),
		port: Number.parseInt(addr.slice(idx + 1), 10) || 0,
	};
}

// buildHeaderRecord folds key/value rows into a headers map, collapsing repeated
// names into a string array.
function buildHeaderRecord(rows: KVRow[]): Record<string, string | string[]> {
	const record: Record<string, string | string[]> = {};
	for (const { name, value } of rows) {
		const key = name.trim();
		if (!key) continue;
		const existing = record[key];
		if (existing === undefined) record[key] = value;
		else if (Array.isArray(existing)) existing.push(value);
		else record[key] = [existing, value];
	}
	return record;
}

// buildQueryString URL-encodes key/value rows into a query string; repeated names
// produce repeated parameters (multi-valued query params).
function buildQueryString(rows: KVRow[]): string {
	return rows
		.filter((r) => r.name.trim() !== "")
		.map(
			(r) =>
				`${encodeURIComponent(r.name.trim())}=${encodeURIComponent(r.value)}`,
		)
		.join("&");
}

function KeyValueEditor({
	rows,
	onChange,
	namePlaceholder,
	valuePlaceholder,
	addLabel,
}: {
	rows: KVRow[];
	onChange: (rows: KVRow[]) => void;
	namePlaceholder: string;
	valuePlaceholder: string;
	addLabel: string;
}) {
	const update = (id: string, patch: Partial<KVRow>) =>
		onChange(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
	const remove = (id: string) =>
		onChange(
			rows.length === 1 ? [newRow()] : rows.filter((row) => row.id !== id),
		);

	return (
		<div className="flex flex-col gap-2">
			{rows.map((row) => (
				<div key={row.id} className="flex items-center gap-2">
					<Input
						className="h-8 flex-1 text-xs"
						value={row.name}
						onChange={(e) => update(row.id, { name: e.target.value })}
						placeholder={namePlaceholder}
					/>
					<Input
						className="h-8 flex-1 text-xs"
						value={row.value}
						onChange={(e) => update(row.id, { value: e.target.value })}
						placeholder={valuePlaceholder}
					/>
					<Button
						variant="ghost"
						size="icon-sm"
						onClick={() => remove(row.id)}
						aria-label="Remove row"
					>
						×
					</Button>
				</div>
			))}
			<Button
				variant="outline"
				size="sm"
				className="self-start"
				onClick={() => onChange([...rows, newRow()])}
			>
				{addLabel}
			</Button>
		</div>
	);
}

export interface ServicePanelHandle {
	send: () => void;
	clear: () => void;
}

export const ServicePanel = React.forwardRef<
	ServicePanelHandle,
	{
		addrs: string[];
		dispatchHttp: (req: HttpRequestSpec) => Promise<HttpResponse>;
		active: boolean;
		onStateChange: (state: { isSending: boolean; canSend: boolean }) => void;
	}
>(function ServicePanel({ addrs, dispatchHttp, active, onStateChange }, ref) {
	const [addr, setAddr] = React.useState(addrs[0] ?? "");
	const [method, setMethod] =
		React.useState<(typeof HTTP_METHODS)[number]>("GET");
	const [path, setPath] = React.useState("/");
	const [queryRows, setQueryRows] = React.useState<KVRow[]>(() => [newRow()]);
	const [headerRows, setHeaderRows] = React.useState<KVRow[]>(() => [newRow()]);
	const [body, setBody] = React.useState("");
	const [tab, setTab] = React.useState<RequestTab>("query");

	const [response, setResponse] = React.useState<HttpResponse | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [isSending, setIsSending] = React.useState(false);
	const [respTab, setRespTab] = React.useState<"body" | "headers">("body");

	React.useEffect(() => {
		if (!addrs.includes(addr)) setAddr(addrs[0] ?? "");
	}, [addrs, addr]);

	const handleSend = React.useCallback(async () => {
		if (isSending) return;
		setIsSending(true);
		setError(null);
		try {
			const { host, port } = splitAddr(addr);
			const res = await dispatchHttp({
				method,
				host,
				port,
				path: path || "/",
				query: buildQueryString(queryRows) || undefined,
				headers: buildHeaderRecord(headerRows),
				body: body !== "" ? body : undefined,
			});
			setResponse(res);
			setRespTab("body");
		} catch (err) {
			setResponse(null);
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSending(false);
		}
	}, [
		addr,
		method,
		path,
		queryRows,
		headerRows,
		body,
		dispatchHttp,
		isSending,
	]);

	const handleClear = React.useCallback(() => {
		setMethod("GET");
		setPath("/");
		setQueryRows([newRow()]);
		setHeaderRows([newRow()]);
		setBody("");
		setTab("query");
		setResponse(null);
		setError(null);
		setRespTab("body");
	}, []);

	const canSend = addr !== "" && !isSending;

	React.useImperativeHandle(
		ref,
		() => ({ send: () => void handleSend(), clear: handleClear }),
		[handleSend, handleClear],
	);

	React.useEffect(() => {
		onStateChange({ isSending, canSend });
	}, [isSending, canSend, onStateChange]);

	const queryCount = countFilled(queryRows);
	const headerCount = countFilled(headerRows);
	const respHeaderCount = response ? Object.keys(response.headers).length : 0;
	const tabs: { id: RequestTab; label: string }[] = [
		{ id: "query", label: queryCount ? `Query (${queryCount})` : "Query" },
		{
			id: "headers",
			label: headerCount ? `Headers (${headerCount})` : "Headers",
		},
		{ id: "body", label: body ? "Body •" : "Body" },
	];

	return (
		<div className={cn("flex-1 flex-col min-h-0", active ? "flex" : "hidden")}>
			{/* Request */}
			<div className="flex flex-col gap-3 border-b p-3 shrink-0">
				<div className="flex flex-wrap items-end gap-2">
					<div className="flex flex-col gap-1">
						<Label className="text-xs text-muted-foreground">Method</Label>
						<select
							className="h-8 border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
							value={method}
							onChange={(e) =>
								setMethod(e.target.value as (typeof HTTP_METHODS)[number])
							}
						>
							{HTTP_METHODS.map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-col gap-1">
						<Label className="text-xs text-muted-foreground">Listener</Label>
						<select
							className="h-8 border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
							value={addr}
							onChange={(e) => setAddr(e.target.value)}
						>
							{addrs.map((a) => (
								<option key={a} value={a}>
									{a}
								</option>
							))}
						</select>
					</div>
					<div className="flex flex-1 flex-col gap-1 min-w-[8rem]">
						<Label className="text-xs text-muted-foreground">Path</Label>
						<Input
							className="h-8 text-xs"
							value={path}
							onChange={(e) => setPath(e.target.value)}
							placeholder="/greeting"
						/>
					</div>
				</div>

				{/* Request section tabs */}
				<div className="flex items-center gap-1">
					{tabs.map((t) => (
						<Button
							key={t.id}
							variant={tab === t.id ? "secondary" : "ghost"}
							size="sm"
							onClick={() => setTab(t.id)}
						>
							{t.label}
						</Button>
					))}
				</div>

				<div className="max-h-40 overflow-y-auto">
					{tab === "query" && (
						<KeyValueEditor
							rows={queryRows}
							onChange={setQueryRows}
							namePlaceholder="Param name"
							valuePlaceholder="Value"
							addLabel="Add param"
						/>
					)}
					{tab === "headers" && (
						<KeyValueEditor
							rows={headerRows}
							onChange={setHeaderRows}
							namePlaceholder="Header name"
							valuePlaceholder="Value"
							addLabel="Add header"
						/>
					)}
					{tab === "body" && (
						<textarea
							className="min-h-20 w-full border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							placeholder='{"name": "world"}'
						/>
					)}
				</div>
			</div>

			{/* Response */}
			<div className="flex flex-1 flex-col min-h-0">
				<div className="flex h-8 shrink-0 items-center gap-2 border-b px-4">
					<span className="text-xs text-muted-foreground">Response</span>
					{response && (
						<span
							className={cn(
								"text-xs font-medium",
								response.status >= 400 ? "text-destructive" : "text-foreground",
							)}
						>
							{response.status}
						</span>
					)}
					{response && (
						<div className="ml-auto flex items-center gap-1">
							<Button
								variant={respTab === "body" ? "secondary" : "ghost"}
								size="xs"
								onClick={() => setRespTab("body")}
							>
								Body
							</Button>
							<Button
								variant={respTab === "headers" ? "secondary" : "ghost"}
								size="xs"
								onClick={() => setRespTab("headers")}
							>
								{respHeaderCount ? `Headers (${respHeaderCount})` : "Headers"}
							</Button>
						</div>
					)}
				</div>
				<div className="flex-1 overflow-y-auto p-3">
					{error ? (
						<pre className="border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive whitespace-pre-wrap wrap-break-word">
							{error}
						</pre>
					) : response ? (
						respTab === "headers" ? (
							respHeaderCount > 0 ? (
								<div className="flex flex-col gap-0.5">
									{Object.entries(response.headers).map(([name, values]) => (
										<div key={name} className="text-xs text-muted-foreground">
											<span className="font-medium text-foreground">
												{name}
											</span>
											: {values.join(", ")}
										</div>
									))}
								</div>
							) : (
								<p className="text-xs text-muted-foreground">No headers.</p>
							)
						) : (
							<pre className="text-xs whitespace-pre-wrap wrap-break-word">
								{response.body}
							</pre>
						)
					) : (
						<p className="text-xs text-muted-foreground">
							Send a request to see the response.
						</p>
					)}
				</div>
			</div>
		</div>
	);
});
