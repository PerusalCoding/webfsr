import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import { difficultyBadge, gradeDisplay, formatDuration, formatRate } from "~/lib/songFormatting";
import { type BroadcastSongEntry, type ObsBroadcastPayload, useOBS } from "~/lib/useOBS";

type SongTickerConfig = {
	count: number; // how many songs stay visible at once, 1-10
	showBanner: boolean;
	showGrade: boolean;
	showStats: boolean; // Avg HR / Max HR / Cal / Time row
	fadeMs: number; // enter/leave crossfade duration
	containerBackgroundColor: string;
	textColor: string;
	fontScale: number; // multiplier on all text sizes, 0.5-3
	bannerScale: number; // multiplier on the banner image size, 0.5-3
};

// Base (scale=1) pixel sizes for everything that needs to grow with the
// font/banner sliders. Kept as plain numbers rather than Tailwind
// arbitrary-value classes (text-[11px] etc.) so they can be multiplied by
// the live scale and applied as inline styles.
const BASE_SIZES = {
	title: 11,
	artist: 9,
	badge: 8,
	gradeLabel: 10,
	gradeScore: 8,
	statsLabel: 8,
	statsValue: 11,
	rowGap: 8, // px, the flex `gap` between banner/info/grade/stats
	rowPaddingX: 8,
	rowPaddingY: 6,
	borderRadius: 6,
};

const BASE_BANNER = { width: 56, height: 24 };

type ObsPayload = ObsBroadcastPayload & {
	eventType?: string;
};

const DEFAULT_CONFIG: SongTickerConfig = {
	count: 5,
	showBanner: true,
	showGrade: true,
	showStats: true,
	fadeMs: 500,
	containerBackgroundColor: "rgba(0, 0, 0, 0.55)",
	textColor: "rgba(255, 255, 255, 1)",
	fontScale: 1,
	bannerScale: 1,
};

// Clamp + fall back to a default when the query param is missing or NaN.
function parseScale(raw: string | null, fallback: number) {
	const n = Number(raw);
	if (!raw || Number.isNaN(n)) return fallback;
	return Math.max(0.5, Math.min(3, n));
}

function getQueryPassword() {
	const params = new URLSearchParams(window.location.search);
	return params.get("pwd") || "";
}

function parseQueryConfig(): SongTickerConfig {
	const params = new URLSearchParams(window.location.search);
	return {
		count: Math.max(1, Math.min(10, Number(params.get("count")) || DEFAULT_CONFIG.count)),
		showBanner: params.get("showBanner") !== "false",
		showGrade: params.get("showGrade") !== "false",
		showStats: params.get("showStats") !== "false",
		fadeMs: Math.max(0, Math.min(3000, Number(params.get("fadeMs")) || DEFAULT_CONFIG.fadeMs)),
		containerBackgroundColor: params.get("containerBgColor") || DEFAULT_CONFIG.containerBackgroundColor,
		textColor: params.get("textColor") || DEFAULT_CONFIG.textColor,
		fontScale: parseScale(params.get("fontScale"), DEFAULT_CONFIG.fontScale),
		bannerScale: parseScale(params.get("bannerScale"), DEFAULT_CONFIG.bannerScale),
	};
}

type ItemStatus = "entering" | "visible" | "leaving";
interface DisplayItem {
	song: BroadcastSongEntry;
	status: ItemStatus;
}

// Manages the visible list's enter/leave crossfade. Kept dependency-free
// (no transition library) -- a song freshly pushed onto the top of the
// broadcasted list mounts as "entering" (opacity 0, offset), flips to
// "visible" on the next frame so the CSS transition actually animates,
// and a song that fell off the configured `count` gets marked "leaving"
// (fades out in place) and is only actually removed from state after
// `fadeMs`, rather than vanishing instantly.
function useSongTicker(recentSongs: BroadcastSongEntry[], count: number, fadeMs: number) {
	const [items, setItems] = useState<DisplayItem[]>([]);
	const timeoutsRef = useRef<Map<number, number>>(new Map());

	useEffect(() => {
		const nextTop = recentSongs.slice(0, count);
		const nextKeys = new Set(nextTop.map((s) => s.startTime));

		setItems((prev) => {
			const stillHere = prev.map((it) =>
				it.status !== "leaving" && !nextKeys.has(it.song.startTime) ? { ...it, status: "leaving" as const } : it,
			);
			const existingKeys = new Set(stillHere.map((it) => it.song.startTime));
			const entering: DisplayItem[] = nextTop
				.filter((s) => !existingKeys.has(s.startTime))
				.map((s) => ({ song: s, status: "entering" as const }));
			return [...entering, ...stillHere];
		});
	}, [recentSongs, count]);

	// Flip "entering" -> "visible" one frame after mount, so the CSS
	// transition has a starting state to animate away from.
	useEffect(() => {
		if (!items.some((it) => it.status === "entering")) return;
		const id = requestAnimationFrame(() => {
			setItems((prev) => prev.map((it) => (it.status === "entering" ? { ...it, status: "visible" } : it)));
		});
		return () => cancelAnimationFrame(id);
	}, [items]);

	// Actually drop "leaving" items after the fade finishes.
	useEffect(() => {
		for (const it of items) {
			if (it.status === "leaving" && !timeoutsRef.current.has(it.song.startTime)) {
				const id = window.setTimeout(() => {
					setItems((prev) => prev.filter((p) => p.song.startTime !== it.song.startTime));
					timeoutsRef.current.delete(it.song.startTime);
				}, fadeMs);
				timeoutsRef.current.set(it.song.startTime, id);
			}
		}
	}, [items, fadeMs]);

	useEffect(() => {
		const timeouts = timeoutsRef.current;
		return () => {
			for (const id of timeouts.values()) window.clearTimeout(id);
		};
	}, []);

	return items;
}

function SongTickerRow({ item, config }: { item: DisplayItem; config: SongTickerConfig }) {
	const { song, status } = item;
	const { label: gradeLabel, className: gradeClassName } = gradeDisplay(song.grade, song.passed, song.score);
	const rateLabel = formatRate(song.rate);

	const transformOffset = status === "leaving" ? "translateY(6px)" : status === "entering" ? "translateY(-10px)" : "translateY(0)";

	// Everything below is sized in px from BASE_SIZES * config.fontScale (or
	// bannerScale for the banner image) rather than fixed Tailwind classes,
	// so the sliders in the config page actually change the rendered size.
	const fs = config.fontScale;
	const bs = config.bannerScale;

	return (
		<div
			className="flex items-center overflow-hidden self-start w-fit max-w-full"
			style={{
				gap: BASE_SIZES.rowGap * fs,
				borderRadius: BASE_SIZES.borderRadius * fs,
				paddingLeft: BASE_SIZES.rowPaddingX * fs,
				paddingRight: BASE_SIZES.rowPaddingX * fs,
				paddingTop: BASE_SIZES.rowPaddingY * fs,
				paddingBottom: BASE_SIZES.rowPaddingY * fs,
				backgroundColor: config.containerBackgroundColor,
				color: config.textColor,
				opacity: status === "visible" ? 1 : 0,
				transform: transformOffset,
				transition: `opacity ${config.fadeMs}ms ease, transform ${config.fadeMs}ms ease`,
			}}
		>
			{config.showBanner &&
				(song.bannerUrl ? (
					<img
						src={song.bannerUrl}
						alt=""
						className="rounded object-contain shrink-0 bg-black/30"
						style={{ width: BASE_BANNER.width * bs, height: BASE_BANNER.height * bs }}
					/>
				) : (
					<div className="rounded shrink-0 bg-black/30" style={{ width: BASE_BANNER.width * bs, height: BASE_BANNER.height * bs }} />
				))}

			<div className="min-w-0 flex-1">
				<div className="font-semibold leading-tight truncate" style={{ fontSize: BASE_SIZES.title * fs }}>
					{song.title}
				</div>
				<div className="opacity-70 leading-tight truncate" style={{ fontSize: BASE_SIZES.artist * fs }}>
					{song.artist}
				</div>
				<div className="flex items-center gap-1 mt-0.5">
					<span
						className="inline-block px-1 py-px font-bold rounded bg-red-600 text-white"
						style={{ fontSize: BASE_SIZES.badge * fs }}
					>
						{difficultyBadge(song.style, song.difficultyName, song.difficulty)}
					</span>
					{rateLabel && (
						<span
							className="inline-block px-1 py-px font-bold rounded bg-violet-600 text-white"
							style={{ fontSize: BASE_SIZES.badge * fs }}
						>
							{rateLabel}
						</span>
					)}
				</div>
			</div>

			{config.showGrade && (
				<div className="flex flex-col items-center gap-px shrink-0">
					<span
						className={`inline-flex items-center justify-center px-1 py-px rounded font-bold tabular-nums ${gradeClassName}`}
						style={{ fontSize: BASE_SIZES.gradeLabel * fs, minWidth: 28 * fs }}
					>
						{gradeLabel}
					</span>
					{song.score && (
						<span className="opacity-70 tabular-nums" style={{ fontSize: BASE_SIZES.gradeScore * fs }}>
							{song.score}%
						</span>
					)}
				</div>
			)}

			{config.showStats && (
				<div className="flex items-center shrink-0" style={{ gap: 6 * fs, fontSize: BASE_SIZES.statsLabel * fs }}>
					<div className="text-center">
						<div className="opacity-60 uppercase tracking-wide">HR</div>
						<div className="tabular-nums" style={{ fontSize: BASE_SIZES.statsValue * fs }}>
							{song.avgHr ?? "—"}
						</div>
					</div>
					<div className="text-center">
						<div className="opacity-60 uppercase tracking-wide">Max</div>
						<div className="tabular-nums" style={{ fontSize: BASE_SIZES.statsValue * fs }}>
							{song.maxHr ?? "—"}
						</div>
					</div>
					<div className="text-center">
						<div className="opacity-60 uppercase tracking-wide">Cal</div>
						<div className="tabular-nums" style={{ fontSize: BASE_SIZES.statsValue * fs }}>
							{song.calories ?? "—"}
						</div>
					</div>
					<div className="text-center">
						<div className="opacity-60 uppercase tracking-wide">Time</div>
						<div className="tabular-nums" style={{ fontSize: BASE_SIZES.statsValue * fs }}>
							{formatDuration(song.durationSeconds)}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function SongTickerOBSComponent() {
	const pwd = getQueryPassword();
	const config = parseQueryConfig();
	const { connect, addCustomEventListener, isConnected, isConnecting, error } = useOBS();
	const [recentSongs, setRecentSongs] = useState<BroadcastSongEntry[]>([]);

	useEffect(() => {
		if (!pwd) return;
		void connect(pwd);
	}, [pwd]);

	useEffect(() => {
		const unmount = addCustomEventListener((eventData) => {
			try {
				const payload = (eventData || {}) as ObsPayload;
				if (!Array.isArray(payload.recentSongs)) return;
				setRecentSongs(payload.recentSongs);
			} catch {
				// ignore malformed events
			}
		});
		return unmount;
	}, [addCustomEventListener]);

	const items = useSongTicker(recentSongs, config.count, config.fadeMs);

	if (!isConnected && !isConnecting) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-transparent overflow-hidden">
				<div className="px-6 py-4 rounded-lg border bg-white/70 text-gray-900 shadow-sm">
					<h1 className="text-lg font-semibold">WebFSR OBS Song Ticker</h1>
					<p className="text-sm text-gray-700">Status: {isConnecting ? "Connecting…" : isConnected ? "Connected" : "Disconnected"}</p>
					{error && <p className="text-sm text-red-600">{error}</p>}
					{!pwd && <p className="text-sm text-amber-600">No password provided in URL</p>}
				</div>
			</div>
		);
	}

	return (
		<div className="h-screen w-screen overflow-hidden bg-transparent p-1.5 flex flex-col items-start gap-1.5 justify-end">
			{items.map((item) => (
				<SongTickerRow key={item.song.startTime} item={item} config={config} />
			))}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<SongTickerOBSComponent />
	</StrictMode>,
);
