import { useEffect, useState } from "react";
import { supabase, type PublicSongPlay } from "~/lib/supabaseClient";
import { difficultyBadge, gradeDisplay, formatDuration, formatDate } from "~/lib/songFormatting";

const FEED_PAGE_SIZE = 50;

function GradeBadge({ passed, score }: { passed: boolean; score: string }) {
	// The public feed's Supabase row doesn't carry the raw StepMania
	// `grade` field (only the local song history does, straight from
	// SongHRLog.lua) -- gradeDisplay() falls back to estimating the tier
	// from the score percentage when no grade string is passed, using the
	// same real Tier01-17 thresholds as the exact version. Slightly less
	// precise right at a tier boundary than the real enum value would be,
	// but far closer than the old fixed 3-star scale this replaced. If a
	// literal grade is wanted here too, that needs `grade` added to
	// usePublishSongs.ts's upload payload and the song_plays table.
	const { label, className } = gradeDisplay(undefined, passed, score);
	return (
		<span className={`inline-flex items-center justify-center min-w-[3rem] px-2 py-1 rounded font-bold text-sm tabular-nums ${className}`}>
			{label}
		</span>
	);
}

function FeedRow({ play }: { play: PublicSongPlay }) {
	const playedAtSeconds = new Date(play.played_at).getTime() / 1000;
	const { date, time } = formatDate(playedAtSeconds);

	return (
		<div className="flex items-center gap-3 py-4 border-b last:border-b-0">
			{play.banner_url ? (
				<img
					src={play.banner_url}
					alt=""
					className="w-48 h-[60px] rounded object-contain shrink-0 bg-neutral-800"
					onError={(e) => {
						(e.target as HTMLImageElement).style.visibility = "hidden";
					}}
				/>
			) : (
				<div className="w-48 h-[60px] rounded shrink-0 bg-neutral-800" />
			)}

			<div className="min-w-0 flex-1">
				<div className="font-medium truncate">{play.title}</div>
				<div className="text-xs text-gray-500 truncate">{play.artist}</div>
				<div className="flex items-center gap-2 mt-1">
					<span className="inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-red-600 text-white">
						{difficultyBadge(play.style, play.difficulty_name, play.difficulty)}
					</span>
					<span className="text-xs text-gray-400 truncate">{play.player_name}</span>
					{!play.passed && <span className="text-xs text-destructive">Failed</span>}
				</div>
			</div>

			<div className="flex flex-col items-center gap-1 w-20 shrink-0">
				<GradeBadge passed={play.passed} score={play.score} />
				{play.score && <div className="text-blue-400 font-semibold text-sm">{play.score}%</div>}
			</div>

			<div className="flex items-center gap-3 text-sm w-56 shrink-0 justify-end">
				<div className="text-center">
					<div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg HR</div>
					<div>{play.avg_hr ?? "—"}</div>
				</div>
				<div className="text-center">
					<div className="text-[10px] text-gray-500 uppercase tracking-wide">Max HR</div>
					<div>{play.max_hr ?? "—"}</div>
				</div>
				<div className="text-center">
					<div className="text-[10px] text-gray-500 uppercase tracking-wide">Cal</div>
					<div>{play.calories ?? "—"}</div>
				</div>
				<div className="text-center">
					<div className="text-[10px] text-gray-500 uppercase tracking-wide">Time</div>
					<div>{formatDuration(play.duration_seconds)}</div>
				</div>
			</div>

			<div className="text-right text-xs text-gray-500 w-24 shrink-0">
				<div>{date}</div>
				<div>{time}</div>
			</div>
		</div>
	);
}

export function PublicSongFeed() {
	const [plays, setPlays] = useState<PublicSongPlay[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;

		async function load() {
			const { data, error: fetchError } = await supabase
				.from("song_plays")
				.select("*")
				.order("played_at", { ascending: false })
				.limit(FEED_PAGE_SIZE);

			if (cancelled) return;
			if (fetchError) {
				setError(fetchError.message);
			} else {
				setPlays(data ?? []);
				setError(null);
			}
			setLoading(false);
		}

		load();

		// Live updates: new rows appear in the feed as soon as anyone
		// publishes a play, matching the "automatic" publish behavior on
		// the app side.
		const channel = supabase
			.channel("song_plays_public_feed")
			.on(
				"postgres_changes",
				{ event: "INSERT", schema: "public", table: "song_plays" },
				(payload) => {
					setPlays((prev) => [payload.new as PublicSongPlay, ...prev].slice(0, FEED_PAGE_SIZE));
				},
			)
			.subscribe();

		return () => {
			cancelled = true;
			supabase.removeChannel(channel);
		};
	}, []);

	if (loading) {
		return <div className="p-4 text-sm text-gray-600 dark:text-gray-400">Loading feed…</div>;
	}

	if (error) {
		return <div className="p-4 text-sm text-destructive">Couldn't load the feed: {error}</div>;
	}

	if (plays.length === 0) {
		return (
			<div className="p-4 text-sm text-gray-600 dark:text-gray-400">
				No plays published yet. Songs played in the Awakened Animus desktop app show up here automatically.
			</div>
		);
	}

	return (
		<div className="p-4">
			<div className="border rounded bg-white dark:bg-neutral-900 px-3">
				{plays.map((play) => (
					<FeedRow key={play.id} play={play} />
				))}
			</div>
		</div>
	);
}
