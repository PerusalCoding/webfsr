import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../index.css";
import {
	HeartrateCurrentDisplay,
	HeartrateHistoryGraph,
	type CalorieIconStyle,
	type HeartIconStyle,
	type HeartrateHistoryAxisSide,
	type HeartrateSample,
} from "~/components/HeartrateDisplay";
import { estimateCalories } from "~/lib/calorieEstimate";
import { useBiometrics } from "~/lib/useBiometrics";
import { type ObsBroadcastPayload, useOBS } from "~/lib/useOBS";

type HeartrateMode = "current" | "graph";

// Mirrors HeartIconStyle from HeartrateDisplay.tsx -- kept as a runtime
// Set (rather than importing a type) so an unrecognized/garbled query
// param value falls back to the default instead of rendering nothing.
const VALID_HEART_ICON_STYLES = new Set([
	"classic",
	"pixel",
	"canada",
	"dragon",
	"halloweenHeart",
	"halloweenBat",
	"flatHeart",
	"jokr",
	"retro",
	"usa",
	"custom",
]);

type HeartrateOBSConfig = {
	mode: HeartrateMode;
	animateHeartbeat: boolean;
	showBpmText: boolean;
	showHeartVisual: boolean;
	showBorder: boolean;
	showCalories: boolean;
	calorieGoal: number | null;
	zoneColorsEnabled: boolean;
	zoneLowMax: number;
	zoneMidMax: number;
	zoneLowColor: string;
	zoneMidColor: string;
	zoneHighColor: string;
	bpmFontSize: number;
	caloriesFontSize: number;
	heartIconSize: number;
	heartIconStyle: HeartIconStyle;
	customHeartImageUrl: string | null;
	calorieIconStyle: CalorieIconStyle;
	timeWindow: number;
	containerBackgroundColor: string;
	heartColor: string;
	heartBackgroundColor: string;
	textColor: string;
	historyGradientTopColor: string;
	historyGradientBottomColor: string;
	historyLineColor: string;
	historySmoothLine: boolean;
	historyShowAxisText: boolean;
	historyAxisLabelSide: HeartrateHistoryAxisSide;
	historyAxisTextColor: string;
	historyAxisTextGap: number;
};

type ObsPayload = ObsBroadcastPayload & {
	eventType?: string;
};

const DEFAULT_CONFIG: HeartrateOBSConfig = {
	mode: "current",
	animateHeartbeat: true,
	showBpmText: true,
	showHeartVisual: true,
	showBorder: false,
	showCalories: false,
	calorieGoal: null,
	zoneColorsEnabled: false,
	zoneLowMax: 120,
	zoneMidMax: 160,
	zoneLowColor: "rgba(96, 165, 250, 1)",
	zoneMidColor: "rgba(250, 204, 21, 1)",
	zoneHighColor: "rgba(239, 68, 68, 1)",
	bpmFontSize: 220,
	caloriesFontSize: 24,
	heartIconSize: 84,
	heartIconStyle: "classic",
	customHeartImageUrl: null,
	calorieIconStyle: "flame",
	timeWindow: 30,
	containerBackgroundColor: "rgba(0, 0, 0, 0.35)",
	heartColor: "rgba(239, 68, 68, 1)",
	heartBackgroundColor: "rgba(239, 68, 68, 0.12)",
	textColor: "rgba(255, 255, 255, 1)",
	historyGradientTopColor: "rgba(248, 113, 113, 0.35)",
	historyGradientBottomColor: "rgba(248, 113, 113, 0)",
	historyLineColor: "rgba(248, 113, 113, 1)",
	historySmoothLine: true,
	historyShowAxisText: true,
	historyAxisLabelSide: "right",
	historyAxisTextColor: "rgba(255, 255, 255, 0.72)",
	historyAxisTextGap: 30,
};

function getHeartrateHistoryRetentionMs(timeWindowSeconds: number) {
	const timeWindowMs = timeWindowSeconds * 1000;
	return timeWindowMs + Math.max(5000, Math.round(timeWindowMs * 0.25));
}

function getQueryPassword() {
	const params = new URLSearchParams(window.location.search);
	return params.get("pwd") || "";
}

function parseQueryConfig(): HeartrateOBSConfig {
	const params = new URLSearchParams(window.location.search);
	const mode = params.get("mode");
	const borderParam = params.get("border");
	const axisSide = params.get("axisSide");

	return {
		mode: mode === "graph" || mode === "historical" ? "graph" : DEFAULT_CONFIG.mode,
		animateHeartbeat: params.get("animateHeartbeat") !== "false",
		showBpmText: params.get("showBpmText") !== "false",
		showHeartVisual: params.get("showHeart") !== "false",
		showBorder: borderParam == null ? DEFAULT_CONFIG.showBorder : borderParam !== "false",
		showCalories: params.get("showCalories") === "true",
		calorieGoal: params.get("calorieGoal") ? Math.max(1, Number(params.get("calorieGoal")) || 0) || null : null,
		zoneColorsEnabled: params.get("zoneColors") === "true",
		zoneLowMax: Number(params.get("zoneLowMax")) || DEFAULT_CONFIG.zoneLowMax,
		zoneMidMax: Number(params.get("zoneMidMax")) || DEFAULT_CONFIG.zoneMidMax,
		zoneLowColor: params.get("zoneLowColor") || DEFAULT_CONFIG.zoneLowColor,
		zoneMidColor: params.get("zoneMidColor") || DEFAULT_CONFIG.zoneMidColor,
		zoneHighColor: params.get("zoneHighColor") || DEFAULT_CONFIG.zoneHighColor,
		bpmFontSize: Math.max(40, Math.min(400, Number(params.get("bpmSize")) || DEFAULT_CONFIG.bpmFontSize)),
		caloriesFontSize: Math.max(10, Math.min(120, Number(params.get("caloriesSize")) || DEFAULT_CONFIG.caloriesFontSize)),
		heartIconSize: Math.max(24, Math.min(400, Number(params.get("heartSize")) || DEFAULT_CONFIG.heartIconSize)),
		heartIconStyle: (VALID_HEART_ICON_STYLES.has(params.get("heartStyle") ?? "") ? (params.get("heartStyle") as HeartIconStyle) : DEFAULT_CONFIG.heartIconStyle),
		customHeartImageUrl: params.get("heartImage") || DEFAULT_CONFIG.customHeartImageUrl,
		calorieIconStyle: params.get("calorieIcon") === "pixel" ? "pixel" : DEFAULT_CONFIG.calorieIconStyle,
		timeWindow: Number(params.get("window")) || DEFAULT_CONFIG.timeWindow,
		containerBackgroundColor: params.get("containerBgColor") || DEFAULT_CONFIG.containerBackgroundColor,
		heartColor: params.get("heartColor") || DEFAULT_CONFIG.heartColor,
		heartBackgroundColor: params.get("heartBgColor") || DEFAULT_CONFIG.heartBackgroundColor,
		textColor: params.get("textColor") || DEFAULT_CONFIG.textColor,
		historyGradientTopColor: params.get("gradientTopColor") || DEFAULT_CONFIG.historyGradientTopColor,
		historyGradientBottomColor: params.get("gradientBottomColor") || DEFAULT_CONFIG.historyGradientBottomColor,
		historyLineColor: params.get("lineColor") || DEFAULT_CONFIG.historyLineColor,
		historySmoothLine: params.get("smoothLine") == null ? DEFAULT_CONFIG.historySmoothLine : params.get("smoothLine") !== "false",
		historyShowAxisText: params.get("showAxisText") == null ? DEFAULT_CONFIG.historyShowAxisText : params.get("showAxisText") !== "false",
		historyAxisLabelSide: axisSide === "left" || axisSide === "right" ? axisSide : DEFAULT_CONFIG.historyAxisLabelSide,
		historyAxisTextColor: params.get("axisTextColor") || DEFAULT_CONFIG.historyAxisTextColor,
		historyAxisTextGap: Math.max(0, Number(params.get("axisTextGap")) || DEFAULT_CONFIG.historyAxisTextGap),
	};
}

function HeartrateOBSComponent() {
	const pwd = getQueryPassword();
	const config = parseQueryConfig();
	const { connect, addCustomEventListener, isConnected, isConnecting, error } = useOBS();
	const [currentSample, setCurrentSample] = useState<HeartrateSample | null>(null);
	const [history, setHistory] = useState<HeartrateSample[]>([]);
	const [heartrateConnected, setHeartrateConnected] = useState(false);
	const lastTimestampRef = useRef<number | null>(null);
	const { biometrics } = useBiometrics();
	const [calories, setCalories] = useState<number | null>(null);
	const sessionStartRef = useRef<number | null>(null);
	const sumHeartrateRef = useRef(0);
	const sampleCountRef = useRef(0);
	const [goalReached, setGoalReached] = useState(false);
	const goalAlreadyCelebratedRef = useRef(false);
	const goalResetTimeoutRef = useRef<number | null>(null);

	useEffect(() => {
		if (!pwd) return;
		void connect(pwd);
	}, [pwd]);

	useEffect(() => {
		const unmount = addCustomEventListener((eventData) => {
			try {
				const payload = (eventData || {}) as ObsPayload;

				if (typeof payload.heartrateConnected === "boolean") {
					setHeartrateConnected(payload.heartrateConnected);
				}

				if (typeof payload.heartrate !== "number") return;

				const timestamp = typeof payload.heartrateTimestamp === "number" ? payload.heartrateTimestamp : Date.now();
				if (lastTimestampRef.current === timestamp) return;
				lastTimestampRef.current = timestamp;

				const sample = {
					heartrate: payload.heartrate,
					timestamp,
				};

				setCurrentSample(sample);
				setHistory((prev) => {
					const retentionMs = getHeartrateHistoryRetentionMs(config.timeWindow);
					return [...prev, sample].filter((entry) => entry.timestamp >= timestamp - retentionMs);
				});

				// Running kcal estimate for the OBS overlay -- same
				// Keytel et al. formula the sidebar uses, fed a running
				// average HR over the elapsed session so it stays stable
				// (a single-sample average would make the number jump
				// around every time a new BPM reading comes in).
				if (sessionStartRef.current == null) sessionStartRef.current = timestamp;
				sumHeartrateRef.current += sample.heartrate;
				sampleCountRef.current += 1;
				const avgHeartrate = sumHeartrateRef.current / sampleCountRef.current;
				const durationSeconds = (timestamp - sessionStartRef.current) / 1000;
				const kcal = estimateCalories(avgHeartrate, durationSeconds, biometrics);
				if (kcal != null) {
					setCalories(kcal);

					// Fire the goal-reached celebration exactly once per
					// session (not every sample after crossing, and not
					// again if kcal dips back down from a recalculated
					// average) -- goalAlreadyCelebratedRef latches on the
					// first crossing for the lifetime of this page load.
					if (
						config.calorieGoal != null &&
						config.calorieGoal > 0 &&
						kcal >= config.calorieGoal &&
						!goalAlreadyCelebratedRef.current
					) {
						goalAlreadyCelebratedRef.current = true;
						setGoalReached(true);
						if (goalResetTimeoutRef.current != null) window.clearTimeout(goalResetTimeoutRef.current);
						goalResetTimeoutRef.current = window.setTimeout(() => setGoalReached(false), 3400);
					}
				}
			} catch {
				// ignore malformed events
			}
		});

		return unmount;
	}, [addCustomEventListener, config.timeWindow, config.calorieGoal]);

	useEffect(() => {
		return () => {
			if (goalResetTimeoutRef.current != null) window.clearTimeout(goalResetTimeoutRef.current);
		};
	}, []);

	useEffect(() => {
		setHistory((prev) => {
			const latestTimestamp = prev.length > 0 ? prev[prev.length - 1].timestamp : null;
			if (!latestTimestamp) return prev;
			return prev.filter((entry) => entry.timestamp >= latestTimestamp - getHeartrateHistoryRetentionMs(config.timeWindow));
		});
	}, [config.timeWindow]);

	if (!isConnected && !isConnecting) {
		return (
			<div className="flex h-screen w-screen items-center justify-center bg-transparent overflow-hidden">
				<div className="px-6 py-4 rounded-lg border bg-white/70 text-gray-900 shadow-sm">
					<h1 className="text-lg font-semibold">WebFSR OBS Heartrate</h1>
					<p className="text-sm text-gray-700">Status: {isConnecting ? "Connecting…" : isConnected ? "Connected" : "Disconnected"}</p>
					{error && <p className="text-sm text-red-600">{error}</p>}
					{!pwd && <p className="text-sm text-amber-600">No password provided in URL</p>}
				</div>
			</div>
		);
	}

	const statusText = currentSample
		? heartrateConnected
			? undefined
			: "Showing the last received heartrate sample."
		: heartrateConnected
			? "Waiting for heartrate data..."
			: "Heartrate monitor not connected";

	return (
		<div className="h-screen w-screen overflow-hidden bg-transparent">
			{config.mode === "graph" ? (
				<div className="flex h-full w-full items-center justify-center">
					<div className="h-full w-full">
						<HeartrateHistoryGraph
							samples={history}
							timeWindowSeconds={config.timeWindow}
							emptyMessage={heartrateConnected ? "Waiting for heartrate data..." : "Heartrate monitor not connected"}
							showBorder={config.showBorder}
							gradientTopColor={config.historyGradientTopColor}
							gradientBottomColor={config.historyGradientBottomColor}
							lineColor={config.historyLineColor}
							smoothLine={config.historySmoothLine}
							showAxisText={config.historyShowAxisText}
							axisLabelSide={config.historyAxisLabelSide}
							axisTextColor={config.historyAxisTextColor}
							axisTextGap={config.historyAxisTextGap}
						/>
					</div>
				</div>
			) : (
				<HeartrateCurrentDisplay
					heartrate={currentSample?.heartrate ?? null}
					animateHeartbeat={config.animateHeartbeat}
					showBpmText={config.showBpmText}
					showHeartVisual={config.showHeartVisual}
					showBorder={config.showBorder}
					containerBackgroundColor={config.containerBackgroundColor}
					heartColor={config.heartColor}
					heartBackgroundColor={config.heartBackgroundColor}
					textColor={config.textColor}
					isLive={heartrateConnected}
					statusText={statusText}
					showCalories={config.showCalories}
					calories={calories}
					calorieGoal={config.calorieGoal}
					goalReached={goalReached}
					zoneColorsEnabled={config.zoneColorsEnabled}
					zoneLowMax={config.zoneLowMax}
					zoneMidMax={config.zoneMidMax}
					zoneLowColor={config.zoneLowColor}
					zoneMidColor={config.zoneMidColor}
					zoneHighColor={config.zoneHighColor}
					bpmFontSize={config.bpmFontSize}
					caloriesFontSize={config.caloriesFontSize}
					heartIconSize={config.heartIconSize}
					heartIconStyle={config.heartIconStyle}
					customHeartImageUrl={config.customHeartImageUrl}
					calorieIconStyle={config.calorieIconStyle}
				/>
			)}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<HeartrateOBSComponent />
	</StrictMode>,
);
