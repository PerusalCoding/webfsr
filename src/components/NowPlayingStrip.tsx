import { useEffect, useState } from "react";
import { supabase } from "~/lib/supabaseClient";
import { difficultyBadge } from "~/lib/songFormatting";

interface NowPlayingRow {
	player_name: string;
	title: string;
	artist: string;
	pack: string;
	difficulty: number;
	difficulty_name: string;
	style: string;
	started_at: string;
}

// Separate from song_plays/PublicSongFeed entirely -- this is written
// directly by SongHRLog.lua via NETWORK:HttpRequest, not by the desktop
// app, so it works even when nobody has the app open. It never carries
// HR/calories (Lua has no access to that), just "who's playing what right
// now" -- upserted at song start, deleted at song end.
export function NowPlayingStrip() {
	const [rows, setRows] = useState<NowPlayingRow[]>([]);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			const { data } = await supabase.from("now_playing").select("*").order("started_at", { ascending: false });
			if (!cancelled) setRows(data ?? []);
		}

		load();

		const channel = supabase
			.channel("now_playing_live")
			.on("postgres_changes", { event: "*", schema: "public", table: "now_playing" }, () => {
				// Any insert/update/delete just triggers a fresh fetch --
				// this table is tiny (one row per active player), so
				// re-querying on every change is simpler and cheap
				// compared to patching individual rows in from the payload.
				load();
			})
			.subscribe();

		return () => {
			cancelled = true;
			supabase.removeChannel(channel);
		};
	}, []);

	if (rows.length === 0) return null;

	return (
		<div className="flex flex-wrap gap-2 px-4 pt-4">
			{rows.map((row) => (
				<div
					key={row.player_name}
					className="flex items-center gap-2 px-3 py-1.5 rounded-full border bg-white dark:bg-neutral-900 text-sm"
				>
					<span className="relative flex size-2">
						<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
						<span className="relative inline-flex rounded-full size-2 bg-green-500" />
					</span>
					<span className="font-medium">{row.player_name}</span>
					<span className="text-gray-500">is playing</span>
					<span className="truncate max-w-[12rem]">{row.title}</span>
					<span className="px-1.5 py-0.5 text-xs font-semibold rounded bg-red-600 text-white">
						{difficultyBadge(row.style, row.difficulty_name, row.difficulty)}
					</span>
				</div>
			))}
		</div>
	);
}
