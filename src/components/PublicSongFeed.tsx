import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { supabase, type PublicSongPlay } from "~/lib/supabaseClient";
import { difficultyBadge, gradeDisplay, formatDuration, formatDate, dayKey, dayLabel } from "~/lib/songFormatting";
import { NowPlayingStrip } from "~/components/NowPlayingStrip";

const FEED_PAGE_SIZE = 50;

function playedAtEpochSeconds(play: PublicSongPlay): number {
	return new Date(play.played_at).getTime() / 1000;
}

interface DayGroup {
	key: string;
	label: string;
	plays: PublicSongPlay[];
}

// Same day-grouping behavior as the local (Electron) song list -- with a
// shared, growing feed across everyone using the app, a flat list gets
// unmanageable fast, so it's grouped by day with only the most recent day
// expanded by default.
function groupByDay(plays: PublicSongPlay[]): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const play of plays) {
		const key = dayKey(playedAtEpochSeconds(play));
		const lastGroup = groups[groups.length - 1];
		if (lastGroup && lastGroup.key === key) {
			lastGroup.plays.push(play);
		} else {
			groups.push({ key, label: dayLabel(playedAtEpochSeconds(play)), plays: [play] });
		}
	}
	return groups;
}

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

	const dayGroups = useMemo(() => groupByDay(plays), [plays]);

	const [collapsedDays, setCollapsedDays] = useState<Set<string>>(
		() => new Set(dayGroups.slice(1).map((g) => g.key)),
	);
	const toggleDay = (key: string) => {
		setCollapsedDays((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	if (loading) {
		return (
			<div>
				<NowPlayingStrip />
				<div className="p-4 text-sm text-gray-600 dark:text-gray-400">Loading feed…</div>
			</div>
		);
	}

	if (error) {
		return (
			<div>
				<NowPlayingStrip />
				<div className="p-4 text-sm text-destructive">Couldn't load the feed: {error}</div>
			</div>
		);
	}

	if (plays.length === 0) {
		return (
			<div>
				<NowPlayingStrip />
				<div className="p-4 text-sm text-gray-600 dark:text-gray-400">
					No plays published yet. Songs played in the Awakened Animus desktop app show up here automatically.
				</div>
			</div>
		);
	}

	return (
		<div>
			<NowPlayingStrip />
			<div className="p-4 space-y-3">
				{dayGroups.map((group) => {
					const isCollapsed = collapsedDays.has(group.key);
					return (
						<div key={group.key} className="border rounded bg-white dark:bg-neutral-900">
							<button
								onClick={() => toggleDay(group.key)}
								className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium hover:bg-gray-50 dark:hover:bg-neutral-800"
							>
								{isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
								<span>{group.label}</span>
								<span className="text-xs text-gray-500 font-normal">
									({group.plays.length} {group.plays.length === 1 ? "play" : "plays"})
								</span>
							</button>
							{!isCollapsed && (
								<div className="px-3 border-t">
									{group.plays.map((play) => (
										<FeedRow key={play.id} play={play} />
									))}
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
