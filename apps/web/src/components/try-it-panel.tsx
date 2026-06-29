import * as React from "react";

import { Cancel01Icon, SentIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form";

import * as z from "zod/v3";

import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";

import { cn } from "@/lib/utils";

import { useBallerina } from "@/providers/ballerina-provider";

import type {
	HttpDispatchRequest,
	HttpDispatchResponse,
} from "@/workers/ballerina-worker-api";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const DEFAULT_HTTP_HOST = "0.0.0.0";

const keyValuePairSchema = z.object({
	key: z.string(),
	value: z.string(),
});

const keyValuePairsSchema = z.array(keyValuePairSchema);

const formSchema = z.object({
	method: z.enum(HTTP_METHODS),
	listenerPort: z.string().min(1),
	path: z.string().trim().min(1),
	query: keyValuePairsSchema,
	headers: keyValuePairsSchema,
	body: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

type KeyValueEntry = z.infer<typeof keyValuePairSchema>;

type ResponseState = {
	statusCode: number | null;
	body: string;
	headers: KeyValueEntry[];
	error?: string;
};

type FieldArrayName = "query" | "headers";

export type TryItPanelHandle = {
	clear: () => void;
};

type Props = {
	listenerAddresses: string[];
};

function isKeyValueEntryEmpty(
	entry: { key: string; value: string } | undefined,
) {
	return !entry?.key.trim() && !entry?.value.trim();
}

function areEntriesEqual(left: KeyValueEntry[], right: KeyValueEntry[]) {
	return (
		left.length === right.length &&
		left.every(
			(entry, index) =>
				entry.key === right[index]?.key && entry.value === right[index]?.value,
		)
	);
}

function KeyValueFields({
	form,
	name,
}: {
	form: ReturnType<typeof useForm<FormValues>>;
	name: FieldArrayName;
}) {
	const { fields, append, remove, replace } = useFieldArray({
		control: form.control,
		name,
	});
	const entries = useWatch({ control: form.control, name });

	React.useEffect(() => {
		if (fields.length === 0) {
			append({ key: "", value: "" }, { shouldFocus: false });
			return;
		}

		const lastEntry = entries?.[fields.length - 1];
		const previousEntry = entries?.[fields.length - 2];

		if (
			fields.length > 1 &&
			isKeyValueEntryEmpty(lastEntry) &&
			isKeyValueEntryEmpty(previousEntry)
		) {
			remove(fields.length - 1);
			return;
		}

		if (!isKeyValueEntryEmpty(lastEntry)) {
			append({ key: "", value: "" }, { shouldFocus: false });
		}
	}, [append, entries, fields.length, remove]);

	function getNormalizedEntries(entries: KeyValueEntry[]) {
		const nextEntries = [...entries];

		while (
			nextEntries.length > 1 &&
			isKeyValueEntryEmpty(nextEntries.at(-1)) &&
			isKeyValueEntryEmpty(nextEntries.at(-2))
		) {
			nextEntries.pop();
		}

		if (nextEntries.length === 0 || !isKeyValueEntryEmpty(nextEntries.at(-1))) {
			nextEntries.push({ key: "", value: "" });
		}

		return nextEntries;
	}

	function normalizeEntries() {
		const currentEntries = form.getValues(name);
		const nextEntries = getNormalizedEntries(currentEntries);

		if (!areEntriesEqual(currentEntries, nextEntries)) {
			replace(nextEntries);
		}
	}

	function handleRemove(index: number) {
		const currentEntries = form.getValues(name);
		const nextEntries = getNormalizedEntries(
			currentEntries.filter((_, entryIndex) => entryIndex !== index),
		);

		replace(nextEntries);
	}

	return (
		<div className="flex flex-col gap-2">
			{fields.map((field, index) => {
				const keyField = form.register(`${name}.${index}.key`);
				const valueField = form.register(`${name}.${index}.value`);

				return (
					<div key={field.id} className="flex items-center gap-2">
						<Input
							{...keyField}
							placeholder="Key"
							autoComplete="off"
							aria-label={`${name} key ${index + 1}`}
							onBlur={(event) => {
								void keyField.onBlur(event);
								normalizeEntries();
							}}
						/>
						<Input
							{...valueField}
							placeholder="Value"
							autoComplete="off"
							aria-label={`${name} value ${index + 1}`}
							onBlur={(event) => {
								void valueField.onBlur(event);
								normalizeEntries();
							}}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							aria-label={`Remove ${name} entry ${index + 1}`}
							onClick={() => handleRemove(index)}
						>
							<HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.5} />
						</Button>
					</div>
				);
			})}
		</div>
	);
}

function toHeaderEntries(
	headers: HttpDispatchResponse["headers"],
): KeyValueEntry[] {
	return Object.entries(headers).flatMap(([key, values]) =>
		values.map((value) => ({ key, value })),
	);
}

function buildHeaderRecord(
	entries: KeyValueEntry[],
): HttpDispatchRequest["headers"] {
	const headers: Record<string, string | string[]> = {};
	for (const entry of entries) {
		const key = entry.key.trim();
		const value = entry.value.trim();
		if (!key || !value) continue;

		const existing = headers[key];
		if (Array.isArray(existing)) {
			existing.push(value);
		} else if (typeof existing === "string") {
			headers[key] = [existing, value];
		} else {
			headers[key] = value;
		}
	}

	return headers;
}

function buildQueryString(url: URL, entries: KeyValueEntry[]) {
	const params = new URLSearchParams(url.search);
	for (const entry of entries) {
		const key = entry.key.trim();
		const value = entry.value.trim();
		if (!key || !value) continue;
		params.append(key, value);
	}

	return params.toString();
}

function toListenerPort(address: string) {
	return address.split(":").at(-1) ?? address;
}

function parseRequestPath(value: string, listenerPort: string) {
	const trimmed = value.trim();
	const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	return new URL(path, `http://${DEFAULT_HTTP_HOST}:${listenerPort}`);
}

function buildHttpDispatchRequest(values: FormValues): HttpDispatchRequest {
	const url = parseRequestPath(values.path, values.listenerPort);
	const method: HttpDispatchRequest["method"] = values.method;
	const request: HttpDispatchRequest = {
		method,
		host: url.host,
		path: url.pathname || "/",
		query: buildQueryString(url, values.query),
		headers: buildHeaderRecord(values.headers),
	};

	if (method !== "GET" && method !== "HEAD") request.body = values.body;
	return request;
}

function ResponseSection({ response }: { response: ResponseState }) {
	return (
		<section>
			<Tabs defaultValue="body" className="gap-4">
				<div className="flex items-center justify-between gap-4">
					<div className="flex items-center gap-2">
						<h3 className="text-sm font-medium text-foreground">Response</h3>
						{response.statusCode !== null && (
							<span className="border px-1.5 py-0.5 text-xs text-muted-foreground">
								{response.statusCode}
							</span>
						)}
					</div>
					<TabsList className="w-fit shrink-0 border border-border bg-muted p-0">
						<TabsTrigger
							value="body"
							className="px-4 not-last:border-r border-0 border-border"
						>
							Body
						</TabsTrigger>
						<TabsTrigger
							value="headers"
							className="px-4 not-last:border-r border-0 border-border"
						>
							Headers
						</TabsTrigger>
					</TabsList>
				</div>
				<TabsContent value="body" className="mt-0" keepMounted>
					<pre
						className={cn(
							"min-h-24 border p-3 text-xs whitespace-pre-wrap wrap-break-word text-muted-foreground",
							response.error && "text-destructive",
						)}
					>
						{response.error || response.body}
					</pre>
				</TabsContent>
				<TabsContent value="headers" className="mt-0" keepMounted>
					<div className="min-h-24 border p-3 text-xs text-muted-foreground">
						{response.headers.length ? (
							<div className="flex flex-col gap-2">
								{response.headers.map((header) => (
									<div
										key={`${header.key}-${header.value}`}
										className="grid grid-cols-2 gap-2"
									>
										<span className="text-foreground">{header.key}</span>
										<span>{header.value}</span>
									</div>
								))}
							</div>
						) : (
							"No response headers."
						)}
					</div>
				</TabsContent>
			</Tabs>
		</section>
	);
}

export const TryItPanel = React.forwardRef<TryItPanelHandle, Props>(
	function TryItPanel({ listenerAddresses }, ref) {
		const { dispatchHttpRequest } = useBallerina();
		const listenerPorts = React.useMemo(
			() => listenerAddresses.map(toListenerPort),
			[listenerAddresses],
		);
		const [response, setResponse] = React.useState<ResponseState | null>(null);
		const form = useForm<FormValues>({
			resolver: zodResolver(formSchema),
			defaultValues: {
				method: "GET",
				listenerPort: listenerPorts[0] ?? "",
				path: "/",
				query: [{ key: "", value: "" }],
				headers: [{ key: "", value: "" }],
				body: "",
			},
		});

		React.useEffect(() => {
			const listenerPort = form.getValues("listenerPort");
			if (!listenerPorts.includes(listenerPort)) {
				form.setValue("listenerPort", listenerPorts[0] ?? "");
			}
		}, [form, listenerPorts]);

		React.useImperativeHandle(
			ref,
			() => ({
				clear: () => {
					const { method, listenerPort, path } = form.getValues();
					form.reset({
						method,
						listenerPort,
						path,
						query: [{ key: "", value: "" }],
						headers: [{ key: "", value: "" }],
						body: "",
					});
					setResponse(null);
				},
			}),
			[form],
		);

		async function onSubmit(data: FormValues) {
			try {
				const httpResponse = await dispatchHttpRequest(
					buildHttpDispatchRequest(data),
				);
				setResponse({
					statusCode: httpResponse.statusCode,
					body: httpResponse.body,
					headers: toHeaderEntries(httpResponse.headers),
				});
			} catch (error) {
				setResponse({
					statusCode: null,
					body: "",
					headers: [],
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return (
			<form
				className="flex flex-col gap-4"
				onSubmit={form.handleSubmit(onSubmit)}
				autoComplete="off"
			>
				<FieldGroup>
					<div className="flex items-start gap-0">
						<Controller
							control={form.control}
							name="method"
							render={({ field, fieldState }) => (
								<Field
									data-invalid={fieldState.invalid}
									className="w-24 shrink-0"
								>
									<FieldLabel htmlFor={field.name} className="sr-only">
										HTTP method
									</FieldLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger
											id={field.name}
											aria-invalid={fieldState.invalid}
											className="w-24 shrink-0"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{HTTP_METHODS.map((httpMethod) => (
												<SelectItem key={httpMethod} value={httpMethod}>
													{httpMethod}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
						/>
						<Controller
							control={form.control}
							name="listenerPort"
							render={({ field, fieldState }) => (
								<Field
									data-invalid={fieldState.invalid}
									className="w-24 shrink-0"
								>
									<FieldLabel htmlFor={field.name} className="sr-only">
										Listeners
									</FieldLabel>
									<Select value={field.value} onValueChange={field.onChange}>
										<SelectTrigger
											id={field.name}
											aria-invalid={fieldState.invalid}
											className="w-24 shrink-0"
										>
											<SelectValue />
										</SelectTrigger>
										<SelectContent align="end">
											{listenerPorts.map((port) => (
												<SelectItem key={port} value={port}>
													{port}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
						/>
						<Controller
							control={form.control}
							name="path"
							render={({ field, fieldState }) => (
								<Field
									data-invalid={fieldState.invalid}
									className="min-w-0 flex-1"
								>
									<FieldLabel htmlFor={field.name} className="sr-only">
										Request path
									</FieldLabel>
									<Input
										{...field}
										id={field.name}
										placeholder="/"
										autoComplete="off"
										aria-invalid={fieldState.invalid}
									/>
								</Field>
							)}
						/>
						<Button
							type="submit"
							className="shrink-0"
							variant="outline"
							disabled={form.formState.isSubmitting}
						>
							{form.formState.isSubmitting ? (
								"[...]"
							) : (
								<>
									<HugeiconsIcon icon={SentIcon} strokeWidth={1.5} />
									Send
								</>
							)}
						</Button>
					</div>
				</FieldGroup>

				<Tabs defaultValue="query" className="gap-4">
					<TabsList className="w-fit border border-border bg-muted p-0">
						<TabsTrigger
							value="query"
							className="px-4 not-last:border-r border-0 border-border"
						>
							Query
						</TabsTrigger>
						<TabsTrigger
							value="headers"
							className="px-4 not-last:border-r border-0 border-border"
						>
							Headers
						</TabsTrigger>
						<TabsTrigger
							value="body"
							className="px-4 not-last:border-r border-0 border-border"
						>
							Body
						</TabsTrigger>
					</TabsList>
					<TabsContent value="query" className="mt-0" keepMounted>
						<KeyValueFields form={form} name="query" />
					</TabsContent>
					<TabsContent value="headers" className="mt-0" keepMounted>
						<KeyValueFields form={form} name="headers" />
					</TabsContent>
					<TabsContent value="body" className="mt-0" keepMounted>
						<Field>
							<FieldLabel htmlFor="try-it-body" className="sr-only">
								Body
							</FieldLabel>
							<Textarea
								{...form.register("body")}
								id="try-it-body"
								placeholder="Request body"
								autoComplete="off"
								className="min-h-32 resize-y"
							/>
						</Field>
					</TabsContent>
				</Tabs>
				<Separator className="-mx-4 w-[calc(100%+2rem)]!" />
				{!!response && <ResponseSection response={response} />}
			</form>
		);
	},
);
