import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";

interface VersionRowProps {
	label: string;
	value: string;
	href?: string;
}

function VersionRow({ label, value, href }: VersionRowProps) {
	const inner = <span>{value}</span>;
	return (
		<div className="flex items-center justify-between gap-8 text-xs text-muted-foreground">
			<span>{label}</span>
			{href ? (
				<a
					className="hover:text-secondary-foreground"
					href={href}
					target="_blank"
					rel="noopener noreferrer"
				>
					{inner}
				</a>
			) : (
				inner
			)}
		</div>
	);
}

function getGitHubUrl(
	owner: string,
	repo: string,
	version: string,
	sentinel: string,
): string | undefined {
	if (version === sentinel) return undefined;
	const isTag = /^v\d+\.\d+\.\d+/.test(version);
	const suffix = isTag ? `releases/tag/${version}` : `commit/${version}`;
	return `https://github.com/${owner}/${repo}/${suffix}`;
}

export function VersionCard() {
	const rows: VersionRowProps[] = [
		{
			label: "Ballerina Interpreter",
			value: __BALLERINA_VERSION__,
			href: getGitHubUrl(
				"ballerina-nutcracker",
				"ballerina",
				__BALLERINA_VERSION__,
				"unknown",
			),
		},
		{
			label: "Playground",
			value: __COMMIT_SHA__ !== "dev" ? __COMMIT_SHA__.slice(0, 7) : "dev",
			href: getGitHubUrl(
				"ballerina-nutcracker",
				"playground",
				__COMMIT_SHA__,
				"dev",
			),
		},
	];

	return (
		<HoverCard>
			<HoverCardTrigger className="text-xs text-muted-foreground select-none">
				{__BALLERINA_VERSION__}
			</HoverCardTrigger>
			<HoverCardContent
				className="flex w-full max-w-105 flex-col gap-2 p-3 text-muted-foreground select-none"
				side="bottom"
				align="end"
			>
				{rows.map((row) => (
					<VersionRow key={row.label} {...row} />
				))}
			</HoverCardContent>
		</HoverCard>
	);
}
