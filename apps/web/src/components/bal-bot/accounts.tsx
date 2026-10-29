import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	loginProvider,
	logoutProvider,
	providerOptions,
	type ProviderAccount,
} from "./providers";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";

interface Props {
	accounts: ProviderAccount[];
	provider: string;
	busy: boolean;
	chooseProvider: (provider: string) => void;
	refresh: () => Promise<void>;
	loginRequest: number;
}
function ProviderIcon({ id }: { id: string }) {
	return (
		<span
			className="provider-icon inline-flex size-5 flex-none items-center justify-center"
			aria-hidden="true"
		>
			{id === "openai" || id === "anthropic" ? (
				<img
					src={`${import.meta.env.BASE_URL}${id}.svg`}
					alt=""
					width="20"
					height="20"
					className="size-5 object-contain"
				/>
			) : (
				<span>{id === "google" ? "✦" : "⇄"}</span>
			)}
		</span>
	);
}
export function Accounts({
	accounts,
	provider,
	busy,
	chooseProvider,
	refresh,
	loginRequest,
}: Props) {
	const [error, setError] = useState("");
	const [key, setKey] = useState("");
	const [working, setWorking] = useState(false);
	const [showLogin, setShowLogin] = useState(false);
	const [pickerOpen, setPickerOpen] = useState(false);
	const lastLoginRequest = useRef(loginRequest);
	const selected =
		providerOptions.find((option) => option.id === provider) ??
		providerOptions[0];
	const current = accounts.find((account) => account.id === provider);
	useEffect(() => {
		if (lastLoginRequest.current === loginRequest) return;
		lastLoginRequest.current = loginRequest;
		setError("");
		setKey("");
		setShowLogin(true);
	}, [loginRequest]);
	async function saveKey() {
		setWorking(true);
		setError("");
		try {
			await loginProvider(provider, key);
			setKey("");
			await refresh();
			setShowLogin(false);
		} catch {
			setKey("");
			setError("Could not configure the API key. Please try again.");
		} finally {
			setWorking(false);
		}
	}
	async function forgetKey() {
		setWorking(true);
		setError("");
		setKey("");
		try {
			await logoutProvider(provider);
			await refresh();
			setShowLogin(false);
		} catch {
			setError("Could not forget the API key. Please retry.");
		} finally {
			setWorking(false);
		}
	}
	return (
		<div className="provider-controls flex flex-none items-center gap-2">
			<DropdownMenu
				open={pickerOpen}
				onOpenChange={(open) => {
					setPickerOpen(open);
					if (open) {
						setShowLogin(false);
						setKey("");
					}
				}}
			>
				<DropdownMenuTrigger
					render={
						<Button
							variant="outline"
							size="sm"
							className="provider-trigger"
							aria-label={`Provider: ${selected.name}`}
						/>
					}
					disabled={busy || working}
				>
					<ProviderIcon id={provider} />
					<span>{selected.name}</span>
					<HugeiconsIcon
						icon={ArrowDown01Icon}
						strokeWidth={1.5}
						aria-hidden="true"
					/>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="provider-options w-72 p-1">
					<DropdownMenuRadioGroup value={provider}>
						{providerOptions.map((option) => (
							<DropdownMenuRadioItem
								key={option.id}
								value={option.id}
								closeOnClick
								className="provider-option gap-2"
								onClick={() => {
									chooseProvider(option.id);
									setError("");
									setKey("");
									setShowLogin(true);
								}}
							>
								<ProviderIcon id={option.id} />
								<span className="min-w-0 flex-1 text-left">
									{option.name}
									<small className="block text-[10px] font-normal text-muted-foreground">
										{option.description}
									</small>
								</span>
								{accounts.find((account) => account.id === option.id)
									?.connected && (
									<span
										className="inline-flex"
										role="img"
										aria-label="API key configured"
									>
										<HugeiconsIcon
											icon={Tick02Icon}
											strokeWidth={1.5}
											aria-hidden="true"
										/>
									</span>
								)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog
				open={showLogin}
				onOpenChange={(open) => {
					setShowLogin(open);
					if (!open) setKey("");
				}}
			>
				<DialogContent
					className="provider-popover flex flex-col gap-3 sm:max-w-[460px]"
					aria-label="Provider API key"
				>
					<div className="login-heading text-sm font-semibold">
						{selected.name} API key
					</div>
					<DialogDescription className="text-[11px]">
						Use an API key, not a subscription sign-in. Keys stay in this tab’s
						memory and are forgotten on refresh or close.
					</DialogDescription>
					{current?.connected && (
						<p className="text-[11px] text-muted-foreground" role="status">
							API key configured. It will be checked when you send a message.
						</p>
					)}
					<form
						className="api-key-form flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void saveKey();
						}}
					>
						<label
							htmlFor="bal-bot-api-key"
							className="flex flex-col gap-1.5 text-[11px]"
						>
							API key
							<Input
								id="bal-bot-api-key"
								className="h-8"
								type="password"
								aria-label="API key"
								autoComplete="off"
								spellCheck={false}
								value={key}
								disabled={busy || working}
								onChange={(event) => setKey(event.target.value)}
							/>
						</label>
						<Button
							type="submit"
							className="self-end"
							disabled={busy || working || !key.trim()}
						>
							{current?.connected ? "Replace API key" : "Use API key"}
						</Button>
					</form>
					{error && (
						<p className="message-error text-xs text-destructive" role="alert">
							{error}
						</p>
					)}
					{current?.connected && (
						<div className="login-actions">
							<Button
								variant="outline"
								size="sm"
								disabled={busy || working}
								onClick={() => void forgetKey()}
							>
								Forget API key
							</Button>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</div>
	);
}
