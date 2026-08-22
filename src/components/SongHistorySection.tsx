import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { SongLogEntry, HeartrateSample, SongWithStats } from "~/lib/useSongHistory";
import { bannerUrl, computeSongStats } from "~/lib/useSongHistory";
import type { Biometrics } from "~/lib/calorieEstimate";
import { usePlayerName } from "~/lib/usePlayerName";
import { usePublishOptIn } from "~/lib/usePublishOptIn";
import { usePublishSongs } from "~/lib/usePublishSongs";
import { PublicSongFeed } from "~/components/PublicSongFeed";
import {
	difficultyBadge,
	gradeDisplay,
	formatRate,
	JUDGMENT_LABELS,
	formatDuration,
	formatDate,
	dayKey,
	dayLabel,
} from "~/lib/songFormatting";

interface SongHistorySectionProps {
	songs: SongLogEntry[];
	hrSamples: HeartrateSample[];
	folder: string | null;
	installFolder: string | null;
	mediaBaseUrl: string | null;
	isSupported: boolean;
	selectFolder: () => void;
	selectInstallFolder: () => void;
	biometrics: Biometrics;
	setBiometrics: (b: Biometrics) => void;
}

interface DayGroup {
	key: string;
	label: string;
	songs: SongWithStats[];
}

// Groups already-sorted-descending songs into per-day buckets, preserving
// order. Only the most recent day starts expanded -- with hundreds of
// songs logged over time, a flat list gets unmanageable fast, so older
// days collapse to a single summary row until clicked open.
function groupByDay(songs: SongWithStats[]): DayGroup[] {
	const groups: DayGroup[] = [];
	for (const song of songs) {
		const key = dayKey(song.startTime);
		const lastGroup = groups[groups.length - 1];
		if (lastGroup && lastGroup.key === key) {
			lastGroup.songs.push(song);
		} else {
			groups.push({ key, label: dayLabel(song.startTime), songs: [song] });
		}
	}
	return groups;
}

function GradeBadge({ grade, passed, score }: { grade: string; passed: boolean; score: string }) {
	const { label, className } = gradeDisplay(grade, passed, score);
	return (
		<span className={`inline-flex items-center justify-center min-w-[3rem] px-2 py-1 rounded font-bold text-sm tabular-nums ${className}`}>
			{label}
		</span>
	);
}

// True if this entry has any judgment-count data at all -- older log
// entries (written before SongHRLog.lua captured judgments) will have all
// six fields undefined, in which case there's nothing meaningful to
// expand into, so the row doesn't get the expand affordance at all rather
// than showing a panel of all-zeroes that looks like an FC.
function hasJudgmentData(song: SongWithStats): boolean {
	return (
		song.fantastic != null ||
		song.excellent != null ||
		song.great != null ||
		song.decent != null ||
		song.wayOff != null ||
		song.miss != null
	);
}

function SongRow({ song, mediaBaseUrl }: { song: SongWithStats; mediaBaseUrl: string | null }) {
	const banner = bannerUrl(mediaBaseUrl, song.bannerPath);
	const { date, time } = formatDate(song.startTime);
	const rateLabel = formatRate(song.rate);
	const expandable = hasJudgmentData(song);
	const [expanded, setExpanded] = useState(false);

	return (
		<div className="border-b last:border-b-0">
			<div
				className={`flex items-center gap-3 py-4 ${expandable ? "cursor-pointer" : ""}`}
				onClick={expandable ? () => setExpanded((v) => !v) : undefined}
			>
				{banner ? (
					<img
						src={banner}
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
					<div className="font-medium truncate">{song.title}</div>
					<div className="text-xs text-gray-500 truncate">{song.artist}</div>
					<span className="inline-block mt-1 px-1.5 py-0.5 text-xs font-semibold rounded bg-red-600 text-white">
						{difficultyBadge(song.style, song.difficultyName, song.difficulty)}
					</span>
					{!song.passed && <span className="ml-2 text-xs text-destructive">Failed</span>}
					{rateLabel && (
						<span className="ml-2 inline-block px-1.5 py-0.5 text-xs font-semibold rounded bg-violet-600 text-white">
							{rateLabel}
						</span>
					)}
				</div>

				<div className="flex flex-col items-center gap-1 w-20 shrink-0">
					<GradeBadge grade={song.grade} passed={song.passed} score={song.score} />
					{song.score && <div className="text-blue-400 font-semibold text-sm">{song.score}%</div>}
				</div>

				<div className="flex items-center gap-3 text-sm w-56 shrink-0 justify-end">
					<div className="text-center">
						<div className="text-[10px] text-gray-500 uppercase tracking-wide">Avg HR</div>
						<div>{song.avgHr ?? "—"}</div>
					</div>
					<div className="text-center">
						<div className="text-[10px] text-gray-500 uppercase tracking-wide">Max HR</div>
						<div>{song.maxHr ?? "—"}</div>
					</div>
					<div className="text-center">
						<div className="text-[10px] text-gray-500 uppercase tracking-wide">Cal</div>
						<div>{song.calories ?? "—"}</div>
					</div>
					<div className="text-center">
						<div className="text-[10px] text-gray-500 uppercase tracking-wide">Time</div>
						<div>{formatDuration(song.durationSeconds)}</div>
					</div>
				</div>

				<div className="text-right text-xs text-gray-500 w-24 shrink-0">
					<div>{date}</div>
					<div>{time}</div>
				</div>

				<div className="w-4 shrink-0 flex justify-center">
					{expandable && (
						expanded ? (
							<ChevronDown className="size-4 text-gray-500" />
						) : (
							<ChevronRight className="size-4 text-gray-500" />
						)
					)}
				</div>
			</div>

			{expandable && expanded && (
				<div className="pb-4 pl-3 -mt-1 flex flex-wrap gap-x-6 gap-y-1 text-sm">
					{JUDGMENT_LABELS.map(({ key, label, className }) => (
						<div key={key} className="flex items-baseline gap-1.5">
							<span className={`font-semibold tabular-nums ${className}`}>{song[key] ?? 0}</span>
							<span className="text-xs text-gray-500">{label}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

export function SongHistorySection({
	songs,
	hrSamples,
	folder,
	installFolder,
	mediaBaseUrl,
	isSupported,
	selectFolder,
	selectInstallFolder,
	biometrics,
	setBiometrics,
}: SongHistorySectionProps) {
	const songsWithStats = useMemo(() => {
		return songs
			.map((song) => computeSongStats(song, hrSamples, biometrics))
			.sort((a, b) => b.startTime - a.startTime);
	}, [songs, hrSamples, biometrics]);

	const { playerName, setPlayerName } = usePlayerName();
	const { publishEnabled, setPublishEnabled } = usePublishOptIn();
	usePublishSongs(songsWithStats, publishEnabled ? playerName : "", mediaBaseUrl);

	// "My Plays" (this device's local history) vs "Global Feed" (everyone's
	// published plays, same data the public webfsr site shows) -- defaults
	// to local so existing behavior for anyone not using this doesn't
	// change.
	const [viewMode, setViewMode] = useState<"local" | "global">("local");

	const dayGroups = useMemo(() => groupByDay(songsWithStats), [songsWithStats]);

	// Every day but the most recent starts collapsed -- with hundreds of
	// songs logged over time a flat list gets unwieldy fast, so history
	// tucks away behind a click while today's/the current set's plays stay
	// visible up front.
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

	// Browser (non-Electron) visitors -- including anyone visiting the
	// public webfsr site -- see the shared public feed instead of a local
	// file-backed history, since there's no local ITGMania/Save folder to
	// read from in a browser tab.
	if (!isSupported) {
		return <PublicSongFeed />;
	}

	return (
		<div className="p-4 space-y-4">
			<div className="p-3 border rounded bg-white dark:bg-neutral-900 space-y-3">
				<div className="flex items-center justify-between gap-2">
					<div className="text-sm">
						<div className="font-medium">ITGMania folder (Save/)</div>
						<div className="text-xs text-gray-600 dark:text-gray-400">
							{folder ?? "Not set — pick the folder that contains Save/"}
						</div>
					</div>
					<button
						onClick={selectFolder}
						className="px-3 py-1.5 text-sm rounded border hover:bg-gray-100 dark:hover:bg-neutral-800 shrink-0"
					>
						{folder ? "Change" : "Select folder"}
					</button>
				</div>

				<div className="flex items-center justify-between gap-2">
					<div className="text-sm">
						<div className="font-medium">ITGMania install folder (Songs/, for banners)</div>
						<div className="text-xs text-gray-600 dark:text-gray-400">
							{installFolder ??
								"Not set — only needed if this is different from the folder above (e.g. an installed, non-portable ITGMania)"}
						</div>
					</div>
					<button
						onClick={selectInstallFolder}
						className="px-3 py-1.5 text-sm rounded border hover:bg-gray-100 dark:hover:bg-neutral-800 shrink-0"
					>
						{installFolder ? "Change" : "Select folder"}
					</button>
				</div>

				<div className="flex flex-col gap-1 text-sm">
					<span className="text-xs text-gray-600 dark:text-gray-400">
						Display name (shown on the public feed at perusalcoding.github.io/webfsr/)
					</span>
					<input
						type="text"
						value={playerName}
						onChange={(e) => setPlayerName(e.target.value)}
						placeholder="e.g. Daniel"
						maxLength={40}
						className="px-2 py-1 rounded border bg-transparent"
					/>
				</div>

				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={publishEnabled}
						onChange={(e) => setPublishEnabled(e.target.checked)}
						className="size-4"
					/>
					<span>Publish my plays to the public feed</span>
					<span className="text-xs text-gray-500">
						{publishEnabled
							? playerName.trim()
								? "Publishing to feed"
								: "Set a display name above to start publishing"
							: "Off — your plays stay local to this device"}
					</span>
				</label>

				<div className="grid grid-cols-3 gap-2 text-sm">
					<label className="flex flex-col gap-1">
						<span className="text-xs text-gray-600 dark:text-gray-400">Weight (kg)</span>
						<input
							type="number"
							value={biometrics.weightKg}
							onChange={(e) => setBiometrics({ ...biometrics, weightKg: Number(e.target.value) })}
							className="px-2 py-1 rounded border bg-transparent"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-gray-600 dark:text-gray-400">Age</span>
						<input
							type="number"
							value={biometrics.age}
							onChange={(e) => setBiometrics({ ...biometrics, age: Number(e.target.value) })}
							className="px-2 py-1 rounded border bg-transparent"
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs text-gray-600 dark:text-gray-400">Sex</span>
						<select
							value={biometrics.sex}
							onChange={(e) => setBiometrics({ ...biometrics, sex: e.target.value as Biometrics["sex"] })}
							className="px-2 py-1 rounded border bg-transparent"
						>
							<option value="male">Male</option>
							<option value="female">Female</option>
						</select>
					</label>
				</div>
			</div>

			<div className="flex gap-1 border rounded p-1 w-fit bg-white dark:bg-neutral-900">
				<button
					onClick={() => setViewMode("local")}
					className={`px-3 py-1 text-sm rounded ${
						viewMode === "local" ? "bg-gray-200 dark:bg-neutral-700 font-medium" : "text-gray-500"
					}`}
				>
					My Plays
				</button>
				<button
					onClick={() => setViewMode("global")}
					className={`px-3 py-1 text-sm rounded ${
						viewMode === "global" ? "bg-gray-200 dark:bg-neutral-700 font-medium" : "text-gray-500"
					}`}
				>
					Global Feed
				</button>
			</div>

			{viewMode === "global" ? (
				<PublicSongFeed />
			) : songsWithStats.length === 0 ? (
				<div className="text-sm text-gray-600 dark:text-gray-400">
					No songs logged yet. Play a song with SongHRLog.lua installed and the HR monitor connected.
				</div>
			) : (
				<div className="space-y-3">
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
										({group.songs.length} {group.songs.length === 1 ? "song" : "songs"})
									</span>
								</button>
								{!isCollapsed && (
									<div className="px-3 border-t">
										{group.songs.map((song, i) => (
											<SongRow key={`${song.startTime}-${i}`} song={song} mediaBaseUrl={mediaBaseUrl} />
										))}
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}
