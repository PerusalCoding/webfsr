import { Flame, Heart } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

// "classic" is the existing lucide Heart/Flame glyph; "pixel" is a retro
// 8-bit-style blocky glyph built from PIXEL_GLYPH bitmaps below; the named
// keys are the bundled preset images (see HEART_IMAGE_PRESETS); "custom" is
// a user-supplied image URL, passed in via customHeartImageUrl. Presets and
// "custom" render as an <img>, not currentColor, so heartColor/zone
// coloring only affects "classic" and "pixel".
export type HeartImagePresetKey = "canada" | "dragon" | "halloweenHeart" | "halloweenBat" | "flatHeart" | "jokr" | "retro" | "usa";
export type HeartIconStyle = "classic" | "pixel" | HeartImagePresetKey | "custom";
export type CalorieIconStyle = "flame" | "pixel";

// Bundled image assets -- copy the files from the "hearts" output folder
// into this project's public/hearts/ directory. Only the filename is
// stored here; the base path is supplied by heartImageBaseUrl since it
// differs by caller: the OBS overlay page (heartrate.tsx) is served over
// http://127.0.0.1:<port>/, where a root-relative "/hearts/..." path
// resolves correctly -- but the live preview in OBSComponentDialog.tsx is
// part of the main app bundle, loaded via file:///.../dist/index.html
// with a relative Vite base ("./"), where a leading-slash path resolves
// to the OS filesystem root instead of dist/, and 404s silently.
export const HEART_IMAGE_PRESETS: Record<HeartImagePresetKey, { label: string; file: string }> = {
	canada: { label: "Canada", file: "canada.png" },
	dragon: { label: "Dragon", file: "dragon.png" },
	halloweenHeart: { label: "Halloween Heart", file: "halloween-heart.png" },
	halloweenBat: { label: "Halloween Bat", file: "halloween-bat.png" },
	flatHeart: { label: "Flat Heart", file: "flat-heart.png" },
	jokr: { label: "Joker", file: "jokr.png" },
	retro: { label: "Retro", file: "retro.png" },
	usa: { label: "USA", file: "usa.png" },
};

type HeartrateCurrentDisplayProps = {
	heartrate: number | null;
	animateHeartbeat: boolean;
	showBpmText: boolean;
	isLive: boolean;
	statusText?: string;
	showHeartVisual?: boolean;
	showBorder?: boolean;
	containerBackgroundColor?: string;
	heartColor?: string;
	heartBackgroundColor?: string;
	textColor?: string;
	showCalories?: boolean;
	calories?: number | null;
	calorieGoal?: number | null;
	goalReached?: boolean;
	zoneColorsEnabled?: boolean;
	zoneLowMax?: number;
	zoneMidMax?: number;
	zoneLowColor?: string;
	zoneMidColor?: string;
	zoneHighColor?: string;
	bpmFontSize?: number;
	caloriesFontSize?: number;
	// Icon size + style are independent: size controls how big the glyph
	// renders (heartIconSize also scales the round shell behind it,
	// proportionally to the original 84px icon / 160px shell ratio, so
	// resizing doesn't leave a mismatched shell), style picks the glyph.
	heartIconSize?: number;
	heartIconStyle?: HeartIconStyle;
	// Only used when heartIconStyle === "custom" -- any publicly reachable
	// image URL (e.g. a Supabase Storage public URL from the upload flow
	// in OBSComponentDialog.tsx). Falls back to the classic heart if unset.
	customHeartImageUrl?: string | null;
	// Base path prepended to each preset's filename (see HEART_IMAGE_PRESETS
	// above for why this can't be hardcoded into the preset map itself).
	// Defaults to "../../hearts" -- a relative path, not absolute -- since
	// heartrate.tsx (obs/heartrate/index.html) is served in two different
	// contexts that need the same two-levels-up relative path to reach
	// hearts/ correctly: a plain static web host serving the real on-disk
	// nesting (obs/heartrate/ -> up 2 -> hearts/), and Electron's local
	// server, which flattens everything to look like it's served from
	// /heartrate/ directly -- browsers clamp excess "../" at the root
	// rather than erroring, so the same "../../hearts" still lands on
	// /hearts/ there too. OBSComponentDialog.tsx's live preview overrides
	// this to a Vite-base-relative path instead, since it's loaded via
	// file:// as part of the main app bundle, not either of the above.
	heartImageBaseUrl?: string;
	calorieIconStyle?: CalorieIconStyle;
};

export interface HeartrateSample {
	heartrate: number;
	timestamp: number;
}

export type HeartrateHistoryAxisSide = "left" | "right";

type HeartrateHistoryGraphProps = {
	samples: HeartrateSample[];
	timeWindowSeconds: number;
	emptyMessage?: string;
	showBorder?: boolean;
	gradientTopColor?: string;
	gradientBottomColor?: string;
	lineColor?: string;
	smoothLine?: boolean;
	showAxisText?: boolean;
	axisLabelSide?: HeartrateHistoryAxisSide;
	axisTextColor?: string;
	axisTextGap?: number;
};

const HEARTBEAT_STYLE_ID = "heartrate-obs-animation";
const GOAL_PULSE_STYLE_ID = "heartrate-obs-goal-pulse-animation";
const DEFAULT_ZONE_LOW_MAX = 120;
const DEFAULT_ZONE_MID_MAX = 160;
const DEFAULT_ZONE_LOW_COLOR = "rgba(96, 165, 250, 1)"; // blue
const DEFAULT_ZONE_MID_COLOR = "rgba(250, 204, 21, 1)"; // yellow
const DEFAULT_ZONE_HIGH_COLOR = "rgba(239, 68, 68, 1)"; // red
const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 320;
const MIN_RENDER_POINTS = 56;
const MAX_RENDER_POINTS = 180;
const DEFAULT_HEARTRATE_BORDER_COLOR = "rgba(255, 255, 255, 0.12)";
const DEFAULT_CURRENT_DISPLAY_BACKGROUND_COLOR = "rgba(0, 0, 0, 0.35)";
const DEFAULT_HEART_COLOR = "rgba(239, 68, 68, 1)";
const DEFAULT_HEART_BACKGROUND_COLOR = "rgba(239, 68, 68, 0.12)";
const DEFAULT_TEXT_COLOR = "rgba(255, 255, 255, 1)";
const DEFAULT_HISTORY_GRADIENT_TOP_COLOR = "rgba(248, 113, 113, 0.35)";
const DEFAULT_HISTORY_GRADIENT_BOTTOM_COLOR = "rgba(248, 113, 113, 0)";
const DEFAULT_HISTORY_LINE_COLOR = "rgba(248, 113, 113, 1)";
const DEFAULT_HISTORY_AXIS_TEXT_COLOR = "rgba(255, 255, 255, 0.72)";
const DEFAULT_HISTORY_AXIS_SIDE: HeartrateHistoryAxisSide = "right";
const DEFAULT_HISTORY_AXIS_TEXT_GAP = 30;
const AXIS_LABEL_EDGE_INSET_Y = 16;
const CURRENT_DISPLAY_PADDING = 28;
const CURRENT_DISPLAY_RADIUS = 36;
const CURRENT_DISPLAY_CONTENT_GAP = 28;
const CURRENT_DISPLAY_SECTION_GAP = 26;
const CURRENT_DISPLAY_HEART_SHELL_SIZE = 160;
const CURRENT_DISPLAY_HEART_ICON_SIZE = 84;
// Keeps the round shell in proportion to the heart glyph as heartIconSize
// changes, instead of the shell staying fixed while only the glyph resizes.
const HEART_SHELL_TO_ICON_RATIO = CURRENT_DISPLAY_HEART_SHELL_SIZE / CURRENT_DISPLAY_HEART_ICON_SIZE;
const DEFAULT_BPM_FONT_SIZE = 220;
const CURRENT_DISPLAY_BPM_LABEL_FONT_SIZE = 24;
const CURRENT_DISPLAY_STATUS_FONT_SIZE = 22;
const DEFAULT_CALORIES_FONT_SIZE = 24;
const CALORIES_ICON_TO_FONT_RATIO = 22 / 24; // keeps the flame in proportion as the font size changes
const CURRENT_DISPLAY_GOAL_BAR_WIDTH = 160;
const CURRENT_DISPLAY_GOAL_BAR_HEIGHT = 6;
const CURRENT_DISPLAY_GOAL_TEXT_FONT_SIZE = 13;
const CURRENT_DISPLAY_STATUS_MAX_WIDTH = 680;
const CURRENT_DISPLAY_BPM_PLACEHOLDER = "888";

// Retro 8-bit-style bitmaps -- 1 = filled pixel, 0 = empty. Rendered as a
// grid of <rect> with shape-rendering="crispEdges" so scaling stays
// blocky/pixelated instead of getting smoothed like a normal SVG path
// would. Chosen to read clearly at small sizes (matches the readability
// bar of the lucide glyphs they're standing in for).
const HEART_PIXEL_BITMAP: number[][] = [
	[0, 1, 1, 0, 0, 1, 1, 0],
	[1, 1, 1, 1, 1, 1, 1, 1],
	[1, 1, 1, 1, 1, 1, 1, 1],
	[1, 1, 1, 1, 1, 1, 1, 1],
	[0, 1, 1, 1, 1, 1, 1, 0],
	[0, 0, 1, 1, 1, 1, 0, 0],
	[0, 0, 0, 1, 1, 0, 0, 0],
];

const FLAME_PIXEL_BITMAP: number[][] = [
	[0, 0, 0, 1, 1, 0, 0, 0],
	[0, 0, 1, 1, 1, 1, 0, 0],
	[0, 1, 1, 0, 0, 1, 1, 0],
	[0, 1, 1, 1, 1, 1, 1, 0],
	[1, 1, 0, 1, 1, 0, 1, 1],
	[1, 1, 1, 1, 1, 1, 1, 1],
	[0, 1, 1, 1, 1, 1, 1, 0],
	[0, 0, 1, 1, 1, 1, 0, 0],
	[0, 0, 0, 1, 1, 0, 0, 0],
];

// `size` sets the glyph's width, same meaning as the `height`/`width`
// style already used for the lucide Heart/Flame icons elsewhere in this
// file -- height is derived from the bitmap's own aspect ratio so the
// pixels stay square instead of being stretched.
function PixelGlyph({ bitmap, size }: { bitmap: number[][]; size: number }) {
	const cols = bitmap[0]?.length ?? 1;
	const rows = bitmap.length;
	const height = Math.round(size * (rows / cols));

	return (
		<svg
			width={size}
			height={height}
			viewBox={`0 0 ${cols} ${rows}`}
			shapeRendering="crispEdges"
			style={{ display: "block" }}
			aria-hidden
		>
			{bitmap.map((row, y) =>
				row.map((filled, x) => (filled ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill="currentColor" /> : null)),
			)}
		</svg>
	);
}

function buildSmoothedSamples(samples: HeartrateSample[], startTime: number, endTime: number): HeartrateSample[] {
	if (samples.length === 0) return [];
	if (samples.length === 1) return [{ heartrate: samples[0].heartrate, timestamp: samples[0].timestamp }];

	const duration = Math.max(1, endTime - startTime);
	const pointCount = Math.min(MAX_RENDER_POINTS, Math.max(MIN_RENDER_POINTS, Math.round(duration / 500)));
	const sigma = Math.min(5000, Math.max(500, duration * 0.05));
	const smoothed: HeartrateSample[] = [];
	let previousValue = samples[0].heartrate;
	const blend = Math.min(0.82, Math.max(0.35, duration / 30000));

	for (let index = 0; index < pointCount; index++) {
		const progress = pointCount === 1 ? 1 : index / (pointCount - 1);
		const timestamp = startTime + progress * duration;
		let weightedTotal = 0;
		let totalWeight = 0;

		for (const sample of samples) {
			const distance = sample.timestamp - timestamp;
			if (distance > 0 || Math.abs(distance) > sigma * 3) continue;

			const weight = Math.exp(-0.5 * (distance / sigma) ** 2);
			weightedTotal += sample.heartrate * weight;
			totalWeight += weight;
		}

		const nearestSample = samples.reduce((closest, sample) => {
			if (sample.timestamp > timestamp) return closest;
			const closestDistance = Math.abs(closest.timestamp - timestamp);
			const sampleDistance = Math.abs(sample.timestamp - timestamp);
			return sampleDistance < closestDistance ? sample : closest;
		}, samples[0]);

		const rawValue = totalWeight > 0 ? weightedTotal / totalWeight : nearestSample.heartrate;
		const easedValue = index === 0 ? rawValue : previousValue * blend + rawValue * (1 - blend);
		previousValue = easedValue;

		smoothed.push({
			heartrate: easedValue,
			timestamp,
		});
	}

	return smoothed;
}

function useScaleToFit() {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const [scale, setScale] = useState(1);

	useLayoutEffect(() => {
		const container = containerRef.current;
		const content = contentRef.current;
		if (!container || !content) return;

		let frameId = 0;
		const updateScale = () => {
			cancelAnimationFrame(frameId);
			frameId = window.requestAnimationFrame(() => {
				const containerWidth = container.clientWidth;
				const containerHeight = container.clientHeight;
				const contentWidth = content.offsetWidth;
				const contentHeight = content.offsetHeight;

				if (containerWidth <= 0 || containerHeight <= 0 || contentWidth <= 0 || contentHeight <= 0) {
					setScale(1);
					return;
				}

				const nextScale = Math.min(containerWidth / contentWidth, containerHeight / contentHeight);
				setScale((previousScale) => (Math.abs(previousScale - nextScale) < 0.001 ? previousScale : nextScale));
			});
		};

		updateScale();
		if (typeof ResizeObserver === "undefined") {
			return () => {
				cancelAnimationFrame(frameId);
			};
		}

		const resizeObserver = new ResizeObserver(updateScale);

		resizeObserver.observe(container);
		resizeObserver.observe(content);

		return () => {
			cancelAnimationFrame(frameId);
			resizeObserver.disconnect();
		};
	}, []);

	return {
		containerRef,
		contentRef,
		scale,
	};
}

export function HeartrateCurrentDisplay({
	heartrate,
	animateHeartbeat,
	showBpmText,
	isLive,
	statusText,
	showHeartVisual = true,
	showBorder = false,
	containerBackgroundColor = DEFAULT_CURRENT_DISPLAY_BACKGROUND_COLOR,
	heartColor = DEFAULT_HEART_COLOR,
	heartBackgroundColor = DEFAULT_HEART_BACKGROUND_COLOR,
	textColor = DEFAULT_TEXT_COLOR,
	showCalories = false,
	calories = null,
	calorieGoal = null,
	goalReached = false,
	zoneColorsEnabled = false,
	zoneLowMax = DEFAULT_ZONE_LOW_MAX,
	zoneMidMax = DEFAULT_ZONE_MID_MAX,
	zoneLowColor = DEFAULT_ZONE_LOW_COLOR,
	zoneMidColor = DEFAULT_ZONE_MID_COLOR,
	zoneHighColor = DEFAULT_ZONE_HIGH_COLOR,
	bpmFontSize = DEFAULT_BPM_FONT_SIZE,
	caloriesFontSize = DEFAULT_CALORIES_FONT_SIZE,
	heartIconSize = CURRENT_DISPLAY_HEART_ICON_SIZE,
	heartIconStyle = "classic",
	customHeartImageUrl = null,
	heartImageBaseUrl = "../../hearts",
	calorieIconStyle = "flame",
}: HeartrateCurrentDisplayProps) {
	const heartShellSize = Math.round(heartIconSize * HEART_SHELL_TO_ICON_RATIO);
	const heartImageSrc =
		heartIconStyle === "custom"
			? customHeartImageUrl
			: heartIconStyle in HEART_IMAGE_PRESETS
				? `${heartImageBaseUrl.replace(/\/$/, "")}/${HEART_IMAGE_PRESETS[heartIconStyle as HeartImagePresetKey].file}`
				: null;
	// Zone coloring only overrides the heart icon and the big BPM number --
	// the "BPM" label and status text underneath stay on textColor, so the
	// display doesn't lose overall legibility/theme consistency just
	// because the wearer's heart rate crossed a threshold.
	const activeHeartColor =
		zoneColorsEnabled && heartrate != null
			? heartrate < zoneLowMax
				? zoneLowColor
				: heartrate < zoneMidMax
					? zoneMidColor
					: zoneHighColor
			: heartColor;
	const caloriesIconSize = Math.round(caloriesFontSize * CALORIES_ICON_TO_FONT_RATIO);
	const animationDuration =
		!heartrate || !animateHeartbeat
			? undefined
			: {
					animation: `heartbeat ${Math.max(300, (60 / heartrate) * 1000)}ms ease-in-out infinite`,
				};
	const { containerRef, contentRef, scale } = useScaleToFit();

	useEffect(() => {
		if (document.getElementById(HEARTBEAT_STYLE_ID)) return;

		const style = document.createElement("style");
		style.id = HEARTBEAT_STYLE_ID;
		style.textContent = `
			@keyframes heartbeat {
				0%, 100% { transform: scale(1); }
				15% { transform: scale(1.14); }
				30% { transform: scale(1); }
				45% { transform: scale(1.1); }
				60% { transform: scale(1); }
			}
		`;
		document.head.appendChild(style);
	}, []);

	// One-time celebration when a calorie goal is crossed -- a gold glow
	// pulse around the whole card, distinct from the heartbeat animation
	// above (which is continuous and heart-rate-driven, not an event).
	// heartrate.tsx owns the actual crossing detection/timing; this
	// component just renders whatever `goalReached` it's handed.
	useEffect(() => {
		if (document.getElementById(GOAL_PULSE_STYLE_ID)) return;

		const style = document.createElement("style");
		style.id = GOAL_PULSE_STYLE_ID;
		style.textContent = `
			@keyframes goalPulse {
				0% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0.7); transform: scale(1); }
				30% { box-shadow: 0 0 0 18px rgba(250, 204, 21, 0); transform: scale(1.04); }
				60% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0); transform: scale(1); }
				100% { box-shadow: 0 0 0 0 rgba(250, 204, 21, 0); transform: scale(1); }
			}
		`;
		document.head.appendChild(style);
	}, []);

	return (
		<div ref={containerRef} className="flex h-full w-full items-center justify-center overflow-hidden">
			<div
				ref={contentRef}
				className="inline-flex flex-col justify-center shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-md"
				style={{
					backgroundColor: containerBackgroundColor,
					border: showBorder ? `1px solid ${DEFAULT_HEARTRATE_BORDER_COLOR}` : "none",
					borderRadius: CURRENT_DISPLAY_RADIUS,
					padding: CURRENT_DISPLAY_PADDING,
					transform: `scale(${scale})`,
					transformOrigin: "center center",
					animation: goalReached ? "goalPulse 1.6s ease-out 2" : undefined,
				}}
			>
				<div className="flex flex-1 flex-col items-center justify-center text-center" style={{ gap: CURRENT_DISPLAY_SECTION_GAP }}>
					<div className="flex items-center justify-center" style={{ gap: showHeartVisual ? CURRENT_DISPLAY_CONTENT_GAP : 0 }}>
						{showHeartVisual ? (
							<div
								className="flex shrink-0 items-center justify-center rounded-full"
								style={{
									backgroundColor: heartImageSrc
										? "transparent"
										: zoneColorsEnabled
											? `${activeHeartColor.replace(/[\d.]+\)$/, "0.12)")}`
											: heartBackgroundColor,
									height: heartShellSize,
									width: heartShellSize,
									transition: zoneColorsEnabled ? "background-color 400ms ease" : undefined,
								}}
							>
								<div
									style={{
										...animationDuration,
										color: activeHeartColor,
										opacity: isLive ? 1 : 0.45,
										transition: zoneColorsEnabled ? "color 400ms ease" : undefined,
									}}
								>
									{heartImageSrc ? (
										<img src={heartImageSrc} alt="" style={{ width: heartIconSize, height: "auto", display: "block" }} />
									) : heartIconStyle === "pixel" ? (
										<PixelGlyph bitmap={HEART_PIXEL_BITMAP} size={heartIconSize} />
									) : (
										<Heart fill="currentColor" style={{ height: heartIconSize, width: heartIconSize }} />
									)}
								</div>
							</div>
						) : null}
						<div style={{ color: textColor }}>
							<div className="grid place-items-center">
								<span
									aria-hidden
									className="invisible row-start-1 col-start-1 font-semibold leading-none tracking-tight tabular-nums"
									style={{ fontSize: bpmFontSize }}
								>
									{CURRENT_DISPLAY_BPM_PLACEHOLDER}
								</span>
								<div
									className="row-start-1 col-start-1 text-center font-semibold leading-none tracking-tight tabular-nums"
									style={{
										fontSize: bpmFontSize,
										color: zoneColorsEnabled ? activeHeartColor : textColor,
										transition: zoneColorsEnabled ? "color 400ms ease" : undefined,
									}}
								>
									{heartrate ?? "--"}
								</div>
							</div>
							{showBpmText && (
								<div
									className="mt-2 font-medium uppercase tracking-[0.28em]"
									style={{ fontSize: CURRENT_DISPLAY_BPM_LABEL_FONT_SIZE, opacity: 0.68 }}
								>
									BPM
								</div>
							)}
						</div>
					</div>
					{showCalories && calories != null && (
						<div className="flex flex-col items-center gap-1.5">
							<div className="flex items-center justify-center gap-2" style={{ color: textColor, opacity: 0.8 }}>
								{calorieIconStyle === "pixel" ? (
									<PixelGlyph bitmap={FLAME_PIXEL_BITMAP} size={caloriesIconSize} />
								) : (
									<Flame fill="currentColor" style={{ height: caloriesIconSize, width: caloriesIconSize }} />
								)}
								<span className="font-semibold tabular-nums" style={{ fontSize: caloriesFontSize }}>
									{calories}{calorieGoal != null && calorieGoal > 0 ? ` / ${calorieGoal}` : ""} kcal
								</span>
							</div>
							{calorieGoal != null && calorieGoal > 0 && (
								<div
									className="overflow-hidden rounded-full"
									style={{
										width: CURRENT_DISPLAY_GOAL_BAR_WIDTH,
										height: CURRENT_DISPLAY_GOAL_BAR_HEIGHT,
										backgroundColor: `${textColor.replace(/[\d.]+\)$/, "0.18)")}`,
									}}
								>
									<div
										className="h-full rounded-full"
										style={{
											width: `${Math.max(0, Math.min(100, (calories / calorieGoal) * 100))}%`,
											backgroundColor: calories >= calorieGoal ? "rgba(250, 204, 21, 1)" : activeHeartColor,
											transition: "width 500ms ease, background-color 400ms ease",
										}}
									/>
								</div>
							)}
						</div>
					)}
					{statusText && (
						<p
							className="text-balance"
							style={{
								color: textColor,
								fontSize: CURRENT_DISPLAY_STATUS_FONT_SIZE,
								maxWidth: CURRENT_DISPLAY_STATUS_MAX_WIDTH,
								opacity: 0.68,
							}}
						>
							{statusText}
						</p>
					)}
				</div>
			</div>
		</div>
	);
}

export function HeartrateHistoryGraph({
	samples,
	timeWindowSeconds,
	emptyMessage = "Waiting for heartrate data...",
	showBorder = false,
	gradientTopColor = DEFAULT_HISTORY_GRADIENT_TOP_COLOR,
	gradientBottomColor = DEFAULT_HISTORY_GRADIENT_BOTTOM_COLOR,
	lineColor = DEFAULT_HISTORY_LINE_COLOR,
	smoothLine = true,
	showAxisText = true,
	axisLabelSide = DEFAULT_HISTORY_AXIS_SIDE,
	axisTextColor = DEFAULT_HISTORY_AXIS_TEXT_COLOR,
	axisTextGap = DEFAULT_HISTORY_AXIS_TEXT_GAP,
}: HeartrateHistoryGraphProps) {
	const gradientId = useId();
	const timeWindowMs = Math.max(1000, timeWindowSeconds * 1000);
	const latestIncomingSample = samples.length > 0 ? samples[samples.length - 1] : null;
	const [currentTime, setCurrentTime] = useState(() => Date.now());
	const [lockedBounds, setLockedBounds] = useState<{ min: number; max: number } | null>(null);

	useEffect(() => {
		setCurrentTime(Date.now());
		if (!latestIncomingSample) return;

		const intervalId = window.setInterval(() => {
			setCurrentTime(Date.now());
		}, 250);

		return () => window.clearInterval(intervalId);
	}, [latestIncomingSample?.timestamp]);

	useEffect(() => {
		setLockedBounds(null);
	}, [timeWindowMs]);

	const cutoffTime = currentTime - timeWindowMs;
	const visibleSamples = samples.filter((sample) => sample.timestamp >= cutoffTime);
	let stableBounds: { min: number; max: number } | null = null;
	let chartPoints: Array<{ x: number; y: number }> = [];
	const resolvedAxisTextGap = Math.max(0, axisTextGap);
	const axisGutter = showAxisText ? resolvedAxisTextGap : 0;
	const chartStartX = axisLabelSide === "left" ? axisGutter : 0;
	const chartEndX = axisLabelSide === "right" ? GRAPH_WIDTH - axisGutter : GRAPH_WIDTH;
	const innerWidth = Math.max(1, chartEndX - chartStartX);
	const innerHeight = GRAPH_HEIGHT;

	if (visibleSamples.length > 0) {
		let sampleBeforeWindow: HeartrateSample | null = null;
		for (let index = samples.length - 1; index >= 0; index--) {
			if (samples[index].timestamp < cutoffTime) {
				sampleBeforeWindow = samples[index];
				break;
			}
		}

		const windowSamples =
			sampleBeforeWindow && visibleSamples[0].timestamp > cutoffTime
				? [
						{
							heartrate:
								visibleSamples[0].timestamp === sampleBeforeWindow.timestamp
									? visibleSamples[0].heartrate
									: sampleBeforeWindow.heartrate +
										((visibleSamples[0].heartrate - sampleBeforeWindow.heartrate) * (cutoffTime - sampleBeforeWindow.timestamp)) /
											(visibleSamples[0].timestamp - sampleBeforeWindow.timestamp),
							timestamp: cutoffTime,
						},
						...visibleSamples,
					]
				: visibleSamples;

		const firstSampleTime = windowSamples[0].timestamp;
		const renderStartTime = Math.max(cutoffTime, firstSampleTime);
		const renderedSamples = smoothLine
			? buildSmoothedSamples(windowSamples, renderStartTime, currentTime)
			: windowSamples.map((sample) => ({
					heartrate: sample.heartrate,
					timestamp: Math.max(renderStartTime, sample.timestamp),
				}));
		const values = renderedSamples.map((sample) => sample.heartrate);
		const rawMin = Math.min(...values);
		const rawMax = Math.max(...values);
		const yPadding = Math.max(6, Math.round((rawMax - rawMin || 12) * 0.25));
		const nextBounds = {
			min: Math.max(35, rawMin - yPadding),
			max: Math.min(220, rawMax + yPadding),
		};
		stableBounds = lockedBounds
			? {
					min: Math.min(lockedBounds.min, nextBounds.min),
					max: Math.max(lockedBounds.max, nextBounds.max),
				}
			: nextBounds;
		const activeBounds = stableBounds;

		const valueRange = Math.max(1, activeBounds.max - activeBounds.min);
		chartPoints = renderedSamples.map((sample) => {
			const x = chartStartX + ((sample.timestamp - cutoffTime) / Math.max(1, timeWindowMs)) * innerWidth;
			const normalized = (sample.heartrate - activeBounds.min) / valueRange;
			const y = GRAPH_HEIGHT - normalized * innerHeight;
			return { x, y };
		});
	}

	useEffect(() => {
		if (!stableBounds) return;

		setLockedBounds((prev) => {
			if (!prev) return stableBounds;
			if (prev.min === stableBounds.min && prev.max === stableBounds.max) return prev;
			return stableBounds;
		});
	}, [stableBounds?.max, stableBounds?.min]);

	if (!stableBounds) {
		return (
			<div
				className="flex h-full w-full items-center justify-center rounded-[28px] bg-black/35 p-8 text-center text-white/60 backdrop-blur-md"
				style={{
					border: showBorder ? `1px solid ${DEFAULT_HEARTRATE_BORDER_COLOR}` : "none",
				}}
			>
				{emptyMessage}
			</div>
		);
	}

	const getSmoothLinePath = (points: Array<{ x: number; y: number }>) => {
		if (points.length === 0) return "";
		if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;

		let path = `M ${points[0].x} ${points[0].y}`;
		for (let index = 1; index < points.length - 1; index++) {
			const currentPoint = points[index];
			const nextPoint = points[index + 1];
			const controlX = currentPoint.x;
			const controlY = currentPoint.y;
			const midpointX = (currentPoint.x + nextPoint.x) / 2;
			const midpointY = (currentPoint.y + nextPoint.y) / 2;
			path += ` Q ${controlX} ${controlY}, ${midpointX} ${midpointY}`;
		}

		const penultimatePoint = points[points.length - 2];
		const lastPoint = points[points.length - 1];
		path += ` Q ${penultimatePoint.x} ${penultimatePoint.y}, ${lastPoint.x} ${lastPoint.y}`;
		return path;
	};

	const linePath = getSmoothLinePath(chartPoints);
	const firstPoint = chartPoints[0];
	const lastPoint = chartPoints[chartPoints.length - 1];
	const areaPath = chartPoints.length < 2 ? "" : `${linePath} L ${lastPoint.x} ${GRAPH_HEIGHT} L ${firstPoint.x} ${GRAPH_HEIGHT} Z`;
	const axisLabelX = axisLabelSide === "left" ? 0 : GRAPH_WIDTH;
	const axisLabelAnchor = axisLabelSide === "left" ? "start" : "end";
	const axisLabelTop = Math.round(stableBounds.max).toString();
	const axisLabelBottom = Math.round(stableBounds.min).toString();

	return (
		<div
			className="h-full w-full overflow-hidden rounded-[28px] bg-black/35 text-white shadow-[0_18px_60px_rgba(0,0,0,0.32)] backdrop-blur-md"
			style={{
				border: showBorder ? `1px solid ${DEFAULT_HEARTRATE_BORDER_COLOR}` : "none",
			}}
		>
			<svg viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`} className="block h-full w-full" preserveAspectRatio="none" aria-hidden>
				<defs>
					<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
						<stop offset="0%" stopColor={gradientTopColor} />
						<stop offset="100%" stopColor={gradientBottomColor} />
					</linearGradient>
				</defs>

				{chartPoints.length >= 2 && <path d={areaPath} fill={`url(#${gradientId})`} />}
				{chartPoints.length >= 2 && (
					<path d={linePath} fill="none" stroke={lineColor} strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />
				)}
				{showAxisText ? (
					<>
						<text
							x={axisLabelX}
							y={AXIS_LABEL_EDGE_INSET_Y}
							fill={axisTextColor}
							fontSize="18"
							fontWeight="600"
							letterSpacing="0.04em"
							textAnchor={axisLabelAnchor}
							dominantBaseline="hanging"
						>
							{axisLabelTop}
						</text>
						<text
							x={axisLabelX}
							y={GRAPH_HEIGHT - AXIS_LABEL_EDGE_INSET_Y}
							fill={axisTextColor}
							fontSize="18"
							fontWeight="600"
							letterSpacing="0.04em"
							textAnchor={axisLabelAnchor}
							dominantBaseline="text-after-edge"
						>
							{axisLabelBottom}
						</text>
					</>
				) : null}
			</svg>
		</div>
	);
}
