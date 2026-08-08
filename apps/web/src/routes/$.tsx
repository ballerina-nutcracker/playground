import { createFileRoute } from "@tanstack/react-router";

import { BallerinaProvider } from "@/providers/ballerina-provider";
import { FSProvider } from "@/providers/fs-provider";

import { FileRouteSync } from "@/components/file-route-sync";
import { Editor } from "@/components/editor";

type PlaygroundSearch = {
	share?: string;
	sidebar?: "collapsed";
};

export const Route = createFileRoute("/$")({
	validateSearch: (search: Record<string, unknown>): PlaygroundSearch => {
		const validated: PlaygroundSearch = {};

		const share = search.share;
		if (typeof share === "string" && share.trim()) {
			validated.share = share.trim();
		}

		if (search.sidebar === "collapsed") {
			validated.sidebar = "collapsed";
		}

		return validated;
	},
	component: SplatComponent,
});

function SplatComponent() {
	const { sidebar } = Route.useSearch();

	return (
		<FSProvider>
			<BallerinaProvider>
				<FileRouteSync>
					<Editor defaultSidebarOpen={sidebar !== "collapsed"} />
				</FileRouteSync>
			</BallerinaProvider>
		</FSProvider>
	);
}
