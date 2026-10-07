import { AlertTriangle, Download, GripVertical, Heart, Moon, RefreshCw, Share, Smartphone, Sun, Unplug, Upload } from "lucide-react";
import { memo, type PointerEvent as ReactPointerEvent, type ReactNode, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
	AboutDialog,
	GeneralSettingsSection,
	HeartRateMonitorSection,
	OBSSection,
	ProfilesSection,
	VisualSettingsSection,
} from "~/components/DashboardSidebar";
import MobileDashboard from "~/components/MobileDashboard";
import { OBSComponentDialog } from "~/components/OBSComponentDialog";
import PairingQRModal from "~/components/PairingQRModal";
import SensorBar, { SensorUiScaleContext } from "~/components/SensorBar";
import { SongHistorySection } from "~/components/SongHistorySection";
import TimeSeriesGraph from "~/components/TimeSeriesGraph";
import UpdateModal from "~/components/UpdateModal";
import { Button } from "~/components/ui/button";
import { CustomScrollArea } from "~/components/ui/custom-scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { estimateCalories } from "~/lib/calorieEstimate";
import { useBiometrics } from "~/lib/useBiometrics";
import { useHeartrateMonitor } from "~/lib/useHeartrateMonitor";
import { useHypeRateHeartrateMonitor } from "~/lib/useHypeRateHeartrateMonitor";
import { useHypeRateSessionId } from "~/lib/useHypeRateSessionId";
import { type BroadcastSongEntry, type ObsBroadcastPayload, useOBS } from "~/lib/useOBS";
import { type ProfileData, useProfileManager } from "~/lib/useProfileManager";
import { usePWAInstall } from "~/lib/usePWAInstall";
import { useLastCode, useRemoteControl } from "~/lib/useRemoteControl";
import { useSerialPort } from "~/lib/useSerialPort";
import { computeSongStats, bannerUrl, useSongHistory } from "~/lib/useSongHistory";
import { useTheme } from "~/lib/useTheme";
import { useSensorCount } from "~/store/dataStore";
import type { DesktopMessage, MobileMessage, ProfileSyncPayload } from "~/store/remoteStore";
import {
	useBarVisualizationSettings,
	useColorSettings,
	useGeneralSettings,
	useGraphVisualizationSettings,
	useHeartrateSettings,
	useSettingsBulkActions,
} from "~/store/settingsStore";

const MOBILE_BREAKPOINT = 768;

function useIsMobile() {
	const subscribe = (callback: () => void) => {
		const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
		mql.addEventListener("change", callback);
		return () => mql.removeEventListener("change", callback);
	};
	const getSnapshot = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`).matches;
	const getServerSnapshot = () => false;

	return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function useStableCallback<Args extends unknown[], R>(callback: (...args: Args) => R): (...args: Args) => R {
	const callbackRef = useRef(callback);
	callbackRef.current = callback;

	const stableCallbackRef = useRef((...args: Args) => {
		callbackRef.current(...args);
	});

	return stableCallbackRef.current as (...args: Args) => R;
}

// A small, explicit drag handle icon -- dragging only starts when the
// user grabs THIS element, not anywhere on the row. Keeps clicks on
// labels, color swatches, and number inputs elsewhere in the same row
// from accidentally triggering a drag.
function DragHandle({
	onDragStart,
	onDragEnd,
	className = "",
}: {
	onDragStart: (e: React.DragEvent) => void;
	onDragEnd: () => void;
	className?: string;
}) {
	return (
		<div
			draggable
			onDragStart={onDragStart}
			onDragEnd={onDragEnd}
			className={`cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors shrink-0 touch-none ${className}`}
			title="Drag to reorder"
		>
			<GripVertical className="size-4" />
		</div>
	);
}

// Shared drag-and-drop reordering logic used identically by the main
// sensor bars, LED Panels list, and Sensor Tuning list -- all three need
// to agree on the SAME display order (it's one shared concept: "which
// physical position does this sensor visually appear in"), so the actual
// state lives once in Dashboard (displayOrder/moveDisplayPosition) and
// each list just needs this small bit of local drag-tracking UI state
// plus a way to call back into that shared move function.
function useRowDragReorder(onMove: (fromPos: number, toPos: number) => void) {
	const [draggingPos, setDraggingPos] = useState<number | null>(null);
	const [dragOverPos, setDragOverPos] = useState<number | null>(null);

	const handleDragStart = (pos: number) => (e: React.DragEvent) => {
		setDraggingPos(pos);
		// Required for Firefox to actually initiate the drag.
		e.dataTransfer.effectAllowed = "move";
		e.dataTransfer.setData("text/plain", String(pos));
	};

	const handleDragEnd = () => {
		setDraggingPos(null);
		setDragOverPos(null);
	};

	const handleDragOver = (pos: number) => (e: React.DragEvent) => {
		e.preventDefault();
		if (draggingPos !== null && pos !== draggingPos) {
			setDragOverPos(pos);
		}
	};

	const handleDrop = (pos: number) => (e: React.DragEvent) => {
		e.preventDefault();
		if (draggingPos !== null && draggingPos !== pos) {
			onMove(draggingPos, pos);
		}
		setDraggingPos(null);
		setDragOverPos(null);
	};

	return { draggingPos, dragOverPos, handleDragStart, handleDragEnd, handleDragOver, handleDrop };
}

const MOCK_SENSOR_COUNT = 6;
const MOCK_SENSOR_VALUES = [280, 620, 445, 780, 390, 540];
const MOCK_THRESHOLDS = [480, 550, 420, 600, 510, 470];
const MOCK_SENSOR_LABELS = Array.from({ length: MOCK_SENSOR_COUNT }, (_, i) => `Sensor ${i + 1}`);

// Small sparks that drift upward past the sidebar logo, layered on top of
// the aura glow/orbit blobs. Colors alternate between the active theme's
// rgb(var(--primary)) and rgb(var(--accent)) (resolved at render time, not
// baked in here) so they always match whichever palette is active. Kept as
// a static, deterministic list (no Math.random) so the layout doesn't
// shift between renders -- left position, size, duration, and delay are
// all varied by hand for an organic, non-mechanical rise.
const AURA_PARTICLES: { left: string; size: number; duration: number; delay: number; color: "primary" | "accent" }[] = [
	{ left: "6%",  size: 3, duration: 3.2, delay: 0,   color: "primary" },
	{ left: "20%", size: 2, duration: 3.8, delay: 0.5, color: "accent"  },
	{ left: "35%", size: 3, duration: 3.4, delay: 1.1, color: "primary" },
	{ left: "50%", size: 2, duration: 4.0, delay: 0.2, color: "accent"  },
	{ left: "65%", size: 3, duration: 3.6, delay: 1.6, color: "primary" },
	{ left: "80%", size: 2, duration: 3.3, delay: 0.8, color: "accent"  },
	{ left: "94%", size: 3, duration: 3.9, delay: 1.3, color: "primary" },
];

function generateMockTimeSeriesData(timeWindow: number): Array<Array<{ value: number; timestamp: number }>> {
	const now = Date.now();
	const pointCount = 120;
	const interval = timeWindow / (pointCount - 1);

	return Array.from({ length: MOCK_SENSOR_COUNT }, (_, sensorIndex) => {
		const baseValue = MOCK_SENSOR_VALUES[sensorIndex];
		const frequency = 0.8 + sensorIndex * 0.1;
		const amplitude = 60 + sensorIndex * 15;
		const phaseOffset = sensorIndex * 0.8;

		return Array.from({ length: pointCount }, (_, pointIndex) => {
			const t = pointIndex / (pointCount - 1);
			const sineComponent = Math.sin(t * Math.PI * 2 * frequency + phaseOffset) * amplitude;
			const secondaryWave = Math.sin(t * Math.PI * 4 * frequency + phaseOffset * 2) * (amplitude * 0.2);
			const value = Math.max(0, Math.min(1023, Math.round(baseValue + sineComponent + secondaryWave)));
			const timestamp = now - timeWindow + pointIndex * interval;
			return { value, timestamp };
		});
	});
}

/*===========================================================================*/
// LED PANEL — types and helpers

const LS_CUSTOM_PRESETS_KEY = "webfsr_led_presets_v5";
const LS_SENSOR_MAP_KEY     = "webfsr_led_sensors_v5";
const LS_ACCENT_ZONE_KEY    = "webfsr_led_accent_v1";

// One entry per FSR sensor — fully flexible, no hardcoded directions
interface SensorZone {
	sensorIndex: number;  // 0-based firmware sensor index
	label: string;        // user-editable name e.g. "Left", "Up 2"
	color: string;        // hex color e.g. "#ff0000"
	ledCount: number;
	ledOffset: number;
}

interface LedPreset {
	name: string;
	sensors: SensorZone[];
	brightness: number;
}

// A NON-sensor decorative LED zone -- e.g. under the cap / around the
// controller enclosure. Unlike SensorZone, this never reacts to an FSR
// reading; it just runs a firmware-side animation over its own LED range
// (defaults to starting right after the sensor zones, offset 32+, so it
// doesn't overlap the panel strips by default). Effects are computed on
// the Teensy itself (not by the dashboard pushing rapid color updates)
// so the cap keeps animating even when the dashboard isn't connected --
// only the CONFIG (effect, speed, color, range) is sent over serial.
type AccentEffect = "off" | "solid" | "rainbow" | "pulse" | "chase";

interface AccentZone {
	label: string;
	effect: AccentEffect;
	color: string;      // base color for solid/pulse/chase; ignored by rainbow
	speed: number;       // 1-255, effect speed (higher = faster)
	ledCount: number;
	ledOffset: number;   // defaults to 32 -- right after a typical 8-sensor/32-LED panel layout
}

const DEFAULT_ACCENT_ZONE: AccentZone = {
	label: "Cap",
	effect: "off",
	color: "#00ddcc",
	speed: 60,
	ledCount: 12,
	ledOffset: 32,
};

// Both the accent zone and every sensor's LED zone write into the SAME
// physical leds[] array on the board (LedZoneOn/LedZoneOff for sensors,
// AccentRenderNow() for the accent zone) -- nothing in the firmware
// prevents their offset/count ranges from overlapping. If they do, a
// sensor press will visibly steal/overwrite the accent zone's LEDs for
// as long as it's held (LedZoneOn writes the sensor's color over
// whatever was there), and worse, releasing it can leave those LEDs
// stuck black afterward for Solid/Off (which only repaint on a config
// change, not continuously) until the accent zone is next touched.
// Checked live in the UI so this shows up as a warning instead of a
// confusing "why does my cap flash when I step" bug report.
function findAccentOverlap(accent: AccentZone, sensors: SensorZone[]): SensorZone[] {
	const aStart = accent.ledOffset;
	const aEnd = accent.ledOffset + accent.ledCount;
	return sensors.filter((s) => {
		const sStart = s.ledOffset;
		const sEnd = s.ledOffset + s.ledCount;
		return sStart < aEnd && aStart < sEnd;
	});
}

// Same sharing problem, but between two SENSORS' own zones rather than a
// sensor and the accent zone -- just as easy to end up with (hand-edited
// offsets, a preset applied on top of custom zones, etc.) and just as
// invisible: the strip preview below picks whichever sensor comes first
// in the array as a given LED's "owner" with no indication a second
// sensor also claims it, so two panels can be silently fighting over the
// same physical LEDs -- each press overwriting whatever the other one
// last set -- and nothing in the UI would show it. Returns one entry per
// conflicting PAIR (not per sensor), each with the specific LED range
// they share.
function findSensorZoneOverlaps(sensors: SensorZone[]): { a: SensorZone; b: SensorZone; from: number; to: number }[] {
	const conflicts: { a: SensorZone; b: SensorZone; from: number; to: number }[] = [];
	for (let i = 0; i < sensors.length; i++) {
		for (let j = i + 1; j < sensors.length; j++) {
			const a = sensors[i], b = sensors[j];
			const from = Math.max(a.ledOffset, b.ledOffset);
			const to = Math.min(a.ledOffset + a.ledCount, b.ledOffset + b.ledCount);
			if (from < to) conflicts.push({ a, b, from, to: to - 1 });
		}
	}
	return conflicts;
}

const ACCENT_EFFECT_LABELS: Record<AccentEffect, string> = {
	off: "Off",
	solid: "Solid",
	rainbow: "Rainbow Cycle",
	pulse: "Pulse / Glow",
	chase: "Chase",
};

// Module-scope (not component-local) so both LedSection (sending live
// config) and FirmwareUpdateSection (replaying a backup) can encode/decode
// the same "a" command without duplicating the mapping.
const ACCENT_EFFECT_TO_NUM: Record<AccentEffect, number> = { off: 0, solid: 1, rainbow: 2, pulse: 3, chase: 4 };
const ACCENT_EFFECT_BY_NUM: AccentEffect[] = ["off", "solid", "rainbow", "pulse", "chase"];

function loadAccentZone(): AccentZone {
	try {
		const raw = localStorage.getItem(LS_ACCENT_ZONE_KEY);
		return raw ? { ...DEFAULT_ACCENT_ZONE, ...(JSON.parse(raw) as Partial<AccentZone>) } : { ...DEFAULT_ACCENT_ZONE };
	} catch { return { ...DEFAULT_ACCENT_ZONE }; }
}
function saveAccentZone(z: AccentZone) {
	localStorage.setItem(LS_ACCENT_ZONE_KEY, JSON.stringify(z));
}

// Bridge shape returned by LedSection's _getLedControls() -- powers the
// LED Pad Preview tab.
interface LedControls {
	sensors: SensorZone[];
	updateSensor: (i: number, patch: Partial<SensorZone>) => void;
	accent: AccentZone;
	updateAccent: (patch: Partial<AccentZone>) => void;
}

const DEFAULT_COLORS = [
	"#e84040", "#4a7fff", "#ff9020", "#3fcf6e",
	"#cc44ff", "#00ddcc", "#ffdd00", "#ff6688",
];
const DEFAULT_LABELS = ["Left", "Down", "Up", "Right", "Up 2", "Down 2", "Extra 1", "Extra 2"];

function makeDefaultSensors(count: number): SensorZone[] {
	return Array.from({ length: count }, (_, i) => ({
		sensorIndex: i,
		label: DEFAULT_LABELS[i] ?? `S${i + 1}`,
		color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
		ledCount: 4,
		ledOffset: i * 4,
	}));
}

const BUILTIN_PRESETS: LedPreset[] = [
	{
		name: "Default 4",
		brightness: 60,
		sensors: makeDefaultSensors(4),
	},
	{
		name: "Default 6",
		brightness: 60,
		sensors: makeDefaultSensors(6),
	},
	{
		name: "DDR",
		brightness: 60,
		sensors: [
			{ sensorIndex:0, label:"Left",  color:"#ffcc00", ledCount:4, ledOffset:0  },
			{ sensorIndex:1, label:"Down",  color:"#0088ff", ledCount:4, ledOffset:4  },
			{ sensorIndex:2, label:"Up",    color:"#ff2288", ledCount:4, ledOffset:8  },
			{ sensorIndex:3, label:"Right", color:"#00ddaa", ledCount:4, ledOffset:12 },
		],
	},
	{
		name: "Fire",
		brightness: 60,
		sensors: [
			{ sensorIndex:0, label:"Left",  color:"#ff2200", ledCount:4, ledOffset:0  },
			{ sensorIndex:1, label:"Down",  color:"#ff6600", ledCount:4, ledOffset:4  },
			{ sensorIndex:2, label:"Up",    color:"#ffaa00", ledCount:4, ledOffset:8  },
			{ sensorIndex:3, label:"Right", color:"#ffdd00", ledCount:4, ledOffset:12 },
		],
	},
	{
		name: "Ice",
		brightness: 60,
		sensors: [
			{ sensorIndex:0, label:"Left",  color:"#aaddff", ledCount:4, ledOffset:0  },
			{ sensorIndex:1, label:"Down",  color:"#66bbff", ledCount:4, ledOffset:4  },
			{ sensorIndex:2, label:"Up",    color:"#2299ff", ledCount:4, ledOffset:8  },
			{ sensorIndex:3, label:"Right", color:"#0055cc", ledCount:4, ledOffset:12 },
		],
	},
];

function hexToRgb(hex: string) {
	const c = hex.replace("#", "");
	return { r: parseInt(c.slice(0,2),16), g: parseInt(c.slice(2,4),16), b: parseInt(c.slice(4,6),16) };
}

/*===========================================================================*/
// ACCENT EFFECT PREVIEW MATH -- a client-side mirror of the exact firmware
// math in AccentRenderRainbow/Pulse/Chase (Fsr_Awaken_Animus_Master_V5.ino)
// so the dashboard can show a live animated demo of an effect/color BEFORE
// (or without) a pad connected. This is ONLY ever used to drive pixels in
// the UI -- never sent over serial -- so it's fine for it to be a JS
// reimplementation rather than sharing code with the firmware; what matters
// is the two stay visually equivalent (same hue-step/brightness-ramp/
// comet-tail formulas, same phase-per-step advance), not byte-identical.

// speed 1 (slow) -> ~120ms/step, speed 255 (fast) -> ~20ms/step -- matches
// AccentStepIntervalMs() in firmware exactly (floor raised from an
// earlier 4ms so this preview's cadence matches the real, gameplay-safe
// cadence the board now runs at -- see that function's own comment for
// why the floor exists).
function accentStepIntervalMs(speed: number): number {
	return Math.max(20, Math.min(120, 124 - Math.floor(speed / 2)));
}

// FastLED-style CHSV (each channel 0-255, hue wraps at 256) -> hex, since
// that's the exact hue space AccentRenderRainbow() computes in on the
// Teensy (NOT the usual 0-360 degree HSV) -- using the same 0-255 space
// here means the preview's rainbow sweep lines up with the real one
// instead of just looking similar.
function chsvToHex(h255: number, s255: number, v255: number): string {
	const h = ((h255 % 256) + 256) % 256 / 255 * 360;
	const s = s255 / 255;
	const v = v255 / 255;
	const c = v * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = v - c;
	let r = 0, g = 0, b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const toHex = (v: number) => Math.round(Math.max(0, Math.min(255, (v + m) * 255))).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Mirrors FastLED's nscale8_video -- linear scale toward black, matching
// AccentRenderPulse()/AccentRenderChase()'s CRGB::nscale8_video() calls.
function scaleHex(hex: string, factor0to255: number): string {
	const { r, g, b } = hexToRgb(hex);
	const f = Math.max(0, Math.min(255, factor0to255)) / 255;
	const toHex = (v: number) => Math.round(v * f).toString(16).padStart(2, "0");
	return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// One animation frame's worth of per-LED hex colors for an AccentZone at a
// given phase -- same phase/step semantics as the firmware's accentPhase
// (increments by 1 every accentStepIntervalMs(speed)).
function computeAccentFrame(accent: AccentZone, phase: number): string[] {
	const n = Math.max(1, accent.ledCount);
	if (accent.effect === "off") return Array(n).fill("#1a1a1a"); // dim gray, not pure black -- stays visible as "off but present" in the UI
	if (accent.effect === "solid") return Array(n).fill(accent.color);
	if (accent.effect === "rainbow") {
		const hueStep = 256 / n;
		return Array.from({ length: n }, (_, i) => chsvToHex(phase + i * hueStep, 255, 255));
	}
	if (accent.effect === "pulse") {
		const t = phase % 512;
		const brightness = t < 256 ? t : 511 - t;
		return Array(n).fill(scaleHex(accent.color, brightness));
	}
	// chase
	const head = phase % n;
	const tailLen = Math.min(3, n);
	const colors = Array(n).fill("#1a1a1a");
	for (let tail = 0; tail < tailLen; tail++) {
		let pos = head - tail;
		if (pos < 0) pos += n;
		colors[pos] = scaleHex(accent.color, 255 - tail * 85);
	}
	return colors;
}

// Runs the requestAnimationFrame loop and returns the current frame's
// per-LED colors -- shared by every place that wants to preview the
// accent zone (sidebar section, both edit cards, the pad's Cap node).
// Restarts phase at 0 whenever the config that affects the animation's
// shape changes, so e.g. switching effects doesn't pick up mid-cycle.
function useAccentPreviewFrame(accent: AccentZone): string[] {
	const [frame, setFrame] = useState<string[]>(() => computeAccentFrame(accent, 0));
	const phaseRef = useRef(0);
	const lastStepRef = useRef<number>(0);

	useEffect(() => {
		phaseRef.current = 0;
		lastStepRef.current = 0;

		// Off and Solid are static outputs with nothing to animate -- render
		// them once here and skip the rAF loop entirely. Previously both
		// effects still ran through the same tick loop below, gated only by
		// the Speed-derived interval, so Solid kept calling setFrame with a
		// freshly-built (but value-identical) array on every step -- the
		// constant re-render was visible as a faint pulse, and tied its
		// rate to the Speed slider even though a static color has no
		// "speed" to speak of.
		if (accent.effect === "off" || accent.effect === "solid") {
			setFrame(computeAccentFrame(accent, 0));
			return;
		}

		let rafId: number;
		const tick = (t: number) => {
			if (lastStepRef.current === 0) lastStepRef.current = t;
			if (t - lastStepRef.current >= accentStepIntervalMs(accent.speed)) {
				lastStepRef.current = t;
				phaseRef.current += 1;
				setFrame(computeAccentFrame(accent, phaseRef.current));
			}
			rafId = requestAnimationFrame(tick);
		};
		rafId = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(rafId);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally
		// keyed on the fields that change the animation's SHAPE (effect/speed/
		// color/count), not on `accent` as a whole -- editing the label or
		// offset shouldn't restart the phase/cycle.
	}, [accent.effect, accent.speed, accent.color, accent.ledCount]);

	return frame;
}

// A row of small LED-square previews driven by useAccentPreviewFrame --
// used in the sidebar Accent LEDs section and both edit cards. `size` in
// px; `max` caps how many squares are drawn (the Cap node on the pad image
// is small, so it only wants a handful even if ledCount is larger).
function AccentPreviewStrip({ accent, size = 16, max }: { accent: AccentZone; size?: number; max?: number }) {
	const frame = useAccentPreviewFrame(accent);
	const shown = typeof max === "number" ? frame.slice(0, max) : frame;
	return (
		<div className="flex gap-0.5 flex-wrap">
			{shown.map((color, i) => (
				<div
					key={i}
					className="rounded-sm border border-white/20 shrink-0"
					style={{
						width: size,
						height: size,
						background: color,
						boxShadow: accent.effect !== "off" ? `0 0 4px ${color}` : undefined,
					}}
				/>
			))}
			{max && frame.length > max && (
				<span className="text-[9px] text-muted-foreground self-center">+{frame.length - max}</span>
			)}
		</div>
	);
}
// Walks the PERIMETER of a square, clockwise from the top-left corner --
// t in [0,1) maps to a point on the rim. Used to lay LEDs out like they're
// actually mounted around the edge of a cap/case, not paving its whole
// surface.
function perimeterPosition(t: number): { xPct: number; yPct: number } {
	const frac = ((t % 1) + 1) % 1;
	if (frac < 0.25) return { xPct: (frac / 0.25) * 100, yPct: 0 };
	if (frac < 0.5) return { xPct: 100, yPct: ((frac - 0.25) / 0.25) * 100 };
	if (frac < 0.75) return { xPct: 100 - ((frac - 0.5) / 0.25) * 100, yPct: 100 };
	return { xPct: 0, yPct: 100 - ((frac - 0.75) / 0.25) * 100 };
}

// Renders `count` LEDs strung evenly around the rim of its container (like
// the green selection outline around the Cap panel), each animated from
// the same rainbow/pulse/chase math as the firmware -- rainbow becomes a
// color ring, chase becomes a light literally circling the edge, pulse
// breathes the whole ring. A filled grid of squares was tried first but
// read as "tacky"/like random dots changing color rather than a coherent
// LED strip; tracing the rim is both more attractive and closer to how
// these LEDs would actually be mounted on the hardware. Runs its OWN
// independent animation loop (via a locally-scoped AccentZone with
// ledCount swapped for `count`), so this can be dropped in anywhere a
// live demo is wanted without wiring shared state through props.
function AccentRimDemo({ accent, cellSize = 10, count = 20 }: { accent: AccentZone; cellSize?: number; count?: number }) {
	const demoAccent = useMemo(
		() => ({ ...accent, ledCount: count }),
		// eslint-disable-next-line react-hooks/exhaustive-deps -- only the
		// fields that actually change the animation's shape/color matter
		// here; rebuilding this object on every accent change (e.g. label
		// edits) would restart the animation pointlessly.
		[accent.effect, accent.speed, accent.color, count],
	);
	const frame = useAccentPreviewFrame(demoAccent);
	return (
		<div className="absolute inset-0">
			{frame.map((c, i) => {
				const { xPct, yPct } = perimeterPosition(i / frame.length);
				return (
					<div
						key={i}
						className="absolute rounded-sm"
						style={{
							width: cellSize,
							height: cellSize,
							left: `${xPct}%`,
							top: `${yPct}%`,
							transform: "translate(-50%, -50%)",
							background: c,
							boxShadow: accent.effect !== "off" ? `0 0 ${Math.max(3, cellSize * 0.7)}px ${c}` : undefined,
						}}
					/>
				);
			})}
		</div>
	);
}

function loadSensors(): SensorZone[] {
	try {
		const raw = localStorage.getItem(LS_SENSOR_MAP_KEY);
		return raw ? (JSON.parse(raw) as SensorZone[]) : makeDefaultSensors(4);
	} catch { return makeDefaultSensors(4); }
}
function saveSensors(s: SensorZone[]) {
	localStorage.setItem(LS_SENSOR_MAP_KEY, JSON.stringify(s));
}
function loadCustomPresets(): LedPreset[] {
	try {
		const raw = localStorage.getItem(LS_CUSTOM_PRESETS_KEY);
		return raw ? (JSON.parse(raw) as LedPreset[]) : [];
	} catch { return []; }
}
function saveCustomPresets(p: LedPreset[]) {
	localStorage.setItem(LS_CUSTOM_PRESETS_KEY, JSON.stringify(p));
}

/*===========================================================================*/



interface LedSectionProps {
	connected: boolean;
	sendText: (text: string) => void;
	thresholds: number[];
	displayOrder: number[];
	moveDisplayPosition: (fromPos: number, toPos: number) => void;
	numSensors: number;  // live count from connected pad — used to auto-scale presets
}

function LedSection({ connected, sendText, displayOrder, moveDisplayPosition, numSensors }: LedSectionProps) {
	const [sensors, setSensors]       = useState<SensorZone[]>(loadSensors);
	const [brightness, setBrightness] = useState<number>(60);
	const [ledOpen, setLedOpen]       = useState<boolean>(true);
	const [zoneOpen, setZoneOpen]     = useState<boolean>(false);
	const [customPresets, setCustomPresets] = useState<LedPreset[]>(loadCustomPresets);
	const [newPresetName, setNewPresetName] = useState<string>("");
	const [showSaveInput, setShowSaveInput] = useState<boolean>(false);
	const [accentOpen, setAccentOpen]   = useState<boolean>(false);
	const [accent, setAccent]           = useState<AccentZone>(loadAccentZone);
	const ledDrag = useRowDragReorder(moveDisplayPosition);

	// Publish to the external store consumed by LedPadPreview (LEDs tab).
	useEffect(() => {
		publishLedStore(sensors);
	}, [sensors]);
	useEffect(() => {
		publishAccentStore(accent);
	}, [accent]);

	// Query firmware on connect. We deliberately do NOT push our locally
	// cached `sensors` back to the firmware here -- doing so used to race
	// against the "c" response and could re-assert stale localStorage
	// entries (e.g. 3 leftover sensors from earlier testing) even when
	// only 1 FSR is actually wired up. The firmware's own "c" response is
	// the single source of truth; handleLedLine() below truncates our
	// local array to match it exactly.
	const hasQueriedRef = useRef(false);
	useEffect(() => {
		if (connected && !hasQueriedRef.current) {
			hasQueriedRef.current = true;
			setTimeout(() => {
				sendText("q\n");
			}, 400);
			// Query the accent zone config too ("a" with no args = query,
			// mirroring "q" for sensor zones). Sent slightly after "q" so
			// the two responses don't land in the same serial write burst.
			setTimeout(() => {
				sendText("a\n");
			}, 460);
		}
		if (!connected) hasQueriedRef.current = false;
	}, [connected, sendText]);

	// Parse firmware "c" response — 5 values per sensor: r g b offset count, then brightness
	// Firmware never has more than 8 sensors (MAX_SENSORS in fsr_*.ino).
	// Used as a sanity cap below to reject obviously corrupted "c" lines
	// rather than building a huge bogus sensor list from them.
	const MAX_FIRMWARE_SENSORS = 8;

	const handleLedLine = (line: string) => {
		if (!line.startsWith("c")) return false;
		const nums = line.slice(1).trim().split(/\s+/).map(Number);
		if (nums.length < 6) return false;
		const count = Math.floor((nums.length - 1) / 5);
		if (count < 1) return false;
		if (count > MAX_FIRMWARE_SENSORS) {
			// Defense in depth: a real firmware response can never report
			// more than MAX_SENSORS. Seeing more than that means this line
			// got corrupted or multiple responses got concatenated together
			// (e.g. two "c" lines merged without a clean newline between
			// them, which is what caused the LED Panels list to explode to
			// 50+ entries after rapid-fire serial writes). Drop it rather
			// than building a sensor list from garbage data.
			console.error(`Ignoring corrupted "c" line reporting ${count} sensors (max is ${MAX_FIRMWARE_SENSORS}):`, line);
			return false;
		}
		setSensors(prev => {
			// IMPORTANT: rebuild from scratch sized exactly to what the firmware
			// reports, rather than only growing/overwriting a stale array. This
			// prevents leftover sensors from old testing/localStorage (e.g. 30
			// rows accumulated before useSerialPort forwarded "c" lines) from
			// sticking around forever once the pad reports a smaller real count.
			const updated: SensorZone[] = [];
			for (let i = 0; i < count; i++) {
				const r = nums[i*5], g = nums[i*5+1], b = nums[i*5+2];
				const hex = "#" + [r,g,b].map(v => v.toString(16).padStart(2,"0")).join("");
				const offset = nums[i*5+3];
				const cnt    = nums[i*5+4];
				const existing = prev[i];
				updated.push({
					sensorIndex: i,
					label: existing?.label ?? DEFAULT_LABELS[i] ?? `S${i+1}`,
					color: hex,
					ledOffset: offset,
					ledCount: cnt,
				});
			}
			saveSensors(updated);
			return updated;
		});
		setBrightness(nums[nums.length - 1]);
		return true;
	};

	// Parse firmware "a <offset> <count> <effect> <speed> <r> <g> <b>"
	// response for the accent/cap zone (see sendAccentConfig below for the
	// matching outbound format). Effect is sent as a number so it's a
	// single byte over serial like everything else here:
	//   0=off 1=solid 2=rainbow 3=pulse 4=chase
	const handleAccentLine = (line: string) => {
		if (!line.startsWith("a ")) return false;
		const nums = line.slice(2).trim().split(/\s+/).map(Number);
		if (nums.length < 7) return false;
		const [offset, count, effectNum, speed, r, g, b] = nums;
		const hex = "#" + [r, g, b].map((v) => (v || 0).toString(16).padStart(2, "0")).join("");
		const next: AccentZone = {
			label: accent.label,
			ledOffset: offset,
			ledCount: count,
			effect: ACCENT_EFFECT_BY_NUM[effectNum] ?? "off",
			speed,
			color: hex,
		};
		setAccent(next);
		saveAccentZone(next);
		return true;
	};

	const sendColor = (i: number, hex: string) => {
		if (!connected) return;
		const { r, g, b } = hexToRgb(hex);
		sendText(`l ${i} ${r} ${g} ${b}\n`);
	};
	const sendZone = (i: number, offset: number, count: number) => {
		if (!connected) return;
		sendText(`z ${i} ${offset} ${count}\n`);
	};
	const sendBrightness = (val: number) => {
		if (!connected) return;
		sendText(`b ${val}\n`);
	};

	// Sends the full accent config in one shot -- firmware runs the actual
	// rainbow/pulse/chase animation itself off this, so the cap keeps
	// animating on its own timer even when nothing is connected/redrawing.
	const sendAccentConfig = (z: AccentZone) => {
		if (!connected) return;
		const { r, g, b } = hexToRgb(z.color);
		sendText(`a ${z.ledOffset} ${z.ledCount} ${ACCENT_EFFECT_TO_NUM[z.effect]} ${z.speed} ${r} ${g} ${b}\n`);
	};

	const updateSensor = (i: number, patch: Partial<SensorZone>) => {
		const updated = sensors.map((s, idx) => idx === i ? { ...s, ...patch } : s);
		setSensors(updated);
		saveSensors(updated);
		const s = updated[i];
		// Always use s.sensorIndex (not i) so firmware gets the correct sensor
		if ("color" in patch || "sensorIndex" in patch) sendColor(s.sensorIndex, s.color);
		if ("ledOffset" in patch || "ledCount" in patch || "sensorIndex" in patch) sendZone(s.sensorIndex, s.ledOffset, s.ledCount);
	};

	// `label` is dashboard-only (never sent to firmware -- see
	// sendAccentConfig), so patching just the label skips the serial write
	// entirely rather than sending a no-op config line.
	const updateAccent = (patch: Partial<AccentZone>) => {
		const updated = { ...accent, ...patch };
		setAccent(updated);
		saveAccentZone(updated);
		const onlyLabelChanged = Object.keys(patch).every((k) => k === "label");
		if (!onlyLabelChanged) sendAccentConfig(updated);
	};

	// Tell firmware how many sensors are active. Firmware auto-assigns
	// default zones/colors for any newly added sensors and saves to EEPROM.
	const sendSensorCount = (count: number) => {
		if (!connected) return;
		sendText(`n ${count}\n`);
	};

	const addSensor = () => {
		const i = sensors.length;
		const lastOffset = sensors.length > 0
			? sensors[sensors.length-1].ledOffset + sensors[sensors.length-1].ledCount
			: 0;
		const newSensor: SensorZone = {
			sensorIndex: i,
			label: DEFAULT_LABELS[i] ?? `S${i+1}`,
			color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
			ledOffset: lastOffset,
			ledCount: 4,
		};
		const updated = [...sensors, newSensor];
		setSensors(updated);
		saveSensors(updated);
		// Firmware handles assigning the new sensor's default zone/color itself
		// and persists it to EEPROM -- then we override with our own defaults
		// to keep dashboard and firmware in sync immediately.
		sendSensorCount(updated.length);
		setTimeout(() => {
			sendColor(i, newSensor.color);
			sendZone(i, newSensor.ledOffset, newSensor.ledCount);
		}, 150);
	};

	const removeSensor = (i: number) => {
		if (sensors.length <= 1) return;
		// IMPORTANT: do NOT reassign sensorIndex here -- see the matching
		// comment in the personal/dev build for the full explanation. In
		// short, sensorIndex is an independently editable field (which
		// physical firmware sensor slot this LED zone responds to), not
		// an array-position mirror. Renumbering it on every removal used
		// to silently reassign a customer's real, working sensor to the
		// wrong slot.
		const updated = sensors.filter((_, idx) => idx !== i);
		setSensors(updated);
		saveSensors(updated);
		// Tell firmware the new count first (it turns off LEDs for removed
		// sensors and persists to EEPROM), then re-sync remaining sensors.
		//
		// IMPORTANT: each "z" and "l" command triggers the firmware to
		// reply with a full "c" config line (see UpdateSensorZone /
		// UpdateSensorColor in firmware -- both call PrintLedConfig()).
		// Firing all of them back-to-back via forEach (no delay between
		// writes) sent up to 14 commands within milliseconds for a
		// 7-sensor pad. The Teensy's single-threaded serial loop can't
		// keep up, and the WebSerial read loop's shared buffer (reset
		// only on a real newline) would end up with multiple responses
		// arriving faster than they could be cleanly split apart --
		// producing garbled "c" lines with corrupted/inflated sensor
		// counts. This is what caused removing one sensor from an 8-FSR
		// setup to explode the LED Panels list up past 50 entries.
		//
		// Fix: serialize the writes with a small delay between each one
		// so the firmware has time to fully process and respond before
		// the next command is sent.
		sendSensorCount(updated.length);
		setTimeout(() => {
			let delay = 0;
			const stepMs = 60; // gives the Teensy's loop() time to read, respond, and flush before the next write
			updated.forEach((s) => {
				setTimeout(() => sendColor(s.sensorIndex, s.color), delay);
				delay += stepMs;
				setTimeout(() => sendZone(s.sensorIndex, s.ledOffset, s.ledCount), delay);
				delay += stepMs;
			});
		}, 150);
	};

	const applyPreset = (preset: LedPreset) => {
		// Auto-scale the preset to match the connected pad's sensor count.
		// If the pad has more sensors than the preset, fill the extras with
		// default colors/offsets continuing from where the preset left off.
		// If the pad has fewer, trim the preset down to fit.
		const targetCount = numSensors > 0 ? numSensors : preset.sensors.length;
		let scaledSensors: SensorZone[];
		if (targetCount <= preset.sensors.length) {
			scaledSensors = preset.sensors.slice(0, targetCount);
		} else {
			scaledSensors = [...preset.sensors];
			for (let i = preset.sensors.length; i < targetCount; i++) {
				const lastOffset = scaledSensors.length > 0
					? scaledSensors[scaledSensors.length-1].ledOffset + scaledSensors[scaledSensors.length-1].ledCount
					: 0;
				scaledSensors.push({
					sensorIndex: i,
					label: DEFAULT_LABELS[i] ?? `S${i+1}`,
					color: DEFAULT_COLORS[i % DEFAULT_COLORS.length],
					ledOffset: lastOffset,
					ledCount: preset.sensors[0]?.ledCount ?? 4,
				});
			}
		}
		setSensors(scaledSensors);
		saveSensors(scaledSensors);
		setBrightness(preset.brightness);
		// Serialized with delays for the same reason as removeSensor above --
		// firing every sensor's "l"/"z" commands back-to-back floods the
		// firmware faster than its single-threaded loop can respond,
		// corrupting the "c" responses that come back.
		let delay = 0;
		const stepMs = 60;
		preset.sensors.forEach((s) => {
			setTimeout(() => sendColor(s.sensorIndex, s.color), delay);
			delay += stepMs;
			setTimeout(() => sendZone(s.sensorIndex, s.ledOffset, s.ledCount), delay);
			delay += stepMs;
		});
		setTimeout(() => sendBrightness(preset.brightness), delay);
	};

	const saveCurrentAsPreset = () => {
		const name = newPresetName.trim();
		if (!name) return;
		const preset: LedPreset = { name, sensors: [...sensors], brightness };
		const updated = [...customPresets, preset];
		setCustomPresets(updated);
		saveCustomPresets(updated);
		setNewPresetName("");
		setShowSaveInput(false);
	};

	const deleteCustomPreset = (i: number) => {
		const updated = customPresets.filter((_, idx) => idx !== i);
		setCustomPresets(updated);
		saveCustomPresets(updated);
	};

	// Try the accent line first -- both start with a single letter + space
	// ("a " vs "c ") so there's no ambiguity, but ordering doesn't matter
	// here since each parser bails out immediately on a prefix mismatch.
	(LedSection as unknown as { _handleLine: (l: string) => boolean })._handleLine =
		(line: string) => handleAccentLine(line) || handleLedLine(line);
	// Lets FirmwareUpdateSection read current LED zones + brightness for
	// a backup, same reasoning as SensorTuningSection's _getSnapshot above.
	// Accent zone included too, so a backup/profile export captures the
	// cap's effect config, not just the per-sensor panel LEDs.
	(LedSection as unknown as { _getSnapshot: () => { sensors: SensorZone[]; brightness: number; accent: AccentZone } })._getSnapshot =
		() => ({ sensors, brightness, accent });
	// Lets the LED Pad Preview tab read current zones/colors AND push
	// changes back -- see the matching comment in the personal/dev build.
	(LedSection as unknown as { _getLedControls: () => LedControls })._getLedControls =
		() => ({ sensors, updateSensor, accent, updateAccent });

	const totalLeds = Math.max(16, ...sensors.map(s => s.ledOffset + s.ledCount));

	return (
		<div className="p-3 border rounded bg-white dark:bg-neutral-900">
			<button
				className="flex items-center justify-between w-full text-left mb-0"
				onClick={() => setLedOpen(o => !o)}
			>
				<span className="text-sm font-semibold">LED Panels</span>
				<span className="text-xs text-muted-foreground">{ledOpen ? "▲" : "▼"}</span>
			</button>

			{ledOpen && (
				<div className="mt-3 flex flex-col gap-3">

					{/* Per-sensor rows -- rendered in DISPLAY order (drag to
					    reorder), but each row's underlying sensorIndex
					    field still refers to the actual firmware sensor.
					    Dragging only changes visual order here, never
					    which physical FSR a row controls. */}
					<div className="flex flex-col gap-2">
						{Array.from({ length: sensors.length }, (_, position) => {
							const i = displayOrder.length === sensors.length
								? (displayOrder[position] ?? position)
								: position;
							const s = sensors[i];
							if (!s) return null;
							return (
								<div
									key={i}
									className={`flex items-center gap-2 transition-opacity ${ledDrag.draggingPos === position ? "opacity-40" : ""} ${ledDrag.dragOverPos === position ? "ring-2 ring-primary rounded" : ""}`}
									onDragOver={ledDrag.handleDragOver(position)}
									onDrop={ledDrag.handleDrop(position)}
								>
									<DragHandle
										onDragStart={ledDrag.handleDragStart(position)}
										onDragEnd={ledDrag.handleDragEnd}
									/>
									{/* Color swatch */}
									<div
										className="w-7 h-7 rounded-md border border-border shrink-0 cursor-pointer relative overflow-hidden"
										style={{ background: s.color }}
									>
										<input
											type="color"
											value={s.color}
											className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
											onChange={(e) => updateSensor(i, { color: e.target.value })}
										/>
									</div>
									{/* Label input */}
									<input
										type="text"
										value={s.label}
										maxLength={12}
										className="flex-1 text-xs bg-transparent border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
										onChange={(e) => updateSensor(i, { label: e.target.value })}
										placeholder={`S${i}`}
									/>
									{/* Editable firmware sensor index */}
									<div className="flex items-center gap-0.5 shrink-0">
										<span className="text-[10px] text-muted-foreground font-mono">#</span>
										<input
											type="number"
											min={0}
											max={15}
											value={s.sensorIndex}
											title="Firmware sensor index — must match position in kSensors[] in your .ino file"
											className="w-8 text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring text-center"
											onChange={(e) => {
												const v = parseInt(e.target.value);
												if (!isNaN(v) && v >= 0 && v <= 15) {
													updateSensor(i, { sensorIndex: v });
												}
											}}
										/>
									</div>
									{/* Remove button */}
									{sensors.length > 1 && (
										<button
											onClick={() => removeSensor(i)}
											className="text-xs text-muted-foreground hover:text-destructive transition-colors shrink-0"
											title="Remove sensor"
										>×</button>
									)}
								</div>
							);
						})}
						{/* Add sensor button */}
						<button
							onClick={addSensor}
							className="w-full text-xs py-1.5 rounded border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-border-secondary transition-colors"
						>
							+ Add FSR sensor
						</button>
					</div>

					{/* Brightness */}
					<div className="flex flex-col gap-1">
						<div className="flex items-center justify-between">
							<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Brightness</label>
							<span className="text-xs font-mono text-muted-foreground">{brightness}</span>
						</div>
						<input
							type="range" min={0} max={255} step={1} value={brightness}
							className="w-full h-1.5 accent-foreground cursor-pointer"
							onChange={(e) => setBrightness(Number(e.target.value))}
							onMouseUp={(e) => { setBrightness(Number((e.target as HTMLInputElement).value)); sendBrightness(Number((e.target as HTMLInputElement).value)); }}
							onTouchEnd={(e) => { setBrightness(Number((e.target as HTMLInputElement).value)); sendBrightness(Number((e.target as HTMLInputElement).value)); }}
						/>
					</div>

					{/* LED Zone per sensor */}
					<div className="flex flex-col gap-1 border border-border rounded p-2">
						<button
							className="flex items-center justify-between w-full text-left"
							onClick={() => setZoneOpen(o => !o)}
						>
							<span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">LED Zones</span>
							<span className="text-xs text-muted-foreground">{zoneOpen ? "▲" : "▼"}</span>
						</button>

						{zoneOpen && (
							<div className="mt-2 flex flex-col gap-2">
								<p className="text-[11px] text-muted-foreground">
									Offset = first LED on the strip (0-based). Count = how many LEDs to light.
								</p>

								{/* Strip preview -- a conflicted LED (claimed by more than one
								    sensor) gets a red hatched marker instead of silently
								    showing whichever sensor happens to come first in the
								    array, which is what the previous version did: it looked
								    identical to a normal, unshared LED even when two panels
								    were actually fighting over it. */}
								<div className="flex gap-0.5 flex-wrap">
									{Array.from({ length: totalLeds }, (_, li) => {
										const owners = sensors.filter(s => li >= s.ledOffset && li < s.ledOffset + s.ledCount);
										const conflicted = owners.length > 1;
										return (
											<div
												key={li}
												className={`w-4 h-4 rounded-sm border flex items-center justify-center ${conflicted ? "border-red-500 ring-1 ring-red-500" : "border-border"}`}
												style={{
													background: conflicted
														? "repeating-linear-gradient(45deg, #ef4444, #ef4444 2px, #1a1a1a 2px, #1a1a1a 4px)"
														: owners[0]?.color ?? "transparent",
												}}
												title={
													conflicted
														? `LED ${li} -- CONFLICT: claimed by ${owners.map(o => o.label).join(" + ")}`
														: `LED ${li}${owners[0] ? ` → ${owners[0].label}` : ""}`
												}
											>
												<span className="text-[8px] text-white/60 font-mono leading-none">{li}</span>
											</div>
										);
									})}
								</div>

								{(() => {
									const conflicts = findSensorZoneOverlaps(sensors);
									if (conflicts.length === 0) return null;
									return (
										<div className="flex flex-col gap-0.5">
											{conflicts.map((c, idx) => (
												<p key={idx} className="text-[10px] text-red-500">
													⚠ {c.a.label} and {c.b.label} both claim LED{c.from === c.to ? "" : "s"} {c.from}
													{c.from !== c.to ? `-${c.to}` : ""} -- each press overwrites
													whatever the other one last set there.
												</p>
											))}
										</div>
									);
								})()}

								{/* Zone inputs */}
								<div className="flex flex-col gap-1.5">
									<div className="grid grid-cols-[1fr_2.5rem_2.5rem] gap-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wide">
										<span>Sensor</span><span className="text-center">Offset</span><span className="text-center">Count</span>
									</div>
									{sensors.map((s, i) => (
										<div key={i} className="grid grid-cols-[1fr_2.5rem_2.5rem] gap-1 items-center">
											<div className="flex items-center gap-1 min-w-0">
												<div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: s.color }}/>
												<span className="text-[11px] text-muted-foreground truncate">{s.label} <span className="font-mono opacity-50">#{s.sensorIndex}</span></span>
											</div>
											<input
												type="number" min={0} max={63} value={s.ledOffset}
												className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
												onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) updateSensor(i, { ledOffset: Math.max(0, Math.min(63, v)) }); }}
											/>
											<input
												type="number" min={1} max={32} value={s.ledCount}
												className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
												onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) updateSensor(i, { ledCount: Math.max(1, Math.min(32, v)) }); }}
											/>
										</div>
									))}
								</div>
							</div>
						)}
					</div>

					{/* Accent / Cap LEDs -- a decorative, non-sensor zone (e.g. under
					    the cap/controller enclosure). Runs its own firmware-side
					    animation instead of reacting to an FSR, so it keeps
					    animating even without the dashboard connected -- only the
					    config (effect/speed/color/range) is pushed over serial. */}
					<div className="flex flex-col gap-1 border border-border rounded p-2">
						<button
							className="flex items-center justify-between w-full text-left"
							onClick={() => setAccentOpen(o => !o)}
						>
							<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
								<AccentPreviewStrip accent={accent} size={8} max={1} />
								Accent LEDs ({accent.label})
							</span>
							<span className="text-xs text-muted-foreground">{accentOpen ? "▲" : "▼"}</span>
						</button>

						{accentOpen && (
							<div className="mt-2 flex flex-col gap-2">
								<p className="text-[11px] text-muted-foreground">
									A decorative zone not tied to any FSR sensor -- e.g. LEDs
									under the cap or around the controller. Runs its own
									animation on the board itself.
								</p>

								<div className="flex items-center gap-2">
									<input
										type="text"
										value={accent.label}
										maxLength={16}
										className="flex-1 text-xs bg-transparent border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
										onChange={(e) => updateAccent({ label: e.target.value })}
										placeholder="Cap"
									/>
									{/* Hidden for Rainbow -- that effect cycles through every
									    hue on its own (including red) and never reads
									    accent.color at all, so leaving this swatch active while
									    Rainbow is selected made it look like picking a color
									    (e.g. purple) was randomly "turning red" -- really you
									    were just watching the rainbow cycle pass through red on
									    its way around, same as any other hue. The edit card
									    opened from the LEDs tab already hid this correctly; this
									    sidebar copy hadn't matched it until now. */}
									{accent.effect !== "rainbow" && (
										<div
											className="w-7 h-7 rounded-md border border-border shrink-0 cursor-pointer relative overflow-hidden"
											style={{ background: accent.color }}
										>
											<input
												type="color"
												value={accent.color}
												className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
												onChange={(e) => updateAccent({ color: e.target.value })}
											/>
										</div>
									)}
								</div>
								{accent.effect === "rainbow" && (
									<p className="text-[10px] text-muted-foreground -mt-1">
										Rainbow cycles through every color on its own -- there's no
										single color to set while it's selected.
									</p>
								)}

								{/* Live demo -- fills a square with an animated grid (not a
								    thin row of dots) so the effect visibly happens across a
								    shape, same math the firmware runs. */}
								<div className="flex flex-col gap-1 p-1.5 rounded border border-border bg-muted/10">
									<span className="text-[9px] text-muted-foreground uppercase tracking-wide">Live demo</span>
									<div className="relative w-full aspect-square max-w-[140px] mx-auto rounded overflow-hidden border border-border/60">
										<AccentRimDemo accent={accent} cellSize={8} count={20} />
									</div>
								</div>

								<div className="grid grid-cols-2 gap-1.5">
									{(Object.keys(ACCENT_EFFECT_LABELS) as AccentEffect[]).map((fx) => (
										<button
											key={fx}
											onClick={() => updateAccent({ effect: fx })}
											className={`text-xs py-1 rounded border transition-colors ${
												accent.effect === fx
													? "bg-foreground text-background border-foreground"
													: "bg-transparent text-muted-foreground border-border hover:text-foreground"
											}`}
										>
											{ACCENT_EFFECT_LABELS[fx]}
										</button>
									))}
								</div>

								{accent.effect !== "off" && accent.effect !== "rainbow" && accent.effect !== "solid" && (
									<p className="text-[10px] text-muted-foreground -mt-1">Uses the color swatch above.</p>
								)}

								{/* Speed has no meaning for a static color -- hidden for Solid
								    too (it never actually did anything to it; see
								    useAccentPreviewFrame's fix for why it looked like it was). */}
								{accent.effect !== "off" && accent.effect !== "solid" && (
									<div className="flex flex-col gap-1">
										<div className="flex items-center justify-between">
											<label className="text-[10px] text-muted-foreground uppercase tracking-wide">Speed</label>
											<span className="text-xs font-mono text-muted-foreground">{accent.speed}</span>
										</div>
										<input
											type="range" min={1} max={255} step={1} value={accent.speed}
											className="w-full h-1.5 accent-foreground cursor-pointer"
											onChange={(e) => setAccent(a => ({ ...a, speed: Number(e.target.value) }))}
											onMouseUp={(e) => updateAccent({ speed: Number((e.target as HTMLInputElement).value) })}
											onTouchEnd={(e) => updateAccent({ speed: Number((e.target as HTMLInputElement).value) })}
										/>
									</div>
								)}

								<div className="grid grid-cols-[1fr_2.5rem_2.5rem] gap-1 items-center">
									<span className="text-[10px] text-muted-foreground uppercase tracking-wide">Range</span>
									<input
										type="number" min={0} max={255} value={accent.ledOffset}
										title="LED Offset -- first LED in this zone"
										className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
										onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) updateAccent({ ledOffset: Math.max(0, Math.min(255, v)) }); }}
									/>
									<input
										type="number" min={1} max={64} value={accent.ledCount}
										title="LED Count"
										className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
										onChange={(e) => { const v = parseInt(e.target.value); if (!isNaN(v)) updateAccent({ ledCount: Math.max(1, Math.min(64, v)) }); }}
									/>
								</div>
								<p className="text-[10px] text-muted-foreground">
									Offset/Count are just LED indices on the same strip -- keep
									them outside your sensor panels' ranges (defaults to 32+)
									so the two don't overlap.
								</p>
								{(() => {
									const overlapping = findAccentOverlap(accent, sensors);
									if (overlapping.length === 0) return null;
									return (
										<p className="text-[10px] text-amber-500">
											⚠ Overlaps {overlapping.map((s) => s.label).join(", ")}'s LED
											range -- pressing {overlapping.length > 1 ? "those sensors" : "that sensor"} will
											steal these LEDs while held, and they may stay black after
											release until this zone is touched again. Move this Offset
											past LED {Math.max(...overlapping.map((s) => s.ledOffset + s.ledCount))} or
											move {overlapping.length > 1 ? "their" : "its"} zone to fix.
										</p>
									);
								})()}
							</div>
						)}
					</div>

					{/* Built-in presets */}
					<div className="flex flex-col gap-1">
						<span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Built-in presets</span>
						<div className="flex flex-wrap gap-1">
							{BUILTIN_PRESETS.map((preset) => (
								<button
									key={preset.name}
									onClick={() => applyPreset(preset)}
									className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-border bg-transparent hover:bg-accent hover:text-accent-foreground transition-colors"
								>
									<span className="flex gap-0.5">
										{preset.sensors.slice(0, 6).map((s, ci) => (
											<span key={ci} className="inline-block w-2 h-2 rounded-full" style={{ background: s.color }}/>
										))}
									</span>
									{preset.name}
								</button>
							))}
						</div>
					</div>

					{/* Custom presets */}
					<div className="flex flex-col gap-1">
						<div className="flex items-center justify-between">
							<span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">My presets</span>
							<button
								className="text-[11px] text-muted-foreground hover:text-foreground transition-colors"
								onClick={() => setShowSaveInput(v => !v)}
							>
								{showSaveInput ? "Cancel" : "+ Save current"}
							</button>
						</div>
						{showSaveInput && (
							<div className="flex gap-1 mt-1">
								<input
									type="text" placeholder="Preset name…" value={newPresetName} maxLength={32}
									className="flex-1 text-xs bg-transparent border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
									onChange={(e) => setNewPresetName(e.target.value)}
									onKeyDown={(e) => { if (e.key === "Enter") saveCurrentAsPreset(); }}
									autoFocus
								/>
								<Button size="sm" variant="outline" className="text-xs px-2 shrink-0"
									onClick={saveCurrentAsPreset} disabled={!newPresetName.trim()}>
									Save
								</Button>
							</div>
						)}
						{customPresets.length === 0 && !showSaveInput && (
							<p className="text-[11px] text-muted-foreground italic">No custom presets yet.</p>
						)}
						<div className="flex flex-wrap gap-1">
							{customPresets.map((preset, idx) => (
								<div key={idx} className="flex items-center gap-0.5">
									<button onClick={() => applyPreset(preset)}
										className="flex items-center gap-1 px-2 py-1 text-xs rounded-l border border-border bg-transparent hover:bg-accent hover:text-accent-foreground transition-colors">
										<span className="flex gap-0.5">
											{preset.sensors.slice(0,6).map((s, ci) => (
												<span key={ci} className="inline-block w-2 h-2 rounded-full" style={{ background: s.color }}/>
											))}
										</span>
										{preset.name}
									</button>
									<button onClick={() => deleteCustomPreset(idx)}
										className="px-1.5 py-1 text-xs rounded-r border border-l-0 border-border bg-transparent hover:bg-destructive hover:text-destructive-foreground transition-colors text-muted-foreground"
										title="Delete preset">×</button>
								</div>
							))}
						</div>
					</div>

					<Button variant="outline" size="sm" className="w-full text-xs" disabled={!connected}
						onClick={() => sendText("q\n")}>
						Sync LEDs from Pad
					</Button>

					{!connected && (
						<p className="text-[11px] text-muted-foreground text-center">Connect to pad to control LEDs</p>
					)}
				</div>
			)}
		</div>
	);
}

/*===========================================================================*/

/*===========================================================================*/
// SENSOR TUNING SECTION — gain, trigger threshold, release threshold.
// Mirrors the firmware's "y", "r", "g", "p" serial commands added in
// fsr_gain_dualthresh.ino. Helps fix missed double-taps at high speed by
// giving a wide, independently adjustable ON/OFF gap per sensor, plus a
// gain multiplier for weaker FSR variants (e.g. UX FSR 406).

// Bridge shape returned by SensorTuningSection's _getControls() (see the
// static-property pattern used throughout this file for cross-component
// access without a full state-lift). Powers the compact Gain/Release
// Debounce/Button Group controls rendered inline under each sensor's wave
// in the main view.
interface SensorTuningControls {
	tuning: SensorTuning[];
	effectiveCount: number;
	sensorLabels: string[];
	commitGain: (i: number, val: number) => void;
	commitButtonGroup: (i: number, group: number) => void;
	commitReleaseDebounce: (i: number, ms: number) => void;
}

interface SensorTuning {
	trigger: number;          // 0-1023, ON threshold
	release: number;          // 0-1023, OFF threshold (must be < trigger)
	gainX100: number;         // 10-500, where 100 = 1.0x
	buttonGroup: number;      // sensors sharing the same group register as ONE
	                          // joystick button to ITGMania. Defaults to the
	                          // sensor's own index (no sharing).
	releaseDebounceMs: number; // 0-100ms. How long the sensor must read
	                          // continuously below Release before actually
	                          // releasing -- protects long holds from being
	                          // cut short by brief, real-world pressure
	                          // noise (e.g. resting weight shifting on a
	                          // metal pad panel). 0 = instant release.
}

// Scopes a localStorage base key to a specific physical board, when known.
// deviceId is the uppercase hex chip ID reported by newer firmware's "i"
// command (see PrintUniqueChipId() in the firmware sketch). When null
// (older firmware, or no board connected yet), falls back to the plain
// unscoped key -- this is what every persisted setting used before
// per-device scoping existed, so it's also what a single-pad user with
// unupdated firmware continues to see, unchanged.
function scopedKey(base: string, deviceId: string | null): string {
	return deviceId ? `${base}:${deviceId}` : base;
}

const LS_TUNING_KEY = "webfsr_sensor_tuning_v3";

// Shared with the "reset to default" buttons on Gain and Release Debounce --
// kept as named constants, in one place, so the displayed "Default: ..." text
// and the reset buttons can never drift out of sync with each other or with
// the fallback values used elsewhere in this file (loadTuning, the
// numSensors-resize effect, etc.).
const DEFAULT_GAIN_X100 = 100;
const DEFAULT_RELEASE_DEBOUNCE_MS = 15;

// Release's default isn't a fixed number -- it's always 20 below whatever
// Trigger currently is, clamped so it can't go negative for a very low
// Trigger. Used by both the "(default ...)" label and the reset button next
// to the main bar's Release readout.
const RELEASE_DEFAULT_GAP = 20;
const defaultReleaseFor = (trigger: number | undefined) => Math.max(0, (trigger ?? 512) - RELEASE_DEFAULT_GAP);

// "Lock Release to Trigger" per-sensor toggle (main-page bar controls,
// separate from the sidebar's tuning array) -- was previously plain
// useState with no persistence at all, so it silently reset to "off" for
// every sensor on any reload, reconnect, or navigation. Given its own
// small localStorage key rather than folding it into SensorTuning, since
// it lives in the Dashboard component, not SensorTuningSection.
const LS_RELEASE_LOCKED_KEY = "webfsr_release_locked_v1";
function loadReleaseLocked(deviceId: string | null): Record<number, boolean> {
	try {
		const raw = localStorage.getItem(scopedKey(LS_RELEASE_LOCKED_KEY, deviceId));
		if (!raw) return {};
		const parsed = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
function saveReleaseLocked(next: Record<number, boolean>, deviceId: string | null) {
	try {
		localStorage.setItem(scopedKey(LS_RELEASE_LOCKED_KEY, deviceId), JSON.stringify(next));
	} catch {
		// Storage full/unavailable -- not persisting is a minor UX
		// regression, not worth surfacing an error for.
	}
}

// ── Tuning external store ───────────────────────────────────────────────
// See the matching comment in the personal/dev dashboard build for the
// full rationale -- in short, SensorMiniControls sits inside the
// sensor-bar grid, which re-renders on every incoming sensor reading.
// Pulling tuning via a plain function call on every one of those was the
// actual cause of reported lag. SensorTuningSection publishes a new
// snapshot only when `tuning` actually changes; SensorMiniControls
// subscribes via useSyncExternalStore, decoupled from the tick rate.
let tuningStoreSnapshot: SensorTuning[] = [];
const tuningStoreListeners = new Set<() => void>();
function publishTuningStore(next: SensorTuning[]) {
	tuningStoreSnapshot = next;
	tuningStoreListeners.forEach((l) => l());
}
function subscribeTuningStore(callback: () => void) {
	tuningStoreListeners.add(callback);
	return () => tuningStoreListeners.delete(callback);
}
function getTuningStoreSnapshot() {
	return tuningStoreSnapshot;
}

// ── LED sensor external store ── see matching comment in the personal/
// dev build for the full reasoning.
let ledStoreSnapshot: SensorZone[] = [];
const ledStoreListeners = new Set<() => void>();
function publishLedStore(next: SensorZone[]) {
	ledStoreSnapshot = next;
	ledStoreListeners.forEach((l) => l());
}
function subscribeLedStore(callback: () => void) {
	ledStoreListeners.add(callback);
	return () => ledStoreListeners.delete(callback);
}
function getLedStoreSnapshot() {
	return ledStoreSnapshot;
}

// ── Accent zone external store ── same pattern/reasoning as the LED
// sensor store just above -- LedPadPreview needs its own subscription to
// the accent zone so it re-renders live as it's edited from the sidebar.
let accentStoreSnapshot: AccentZone = { ...DEFAULT_ACCENT_ZONE };
const accentStoreListeners = new Set<() => void>();
function publishAccentStore(next: AccentZone) {
	accentStoreSnapshot = next;
	accentStoreListeners.forEach((l) => l());
}
function subscribeAccentStore(callback: () => void) {
	accentStoreListeners.add(callback);
	return () => accentStoreListeners.delete(callback);
}
function getAccentStoreSnapshot() {
	return accentStoreSnapshot;
}

function loadTuning(count: number, deviceId: string | null): SensorTuning[] {
	try {
		const raw = localStorage.getItem(scopedKey(LS_TUNING_KEY, deviceId));
		const saved = raw ? (JSON.parse(raw) as SensorTuning[]) : null;
		if (saved && saved.length > 0) {
			// Never truncate saved data on load, even if `count` (which can
			// be a transient fallback value like 4) is smaller than what
			// was actually saved -- only pad with defaults if we need MORE
			// entries than what's saved. Truncating here risked losing
			// Trigger/Release/Gain for sensors beyond `count` if this ever
			// ran with a stale/fallback count at mount time.
			if (saved.length >= count) return saved;
			return [
				...saved,
				...Array.from({ length: count - saved.length }, (_, i) => ({
					trigger: 700, release: 300, gainX100: 100, buttonGroup: saved.length + i, releaseDebounceMs: 15,
				})),
			];
		}
	} catch {}
	return Array.from({ length: count }, (_, i) => ({
		trigger: 700, release: 300, gainX100: 100, buttonGroup: i, releaseDebounceMs: 15,
	}));
}
function saveTuning(t: SensorTuning[], deviceId: string | null) {
	localStorage.setItem(scopedKey(LS_TUNING_KEY, deviceId), JSON.stringify(t));
}

interface SensorTuningSectionProps {
	connected: boolean;
	sendText: (text: string) => void;
	numSensors: number;
	latestValues: number[];
	sensorLabels: string[];
	advancedEnabled: boolean;
	onToggleAdvancedMode: () => void;
	// Reports the current Trigger AND Release thresholds for every sensor
	// up to Dashboard whenever either changes, so the main page sensor
	// bars can show the values the firmware is ACTUALLY using once
	// Advanced mode is on, instead of the stale legacy `thresholds` array
	// which no longer reflects reality the moment Trigger/Release diverge
	// from it.
	onTuningValuesChange?: (triggers: number[], releases: number[]) => void;
	displayOrder: number[];
	moveDisplayPosition: (fromPos: number, toPos: number) => void;
	// Uppercase hex chip ID of the connected board, or null -- see the
	// matching comment on Dashboard's deviceId state. Used to load/save
	// `tuning` under a per-board key instead of one shared globally.
	deviceId: string | null;
}

const LS_ADVANCED_MODE_KEY = "webfsr_advanced_tuning_enabled";

function loadAdvancedMode(): boolean {
	try {
		return localStorage.getItem(LS_ADVANCED_MODE_KEY) === "true";
	} catch {
		return false;
	}
}
function saveAdvancedMode(enabled: boolean) {
	localStorage.setItem(LS_ADVANCED_MODE_KEY, enabled ? "true" : "false");
}

function SensorTuningSection({
	connected,
	sendText,
	numSensors,
	latestValues,
	sensorLabels,
	advancedEnabled,
	onToggleAdvancedMode,
	onTuningValuesChange,
	displayOrder,
	moveDisplayPosition,
	deviceId,
}: SensorTuningSectionProps) {
	const effectiveCount = numSensors > 0 ? numSensors : 4;
	const [tuning, setTuning] = useState<SensorTuning[]>(() => loadTuning(effectiveCount, deviceId));

	// deviceId arrives asynchronously (only known once the identify
	// response comes back after connecting), so the useState initializer
	// above ran with whatever deviceId was at mount -- almost always null
	// the very first time. Re-load once the real board ID is known so
	// this board's own saved tuning is picked up instead of staying on
	// whatever the unscoped/previous-board fallback loaded. Intentionally
	// does NOT fire on every reconnect of the SAME board (deviceId
	// unchanged -> effect doesn't re-run), so it won't fight with the
	// live "p" responses already keeping `tuning` in sync with the
	// firmware in the meantime.
	const prevDeviceIdRef = useRef<string | null>(deviceId);
	useEffect(() => {
		if (deviceId === prevDeviceIdRef.current) return;
		prevDeviceIdRef.current = deviceId;
		setTuning(loadTuning(effectiveCount, deviceId));
	}, [deviceId]);

	const toggleAdvancedMode = onToggleAdvancedMode;

	// Report current Trigger AND Release values up to Dashboard every time
	// they change, so the main page sensor bars can reflect what the
	// firmware is actually using once Advanced mode is on.
	useEffect(() => {
		onTuningValuesChange?.(tuning.map((t) => t.trigger), tuning.map((t) => t.release));
	}, [tuning, onTuningValuesChange]);

	// Publish to the external store consumed by SensorMiniControls.
	useEffect(() => {
		publishTuningStore(tuning);
	}, [tuning]);

	// Grow/shrink tuning array if sensor count changes.
	//
	// IMPORTANT: only do this when numSensors is a TRUSTWORTHY real count
	// from the firmware (i.e. > 0), never based on the effectiveCount
	// fallback-to-4 used elsewhere for display purposes. numSensors
	// briefly resets to 0 in the global store during a disconnect/
	// reconnect cycle (see useSerialPort.ts) -- if this effect reacted
	// to that and "resized" tuning down to the fallback of 4, it would
	// PERMANENTLY destroy and overwrite (via saveTuning) any
	// Trigger/Release/Gain values for sensors 4-7 on an 6 or 8-sensor
	// pad, the moment numSensors flickered to 0 mid-reconnect -- even
	// though the real sensor count never actually changed. This was the
	// cause of Advanced Tuning settings appearing to "reset" on reconnect.
	useEffect(() => {
		if (numSensors > 0 && numSensors !== tuning.length) {
			const next = Array.from({ length: numSensors }, (_, i) =>
				tuning[i] ?? {
					trigger: 700, release: 300, gainX100: 100, buttonGroup: i, releaseDebounceMs: 15,
				}
			);
			setTuning(next);
			saveTuning(next, deviceId);
		}
	}, [numSensors]);

	// Parse "p <sensor> <trigger> <release> <gain> <buttonGroup>
	//        <releaseDebounceMs> <liveValue>"
	// responses from the firmware so the UI reflects what's actually saved
	// on the pad. Tolerates older firmware sending fewer fields, so this
	// doesn't break against a not-yet-reflashed pad.
	const handleTuningLine = (line: string) => {
		if (!line.startsWith("p ")) return false;
		const nums = line.slice(2).trim().split(/\s+/).map(Number);
		if (nums.length < 6) return false;
		const hasDebounceField = nums.length >= 7;
		const [sensor, trigger, release, gain, buttonGroup, maybeDebounce] = nums;
		const releaseDebounceMs = hasDebounceField ? maybeDebounce : 15;
		setTuning((prev) => {
			if (sensor < 0 || sensor >= prev.length) return prev;
			const updated = [...prev];
			updated[sensor] = { trigger, release, gainX100: gain, buttonGroup, releaseDebounceMs };
			saveTuning(updated, deviceId);
			return updated;
		});
		return true;
	};

	(SensorTuningSection as unknown as { _handleLine: (l: string) => boolean })._handleLine = handleTuningLine;
	// Lets FirmwareUpdateSection read the current in-memory tuning state
	// for a backup, without a serial round-trip -- this dashboard's state
	// already mirrors the board as long as it's been synced/connected.
	(SensorTuningSection as unknown as { _getSnapshot: () => SensorTuning[] })._getSnapshot = () => tuning;
	// Lets the main sensor-bar grid render Gain/Release Debounce/Button
	// Group as compact inline controls directly under each sensor's wave,
	// while this component keeps owning the actual `tuning` state, EEPROM
	// sync-on-connect, and serial parsing.
	(SensorTuningSection as unknown as { _getControls: () => SensorTuningControls })._getControls = () => ({
		tuning,
		effectiveCount,
		sensorLabels,
		commitGain,
		commitButtonGroup,
		commitReleaseDebounce,
	});

	// Query all sensors' tuning on connect
	const hasQueriedRef = useRef(false);
	useEffect(() => {
		if (connected && !hasQueriedRef.current) {
			hasQueriedRef.current = true;
			setTimeout(() => {
				for (let i = 0; i < effectiveCount; i++) {
					sendText(`p ${i}\n`);
				}
			}, 500);
		}
		if (!connected) hasQueriedRef.current = false;
	}, [connected, sendText, effectiveCount]);

	const sendGain    = (i: number, val: number) => { if (connected) sendText(`g ${i} ${val}\n`); };
	const sendButtonGroup = (i: number, group: number) => { if (connected) sendText(`m ${i} ${group}\n`); };
	const sendReleaseDebounce = (i: number, ms: number) => { if (connected) sendText(`d ${i} ${ms}\n`); };

	const updateTuning = (i: number, patch: Partial<SensorTuning>) => {
		const updated = tuning.map((t, idx) => idx === i ? { ...t, ...patch } : t);
		setTuning(updated);
		saveTuning(updated, deviceId);
	};

	const commitGain    = (i: number, val: number) => { updateTuning(i, { gainX100: val }); sendGain(i, val); };
	const commitButtonGroup = (i: number, group: number) => { updateTuning(i, { buttonGroup: group }); sendButtonGroup(i, group); };
	const commitReleaseDebounce = (i: number, ms: number) => { updateTuning(i, { releaseDebounceMs: ms }); sendReleaseDebounce(i, ms); };

	return (
		// The old collapsible "Sensor Tuning" sidebar panel (Advanced mode
		// toggle, per-sensor Trigger/Release cards, gap warning, quick
		// presets) has been removed -- it
		// duplicated controls that now live on the main page (the "Sensor
		// Tuning: On/Off" toggle, the bar's Trigger/Release lines, the
		// Release readout + reset, and the always-visible Gain/Debounce/
		// Button Group mini controls). Only "Sync Sensor
		// Tuning from Pad" was unique to this panel, so that's what's kept
		// here -- renamed from the old "Sync from pad" label so it's not
		// visually identical to LedSection's own (different) sync button.
		// All of this component's actual state/logic (tuning, firmware "p"
		// line parsing, the _handleLine/_getSnapshot/_getControls bridges)
		// is untouched -- only the old duplicate UI is gone.
		<Button
			variant="outline"
			size="sm"
			className="w-full text-xs"
			disabled={!connected}
			onClick={() => { for (let i = 0; i < effectiveCount; i++) sendText(`p ${i}\n`); }}
		>
			Sync Sensor Tuning from Pad
		</Button>
	);
}

/*=============================================================================
 FIRMWARE UPDATE SECTION
=============================================================================*/

// Everything the update checker needs, resolved from a GitHub Release
// rather than a separately-hosted manifest file -- one less thing to keep
// in sync. See parseGitHubRelease() below for exactly what each release
// needs to contain.
interface FirmwareManifest {
	version: string;        // from the release's tag name, e.g. "1.1.0"
	eepromSchema: string;   // 2-hex-digit marker, e.g. "A8" -- compared
	                         // against the board's current schema to warn
	                         // BEFORE flashing if calibration will reset.
	hexUrl: string;         // direct download URL for the compiled .hex
	notes?: string;         // release body, shown as the changelog
}

// Fill this in with your actual GitHub repo.
const GITHUB_REPO = "PerusalCoding/webfsr"; // e.g. "PerusalCoding/webfsr"

// Minimal slice of GitHub's Releases API response we actually use.
// Full shape: https://docs.github.com/en/rest/releases/releases#get-the-latest-release
interface GitHubRelease {
	tag_name: string;
	body: string | null;
	assets: { name: string; browser_download_url: string }[];
}

// RELEASE AUTHORING CONVENTION -- follow this each time you cut a release
// on GitHub, and the dashboard picks everything up automatically with no
// separate manifest file to maintain:
//
//   1. Tag the release with the version (e.g. "v1.1.0" or "1.1.0" --
//      either works, the leading "v" is stripped automatically).
//   2. Attach the compiled Fsr_Master_Public.ino.hex as a release asset.
//      The filename just needs to END in ".hex" -- anything before that
//      is fine (e.g. "Fsr_Master_Public_v1.1.0.hex").
//   3. Somewhere in the release description (the "notes"/body field),
//      include a line exactly like:
//          EEPROM_SCHEMA: A8
//      matching kEepromSchema in that release's Fsr_Master_Public.ino.
//      This is what lets the dashboard warn customers BEFORE flashing if
//      an update will reset their calibration. If this line is missing,
//      the dashboard assumes the schema changed (safest default -- it'll
//      just show the reset warning even if it turns out not to be
//      necessary, rather than risk silently skipping a real warning).
//   4. The rest of the release body is shown to customers as-is, so
//      write it like a real changelog.
function parseGitHubRelease(release: GitHubRelease): FirmwareManifest | null {
	const version = release.tag_name.replace(/^v/i, "");
	const hexAsset = release.assets.find((a) => a.name.toLowerCase().endsWith(".hex"));
	if (!hexAsset) return null; // no usable firmware attached to this release
	const schemaMatch = release.body?.match(/EEPROM_SCHEMA:\s*([0-9A-Fa-f]{2})/);
	return {
		version,
		eepromSchema: schemaMatch ? schemaMatch[1].toUpperCase() : "??", // "??" never matches a real schema -> always shows the reset warning, the safe default
		hexUrl: hexAsset.browser_download_url,
		notes: release.body ?? undefined,
	};
}

// Full snapshot of everything worth backing up before a firmware update:
// per-sensor tuning (Trigger/Release/Gain/Group/Debounce) plus LED zones
// and brightness. Saved as a plain JSON file the customer keeps on their
// own machine -- also doubles as a general "export my settings" feature
// independent of updates, e.g. for sharing a known-good config or moving
// to a new PC.
interface BackupFile {
	kind: "webfsr-backup";
	savedAt: string;             // ISO timestamp
	firmwareVersion: string;     // version running WHEN this backup was taken
	eepromSchema: string;
	sensors: SensorTuning[];
	led: { sensors: SensorZone[]; brightness: number; accent?: AccentZone };
}

interface FirmwareUpdateSectionProps {
	connected: boolean;
	sendText: (text: string) => void;
	connect: () => void;
	disconnect: () => void;
	// Fires whenever the identify response's chip ID field changes (a new
	// value on connect, or null on disconnect/for older firmware that
	// doesn't send one). Lets Dashboard scope localStorage-persisted
	// settings (Advanced Tuning, Lock Release to Trigger, etc.) per
	// physical board, so two pads connected at once on different COM
	// ports stop clobbering each other's saved settings -- see the
	// matching comment on PrintUniqueChipId() in the firmware sketch.
	onDeviceIdChange?: (deviceId: string | null) => void;
}

// Minimal shape of what preload.cjs exposes for firmware flashing. Declared
// here rather than in a shared .d.ts so this file stays self-contained --
// move it to a proper global declaration if other components need it too.
interface WebFsrElectronAPI {
	checkFirmwareLoaderAvailable: () => Promise<{ available: boolean; path: string; platform: string }>;
	flashFirmware: (hexBytes: ArrayBuffer) => Promise<{ success: boolean }>;
	onFirmwareFlashProgress: (callback: (line: string) => void) => () => void;
}
declare global {
	interface Window { electronAPI?: WebFsrElectronAPI; }
}

function FirmwareUpdateSection({ connected, sendText, connect, disconnect, onDeviceIdChange }: FirmwareUpdateSectionProps) {
	const [currentVersion, setCurrentVersion] = useState<string | null>(null);
	const [currentSchema, setCurrentSchema] = useState<string | null>(null);
	const [manifest, setManifest] = useState<FirmwareManifest | null>(null);
	const [checkError, setCheckError] = useState<string | null>(null);
	const [checking, setChecking] = useState(false);
	const [backupDone, setBackupDone] = useState(false);
	const [lastBackup, setLastBackup] = useState<BackupFile | null>(null);
	const [restoreStatus, setRestoreStatus] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);

	// Flashing state
	const [flashing, setFlashing] = useState(false);
	const [flashLog, setFlashLog] = useState<string[]>([]);
	const [flashError, setFlashError] = useState<string | null>(null);
	const [flashSucceeded, setFlashSucceeded] = useState(false);
	const [awaitingReconnect, setAwaitingReconnect] = useState(false);

	// Parse "i <version> <schema_hex> <num_sensors> <chip_id_hex>" identify
	// responses. <chip_id_hex> is a newer field -- older firmware only
	// sends the first 3 fields, in which case deviceId is reported as
	// null and callers fall back to their previous (unscoped) behavior.
	const handleIdentifyLine = (line: string) => {
		if (!line.startsWith("i ")) return false;
		const parts = line.slice(2).trim().split(/\s+/);
		if (parts.length < 2) return false;
		setCurrentVersion(parts[0]);
		setCurrentSchema(parts[1].toUpperCase());
		onDeviceIdChange?.(parts.length >= 4 ? parts[3].toUpperCase() : null);
		return true;
	};
	(FirmwareUpdateSection as unknown as { _handleLine: (l: string) => boolean })._handleLine = handleIdentifyLine;

	// Ask the board to identify itself once connected.
	useEffect(() => {
		if (connected) {
			sendText("i\n");
		} else {
			// Disconnected -- this board's ID no longer applies. Cleared
			// explicitly rather than left stale, since a stale deviceId
			// left over from the last board could cause the NEXT board
			// connected (if identify hasn't responded yet) to briefly read/
			// write under the wrong board's scoped keys.
			onDeviceIdChange?.(null);
		}
	}, [connected]);

	// After a successful flash, WebSerial requires a genuine user click to
	// reconnect (it won't let us call connect() programmatically from an
	// async callback) -- so we just wait here for `connected` to flip true
	// again from the user clicking "Reconnect", then auto-replay the
	// backup taken right before the flash. This is what actually closes
	// the loop so an update feels like one smooth action instead of two.
	useEffect(() => {
		if (connected && awaitingReconnect && lastBackup) {
			setAwaitingReconnect(false);
			sendText("i\n"); // refresh version display to confirm the new firmware
			applyBackup(lastBackup);
		}
	}, [connected, awaitingReconnect, lastBackup]);

	const checkForUpdates = async () => {
		setChecking(true);
		setCheckError(null);
		try {
			// GitHub's REST API sends CORS headers on public GET endpoints,
			// so this works as a plain fetch straight from the renderer --
			// no proxy or main-process involvement needed. Unauthenticated
			// requests are capped at 60/hour per IP, which is comfortably
			// enough for customers occasionally clicking "Check for
			// Updates" -- not something to worry about at this scale.
			const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
				headers: { Accept: "application/vnd.github+json" },
				cache: "no-store",
			});
			if (!res.ok) throw new Error(`GitHub returned ${res.status} -- check GITHUB_REPO is set correctly`);
			const release = (await res.json()) as GitHubRelease;
			const data = parseGitHubRelease(release);
			if (!data) throw new Error("Latest release has no .hex file attached");
			setManifest(data);
		} catch (err) {
			setCheckError(err instanceof Error ? err.message : "Couldn't check for updates");
		} finally {
			setChecking(false);
		}
	};

	const updateAvailable = manifest && currentVersion && manifest.version !== currentVersion;
	const schemaWillChange = manifest && currentSchema && manifest.eepromSchema.toUpperCase() !== currentSchema;

	// Gathers a full snapshot from the OTHER sections' live in-memory state
	// via the _getSnapshot bridge (same pattern as _handleLine above) --
	// this reflects whatever the dashboard currently has synced from the
	// board, not a fresh serial round-trip.
	const gatherBackup = (): BackupFile | null => {
		const tuningSnapshot = (SensorTuningSection as unknown as { _getSnapshot?: () => SensorTuning[] })._getSnapshot?.();
		const ledSnapshot = (LedSection as unknown as { _getSnapshot?: () => { sensors: SensorZone[]; brightness: number; accent: AccentZone } })._getSnapshot?.();
		if (!tuningSnapshot || !ledSnapshot) return null;
		return {
			kind: "webfsr-backup",
			savedAt: new Date().toISOString(),
			firmwareVersion: currentVersion ?? "unknown",
			eepromSchema: currentSchema ?? "unknown",
			sensors: tuningSnapshot,
			led: ledSnapshot,
		};
	};

	const downloadBackup = () => {
		const backup = gatherBackup();
		if (!backup) {
			setRestoreStatus("Couldn't read current settings -- make sure the pad is connected and synced first.");
			return;
		}
		const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `webfsr-backup-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
		setBackupDone(true);
		setLastBackup(backup); // kept in memory too, so a post-update auto-restore doesn't need the file
	};

	// Replays a backup back over serial -- shared by the manual "Restore
	// My Settings" file-picker flow AND the automatic post-update restore.
	// Small delay between commands so the firmware's serial buffer/EEPROM
	// writes aren't hammered back-to-back (mirrors the delay pattern
	// already used elsewhere for applying LED presets).
	const applyBackup = (backup: BackupFile) => {
		if (!connected) {
			setRestoreStatus("Connect to the pad before restoring.");
			return;
		}
		setRestoreStatus("Restoring...");
		let delay = 0;
		const step = 60; // ms between commands
		backup.sensors.forEach((s, i) => {
			setTimeout(() => sendText(`y ${i} ${s.trigger}\n`), delay += step);
			setTimeout(() => sendText(`r ${i} ${s.release}\n`), delay += step);
			setTimeout(() => sendText(`g ${i} ${s.gainX100}\n`), delay += step);
			setTimeout(() => sendText(`m ${i} ${s.buttonGroup}\n`), delay += step);
			setTimeout(() => sendText(`d ${i} ${s.releaseDebounceMs}\n`), delay += step);
		});
		backup.led.sensors.forEach((s) => {
			const { r, g, b } = hexToRgb(s.color);
			setTimeout(() => sendText(`l ${s.sensorIndex} ${r} ${g} ${b}\n`), delay += step);
			setTimeout(() => sendText(`z ${s.sensorIndex} ${s.ledOffset} ${s.ledCount}\n`), delay += step);
		});
		setTimeout(() => sendText(`b ${backup.led.brightness}\n`), delay += step);
		// Accent/cap zone -- optional field, so backups taken before this
		// feature existed just skip this step and leave the cap as-is.
		if (backup.led.accent) {
			const az = backup.led.accent;
			const { r, g, b } = hexToRgb(az.color);
			setTimeout(() => sendText(`a ${az.ledOffset} ${az.ledCount} ${ACCENT_EFFECT_TO_NUM[az.effect]} ${az.speed} ${r} ${g} ${b}\n`), delay += step);
		}
		setTimeout(() => setRestoreStatus(`Restored ${backup.sensors.length} sensor(s) from backup taken ${new Date(backup.savedAt).toLocaleString()}.`), delay += step);
	};

	const restoreFromFile = (file: File) => {
		setRestoreStatus("Restoring...");
		file.text().then((text) => {
			let backup: BackupFile;
			try {
				backup = JSON.parse(text);
			} catch {
				setRestoreStatus("That file doesn't look like a valid backup.");
				return;
			}
			if (backup.kind !== "webfsr-backup") {
				setRestoreStatus("That file doesn't look like an Awakened Animus backup.");
				return;
			}
			applyBackup(backup);
		});
	};

	// The actual one-click update flow. Requires window.electronAPI (i.e.
	// running inside the Electron app, not a bare browser tab) since
	// flashing needs Node's child_process to run teensy_loader_cli --
	// something a web page fundamentally can't do on its own.
	const updateNow = async () => {
		if (!manifest) return;
		setFlashError(null);
		setFlashLog([]);
		setFlashSucceeded(false);

		if (!window.electronAPI) {
			setFlashError("One-click updates only work in the Awakened Animus desktop app, not a browser tab.");
			return;
		}

		const loaderCheck = await window.electronAPI.checkFirmwareLoaderAvailable();
		if (!loaderCheck.available) {
			setFlashError(`Firmware loader isn't set up on this install (expected at ${loaderCheck.path}).`);
			return;
		}

		setFlashing(true);
		const unsubscribe = window.electronAPI.onFirmwareFlashProgress((line) => {
			setFlashLog((prev) => [...prev, line]);
		});

		try {
			setFlashLog((prev) => [...prev, `Downloading firmware v${manifest.version}...`]);
			const res = await fetch(manifest.hexUrl);
			if (!res.ok) throw new Error(`Couldn't download firmware (server returned ${res.status})`);
			const hexBytes = await res.arrayBuffer();

			// Release the WebSerial connection so the OS/USB stack is free
			// for teensy_loader_cli to find the board once it reboots into
			// its bootloader.
			await disconnect();

			setFlashLog((prev) => [...prev, "Press and release the button on your Teensy now to enter update mode..."]);
			await window.electronAPI.flashFirmware(hexBytes);

			setFlashSucceeded(true);
			setAwaitingReconnect(true);
		} catch (err) {
			setFlashError(err instanceof Error ? err.message : "Update failed");
		} finally {
			unsubscribe();
			setFlashing(false);
		}
	};

	return (
		<div className="flex flex-col gap-3 p-3 rounded-lg border border-border bg-card">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-semibold">Firmware Update</h3>
				{currentVersion && (
					<span className="text-[11px] font-mono text-muted-foreground">
						Running v{currentVersion}{currentSchema ? ` (schema ${currentSchema})` : ""}
					</span>
				)}
			</div>

			{!connected && (
				<p className="text-[11px] text-muted-foreground">Connect to your pad to check its firmware version.</p>
			)}

			<Button variant="outline" size="sm" onClick={checkForUpdates} disabled={checking} className="gap-1.5 self-start">
				<RefreshCw className={`w-3.5 h-3.5 ${checking ? "animate-spin" : ""}`} />
				{checking ? "Checking..." : "Check for Updates"}
			</Button>

			{checkError && <p className="text-[11px] text-destructive">{checkError}</p>}

			{manifest && !updateAvailable && (
				<p className="text-[11px] text-muted-foreground">You're on the latest version (v{manifest.version}).</p>
			)}

			{manifest && updateAvailable && (
				<div className="flex flex-col gap-2 p-2.5 rounded border border-border bg-muted/20">
					<p className="text-[12px] font-medium">
						Update available: v{currentVersion ?? "?"} -&gt; v{manifest.version}
					</p>
					{manifest.notes && (
						<p className="text-[11px] text-muted-foreground whitespace-pre-wrap max-h-24 overflow-y-auto">
							{manifest.notes}
						</p>
					)}

					{schemaWillChange && (
						<div className="flex gap-2 p-2 rounded border border-amber-500/40 bg-amber-500/10">
							<AlertTriangle className="w-4 h-4 shrink-0 text-amber-600" />
							<p className="text-[11px] text-amber-700 dark:text-amber-400">
								<strong>This update will reset your sensor calibration</strong> (Trigger,
								Release, Gain, Button Group, Release Debounce, LED
								colors/zones) back to defaults. Back up your settings below first --
								Update Now stays disabled until you do, and restoring afterward happens
								automatically.
							</p>
						</div>
					)}

					<div className="flex gap-2 flex-wrap">
						<Button variant="outline" size="sm" onClick={downloadBackup} className="gap-1.5">
							<Download className="w-3.5 h-3.5" />
							{backupDone ? "Backup Saved ✓" : "Back Up My Settings"}
						</Button>
						<Button
							size="sm"
							onClick={updateNow}
							disabled={!backupDone || flashing || !connected}
							className="gap-1.5"
						>
							<RefreshCw className={`w-3.5 h-3.5 ${flashing ? "animate-spin" : ""}`} />
							{flashing ? "Updating..." : "Update Now"}
						</Button>
						<Button variant="outline" size="sm" asChild className="gap-1.5">
							<a href={manifest.hexUrl} download>
								<Download className="w-3.5 h-3.5" />
								Download .hex manually
							</a>
						</Button>
					</div>

					{!backupDone && (
						<p className="text-[10px] text-muted-foreground">
							Back up your settings first -- Update Now unlocks once you have.
						</p>
					)}

					{(flashing || flashLog.length > 0) && (
						<div className="flex flex-col gap-1 p-2 rounded border border-border bg-background/60 max-h-32 overflow-y-auto">
							{flashLog.map((line, idx) => (
								<span key={idx} className="text-[10px] font-mono text-muted-foreground">{line}</span>
							))}
						</div>
					)}

					{flashError && (
						<div className="flex gap-2 p-2 rounded border border-destructive/40 bg-destructive/10">
							<AlertTriangle className="w-4 h-4 shrink-0 text-destructive" />
							<p className="text-[11px] text-destructive">{flashError}</p>
						</div>
					)}

					{flashSucceeded && awaitingReconnect && (
						<div className="flex items-center gap-2 p-2 rounded border border-emerald-500/40 bg-emerald-500/10">
							<p className="text-[11px] text-emerald-700 dark:text-emerald-400 flex-1">
								Flash complete! Reconnect to your pad to auto-restore your settings.
							</p>
							<Button variant="outline" size="sm" onClick={connect} className="gap-1.5 shrink-0">
								Reconnect
							</Button>
						</div>
					)}

					<p className="text-[10px] text-muted-foreground">
						Update Now requires the Awakened Animus desktop app (not a browser tab) and will ask you
						to press the button on your Teensy once the update starts.
					</p>
				</div>
			)}

			<div className="flex items-center gap-2 pt-1 border-t border-border/60">
				<Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()} className="gap-1.5">
					<Upload className="w-3.5 h-3.5" />
					Restore My Settings
				</Button>
				<input
					ref={fileInputRef}
					type="file"
					accept="application/json"
					className="hidden"
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) restoreFromFile(file);
						e.target.value = "";
					}}
				/>
			</div>
			{restoreStatus && <p className="text-[11px] text-muted-foreground">{restoreStatus}</p>}
		</div>
	);
}

/*=============================================================================
 COMMIT NUMBER INPUT -- small typed-value box that sits next to a slider.
 Keeps a local text draft while the user types (so partial entries like "1."
 or an empty box aren't clobbered by the live value), then clamps + commits
 on Enter or blur. Escape reverts. Re-syncs from `value` whenever it changes
 externally (slider drag, reset button, firmware echo) and the box isn't focused.
=============================================================================*/
function CommitNumberInput({
	value, min, max, step = 1, decimals = 0, scale = 1, onCommit, className = "", title,
}: {
	value: number;          // raw stored value (e.g. gainX100)
	min: number;            // in DISPLAY units
	max: number;            // in DISPLAY units
	step?: number;
	decimals?: number;
	scale?: number;         // stored = display * scale (gain: 100)
	onCommit: (raw: number) => void;
	className?: string;
	title?: string;
}) {
	const toDisplay = (v: number) => (v / scale).toFixed(decimals);
	const [draft, setDraft] = useState<string>(() => toDisplay(value));
	const focusedRef = useRef(false);

	useEffect(() => {
		if (!focusedRef.current) setDraft(toDisplay(value));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [value]);

	const commit = () => {
		const n = parseFloat(draft);
		if (!Number.isFinite(n)) { setDraft(toDisplay(value)); return; }
		const clamped = Math.min(max, Math.max(min, n));
		const raw = Math.round(clamped * scale);
		setDraft(toDisplay(raw));
		if (raw !== value) onCommit(raw);
	};

	return (
		<input
			type="number" inputMode="decimal" min={min} max={max} step={step}
			value={draft} title={title}
			className={`w-[calc(48px*var(--sensor-ui-scale))] text-[length:calc(9px*var(--sensor-ui-scale))] font-mono bg-transparent border border-border rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-ring ${className}`}
			onFocus={(e) => { focusedRef.current = true; e.currentTarget.select(); }}
			onChange={(e) => setDraft(e.target.value)}
			onBlur={() => { focusedRef.current = false; commit(); }}
			onKeyDown={(e) => {
				if (e.key === "Enter") { e.currentTarget.blur(); }
				else if (e.key === "Escape") { setDraft(toDisplay(value)); e.currentTarget.blur(); }
			}}
		/>
	);
}

/*=============================================================================
 RESIZABLE GRAPH PANEL -- wraps the wave-signal graph with a drag handle on
 its top edge so it can be made shorter/taller instead of always eating all
 leftover vertical space. Height is persisted in localStorage.
=============================================================================*/
const LS_GRAPH_HEIGHT_KEY = "webfsr_public_graph_height";
const GRAPH_MIN_H = 120;
const GRAPH_MAX_H = 1400;
const GRAPH_DEFAULT_H = 320;

// Shared drag logic for the bottom-edge resize handles. `height` is the
// PREFERRED height (what the user dragged to / what is persisted). The panel
// is laid out with flex-basis = preferred and flex-shrink enabled, so when the
// window is smaller the panel collapses toward its min height on its own and
// grows back to the preferred height when space returns -- the preferred
// value itself is never overwritten by window changes. Drag math starts from
// the panel's ACTUAL rendered height so the handle tracks the pointer even
// when the panel is currently shrunk below its preferred size.
function useVerticalResize(storageKey: string, defaultH: number, minH: number, maxH: number) {
	const [height, setHeight] = useState<number>(() => {
		try {
			const n = Number(localStorage.getItem(storageKey));
			return Number.isFinite(n) && n >= minH ? Math.min(maxH, n) : defaultH;
		} catch { return defaultH; }
	});
	const elRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{ startY: number; startH: number } | null>(null);
	const heightRef = useRef(height);
	heightRef.current = height;

	const persist = (h: number) => { try { localStorage.setItem(storageKey, String(Math.round(h))); } catch { /* ignore */ } };

	const handleProps = {
		onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
			const actual = elRef.current?.getBoundingClientRect().height ?? heightRef.current;
			dragRef.current = { startY: e.clientY, startH: actual };
			setHeight(actual);
			e.currentTarget.setPointerCapture(e.pointerId);
		},
		onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
			if (!dragRef.current) return;
			const next = dragRef.current.startH + (e.clientY - dragRef.current.startY);
			setHeight(Math.min(maxH, Math.max(minH, next)));
		},
		onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
			if (!dragRef.current) return;
			dragRef.current = null;
			if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
			persist(heightRef.current);
		},
		onPointerCancel: () => { dragRef.current = null; },
		onDoubleClick: () => { setHeight(defaultH); persist(defaultH); },
	};
	return { height, elRef, handleProps };
}

function ResizeGrip({ title, ...rest }: { title: string } & ReturnType<typeof useVerticalResize>["handleProps"]) {
	return (
		<div
			role="separator" aria-orientation="horizontal" title={title}
			className="h-2 shrink-0 cursor-row-resize flex items-center justify-center group touch-none"
			{...rest}
		>
			<div className="h-0.5 w-12 rounded bg-border group-hover:bg-foreground/60 transition-colors" />
		</div>
	);
}

function ResizableGraphPanel({ children }: { children: ReactNode }) {
	const { height, elRef, handleProps } = useVerticalResize(LS_GRAPH_HEIGHT_KEY, GRAPH_DEFAULT_H, GRAPH_MIN_H, GRAPH_MAX_H);
	return (
		<div
			ref={elRef}
			className="mt-2 flex flex-col min-w-0 overflow-hidden"
			// flex-basis = preferred height; may shrink down to GRAPH_MIN_H
			// when the window is short, never grows past the preferred size.
			style={{ flex: `0 1 ${height}px`, minHeight: GRAPH_MIN_H }}
		>
			<div className="p-1 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm grow min-h-0 min-w-0 overflow-hidden">
				<div className="h-full w-full min-w-0">{children}</div>
			</div>
			<ResizeGrip title="Drag to resize graph (double-click to reset)" {...handleProps} />
		</div>
	);
}

/*=============================================================================
 RESIZABLE SENSOR PANEL -- wraps the sensor bars (+ heart-rate box) so the
 whole block can be resized by dragging its bottom edge. While resizing it
 publishes a scale (derived from BOTH its height and the width available
 per sensor column) as a `--sensor-ui-scale` CSS variable (mini-controls,
 Release row, fixed-height slots) AND via SensorUiScaleContext (SensorBar's
 canvas text, lines and +/- row) so fonts, icons, inputs and slots scale together,
 so nothing clips, overlaps or drifts out of alignment at any size.
=============================================================================*/
const LS_SENSOR_PANEL_HEIGHT_KEY = "webfsr_public_sensor_panel_height";
const SENSOR_PANEL_DEFAULT_H = 450;
const SENSOR_PANEL_MIN_H = 300;
const SENSOR_PANEL_MAX_H = 1400;
const SENSOR_REF_COL_W = 190;  // column width (px) at which scale == 1
const SENSOR_MIN_COL_W = 116;  // below this per-column width the grid scrolls sideways instead of crushing
const SENSOR_SCALE_MIN = 0.6;
const SENSOR_SCALE_MAX = 1.6;

function ResizableSensorPanel({
	numSensors, reservedWidth = 0, children,
}: { numSensors: number; reservedWidth?: number; children: ReactNode }) {
	const { height, elRef, handleProps } = useVerticalResize(
		LS_SENSOR_PANEL_HEIGHT_KEY, SENSOR_PANEL_DEFAULT_H, SENSOR_PANEL_MIN_H, SENSOR_PANEL_MAX_H,
	);
	// Actual rendered size -- the scale follows what is really on screen
	// (which can be smaller than the preferred height when the window is
	// short), not the stored preference.
	const [size, setSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
	useEffect(() => {
		const el = elRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver((entries) => {
			const r = entries[0].contentRect;
			setSize((prev) => (Math.abs(prev.w - r.width) < 1 && Math.abs(prev.h - r.height) < 1 ? prev : { w: r.width, h: r.height }));
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [elRef]);

	// The heart-rate box takes at most 30% of the width (see its classes).
	const reserved = Math.min(reservedWidth, size.w * 0.3);
	const colW = Math.max(1, (size.w - reserved) / Math.max(1, numSensors));
	const hScale = (size.h > 0 ? size.h : height) / SENSOR_PANEL_DEFAULT_H;
	const wScale = size.w > 0 ? colW / SENSOR_REF_COL_W : Infinity;
	const scale = Math.min(SENSOR_SCALE_MAX, Math.max(SENSOR_SCALE_MIN, Math.min(hScale, wScale)));

	return (
		<div
			ref={elRef}
			className="sensor-scale-root flex flex-col min-w-0"
			// Preferred height as flex-basis; shrinks to the minimum when the
			// window is short, grows back when space returns.
			style={{ flex: `0 1 ${height}px`, minHeight: SENSOR_PANEL_MIN_H, ["--sensor-ui-scale" as string]: scale.toFixed(3) }}
		>
			<SensorUiScaleContext.Provider value={scale}>
				<div className="flex gap-2 flex-1 min-h-0 min-w-0">{children}</div>
			</SensorUiScaleContext.Provider>
			<ResizeGrip title="Drag to resize sensors (double-click to reset)" {...handleProps} />
		</div>
	);
}

/*=============================================================================
 SENSOR MINI CONTROLS -- Gain / Release Debounce / Button Group, rendered
 directly under each sensor's wave in the main view.

 PERFORMANCE: sits inside the sensor-bar grid, which re-renders on every
 incoming sensor reading. React.memo skips re-rendering this component on
 those ordinary ticks (since `index` never changes for a given position);
 useSyncExternalStore gives it an independent subscription to tuning data
 that only fires when tuning actually changes (published by
 SensorTuningSection), so the sliders stay live and correct despite memo
 blocking the parent-driven re-renders.
=============================================================================*/
const SensorMiniControls = memo(function SensorMiniControls({ index }: { index: number }) {
	const tuning = useSyncExternalStore(subscribeTuningStore, getTuningStoreSnapshot);
	// Width-aware: the "(default ...)" hints are dropped when the column is too
	// narrow for them (they used to wrap onto a second line and break the
	// row's alignment). The reset button's tooltip still states the default.
	const uiScale = useContext(SensorUiScaleContext);
	const [rootEl, setRootEl] = useState<HTMLDivElement | null>(null);
	const [boxWidth, setBoxWidth] = useState(0);
	useEffect(() => {
		if (!rootEl || typeof ResizeObserver === "undefined") return;
		const ro = new ResizeObserver((entries) => setBoxWidth(entries[0].contentRect.width));
		ro.observe(rootEl);
		return () => ro.disconnect();
	}, [rootEl]);
	const showDefaults = boxWidth === 0 || boxWidth >= 195 * uiScale;
	const controls = (SensorTuningSection as unknown as { _getControls?: () => SensorTuningControls })._getControls?.();
	if (!controls) return null; // SensorTuningSection hasn't mounted/rendered yet
	const { effectiveCount, sensorLabels, commitGain, commitButtonGroup, commitReleaseDebounce } = controls;
	// Falls back to sane defaults rather than returning null when
	// tuning[index] is momentarily missing -- the tuning array can briefly
	// be shorter than numSensors during the render(s) between numSensors
	// updating and the resize effect actually growing it, and the LAST
	// configured sensor slot is the one most likely to hit that gap. This
	// way the controls always render something usable instead of
	// vanishing; they'll pick up the real values on the next legitimate
	// update.
	const t = tuning[index] ?? {
		trigger: 700, release: 300, gainX100: 100, buttonGroup: index, releaseDebounceMs: 15,
	};

	// LOCAL optimistic state for the group dropdown.
	// Problem: `tuning` is a shared external store snapshot. When ANY sensor's
	// group changes, publishTuningStore fires and every SensorMiniControls
	// re-renders from the same snapshot simultaneously. If the snapshot array
	// has any index offset (e.g. the changed sensor's new value bleeds into
	// a neighbor's slot), every dropdown snaps to a wrong value at once.
	//
	// Fix: each instance keeps its own `localGroup` that it uses as the
	// dropdown's displayed value. It only syncs FROM the external store when
	// the store's value changes AND it didn't originate from this instance's
	// own last commit (tracked via `lastCommittedRef`). This decouples each
	// dropdown from the shared store mid-edit while still accepting legitimate
	// external updates (e.g. firmware echoes on connect, Sync from pad).
	const lastCommittedRef = useRef<number | null>(null);
	const [localGroup, setLocalGroup] = useState<number>(() => t.buttonGroup);

	// Sync local state from store only when the store changes externally.
	// If this instance was the one that changed it (lastCommittedRef matches),
	// skip the sync so the dropdown doesn't flicker.
	const storeGroup = t.buttonGroup;
	useEffect(() => {
		if (lastCommittedRef.current !== null && lastCommittedRef.current === storeGroup) {
			// This was our own change echoed back -- clear the guard and keep local.
			lastCommittedRef.current = null;
			return;
		}
		// External change (firmware sync, another sensor's group affecting ours,
		// or initial load) -- accept it.
		setLocalGroup(storeGroup);
	}, [storeGroup]);

	const handleGroupChange = (newGroup: number) => {
		// Immediately update local display so the dropdown feels instant.
		setLocalGroup(newGroup);
		// Record what we're committing so the useEffect above can ignore
		// the store echo that comes back after commitButtonGroup fires.
		lastCommittedRef.current = newGroup;
		commitButtonGroup(index, newGroup);
	};

	return (
		<div ref={setRootEl} className="flex flex-col gap-1.5 px-2 py-1.5 rounded border border-border/60 bg-muted/10 min-w-0 text-[length:calc(10px*var(--sensor-ui-scale))]">
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground">Gain</span>
					<div className="flex items-center gap-1">
						<span className="font-mono text-muted-foreground whitespace-nowrap">
							{(t.gainX100 / 100).toFixed(2)}x
							{showDefaults && <span className="opacity-60"> (default {(DEFAULT_GAIN_X100 / 100).toFixed(2)}x)</span>}
						</span>
						<button
							type="button"
							title={`Reset Gain to default (${(DEFAULT_GAIN_X100 / 100).toFixed(2)}x)`}
							onClick={() => commitGain(index, DEFAULT_GAIN_X100)}
							className="text-muted-foreground hover:text-foreground shrink-0"
						>
							<RefreshCw className="size-[calc(10px*var(--sensor-ui-scale))]" />
						</button>
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<input
						type="range" min={10} max={500} step={5} value={t.gainX100}
						className="w-full h-1 accent-foreground cursor-pointer"
						onChange={(e) => commitGain(index, Number(e.target.value))}
					/>
					<CommitNumberInput
						title="Type an exact Gain multiplier (0.10x - 5.00x), press Enter"
						value={t.gainX100} min={0.1} max={5} step={0.05} decimals={2} scale={100}
						onCommit={(raw) => commitGain(index, raw)}
					/>
				</div>
			</div>

			{/* Release Debounce */}
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground" title="Release Debounce (ms)">Debounce</span>
					<div className="flex items-center gap-1">
						<span className="font-mono text-muted-foreground whitespace-nowrap">
							{t.releaseDebounceMs}ms
							{showDefaults && <span className="opacity-60"> (default {DEFAULT_RELEASE_DEBOUNCE_MS}ms)</span>}
						</span>
						<button
							type="button"
							title={`Reset Debounce to default (${DEFAULT_RELEASE_DEBOUNCE_MS}ms)`}
							onClick={() => commitReleaseDebounce(index, DEFAULT_RELEASE_DEBOUNCE_MS)}
							className="text-muted-foreground hover:text-foreground shrink-0"
						>
							<RefreshCw className="size-[calc(10px*var(--sensor-ui-scale))]" />
						</button>
					</div>
				</div>
				<div className="flex items-center gap-1.5">
					<input
						type="range" min={0} max={100} step={1} value={t.releaseDebounceMs}
						className="w-full h-1 accent-foreground cursor-pointer"
						onChange={(e) => commitReleaseDebounce(index, Number(e.target.value))}
					/>
					<CommitNumberInput
						title="Type an exact Release Debounce in ms (0 - 100), press Enter"
						value={t.releaseDebounceMs} min={0} max={100} step={1}
						onCommit={(raw) => commitReleaseDebounce(index, raw)}
					/>
				</div>
			</div>

			{/* Button Group — uses localGroup (optimistic) not t.buttonGroup (store)
			    so the dropdown never flickers when the shared store updates. */}
			<div className="flex flex-col gap-0.5">
				<span className="text-muted-foreground">Group</span>
				<select
					value={localGroup}
					onChange={(e) => handleGroupChange(Number(e.target.value))}
					className="w-full text-[length:calc(10px*var(--sensor-ui-scale))] bg-white dark:bg-neutral-900 border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
				>
					<option value={index} className="bg-white dark:bg-neutral-900">Own button (#{index})</option>
					{Array.from({ length: effectiveCount }, (_, j) => j)
						.filter((j) => j !== index)
						.map((j) => (
							<option key={j} value={j} className="bg-white dark:bg-neutral-900">
								Share w/ {sensorLabels[j] || `Sensor ${j + 1}`} (#{j})
							</option>
						))}
				</select>
			</div>
			{localGroup !== index && (
				<p className="text-amber-500">⚠ shares button with {sensorLabels[localGroup] || `Sensor ${localGroup + 1}`} (#{localGroup})</p>
			)}
		</div>
	);
});

/*=============================================================================
 LED PAD PREVIEW -- visual dance-pad layout for the LEDs tab: a custom pad
 background image with actual per-LED dot nodes overlaid directly on top
 of each panel's real position, colored to match that sensor's assigned
 color. See the matching comment in the personal/dev build for the full
 design rationale, including the reactivity-bug fix (useSyncExternalStore
 via the ledStore, instead of pulling from the bridge directly).

 IMAGE SETUP REQUIRED: place your pad background image in your project's
 public/ folder named to match PAD_BACKGROUND_URL below.
=============================================================================*/
const PAD_BACKGROUND_URL = "./pad-background.png"; // relative -- must match vite.config.ts's base: "./" so this still resolves once loaded via file:// in the packaged Electron app, not just the dev server

type Direction = "up" | "down" | "left" | "right";

const PANEL_RECT: Record<Direction, { top: string; left: string }> = {
	up:    { top: "0%",       left: "33.333%" },
	left:  { top: "33.333%",  left: "0%" },
	right: { top: "33.333%",  left: "66.666%" },
	down:  { top: "66.666%",  left: "33.333%" },
};

// PanelTint overlays a pad panel with hue tint(s) that colorize the baked-in
// 3D arrows in pad-background.png via CSS mix-blend-mode:hue, preserving all
// the image's own lighting and 3D detail.
//
// When a panel has TWO sensors (primary + secondary "2"), the arrow is split
// down its axis: primary tint covers the left/top half, secondary covers the
// right/bottom half — matching the physical LED wiring where one FSR lights
// one half of the strip and the other FSR lights the other.
//
// The LED strip shows individual squares, one per LED, each colored by its
// owning sensor and labelled with its absolute LED index. Strip runs:
//   • horizontally across the stem for Up / Down arrows
//   • vertically down the stem for Left / Right arrows
function PanelTint({
	matches,
	direction,
}: {
	matches: { sensor: SensorZone; arrayIndex: number }[];
	direction: Direction;
}) {
	if (matches.length === 0) return null;

	const primary   = matches[0].sensor;
	const secondary = matches[1]?.sensor;

	// For Up/Down the "axis" that splits primary vs secondary is LEFT/RIGHT
	// (left half = primary, right half = secondary).
	// For Left/Right the split is TOP/BOTTOM (top = primary, bottom = secondary).
	const splitIsLeftRight = direction === "up" || direction === "down";

	// Build the flat list of LED squares across all sensors on this panel,
	// in ledOffset order so they read naturally along the strip.
	const allLeds: { index: number; color: string }[] = [];
	for (const { sensor } of matches) {
		for (let i = 0; i < sensor.ledCount; i++) {
			allLeds.push({ index: sensor.ledOffset + i, color: sensor.color });
		}
	}
	allLeds.sort((a, b) => a.index - b.index);

	// LED strip orientation:
	//   Up/Down arrows  → stem runs vertically in the image → strip goes HORIZONTAL
	//   Left/Right arrows → stem runs horizontally → strip goes VERTICAL
	const stripIsHorizontal = direction === "up" || direction === "down";

	// Position the strip in the stem area of each arrow.
	// The stem occupies roughly the center third of the panel.
	// Up:    stem is in the lower ~55-80% vertically, centered horizontally
	// Down:  stem is in the upper ~20-45% vertically, centered horizontally
	// Left:  stem is in the right ~30-65% horizontally, centered vertically
	// Right: stem is in the left ~35-65% horizontally, centered vertically
	const stripPositionStyle: React.CSSProperties = (() => {
		switch (direction) {
			case "up":    return { bottom: "18%", left: "50%", transform: "translateX(-50%)" };
			case "down":  return { top: "18%",    left: "50%", transform: "translateX(-50%)" };
			case "left":  return { right: "14%",  top:  "50%", transform: "translateY(-50%)" };
			case "right": return { left:  "14%",  top:  "50%", transform: "translateY(-50%)" };
		}
	})();

	// Square size per LED — generous enough to read the number
	const SQ = 16;
	const GAP = 2;

	return (
		<div className="absolute inset-0 pointer-events-none" style={{ borderRadius: "inherit" }}>

			{/* ── Hue tint layer(s) ───────────────────────────────────────── */}
			{secondary ? (
				<>
					{/* Primary sensor: covers the left or top half */}
					<div style={{
						position: "absolute",
						backgroundColor: primary.color,
						mixBlendMode: "hue",
						opacity: 0.92,
						...(splitIsLeftRight
							? { top: 0, bottom: 0, left: 0, right: "50%" }   // left half
							: { left: 0, right: 0, top: 0, bottom: "50%" }), // top half
					}} />
					{/* Secondary sensor: covers the right or bottom half */}
					<div style={{
						position: "absolute",
						backgroundColor: secondary.color,
						mixBlendMode: "hue",
						opacity: 0.92,
						...(splitIsLeftRight
							? { top: 0, bottom: 0, left: "50%", right: 0 }   // right half
							: { left: 0, right: 0, top: "50%", bottom: 0 }), // bottom half
					}} />
				</>
			) : (
				/* Single sensor: full panel tint */
				<div style={{
					position: "absolute",
					inset: 0,
					backgroundColor: primary.color,
					mixBlendMode: "hue",
					opacity: 0.92,
				}} />
			)}

			{/* ── LED strip ───────────────────────────────────────────────── */}
			{allLeds.length > 0 && (
				<div style={{
					position: "absolute",
					...stripPositionStyle,
					display: "flex",
					flexDirection: stripIsHorizontal ? "row" : "column",
					gap: GAP,
					alignItems: "center",
					justifyContent: "center",
				}}>
					{allLeds.map(({ index, color }) => (
						<div
							key={index}
							style={{
								width: SQ,
								height: SQ,
								borderRadius: 3,
								background: color,
								border: "1.5px solid rgba(255,255,255,0.55)",
								boxShadow: `0 0 5px 1px ${color}`,
								display: "flex",
								alignItems: "center",
								justifyContent: "center",
								flexShrink: 0,
							}}
						>
							<span style={{
								fontSize: 7,
								fontFamily: "monospace",
								color: "rgba(255,255,255,0.95)",
								textShadow: "0 0 3px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.8)",
								lineHeight: 1,
								userSelect: "none",
							}}>
								{index}
							</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function LedPadPreview() {
	const [selectedDir, setSelectedDir] = useState<Direction | null>(null);
	// When a direction has multiple FSRs, this holds the arrayIndex of the one
	// the user picked to edit. null = not yet chosen (show picker).
	const [selectedSensorIdx, setSelectedSensorIdx] = useState<number | null>(null);
	// "Cap" isn't a Direction -- it's the accent/non-sensor zone's own
	// selection flag, kept separate so opening it doesn't fight with the
	// four directional panels' own selection state.
	const [accentSelected, setAccentSelected] = useState(false);
	const [imageError, setImageError] = useState(false);
	const sensors = useSyncExternalStore(subscribeLedStore, getLedStoreSnapshot);
	const accent = useSyncExternalStore(subscribeAccentStore, getAccentStoreSnapshot);
	const controls = (LedSection as unknown as { _getLedControls?: () => LedControls })._getLedControls?.();

	if (!controls) {
		return <p className="text-sm text-muted-foreground p-4">Connect to your pad to preview its LED layout.</p>;
	}
	const { updateSensor, updateAccent } = controls;

	// Find ALL sensors whose label contains the direction keyword (case-insensitive).
	// "Up" matches "Up" and "Up 2"; "Down" matches "Down" and "Down 2", etc.
	const findAllByDir = (dir: Direction): { sensor: SensorZone; arrayIndex: number }[] =>
		sensors
			.map((s, i) => ({ sensor: s, arrayIndex: i }))
			.filter(({ sensor }) => sensor.label.trim().toLowerCase().includes(dir));

	// Build panel info: first sensor for the arrow visual, plus full list for multi-FSR picker.
	const panels: {
		direction: Direction;
		matches: { sensor: SensorZone; arrayIndex: number }[];
		primarySensor: SensorZone | undefined;
		totalLedCount: number;
	}[] = (["up", "down", "left", "right"] as const).map((direction) => {
		const matches = findAllByDir(direction);
		const primarySensor = matches[0]?.sensor;
		const totalLedCount = matches.reduce((sum, m) => sum + m.sensor.ledCount, 0);
		return { direction, matches, primarySensor, totalLedCount };
	});

	const handlePanelClick = (direction: Direction, matches: { sensor: SensorZone; arrayIndex: number }[]) => {
		setAccentSelected(false);
		if (selectedDir === direction) {
			// Toggle off
			setSelectedDir(null);
			setSelectedSensorIdx(null);
			return;
		}
		setSelectedDir(direction);
		if (matches.length === 1) {
			// Only one FSR on this panel — go straight to the edit card.
			setSelectedSensorIdx(matches[0].arrayIndex);
		} else {
			// Multiple FSRs — show the picker first.
			setSelectedSensorIdx(null);
		}
	};

	const handleAccentClick = () => {
		setSelectedDir(null);
		setSelectedSensorIdx(null);
		setAccentSelected((v) => !v);
	};

	// The sensor currently being edited in the card (if any).
	const editingSensor = selectedSensorIdx !== null ? sensors[selectedSensorIdx] : undefined;

	return (
		<div className="flex flex-col items-center gap-4 p-4 overflow-y-auto">
			{/* Explicit inline aspectRatio (not just the Tailwind aspect-square
			    class) -- aspect-ratio utilities are a fairly recent Tailwind
			    addition, and if this project's Tailwind version/config
			    predates them the class silently no-ops, leaving this
			    container's height to whatever the absolutely-positioned
			    image/overlay children happen to report (which is how it ended
			    up rendering as a squashed non-square rectangle). The inline
			    style is plain CSS and can't silently fail like that. Capped at
			    360px (down from max-w-md's 448px) so it sits more compactly
			    above the edit card instead of dominating the tab. */}
			<div
				className="relative w-full rounded-lg overflow-hidden border border-border bg-muted/20"
				style={{ maxWidth: 360, aspectRatio: "1 / 1" }}
			>
				{!imageError ? (
					<img
						src={PAD_BACKGROUND_URL}
						alt="Pad layout"
						className="absolute inset-0 w-full h-full object-cover select-none"
						draggable={false}
						onError={() => setImageError(true)}
					/>
				) : (
					<div className="absolute inset-0 flex items-center justify-center p-4 text-center">
						<p className="text-xs text-muted-foreground">
							Background image not found. Place your pad image in your project's
							<code className="mx-1 px-1 rounded bg-muted">public/</code> folder as
							<code className="mx-1 px-1 rounded bg-muted">pad-background.png</code>
							(or update <code className="px-1 rounded bg-muted">PAD_BACKGROUND_URL</code> in
							the code to match wherever you put it).
						</p>
					</div>
				)}

				{panels.map(({ direction, matches, primarySensor, totalLedCount }) => (
					<button
						key={direction}
						type="button"
						disabled={matches.length === 0}
						onClick={() => handlePanelClick(direction, matches)}
						className={`absolute w-1/3 h-1/3 transition-all overflow-hidden ${
							matches.length > 0 ? "cursor-pointer" : "cursor-not-allowed"
						} ${selectedDir === direction ? "ring-4 ring-inset ring-white/80" : ""}`}
						style={{
							top: PANEL_RECT[direction].top,
							left: PANEL_RECT[direction].left,
							position: "absolute",
						}}
						title={
							matches.length > 1
								? matches.map((m) => m.sensor.label).join(" + ")
								: primarySensor
									? `${primarySensor.label} — #${primarySensor.sensorIndex}`
									: `No sensor labeled "${direction}"`
						}
					>
						{matches.length > 0 ? (
							<PanelTint
								matches={matches}
								direction={direction}
							/>
						) : (
							<span className="absolute inset-0 flex items-center justify-center text-[10px] text-white/50">—</span>
						)}
					</button>
				))}

				{/* Accent/cap node -- sits in the empty top-right corner (the
				    4-direction cross layout above never uses the corners), so
				    it doesn't compete for space with any sensor panel. Always
				    clickable (unlike the direction buttons, it's never
				    "disabled" since it isn't tied to a labeled sensor existing).
				    AccentRimDemo traces LEDs around the panel's own rim (like
				    the white selection ring drawn around this button when
				    selected) -- tried filling the square with a grid first,
				    but that read as tacky/random dots rather than a coherent
				    strip. An even earlier version tried a CSS mix-blend-mode
				    tint against the pad artwork, which barely showed anything
				    since that blend mode only shifts hue while keeping the
				    backdrop's own brightness -- against this mostly-gray
				    corner there was nothing to shift. */}
				<button
					type="button"
					onClick={handleAccentClick}
					className={`absolute w-1/3 h-1/3 transition-all overflow-hidden cursor-pointer ${
						accentSelected ? "ring-4 ring-inset ring-white/80" : ""
					}`}
					style={{ top: "0%", left: "66.666%", position: "absolute" }}
					title={`${accent.label} — accent LEDs (${ACCENT_EFFECT_LABELS[accent.effect]})`}
				>
					<AccentRimDemo accent={accent} cellSize={5} count={16} />
					<span className="absolute inset-x-0 bottom-0 flex flex-col items-center justify-center gap-0 pointer-events-none bg-black/45 py-0.5">
						<span className="text-[9px] font-medium text-white/90 drop-shadow">{accent.label}</span>
						<span className="text-[7px] text-white/70 drop-shadow uppercase tracking-wide">
							{ACCENT_EFFECT_LABELS[accent.effect]}
						</span>
					</span>
				</button>
			</div>

			{/* Multi-FSR picker: shown when a direction has 2+ sensors and no specific one chosen yet */}
			{selectedDir !== null && (() => {
				const panel = panels.find((p) => p.direction === selectedDir);
				if (!panel || panel.matches.length <= 1) return null;
				if (selectedSensorIdx !== null) return null;
				return (
					<div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card w-full max-w-sm">
						<div className="flex items-center justify-between">
							<h3 className="text-sm font-semibold capitalize">{selectedDir} — which FSR?</h3>
							<button type="button" onClick={() => { setSelectedDir(null); setSelectedSensorIdx(null); }} className="text-xs text-muted-foreground hover:text-foreground">
								Close
							</button>
						</div>
						<p className="text-[11px] text-muted-foreground">
							This panel has {panel.matches.length} FSR sensors. Pick one to edit:
						</p>
						<div className="flex flex-col gap-2">
							{panel.matches.map(({ sensor, arrayIndex }) => (
								<button
									key={arrayIndex}
									type="button"
									onClick={() => setSelectedSensorIdx(arrayIndex)}
									className="flex items-center gap-3 px-3 py-2 rounded border border-border hover:bg-accent hover:text-accent-foreground transition-colors text-left"
								>
									<span
										className="w-4 h-4 rounded-full shrink-0 border border-black/30"
										style={{ background: sensor.color, boxShadow: `0 0 4px ${sensor.color}` }}
									/>
									<div className="flex flex-col">
										<span className="text-sm font-medium">{sensor.label}</span>
										<span className="text-[10px] text-muted-foreground font-mono">
											#{sensor.sensorIndex} · LEDs {sensor.ledOffset}–{sensor.ledOffset + sensor.ledCount - 1} ({sensor.ledCount} LEDs)
										</span>
									</div>
								</button>
							))}
						</div>
					</div>
				);
			})()}

			{/* Edit card: shown once a specific sensor is selected */}
			{editingSensor && selectedSensorIdx !== null && (
				<div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card w-full max-w-sm">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-semibold capitalize">
							{editingSensor.label} (#{editingSensor.sensorIndex})
						</h3>
						<div className="flex gap-2">
							{/* Back to picker if there are multiple FSRs on this panel */}
							{(() => {
								const panel = panels.find((p) => p.direction === selectedDir);
								return panel && panel.matches.length > 1 ? (
									<button
										type="button"
										onClick={() => setSelectedSensorIdx(null)}
										className="text-xs text-muted-foreground hover:text-foreground"
									>
										← Back
									</button>
								) : null;
							})()}
							<button type="button" onClick={() => { setSelectedDir(null); setSelectedSensorIdx(null); }} className="text-xs text-muted-foreground hover:text-foreground">
								Close
							</button>
						</div>
					</div>

					<label className="flex flex-col gap-1 text-xs">
						Color
						<input
							type="color"
							value={editingSensor.color}
							onChange={(e) => updateSensor(selectedSensorIdx, { color: e.target.value })}
							className="h-9 w-full rounded border border-border cursor-pointer"
						/>
					</label>

					<label className="flex flex-col gap-1 text-xs">
						LED Offset
						<input
							type="number" min={0} max={255}
							value={editingSensor.ledOffset}
							onChange={(e) => updateSensor(selectedSensorIdx, { ledOffset: Math.max(0, Number(e.target.value) || 0) })}
							className="px-2 py-1 rounded border border-border bg-transparent text-sm"
						/>
					</label>

					<label className="flex flex-col gap-1 text-xs">
						LED Count
						<input
							type="number" min={1} max={64}
							value={editingSensor.ledCount}
							onChange={(e) => updateSensor(selectedSensorIdx, { ledCount: Math.max(1, Number(e.target.value) || 1) })}
							className="px-2 py-1 rounded border border-border bg-transparent text-sm"
						/>
					</label>

					<p className="text-[10px] text-muted-foreground">
						Changes here push to the board immediately, the same as editing this
						sensor in the LED Panels list in the sidebar.
					</p>
				</div>
			)}

			{/* Accent/cap edit card -- same card layout as the sensor editor
			    above, with an effect picker and speed slider added since this
			    zone runs its own animation rather than a static color. */}
			{accentSelected && (
				<div className="flex flex-col gap-3 p-4 rounded-lg border border-border bg-card w-full max-w-sm">
					<div className="flex items-center justify-between">
						<h3 className="text-sm font-semibold">{accent.label}</h3>
						<button type="button" onClick={() => setAccentSelected(false)} className="text-xs text-muted-foreground hover:text-foreground">
							Close
						</button>
					</div>

					<label className="flex flex-col gap-1 text-xs">
						Name
						<input
							type="text"
							value={accent.label}
							maxLength={16}
							onChange={(e) => updateAccent({ label: e.target.value })}
							className="px-2 py-1 rounded border border-border bg-transparent text-sm"
						/>
					</label>

					{/* Live demo -- same AccentRimDemo used on the Cap node
					    above, just bigger, so the ring is easier to follow while
					    tweaking effect/color/speed. */}
					<div className="flex flex-col gap-1 p-2 rounded border border-border bg-muted/10">
						<span className="text-[10px] text-muted-foreground uppercase tracking-wide">Live demo</span>
						<div className="relative w-full aspect-square rounded overflow-hidden border border-border/60">
							<AccentRimDemo accent={accent} cellSize={12} count={24} />
						</div>
					</div>

					<div className="grid grid-cols-2 gap-1.5">
						{(Object.keys(ACCENT_EFFECT_LABELS) as AccentEffect[]).map((fx) => (
							<button
								key={fx}
								type="button"
								onClick={() => updateAccent({ effect: fx })}
								className={`text-xs py-1.5 rounded border transition-colors ${
									accent.effect === fx
										? "bg-foreground text-background border-foreground"
										: "bg-transparent text-muted-foreground border-border hover:text-foreground"
								}`}
							>
								{ACCENT_EFFECT_LABELS[fx]}
							</button>
						))}
					</div>

					{accent.effect !== "off" && (
						<>
							{accent.effect !== "rainbow" && (
								<label className="flex flex-col gap-1 text-xs">
									Color
									<input
										type="color"
										value={accent.color}
										onChange={(e) => updateAccent({ color: e.target.value })}
										className="h-9 w-full rounded border border-border cursor-pointer"
									/>
								</label>
							)}
							{/* Speed has no meaning for a static color -- Solid never
							    actually used it (see useAccentPreviewFrame's fix for why
							    the preview looked like it was pulsing in time with it). */}
							{accent.effect !== "solid" && (
								<label className="flex flex-col gap-1 text-xs">
									Speed
									<input
										type="range" min={1} max={255} value={accent.speed}
										onChange={(e) => updateAccent({ speed: Number(e.target.value) })}
										className="w-full accent-foreground cursor-pointer"
									/>
								</label>
							)}
						</>
					)}

					<label className="flex flex-col gap-1 text-xs">
						LED Offset
						<input
							type="number" min={0} max={255}
							value={accent.ledOffset}
							onChange={(e) => updateAccent({ ledOffset: Math.max(0, Number(e.target.value) || 0) })}
							className="px-2 py-1 rounded border border-border bg-transparent text-sm"
						/>
					</label>

					<label className="flex flex-col gap-1 text-xs">
						LED Count
						<input
							type="number" min={1} max={64}
							value={accent.ledCount}
							onChange={(e) => updateAccent({ ledCount: Math.max(1, Number(e.target.value) || 1) })}
							className="px-2 py-1 rounded border border-border bg-transparent text-sm"
						/>
					</label>

					{(() => {
						const overlapping = findAccentOverlap(accent, sensors);
						if (overlapping.length === 0) return null;
						return (
							<p className="text-[10px] text-amber-500">
								⚠ Overlaps {overlapping.map((s) => s.label).join(", ")}'s LED range
								-- pressing {overlapping.length > 1 ? "those sensors" : "that sensor"} will
								steal these LEDs while held, and they may stay black after
								release until this zone is touched again. Move this Offset past
								LED {Math.max(...overlapping.map((s) => s.ledOffset + s.ledCount))} or
								move {overlapping.length > 1 ? "their" : "its"} zone in the LED
								Panels list to fix.
							</p>
						);
					})()}

					<p className="text-[10px] text-muted-foreground">
						Not tied to any FSR sensor -- this zone runs its animation on the
						board itself, so it keeps going even after the dashboard closes.
						Changes here push to the board immediately, same as editing it in
						the LED Panels list in the sidebar.
					</p>
				</div>
			)}

			{panels.some((p) => p.matches.length === 0) && (
				<p className="text-xs text-muted-foreground text-center max-w-sm">
					Grayed-out panels don't have a sensor labeled "Up", "Down", "Left",
					or "Right" yet — rename one in the LED Panels list (sidebar) to match.
				</p>
			)}
		</div>
	);
}

const Dashboard = () => {
	// Uppercase hex chip ID reported by the connected board's identify
	// response (null if disconnected, or if the board's firmware predates
	// this field). Declared early (before useProfileManager below) since
	// it needs to be passed in there to scope which profile is "active"
	// per physical board -- see the matching comment on
	// FirmwareUpdateSectionProps.onDeviceIdChange, PrintUniqueChipId() in
	// the firmware sketch, and scopedSettingsKey() in useProfileManager.
	// Also used further down to scope Advanced Tuning and Lock Release to
	// Trigger. Without this, two pads connected to the same computer on
	// different COM ports/tabs would silently share (and clobber) each
	// other's saved settings and active profile.
	const [deviceId, setDeviceId] = useState<string | null>(null);
	const onDeviceIdChangeStable = useStableCallback((id: string | null) => setDeviceId(id));

	const colorSettings = useColorSettings();
	const barSettings = useBarVisualizationSettings();
	const graphSettings = useGraphVisualizationSettings();
	const heartrateSettings = useHeartrateSettings();
	const generalSettings = useGeneralSettings();
	const { updateAllSettings, getAllSettings } = useSettingsBulkActions();
	const songHistory = useSongHistory();
	const { biometrics, setBiometrics } = useBiometrics();

	// Rate limit for the ITGMania overlay bridge -- separate from OBS/remote
	// since the overlay wants to feel instant (high rate) but we still don't
	// want to flood the IPC channel on every single serial read.
	const lastItgManiaBroadcastAtRef = useRef<number>(0);

	const { isSupported, connect, disconnect, connected, connectionError, requestsPerSecond, sendText, latestData } = useSerialPort(
		generalSettings.pollingRate,
		generalSettings.useUnthrottledPolling,
		(values) => {
			const now = performance.now();

			if (obsConnected) {
				const minIntervalMs = Math.max(1, 1000 / Math.max(1, generalSettings.obsSendRate));

				if (now - lastBroadcastAtRef.current >= minIntervalMs) {
					lastBroadcastAtRef.current = now;
					broadcastToOBS({ values, thresholds });
				}
			}

			if (remoteConnected) {
				const remoteMinIntervalMs = 1000 / 30;

				if (now - lastRemoteBroadcastAtRef.current >= remoteMinIntervalMs) {
					lastRemoteBroadcastAtRef.current = now;
					sendRemote({ type: "values", payload: { values, timestamp: Date.now() } });
				}
			}

			// Push live sensor values + trigger state to the ITGMania Lua
			// overlay via the Electron preload bridge, if it's available
			// (i.e. running inside the Electron app, not the plain browser
			// version of webfsr). 60Hz cap keeps this smooth without
			// flooding IPC -- the overlay doesn't need more than that to
			// look instant on screen.
			const bridge = (window as unknown as { itgManiaBridge?: { broadcast: (p: unknown) => void } }).itgManiaBridge;
			if (bridge) {
				const itgManiaMinIntervalMs = 1000 / 30;
				if (now - lastItgManiaBroadcastAtRef.current >= itgManiaMinIntervalMs) {
					lastItgManiaBroadcastAtRef.current = now;
					// Use the SAME trigger logic the firmware/main page would --
					// when Advanced mode is on, compare against the live Trigger
					// value for visual accuracy in the overlay; otherwise use
					// the legacy single threshold.
					const triggered = values.map((v, i) => {
						const effectiveThreshold = advancedTuningEnabled
							? (liveTriggerValues[i] ?? thresholds[i] ?? 512)
							: (thresholds[i] ?? 512);
						return v >= effectiveThreshold;
					});
					bridge.broadcast({
						values,
						triggered,
						labels: sensorLabels,
						timestamp: Date.now(),
					});
				}
			}
		},
		// Forward every non-"v" serial line (c ..., p ..., q_ok, z_ok, n_ok, etc.)
		// to whichever section registered a handler for it via the _handleLine
		// static property trick. This is what actually makes "Sync from pad"
		// work for LED config and sensor tuning -- without this the hook used
		// to silently discard every non-"v" line.
		(line: string) => {
			const ledHandler = (LedSection as unknown as { _handleLine?: (l: string) => boolean })._handleLine;
			if (ledHandler?.(line)) return;
			const tuningHandler = (SensorTuningSection as unknown as { _handleLine?: (l: string) => boolean })._handleLine;
			if (tuningHandler?.(line)) return;
			const updateHandler = (FirmwareUpdateSection as unknown as { _handleLine?: (l: string) => boolean })._handleLine;
			if (updateHandler?.(line)) return;
		},
	);

	// Wrap sendText so LedSection can use it as a stable callback
	const sendTextStable = useStableCallback((text: string) => sendText(text));

	const numSensors = useSensorCount();

	const {
		connect: connectHR,
		disconnect: disconnectHR,
		heartrateData: bluetoothHeartrateData,
		isConnected: bluetoothConnectedHR,
		isConnecting: bluetoothConnectingHR,
		error: bluetoothHeartrateError,
		isSupported: isBluetoothSupported,
		device: heartrateDevice,
	} = useHeartrateMonitor();

	const {
		sessionId: hyperateSessionId,
		setSessionId: setHyperateSessionId,
		clearSessionId: clearHyperateSessionId,
	} = useHypeRateSessionId();
	const {
		connect: connectHypeRate,
		disconnect: disconnectHypeRate,
		heartrateData: hyperateHeartrateData,
		isConnected: hyperateConnected,
		isConnecting: hyperateConnecting,
		error: hyperateError,
	} = useHypeRateHeartrateMonitor(hyperateSessionId);

	// Everywhere else in the app (heart icon, OBS broadcast, song history
	// correlation) just wants "the current heart rate," regardless of
	// source -- so these merged names are what the rest of the file
	// continues to use unchanged. HypeRate wins if both happen to be
	// connected, since connecting it is a deliberate action the user just
	// took. HeartRateMonitorSection below still gets the raw Bluetooth-only
	// values, since that panel is specifically about the Bluetooth device.
	const heartrateData = hyperateConnected ? hyperateHeartrateData : bluetoothHeartrateData;
	const connectedHR = hyperateConnected || bluetoothConnectedHR;
	const connectingHR = hyperateConnecting || bluetoothConnectingHR;
	const heartrateError = hyperateConnected ? hyperateError : bluetoothHeartrateError;

	// Forward every new HR sample to the song history log so it can be
	// correlated against played songs (see SongHRLog.lua / useSongHistory.ts).
	useEffect(() => {
		if (heartrateData) {
			songHistory.recordHeartrateSample(heartrateData.heartrate, heartrateData.timestamp);
		}
	}, [heartrateData, songHistory]);

	// Running average HR + elapsed session duration, fed into Keytel et
	// al.'s regression (see calorieEstimate.ts) -- calorie burn depends on
	// sustained HR over time, not a single instantaneous reading, so a
	// fresh session starts averaging over whenever HR first connects and
	// resets the moment it disconnects.
	const hrSumRef = useRef(0);
	const hrCountRef = useRef(0);
	const hrSessionStartRef = useRef<number | null>(null);
	const [caloriesBurned, setCaloriesBurned] = useState<number | null>(null);

	useEffect(() => {
		if (!connectedHR) {
			hrSumRef.current = 0;
			hrCountRef.current = 0;
			hrSessionStartRef.current = null;
			setCaloriesBurned(null);
			return;
		}
		if (!heartrateData) return;

		if (hrSessionStartRef.current === null) {
			hrSessionStartRef.current = heartrateData.timestamp;
		}
		hrSumRef.current += heartrateData.heartrate;
		hrCountRef.current += 1;

		const avgHeartrate = hrSumRef.current / hrCountRef.current;
		const durationSeconds = (heartrateData.timestamp - hrSessionStartRef.current) / 1000;

		setCaloriesBurned(estimateCalories(avgHeartrate, durationSeconds, biometrics));
	}, [connectedHR, heartrateData, biometrics]);

	const {
		profiles,
		activeProfile,
		activeProfileId,
		isLoading: isProfileLoading,
		error: profileError,
		createProfile,
		deleteProfile,
		updateProfile,
		setActiveProfileById,
		resetProfileToDefaults,
		updateThresholds,
		updateSensorLabels,
		updateDisplayOrder,
	} = useProfileManager(deviceId);

	const { resolvedTheme, setTheme } = useTheme();

	const { lastCode, setLastCode } = useLastCode();
	const [showCodeChoice, setShowCodeChoice] = useState(false);

	const { canInstall, showIOSInstall, isInstalled, install } = usePWAInstall();
	const [installDismissed, setInstallDismissed] = useState(false);
	const showInstallBanner = !isInstalled && !installDismissed && (canInstall || showIOSInstall);

	const createProfileStable = useStableCallback(createProfile);
	const deleteProfileStable = useStableCallback(deleteProfile);
	const updateProfileStable = useStableCallback(updateProfile);
	const setActiveProfileByIdStable = useStableCallback(setActiveProfileById);
	const resetProfileToDefaultsStable = useStableCallback(resetProfileToDefaults);
	// Four-way theme cycle: light → dark → animus → ruby → light
	// Animus and Ruby modes are tracked independently so they can be layered on
	// top of the existing useTheme system (which only knows light/dark). When
	// either is active we force the underlying theme to "dark" so Tailwind's
	// dark: classes render correctly, then our CSS variable overrides finish
	// the job. Ruby is the "Id" palette — deep garnet/near-black base with the
	// same gold armor accent as Animus, swapping the teal for a ruby red.
	const LS_ANIMUS_KEY = "webfsr_animus_theme";
	const LS_RUBY_KEY = "webfsr_ruby_theme";
	const LS_PURPLE_KEY = "webfsr_purple_theme";
	const LS_BLUE_KEY = "webfsr_blue_theme";
	const [animusTheme, setAnimusTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_ANIMUS_KEY) === "true"; } catch { return false; }
	});
	const [rubyTheme, setRubyTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_RUBY_KEY) === "true"; } catch { return false; }
	});
	const [purpleTheme, setPurpleTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_PURPLE_KEY) === "true"; } catch { return false; }
	});
	const [blueTheme, setBlueTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_BLUE_KEY) === "true"; } catch { return false; }
	});

	// Keep underlying dark mode in sync with animus/ruby/purple/blue state
	useEffect(() => {
		if (animusTheme || rubyTheme || purpleTheme || blueTheme) setTheme("dark");
	}, [animusTheme, rubyTheme, purpleTheme, blueTheme]);

	// Six-way theme cycle: light → dark → animus → ruby → purple → blue → light
	const toggleTheme = useStableCallback(() => {
		const noSpecialTheme = !animusTheme && !rubyTheme && !purpleTheme && !blueTheme;
		if (resolvedTheme === "light" && noSpecialTheme) {
			setTheme("dark");
		} else if (resolvedTheme === "dark" && noSpecialTheme) {
			setAnimusTheme(true);
			try { localStorage.setItem(LS_ANIMUS_KEY, "true"); } catch {}
		} else if (animusTheme) {
			// animus → ruby
			setAnimusTheme(false);
			try { localStorage.setItem(LS_ANIMUS_KEY, "false"); } catch {}
			setRubyTheme(true);
			try { localStorage.setItem(LS_RUBY_KEY, "true"); } catch {}
		} else if (rubyTheme) {
			// ruby → purple
			setRubyTheme(false);
			try { localStorage.setItem(LS_RUBY_KEY, "false"); } catch {}
			setPurpleTheme(true);
			try { localStorage.setItem(LS_PURPLE_KEY, "true"); } catch {}
		} else if (purpleTheme) {
			// purple → blue
			setPurpleTheme(false);
			try { localStorage.setItem(LS_PURPLE_KEY, "false"); } catch {}
			setBlueTheme(true);
			try { localStorage.setItem(LS_BLUE_KEY, "true"); } catch {}
		} else {
			// blue → back to light
			setBlueTheme(false);
			try { localStorage.setItem(LS_BLUE_KEY, "false"); } catch {}
			setTheme("light");
		}
	});

	// Logo branding gradients per theme -- teal/gold is the default brand
	// look (used for plain Light/Dark AND Animus mode, same as before),
	// with Ruby/Purple/Blue each swapping in their own palette. Kept as
	// a lookup rather than nested ternaries now that there are 4 skins.
	const LOGO_GRADIENTS = {
		default: {
			awakened: "linear-gradient(135deg, #C9A227 0%, #F0CC55 40%, #00E5CC 75%, #00BFAA 100%)",
			animus: "linear-gradient(135deg, #C9A227 0%, #E8B830 35%, #00E5CC 70%, #00BFAA 100%)",
			textShadow: "0 0 6px rgba(0,229,204,0.35)",
		},
		ruby: {
			awakened: "linear-gradient(135deg, #4A0404 0%, #B91C1C 40%, #EF4444 75%, #FF6B6B 100%)",
			animus: "linear-gradient(135deg, #7A0C1E 0%, #E6394F 35%, #FF4D4D 70%, #FF8A5B 100%)",
			textShadow: "0 0 8px rgba(255,59,59,0.6), 0 0 20px rgba(200,20,40,0.4)",
		},
		purple: {
			awakened: "linear-gradient(135deg, #3B0764 0%, #7C3AED 40%, #C084FC 75%, #E9D5FF 100%)",
			animus: "linear-gradient(135deg, #581C87 0%, #9333EA 35%, #C084FC 70%, #F0ABFC 100%)",
			textShadow: "0 0 8px rgba(168,85,247,0.6), 0 0 20px rgba(126,34,206,0.4)",
		},
		blue: {
			awakened: "linear-gradient(135deg, #082F49 0%, #2563EB 40%, #60A5FA 75%, #BAE6FD 100%)",
			animus: "linear-gradient(135deg, #1E3A8A 0%, #2563EB 35%, #38BDF8 70%, #7DD3FC 100%)",
			textShadow: "0 0 8px rgba(56,189,248,0.6), 0 0 20px rgba(37,99,235,0.4)",
		},
	} as const;
	const activeLogoGradient = purpleTheme
		? LOGO_GRADIENTS.purple
		: blueTheme
			? LOGO_GRADIENTS.blue
			: rubyTheme
				? LOGO_GRADIENTS.ruby
				: LOGO_GRADIENTS.default;

	// Injects the orbiting/pulsing aura glow behind the sidebar logo, once
	// per document (same pattern as the heartbeat keyframes above). The
	// blobs are colored via `rgb(var(--primary))`/`rgb(var(--accent))`
	// rather than hardcoded colors, so the aura automatically follows
	// whichever theme (Light/Dark/Animus/Ruby/Purple/Blue) is active.
	useEffect(() => {
		if (!document.getElementById("aura-animation")) {
			const style = document.createElement("style");
			style.id = "aura-animation";
			style.innerHTML = `
				@keyframes aura-orbit {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
				@keyframes aura-orbit-reverse {
					from { transform: rotate(360deg); }
					to { transform: rotate(0deg); }
				}
				@keyframes aura-pulse {
					0%, 100% { opacity: 0.3; transform: scale(1); }
					50% { opacity: 0.55; transform: scale(1.1); }
				}
				@keyframes particle-rise {
					0% { transform: translate(0, 0) scale(0.5); opacity: 0; }
					15% { opacity: 1; }
					50% { transform: translate(4px, -26px) scale(1); }
					85% { opacity: 0.6; }
					100% { transform: translate(-3px, -52px) scale(0.7); opacity: 0; }
				}
			`;
			document.head.appendChild(style);
		}
	}, []);


	const [thresholds, setThresholds] = useState<number[]>([]);
	const [sensorLabels, setSensorLabels] = useState<string[]>([]);

	// Maps DISPLAY POSITION -> actual sensor index. e.g. displayOrder[0]
	// tells you which real sensor index to show FIRST. Lets someone whose
	// physical FSR wiring doesn't match Left/Down/Up/Right visually
	// reorder the sensor bars, LED Panels list, and Sensor Tuning list to
	// match their pad -- without resoldering anything or changing which
	// firmware sensor index a given panel actually uses underneath.
	// Persisted to the active Profile via updateDisplayOrder.
	const [displayOrder, setDisplayOrder] = useState<number[]>([]);

	// Returns a valid display order for the given sensor count -- either
	// the saved order if it still matches (same length, same set of
	// indices), or a fresh natural-order fallback [0,1,2,...] if the
	// saved order is stale (e.g. sensor count changed since it was saved).
	const getEffectiveDisplayOrder = (count: number, saved: number[]): number[] => {
		if (saved.length === count) {
			const seen = new Set(saved);
			const isValidPermutation = seen.size === count && saved.every((v) => v >= 0 && v < count);
			if (isValidPermutation) return saved;
		}
		return Array.from({ length: count }, (_, i) => i);
	};

	const effectiveDisplayOrder = getEffectiveDisplayOrder(numSensors, displayOrder);

	// Moves the sensor currently shown at `fromPos` to `toPos` in the
	// display order, persists it to the active profile, and updates local
	// state immediately so the UI feels instant rather than waiting on
	// the IndexedDB round trip.
	const moveDisplayPosition = useStableCallback((fromPos: number, toPos: number) => {
		if (fromPos === toPos) return;
		const current = getEffectiveDisplayOrder(numSensors, displayOrder);
		const next = [...current];
		const [moved] = next.splice(fromPos, 1);
		next.splice(toPos, 0, moved);
		setDisplayOrder(next);
		if (activeProfileId) updateDisplayOrder(next);
	});

	// Advanced Sensor Tuning mode -- lifted up to Dashboard level (rather
	// than kept local to SensorTuningSection) because it needs to affect
	// the MAIN PAGE sensor bars too: the main page's threshold drag/slider
	// sends the legacy single-value "0 <sensor> <val>" command, which
	// firmware-side collapses Trigger AND Release back down to a narrow
	// ~20-unit gap. If Advanced mode is on and someone's deliberately set
	// a wide Trigger/Release gap, the main page slider must stop sending
	// that legacy command -- otherwise it silently undoes the Advanced
	// tuning the moment the main page is touched.
	const [advancedTuningEnabled, setAdvancedTuningEnabled] = useState<boolean>(loadAdvancedMode);
	const [mainTab, setMainTab] = useState<"sensors" | "leds" | "songs">("sensors");
	// Sensor Tuning is Release-only now (see handleThresholdChange) -- Trigger
	// lives solely in `thresholds` at all times, so there's no second value to
	// reconcile when this toggles, and no handoff step needed here anymore.
	const toggleAdvancedTuningMode = useStableCallback(() => {
		const next = !advancedTuningEnabled;
		setAdvancedTuningEnabled(next);
		saveAdvancedMode(next);
	});

	// Holds the live Trigger and Release thresholds per sensor as reported
	// by SensorTuningSection, used to show the main page sensor bars'
	// threshold lines correctly once Advanced mode is on (see
	// handleThresholdChange and sensorBars below).
	const [liveTriggerValues, setLiveTriggerValues] = useState<number[]>([]);
	const [liveReleaseValues, setLiveReleaseValues] = useState<number[]>([]);

	// Wave-signal graph visibility (persisted). Hiding it frees the whole
	// lower area for the Trigger/Release + tuning controls.
	const [graphVisible, setGraphVisible] = useState<boolean>(() => {
		try { return localStorage.getItem("webfsr_public_graph_visible") !== "false"; } catch { return true; }
	});
	const toggleGraphVisible = useStableCallback(() => {
		const next = !graphVisible;
		setGraphVisible(next);
		try { localStorage.setItem("webfsr_graph_visible", String(next)); } catch { /* ignore */ }
	});

	// Undo history for Trigger / Release drags. One entry = the values BEFORE
	// a burst of changes to one sensor; continuous drags within COALESCE_MS
	// collapse into a single entry so Ctrl+Z jumps back to where the drag
	// STARTED rather than one pixel back.
	const UNDO_LIMIT = 100;
	const UNDO_COALESCE_MS = 600;
	const undoStackRef = useRef<Array<{ index: number; trigger?: number; release?: number }>>([]);
	const lastUndoPushRef = useRef<{ index: number; kind: "trigger" | "release"; t: number } | null>(null);
	const suppressUndoRecordRef = useRef(false);
	const [undoDepth, setUndoDepth] = useState(0);
	const recordUndo = (index: number, kind: "trigger" | "release", prev: { trigger?: number; release?: number }) => {
		if (suppressUndoRecordRef.current) return;
		const now = Date.now();
		const last = lastUndoPushRef.current;
		lastUndoPushRef.current = { index, kind, t: now };
		if (last && last.index === index && last.kind === kind && now - last.t < UNDO_COALESCE_MS) return;
		const stack = undoStackRef.current;
		stack.push({ index, ...prev });
		if (stack.length > UNDO_LIMIT) stack.shift();
		setUndoDepth(stack.length);
	};
	// Per-sensor "lock Release to Trigger" toggle -- see the matching
	// comment in the personal/dev build for the full reasoning. Purely
	// dashboard-side; the firmware still just receives independent "y"/
	// "r" commands as always. Now persisted via loadReleaseLocked/
	// saveReleaseLocked (localStorage), scoped per physical board via
	// deviceId -- previously this was plain useState with nothing
	// backing it, so it silently reset to "off" for every sensor on any
	// reload, reconnect, or navigation away and back; and before the
	// per-device scoping added here, it was also a single shared key
	// that two pads connected at once would silently clobber.
	const [releaseLocked, setReleaseLockedState] = useState<Record<number, boolean>>(() => loadReleaseLocked(deviceId));
	const setReleaseLocked = useStableCallback(
		(updater: (prev: Record<number, boolean>) => Record<number, boolean>) => {
			setReleaseLockedState((prev) => {
				const next = updater(prev);
				saveReleaseLocked(next, deviceId);
				return next;
			});
		},
	);
	// Same reload-on-real-deviceId-change reasoning as SensorTuningSection's
	// tuning reload -- deviceId is only known after the async identify
	// response, so the useState initializer above almost always ran with
	// null at mount.
	const prevReleaseLockedDeviceIdRef = useRef<string | null>(deviceId);
	useEffect(() => {
		if (deviceId === prevReleaseLockedDeviceIdRef.current) return;
		prevReleaseLockedDeviceIdRef.current = deviceId;
		setReleaseLockedState(loadReleaseLocked(deviceId));
	}, [deviceId]);
	const onTuningValuesChangeStable = useStableCallback((triggers: number[], releases: number[]) => {
		setLiveTriggerValues(triggers);
		setLiveReleaseValues(releases);
	});

	const [isSyncingProfile, setIsSyncingProfile] = useState<boolean>(false);
	const writebackTimeoutRef = useRef<number | null>(null);

	const [openColorPickers, setOpenColorPickers] = useState<boolean[]>([]);

	const [obsComponentDialogOpen, setObsComponentDialogOpen] = useState<boolean>(false);
	const [obsPassword, setobsPassword] = useState<string>(activeProfile?.obsPassword ?? "");
	const [aboutOpen, setAboutOpen] = useState<boolean>(false);
	const [pairingModalOpen, setPairingModalOpen] = useState<boolean>(false);

	const isMobile = useIsMobile();

	const [devHideOverlay, setDevHideOverlay] = useState<boolean>(import.meta.env.DEV);
	
	useEffect(() => {
		setobsPassword(activeProfile?.obsPassword ?? "");
	}, [activeProfile?.obsPassword]);

	const {
		connect: connectOBS,
		disconnect: disconnectOBS,
		isConnected: obsConnected,
		isConnecting: obsConnecting,
		error: obsError,
		broadcast,
		autoConnect: obsAutoConnectEnabled,
		nextRetryInMs: obsNextRetryInMs,
		setAutoConnectEnabled,
	} = useOBS();
	const lastBroadcastAtRef = useRef<number>(0);
	const lastRemoteBroadcastAtRef = useRef<number>(0);
	const broadcastToOBS = useStableCallback((payload: ObsBroadcastPayload) => {
		void broadcast(payload);
	});

	const handleRemoteMessage = useStableCallback((message: DesktopMessage | MobileMessage) => {
		if (message.type === "threshold") {
			const { index, value } = message as { type: "threshold"; index: number; value: number };
			handleThresholdChange(index, value);
		} else if (message.type === "trigger") {
			// Trigger is unified into the single basic thresholds model now
			// (see handleThresholdChange) -- route this the same as
			// "threshold" instead of writing to liveTriggerValues + a
			// separate "y" command, so a paired mobile client can't
			// reintroduce the old stale-value-on-toggle bug through this
			// path. If the mobile app still decides "trigger" vs
			// "threshold" based on advancedTuningEnabled, it can keep doing
			// so safely -- both now land in the same place here.
			const { index, value } = message as { type: "trigger"; index: number; value: number };
			handleThresholdChange(index, value);
		} else if (message.type === "release") {
			const { index, value } = message as { type: "release"; index: number; value: number };
			setLiveReleaseValues((prev) => {
				const next = [...prev];
				next[index] = value;
				return next;
			});
			if (connected) sendText(`r ${index} ${value}\n`);
		} else if (message.type === "ready") {
			sendProfileSync();
		}
	});

	const {
		isConnected: remoteConnected,
		isConnecting: remoteConnecting,
		code: remoteCode,
		connect: connectRemote,
		disconnect: disconnectRemote,
		send: sendRemote,
	} = useRemoteControl({
		role: "host",
		onPeerConnected: () => {
			sendProfileSync();
		},
		onPeerDisconnected: () => {},
		onMessage: handleRemoteMessage,
	});

	useEffect(() => {
		if (remoteConnected && remoteCode) {
			void setLastCode(remoteCode);
		}
	}, [remoteConnected, remoteCode]);

	const sendProfileSync = useStableCallback(() => {
		if (!remoteConnected) return;

		const payload: ProfileSyncPayload = {
			thresholds,
			sensorLabels,
			sensorColors: colorSettings.sensorColors,
			thresholdColor: colorSettings.thresholdColor,
			useThresholdColor: barSettings.useThresholdColor,
			useSingleColor: barSettings.useSingleColor,
			singleBarColor: colorSettings.singleBarColor,
			isLocked: generalSettings.lockThresholds,
			theme: resolvedTheme,
			advancedTuningEnabled: advancedTuningEnabled,
			liveTriggerValues,
			liveReleaseValues,
		};

		sendRemote({ type: "sync", payload });
	});

	useEffect(() => {
		if (!remoteConnected) return;
		sendProfileSync();
	}, [
		remoteConnected,
		thresholds,
		sensorLabels,
		colorSettings.sensorColors,
		colorSettings.thresholdColor,
		barSettings.useThresholdColor,
		barSettings.useSingleColor,
		colorSettings.singleBarColor,
		generalSettings.lockThresholds,
		resolvedTheme,
		advancedTuningEnabled,
		liveTriggerValues,
		liveReleaseValues,
	]);

	const heartBeatDuration =
		!heartrateData?.heartrate || !heartrateSettings.animateHeartbeat
			? 0
			: (60 / heartrateData.heartrate) * 1000;

	const heartBeatStyle = !heartBeatDuration
		? {}
		: {
				animation: `heartbeat ${heartBeatDuration}ms ease-in-out infinite`,
		  };

	useEffect(() => {
		if (!document.getElementById("heartbeat-animation")) {
			const style = document.createElement("style");
			style.id = "heartbeat-animation";
			style.innerHTML = `
				@keyframes heartbeat {
					0%, 100% { transform: scale(1); }
					15% { transform: scale(1.2); }
					30% { transform: scale(1); }
					45% { transform: scale(1.15); }
					60% { transform: scale(1); }
				}
			`;
			document.head.appendChild(style);
		}
	}, []);

	useEffect(() => {
		if (!obsConnected) return;

		broadcastToOBS({
			heartrateConnected: connectedHR,
			heartrate: heartrateData?.heartrate,
			heartrateTimestamp: heartrateData?.timestamp,
		});
	}, [broadcastToOBS, connectedHR, heartrateData?.heartrate, heartrateData?.timestamp, obsConnected]);

	// Feeds the OBS "Song Ticker" component -- broadcasts the most recent
	// plays (banner pre-resolved to an absolute URL, since the OBS browser
	// source page has no Electron bridge access of its own to resolve a
	// raw bannerPath the way the in-app song history view can). Always
	// sends the top 10 regardless of how many the ticker is configured to
	// actually show -- the OBS-side component decides its own visible
	// count from its own URL config, so the count can be changed live in
	// OBS without needing new data pushed from here.
	const recentSongsForBroadcast = useMemo<BroadcastSongEntry[]>(() => {
		return songHistory.songs
			.map((song) => computeSongStats(song, songHistory.hrSamples, biometrics))
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, 10)
			.map((song) => ({
				title: song.title,
				artist: song.artist,
				style: song.style,
				difficultyName: song.difficultyName,
				difficulty: song.difficulty,
				grade: song.grade,
				passed: song.passed,
				score: song.score,
				avgHr: song.avgHr,
				maxHr: song.maxHr,
				calories: song.calories,
				durationSeconds: song.durationSeconds,
				startTime: song.startTime,
				rate: song.rate,
				bannerUrl: bannerUrl(songHistory.mediaBaseUrl, song.bannerPath),
			}));
	}, [songHistory.songs, songHistory.hrSamples, songHistory.mediaBaseUrl, biometrics]);

	useEffect(() => {
		if (!obsConnected) return;
		broadcastToOBS({ recentSongs: recentSongsForBroadcast });
	}, [broadcastToOBS, recentSongsForBroadcast, obsConnected]);

	const handleHeartrateToggle = useStableCallback(async () => {
		if (!isBluetoothSupported) return;

		if (connectedHR) {
			await disconnectHR();
		} else {
			await connectHR();
		}
	});

	const sendAllThresholds = () => {
		// Trigger lives solely in `thresholds` now, in both Sensor Tuning
		// Off and On (see handleThresholdChange), so this needs to resync
		// to the firmware on every connect/profile change regardless of
		// that toggle -- previously this skipped entirely while Advanced
		// mode was on, which made sense when Trigger had its own separate
		// "y"-command-driven model, but would now mean a saved profile's
		// Trigger silently failing to apply on connect whenever Sensor
		// Tuning happened to be left on.
		//
		// NOTE: this still sends the legacy single-value command, which
		// (per firmware) re-derives Release from Trigger with a narrow
		// gap -- so a custom Release set via Sensor Tuning will get
		// pulled back in on every reconnect/profile switch, same as
		// whenever Trigger is dragged on the main bar. Flagging this
		// rather than silently working around it since it depends on
		// exact firmware behavior; if Release should survive reconnects,
		// this needs to re-send liveReleaseValues right after.
		if (!connected || !thresholds.length) return;

		thresholds.forEach((value, index) => {
			const message = `${index} ${value}\n`;
			sendText(message);
		});
	};

	useEffect(() => {
		if (connected) sendAllThresholds();
	}, [connected, advancedTuningEnabled]);

	useEffect(() => {
		if (activeProfileId && connected) sendAllThresholds();
	}, [activeProfileId, connected, advancedTuningEnabled]);

	const syncUIStateWithProfile = (profile: ProfileData) => {
		if (!profile) return;

		updateAllSettings({
			sensorColors: profile.sensorColors,
			showBarThresholdText: profile.showBarThresholdText,
			showBarValueText: profile.showBarValueText,
			thresholdColor: profile.thresholdColor,
			useThresholdColor: profile.useThresholdColor,
			useSingleColor: profile.useSingleColor,
			singleBarColor: profile.singleBarColor,
			useBarGradient: profile.useBarGradient,
			showGridLines: profile.showGridLines,
			showThresholdLines: profile.showThresholdLines,
			thresholdLineOpacity: profile.thresholdLineOpacity,
			showLegend: profile.showLegend,
			showGraphBorder: profile.showGraphBorder,
			showGraphActivation: profile.showGraphActivation,
			graphActivationColor: profile.graphActivationColor,
			timeWindow: profile.timeWindow,
			showHeartrateMonitor: profile.showHeartrateMonitor,
			lockThresholds: profile.lockThresholds,
			verticalAlignHeartrate: profile.verticalAlignHeartrate,
			fillHeartIcon: profile.fillHeartIcon,
			showBpmText: profile.showBpmText,
			animateHeartbeat: profile.animateHeartbeat,
			pollingRate: profile.pollingRate,
			useUnthrottledPolling: profile.useUnthrottledPolling,
		});

		if (profile.thresholds.length > 0) {
			setThresholds(profile.thresholds);
		} else if (numSensors > 0) {
			// Only used for the DISPLAY fallback (and only relevant while
			// Advanced Tuning is off, since sendAllThresholds now skips
			// entirely while it's on -- see the comment there). Deliberately
			// NOT persisted back into the profile via updateThresholds:
			// doing so used to permanently bake a synthesized "512 for
			// every sensor" into any profile that had simply never touched
			// the legacy threshold model (e.g. an Advanced-Tuning-only
			// profile), so just switching to that profile once was enough
			// to corrupt it -- from then on `profile.thresholds.length > 0`
			// would be true, `sendAllThresholds` would treat 512 as
			// legitimate saved data, and (before the sendAllThresholds fix
			// above) it would get pushed to the firmware, overwriting the
			// real tuned values. Leaving the profile's thresholds genuinely
			// empty until the user actually sets one preserves the
			// distinction between "never configured" and "configured to
			// 512" -- the whole reason profile.thresholds.length is used
			// as a check anywhere in this file.
			const defaultThresholds = Array(numSensors).fill(512);
			setThresholds(defaultThresholds);
		}

		if (profile.sensorLabels.length > 0) {
			setSensorLabels(profile.sensorLabels);
		} else if (numSensors > 0) {
			const defaultLabels = Array(numSensors)
				.fill("")
				.map((_, i) => `Sensor ${i + 1}`);
			setSensorLabels(defaultLabels);
			if (activeProfileId) void updateSensorLabels(defaultLabels);
		}

		// displayOrder has no "generate a default" branch like thresholds/
		// labels above -- an empty array is itself a perfectly valid
		// state (it means "natural order", handled by
		// getEffectiveDisplayOrder's fallback), so there's nothing to
		// backfill into the profile here.
		setDisplayOrder(profile.displayOrder ?? []);
	};

	useEffect(() => {
		if (!activeProfile) return;
		setIsSyncingProfile(true);
		syncUIStateWithProfile(activeProfile);
		const id = window.setTimeout(() => setIsSyncingProfile(false), 0);
		return () => window.clearTimeout(id);
	}, [activeProfileId]);

	const getVisualSettingsFromUIState = () => getAllSettings();

	const updateProfileVisualSettings = () => {
		if (!activeProfileId) return;
		updateProfile(activeProfileId, getVisualSettingsFromUIState());
	};

	// ── Profile export / import (.json) ──
	// A standalone snapshot of everything a profile contains -- the visual
	// settings ProfilesSection already persists (via getAllSettings/
	// updateAllSettings), plus thresholds, sensor labels, display order, and
	// the per-sensor tuning (gain/button group/release debounce/trigger/
	// release) that lives in SensorTuningSection. This is
	// separate from FirmwareUpdateSection's "Back Up My Settings": that one
	// is a raw EEPROM snapshot used around OTA firmware updates
	// specifically; this one mirrors a saved Profile, meant for sharing a
	// full setup or keeping an offline copy of it as a portable file.
	const [profileImportStatus, setProfileImportStatus] = useState<string | null>(null);
	const profileImportInputRef = useRef<HTMLInputElement>(null);

	const exportProfileToJson = () => {
		const controls = (SensorTuningSection as unknown as { _getControls?: () => SensorTuningControls })._getControls?.();
		const snapshot = {
			kind: "webfsr-profile" as const,
			savedAt: new Date().toISOString(),
			name: activeProfile?.name ?? "My Profile",
			thresholds,
			sensorLabels,
			displayOrder,
			tuning: controls?.tuning ?? [],
			settings: getVisualSettingsFromUIState(),
		};
		const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const safeName = (snapshot.name || "profile").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
		a.href = url;
		a.download = `${safeName || "webfsr-profile"}-${new Date().toISOString().slice(0, 10)}.json`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const importProfileFromJson = async (file: File) => {
		let parsed: {
			kind?: string;
			name?: string;
			thresholds?: number[];
			sensorLabels?: string[];
			displayOrder?: number[];
			tuning?: SensorTuning[];
			settings?: Record<string, unknown>;
		};
		try {
			parsed = JSON.parse(await file.text());
		} catch {
			setProfileImportStatus("That file isn't valid JSON.");
			return;
		}
		if (parsed?.kind !== "webfsr-profile") {
			setProfileImportStatus("That doesn't look like a webfsr profile export.");
			return;
		}

		if (Array.isArray(parsed.thresholds) && parsed.thresholds.length) {
			setThresholds(parsed.thresholds);
			if (activeProfileId) updateThresholds(parsed.thresholds);
		}
		if (Array.isArray(parsed.sensorLabels) && parsed.sensorLabels.length) {
			setSensorLabels(parsed.sensorLabels);
			if (activeProfileId) updateSensorLabels(parsed.sensorLabels);
		}
		if (Array.isArray(parsed.displayOrder)) {
			setDisplayOrder(parsed.displayOrder);
		}
		if (parsed.settings) {
			updateAllSettings(parsed.settings);
			if (activeProfileId) updateProfile(activeProfileId, parsed.settings);
		}

		// Per-sensor tuning -- applied through the same commit functions the
		// UI itself uses, with a small stagger between commands like
		// applyBackup does elsewhere, so the firmware's serial buffer isn't
		// hammered all at once. Trigger/Release go through the same unified
		// handlers as dragging the main bar (see handleThresholdChange /
		// handleSecondaryThresholdChange above) rather than a raw "y"/"r"
		// send, so imported values participate in Lock Release to Trigger
		// and profile write-back exactly like a manual edit would.
		const controls = (SensorTuningSection as unknown as { _getControls?: () => SensorTuningControls })._getControls?.();
		if (Array.isArray(parsed.tuning) && controls) {
			let delay = 0;
			const step = 60;
			parsed.tuning.forEach((s, i) => {
				if (typeof s.trigger === "number") setTimeout(() => handleThresholdChange(i, s.trigger), (delay += step));
				if (typeof s.release === "number") setTimeout(() => handleSecondaryThresholdChange(i, s.release), (delay += step));
				if (typeof s.gainX100 === "number") setTimeout(() => controls.commitGain(i, s.gainX100), (delay += step));
				if (typeof s.buttonGroup === "number") setTimeout(() => controls.commitButtonGroup(i, s.buttonGroup), (delay += step));
				if (typeof s.releaseDebounceMs === "number") setTimeout(() => controls.commitReleaseDebounce(i, s.releaseDebounceMs), (delay += step));
			});
		}

		setProfileImportStatus(`Imported "${parsed.name ?? "profile"}".`);
	};

	useEffect(() => {
		if (!activeProfileId || isSyncingProfile) return;

		if (writebackTimeoutRef.current) {
			window.clearTimeout(writebackTimeoutRef.current);
		}

		writebackTimeoutRef.current = window.setTimeout(() => {
			updateProfileVisualSettings();
		}, 100);

		return () => {
			if (writebackTimeoutRef.current) window.clearTimeout(writebackTimeoutRef.current);
		};
	}, [activeProfileId, colorSettings, barSettings, graphSettings, heartrateSettings, generalSettings, isSyncingProfile]);

	useEffect(() => {
		if (numSensors === 0) return;

		if (thresholds.length !== numSensors) {
			// Local display-only fill, deliberately NOT persisted to the
			// profile (no updateThresholds call here) -- this effect fires
			// on every numSensors change, which includes ordinary connects
			// where `thresholds` just hasn't caught up to the real count
			// yet. Persisting here meant a plain connect/reconnect could
			// silently bake "512 for every sensor" into the active
			// profile before syncUIStateWithProfile even got a chance to
			// load the profile's real saved thresholds -- see the longer
			// writeup at syncUIStateWithProfile for why that matters.
			const newThresholds = Array(numSensors).fill(512);
			setThresholds(newThresholds);
		}

		if (sensorLabels.length !== numSensors) {
			const newLabels = Array(numSensors)
				.fill("")
				.map((_, i) => `Sensor ${i + 1}`);

			setSensorLabels(newLabels);

			if (activeProfileId) updateSensorLabels(newLabels);
		}

		if (openColorPickers.length !== numSensors) setOpenColorPickers(Array(numSensors).fill(false));
	}, [numSensors, thresholds.length, sensorLabels.length, openColorPickers.length, activeProfileId]);

	// Trigger (sensitivity) now always goes through the single basic
	// threshold model, in BOTH Sensor Tuning Off and On -- previously,
	// turning Sensor Tuning on swapped the main bar's red line over to a
	// separate `liveTriggerValues` model, and turning it back off seeded
	// `thresholds` from whatever `liveTriggerValues` held at that moment.
	// If a sensor's live trigger hadn't been refreshed from the firmware
	// yet (e.g. its "p" query response hadn't come back), that seed step
	// baked the stale/default value permanently back into the firmware
	// the moment Sensor Tuning was closed -- silently changing sensitivity
	// the user never touched. Sensor Tuning is now Release-only, so
	// Trigger never has a second value to reconcile.
	const handleThresholdChange = useStableCallback((index: number, value: number) => {
		const prevTrigger = thresholds[index];
		if (typeof prevTrigger === "number" && prevTrigger !== value) {
			const lockedRelease = advancedTuningEnabled && releaseLocked[index] ? liveReleaseValues[index] : undefined;
			recordUndo(index, "trigger", { trigger: prevTrigger, release: lockedRelease });
		}
		const newThresholds = [...thresholds];
		newThresholds[index] = value;
		setThresholds(newThresholds);

		if (activeProfileId) updateThresholds(newThresholds);

		if (connected) {
			const message = `${index} ${value}\n`;
			sendText(message);
		}

		// Lock Release to Trigger: preserve whatever gap existed when the
		// lock was turned on. Only relevant once Sensor Tuning has been
		// opened (that's the only place the lock toggle and Release line
		// are shown), but harmless to check unconditionally. Clamped to
		// 0-1023 same as any other threshold value.
		if (advancedTuningEnabled && releaseLocked[index] && typeof prevTrigger === "number") {
			const delta = value - prevTrigger;
			const prevRelease = liveReleaseValues[index] ?? 0;
			const newRelease = Math.max(0, Math.min(1023, prevRelease + delta));
			setLiveReleaseValues((prev) => {
				const next = [...prev];
				next[index] = newRelease;
				return next;
			});
			if (connected) sendText(`r ${index} ${newRelease}\n`);
		}
	});

	// Parallel handler for dragging the Release (green) line directly on
	// the main page bar -- only relevant/wired up when Advanced mode is
	// on, since that's the only time SensorBar is given a
	// secondaryThreshold + this callback together (see sensorBars below).
	const handleSecondaryThresholdChange = useStableCallback((index: number, value: number) => {
		const prevRelease = liveReleaseValues[index];
		if (typeof prevRelease === "number" && prevRelease !== value) recordUndo(index, "release", { release: prevRelease });
		setLiveReleaseValues((prev) => {
			const next = [...prev];
			next[index] = value;
			return next;
		});
		if (connected) sendText(`r ${index} ${value}\n`);
	});

	// Pops the most recent Trigger/Release change and re-applies the old
	// value(s) through the normal handlers (so profile save + firmware
	// "y"/"r" commands all happen) without recording a new history entry.
	const undoLastThresholdChange = useStableCallback(() => {
		const entry = undoStackRef.current.pop();
		setUndoDepth(undoStackRef.current.length);
		lastUndoPushRef.current = null;
		if (!entry) return;
		suppressUndoRecordRef.current = true;
		try {
			if (typeof entry.trigger === "number") handleThresholdChange(entry.index, entry.trigger);
			// Applied AFTER trigger so a locked-release shift is overridden
			// by the exact value that was stored.
			if (typeof entry.release === "number") handleSecondaryThresholdChange(entry.index, entry.release);
		} finally {
			suppressUndoRecordRef.current = false;
		}
	});

	// Ctrl/Cmd+Z. Ignored while typing in an input/textarea/select so native
	// text undo (e.g. in the new numeric boxes) still works.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
			const el = e.target as HTMLElement | null;
			if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) {
				// Range sliders have no text undo, so allow those through.
				if (!(el.tagName === "INPUT" && (el as HTMLInputElement).type === "range")) return;
			}
			if (undoStackRef.current.length === 0) return;
			e.preventDefault();
			undoLastThresholdChange();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [undoLastThresholdChange]);

	const onLabelChangeStable = useStableCallback((index: number, value: string) => {
		const newLabels = [...sensorLabels];
		newLabels[index] = value;
		setSensorLabels(newLabels);

		if (activeProfileId) updateSensorLabels(newLabels);
	});

	const handleConnectionToggle = useStableCallback(async () => {
		if (!isSupported) return;

		if (connected) {
			await disconnect();
			return;
		}
		await connect();
	});

	const onObsToggleStable = useStableCallback((pwd: string) => {
		if (!pwd) return;
		if (obsConnected) {
			void disconnectOBS();
			return;
		}
		void connectOBS(pwd);
	});

	useEffect(() => {
		if (!activeProfile) return;
		const shouldAuto = Boolean((activeProfile as { obsAutoConnect?: boolean }).obsAutoConnect);
		const pwd = activeProfile.obsPassword || "";

		setAutoConnectEnabled(shouldAuto && !!pwd, pwd);

		if (shouldAuto && pwd && !obsConnected && !obsConnecting) {
			setAutoConnectEnabled(true, pwd);
		}
	}, [activeProfile?.id, activeProfile?.obsPassword, (activeProfile as { obsAutoConnect?: boolean })?.obsAutoConnect]);

	const onCreateComponent = useStableCallback(() => {
		setObsComponentDialogOpen(true);
	});

	const onToggleAutoConnectStable = useStableCallback((checked: boolean, pwd: string) => {
		if (!pwd) return;
		setAutoConnectEnabled(checked && !!pwd, pwd);
	});

	const sensorBarsDrag = useRowDragReorder(moveDisplayPosition);

	// Sensor bar + its mini-controls live in the SAME per-sensor column
	// again -- see the matching comment in the personal/dev build for
	// why (two separate grids had no guarantee of matching column
	// widths, which is what broke reordering sync).
	const sensorBars = Array.from({ length: numSensors }, (_, position) => {
		const index = effectiveDisplayOrder[position] ?? position;
		return (
			<div
				key={`sensor-pos-${position}`}
				className={`relative h-full min-h-0 min-w-0 flex flex-col transition-opacity ${sensorBarsDrag.draggingPos === position ? "opacity-40" : ""} ${sensorBarsDrag.dragOverPos === position ? "ring-2 ring-primary rounded" : ""}`}
				onDragOver={sensorBarsDrag.handleDragOver(position)}
				onDrop={sensorBarsDrag.handleDrop(position)}
			>
				<div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 pt-0.5">
					<DragHandle
						onDragStart={sensorBarsDrag.handleDragStart(position)}
						onDragEnd={sensorBarsDrag.handleDragEnd}
					/>
				</div>
				<div className="relative flex-1 min-h-0">
					<SensorBar
						key={`sensor-${index}`}
						value={latestData?.values[index] || 0}
						index={index}
						threshold={thresholds[index] || 512}
						onThresholdChange={handleThresholdChange}
						label={sensorLabels[index] || `Sensor ${index + 1}`}
						color={
							barSettings.useSingleColor
								? colorSettings.singleBarColor
								: colorSettings.sensorColors[index % colorSettings.sensorColors.length] || "#ff0000"
						}
						showThresholdText={barSettings.showBarThresholdText}
						showValueText={barSettings.showBarValueText}
						thresholdColor={colorSettings.thresholdColor}
						useThresholdColor={barSettings.useThresholdColor}
						useGradient={barSettings.useBarGradient}
						isLocked={generalSettings.lockThresholds}
						theme={resolvedTheme}
						secondaryThreshold={advancedTuningEnabled ? liveReleaseValues[index] : undefined}
						secondaryThresholdLabel="Release"
						secondaryThresholdColor="rgba(34, 197, 94, 0.9)"
						onSecondaryThresholdChange={advancedTuningEnabled ? handleSecondaryThresholdChange : undefined}
					/>
				</div>
				{/* Release readout + Lock Release to Trigger toggle -- see the
				    matching comment in the personal/dev build for why this
				    can't sit inside SensorBar's own row (external
				    component). Always mounted at a fixed height, same
				    reasoning as the slot below it. Bumped 26px -> 44px to
				    fit the Release value/default/reset row above the lock
				    button. */}
				<div style={{ height: "calc(44px * var(--sensor-ui-scale))" }} className="shrink-0 mt-1 flex flex-col items-center justify-center gap-0.5">
					{advancedTuningEnabled && (
						<>
							<div className="flex items-center gap-1 text-[length:calc(10px*var(--sensor-ui-scale))] text-muted-foreground">
								<span>
									Release: <span className="text-green-500 font-mono">{liveReleaseValues[index] ?? "—"}</span>
									<span className="opacity-60"> (default {defaultReleaseFor(thresholds[index])})</span>
								</span>
								<button
									type="button"
									title={`Reset Release to default (${defaultReleaseFor(thresholds[index])}, 20 below Trigger)`}
									onClick={() => handleSecondaryThresholdChange(index, defaultReleaseFor(thresholds[index]))}
									className="text-muted-foreground hover:text-foreground shrink-0"
								>
									<RefreshCw className="size-[calc(10px*var(--sensor-ui-scale))]" />
								</button>
							</div>
							<button
								type="button"
								onClick={() => setReleaseLocked((prev) => ({ ...prev, [index]: !prev[index] }))}
								title="When on, moving Trigger also moves Release by the same amount, preserving their gap"
								className={`flex items-center gap-1 text-[length:calc(10px*var(--sensor-ui-scale))] px-2 py-0.5 rounded border transition-colors ${
									releaseLocked[index]
										? "bg-foreground text-background border-foreground"
										: "bg-transparent text-muted-foreground border-border"
								}`}
							>
								{releaseLocked[index] ? "🔒" : "🔓"} Lock Release to Trigger
							</button>
						</>
					)}
				</div>
				{/* Always mounted at a fixed height -- only the content inside
				    toggles. overflow-y-auto lets a narrow column scroll WITHIN this
				    slot rather than pushing into/behind the sensor wave above. */}
				<div style={{ height: "calc(152px * var(--sensor-ui-scale))" }} className="shrink-0 mt-1 pt-2 border-t border-border/40 overflow-y-auto">
					{/* Gain / Release Debounce / Button Group are
					    useful regardless of whether Sensor Tuning is on -- none of
					    them touch Trigger or Release, so there's no reason to gate
					    them behind that toggle. Always mounted now instead of only
					    when advancedTuningEnabled. */}
					<SensorMiniControls index={index} />
				</div>
			</div>
		);
	});

	if (isMobile) {
		return (
			<MobileDashboard
				sensorColors={colorSettings.sensorColors}
				thresholdColor={colorSettings.thresholdColor}
				useThresholdColor={barSettings.useThresholdColor}
				useSingleColor={barSettings.useSingleColor}
				singleBarColor={colorSettings.singleBarColor}
				theme={resolvedTheme}
				canInstallPWA={canInstall}
				showIOSInstall={showIOSInstall}
				isInstalled={isInstalled}
				onInstallPWA={install}
				profileName={activeProfile?.name}
			/>
		);
	}

	return (
		<main className={`grid grid-cols-[17rem_1fr] h-screen w-screen bg-background text-foreground overflow-hidden${animusTheme ? " theme-animus" : ""}${rubyTheme ? " theme-ruby" : ""}${purpleTheme ? " theme-purple" : ""}${blueTheme ? " theme-blue" : ""}`}>
		<UpdateModal animusTheme={animusTheme} rubyTheme={rubyTheme} />
		{animusTheme && (
			<style>{`
				.theme-animus {
					/* Deep dark teal-black base */
					--background:        8 18 16;
					--foreground:        210 255 245;
					--card:              10 24 20;
					--card-foreground:   210 255 245;
					--popover:           8 20 17;
					--popover-foreground:210 255 245;

					/* Gold primary — buttons, active states */
					--primary:           201 162 39;
					--primary-foreground:8 18 16;

					/* Teal secondary */
					--secondary:         0 60 50;
					--secondary-foreground:0 229 204;

					/* Muted — slightly brighter than bg so panels read */
					--muted:             12 30 25;
					--muted-foreground:  120 190 175;

					/* Teal accent */
					--accent:            0 45 38;
					--accent-foreground: 0 229 204;

					/* Border — subtle gold tint */
					--border:            40 65 55;
					--input:             12 28 23;
					--ring:              201 162 39;

					/* Destructive stays red */
					--destructive:       220 50 50;
					--destructive-foreground:255 255 255;

					--radius: 0.5rem;
				}

				/* Sidebar */
				.theme-animus .border-r {
					background: rgb(6 14 12) !important;
					border-color: rgb(40 65 55) !important;
				}

				/* Panels / cards */
				.theme-animus .bg-white,
				.theme-animus .dark\\:bg-neutral-900,
				.theme-animus .dark\\:bg-neutral-950 {
					background-color: rgb(10 24 20) !important;
				}

				/* Borders */
				.theme-animus .border,
				.theme-animus .border-border {
					border-color: rgb(40 65 55) !important;
				}

				/* Gold glow on focused inputs */
				.theme-animus input:focus,
				.theme-animus select:focus {
					outline: none;
					box-shadow: 0 0 0 2px rgba(201,162,39,0.45);
				}

				/* Tab active underline — gold */
				.theme-animus .border-foreground {
					border-color: #C9A227 !important;
					color: #C9A227 !important;
				}

				/* Scrollbar */
				.theme-animus ::-webkit-scrollbar-track { background: rgb(8 18 16); }
				.theme-animus ::-webkit-scrollbar-thumb { background: rgb(40 65 55); border-radius: 4px; }
				.theme-animus ::-webkit-scrollbar-thumb:hover { background: #C9A227; }

				/* Sensor bars base bg */
				.theme-animus .bg-muted { background-color: rgb(12 30 25) !important; }

				/* Button primary style override for gold feel */
				.theme-animus button[class*="bg-primary"],
				.theme-animus [class*="bg-primary"] {
					background-color: #C9A227 !important;
					color: rgb(8 18 16) !important;
				}

				/* Subtle circuit-board background pattern on the main content area */
				.theme-animus > div:last-child {
					background-image:
						linear-gradient(rgba(0,229,204,0.03) 1px, transparent 1px),
						linear-gradient(90deg, rgba(0,229,204,0.03) 1px, transparent 1px);
					background-size: 32px 32px;
				}
			`}</style>
		)}
		{rubyTheme && (
			<style>{`
				.theme-ruby {
					/* Deep garnet-black base */
					--background:        16 6 8;
					--foreground:        255 225 220;
					--card:              22 9 11;
					--card-foreground:   255 225 220;
					--popover:           18 7 9;
					--popover-foreground:255 225 220;

					/* Vivid crimson primary — no gold, reads as the gem's own highlight */
					--primary:           220 38 38;
					--primary-foreground:255 240 235;

					/* Ruby secondary */
					--secondary:         60 8 14;
					--secondary-foreground:255 90 100;

					/* Muted — slightly brighter than bg so panels read */
					--muted:             28 11 13;
					--muted-foreground:  190 120 120;

					/* Ember accent */
					--accent:            50 8 12;
					--accent-foreground: 255 110 60;

					/* Border — warm garnet tint */
					--border:            70 35 38;
					--input:             24 10 12;
					--ring:              220 38 38;

					/* Destructive shifted toward orange so it still reads against a red theme */
					--destructive:       255 120 40;
					--destructive-foreground:16 6 8;

					--radius: 0.5rem;
				}

				/* Sidebar */
				.theme-ruby .border-r {
					background: rgb(12 5 6) !important;
					border-color: rgb(70 35 38) !important;
				}

				/* Panels / cards */
				.theme-ruby .bg-white,
				.theme-ruby .dark\\:bg-neutral-900,
				.theme-ruby .dark\\:bg-neutral-950 {
					background-color: rgb(22 9 11) !important;
				}

				/* Borders */
				.theme-ruby .border,
				.theme-ruby .border-border {
					border-color: rgb(70 35 38) !important;
				}

				/* Ruby glow on focused inputs */
				.theme-ruby input:focus,
				.theme-ruby select:focus {
					outline: none;
					box-shadow: 0 0 0 2px rgba(230,57,79,0.45);
				}

				/* Tab active underline — ruby */
				.theme-ruby .border-foreground {
					border-color: #E6394F !important;
					color: #E6394F !important;
				}

				/* Scrollbar */
				.theme-ruby ::-webkit-scrollbar-track { background: rgb(16 6 8); }
				.theme-ruby ::-webkit-scrollbar-thumb { background: rgb(70 35 38); border-radius: 4px; }
				.theme-ruby ::-webkit-scrollbar-thumb:hover { background: #E6394F; }

				/* Sensor bars base bg */
				.theme-ruby .bg-muted { background-color: rgb(28 11 13) !important; }

				/* Button primary style override — vivid crimson, no gold */
				.theme-ruby button[class*="bg-primary"],
				.theme-ruby [class*="bg-primary"] {
					background-color: #DC2626 !important;
					color: rgb(255 240 235) !important;
				}

				/* Subtle ember/circuit background pattern on the main content area */
				.theme-ruby > div:last-child {
					background-image:
						linear-gradient(rgba(230,57,79,0.04) 1px, transparent 1px),
						linear-gradient(90deg, rgba(230,57,79,0.04) 1px, transparent 1px);
					background-size: 32px 32px;
				}
			`}</style>
		)}
		{purpleTheme && (
			<style>{`
				.theme-purple {
					/* Deep violet-black base */
					--background:        16 8 20;
					--foreground:        230 220 255;
					--card:              24 12 30;
					--card-foreground:   230 220 255;
					--popover:           20 10 26;
					--popover-foreground:230 220 255;

					/* Vivid violet primary */
					--primary:           147 51 234;
					--primary-foreground:250 245 255;

					/* Plum secondary */
					--secondary:         45 12 60;
					--secondary-foreground:216 180 254;

					/* Muted — slightly brighter than bg so panels read */
					--muted:             30 15 38;
					--muted-foreground:  180 150 210;

					/* Magenta accent */
					--accent:            40 10 55;
					--accent-foreground: 216 180 254;

					/* Border — warm violet tint */
					--border:            70 40 90;
					--input:             26 13 34;
					--ring:              147 51 234;

					/* Destructive stays red */
					--destructive:       220 50 50;
					--destructive-foreground:255 255 255;

					--radius: 0.5rem;
				}

				/* Sidebar */
				.theme-purple .border-r {
					background: rgb(12 6 16) !important;
					border-color: rgb(70 40 90) !important;
				}

				/* Panels / cards */
				.theme-purple .bg-white,
				.theme-purple .dark\\:bg-neutral-900,
				.theme-purple .dark\\:bg-neutral-950 {
					background-color: rgb(24 12 30) !important;
				}

				/* Borders */
				.theme-purple .border,
				.theme-purple .border-border {
					border-color: rgb(70 40 90) !important;
				}

				/* Violet glow on focused inputs */
				.theme-purple input:focus,
				.theme-purple select:focus {
					outline: none;
					box-shadow: 0 0 0 2px rgba(168,85,247,0.45);
				}

				/* Tab active underline — violet */
				.theme-purple .border-foreground {
					border-color: #A855F7 !important;
					color: #A855F7 !important;
				}

				/* Scrollbar */
				.theme-purple ::-webkit-scrollbar-track { background: rgb(16 8 20); }
				.theme-purple ::-webkit-scrollbar-thumb { background: rgb(70 40 90); border-radius: 4px; }
				.theme-purple ::-webkit-scrollbar-thumb:hover { background: #A855F7; }

				/* Sensor bars base bg */
				.theme-purple .bg-muted { background-color: rgb(30 15 38) !important; }

				/* Button primary style override — vivid violet */
				.theme-purple button[class*="bg-primary"],
				.theme-purple [class*="bg-primary"] {
					background-color: #9333EA !important;
					color: rgb(250 245 255) !important;
				}

				/* Subtle circuit-board background pattern on the main content area */
				.theme-purple > div:last-child {
					background-image:
						linear-gradient(rgba(168,85,247,0.04) 1px, transparent 1px),
						linear-gradient(90deg, rgba(168,85,247,0.04) 1px, transparent 1px);
					background-size: 32px 32px;
				}
			`}</style>
		)}
		{blueTheme && (
			<style>{`
				.theme-blue {
					/* Deep navy-black base */
					--background:        6 12 24;
					--foreground:        220 235 255;
					--card:              10 20 34;
					--card-foreground:   220 235 255;
					--popover:           8 16 28;
					--popover-foreground:220 235 255;

					/* Vivid electric-blue primary */
					--primary:           37 99 235;
					--primary-foreground:240 247 255;

					/* Navy secondary */
					--secondary:         10 40 70;
					--secondary-foreground:147 197 253;

					/* Muted — slightly brighter than bg so panels read */
					--muted:             14 28 46;
					--muted-foreground:  140 175 210;

					/* Cyan accent */
					--accent:            8 40 55;
					--accent-foreground: 34 211 238;

					/* Border — cool blue tint */
					--border:            35 65 95;
					--input:             12 26 42;
					--ring:              37 99 235;

					/* Destructive shifted toward orange so it still reads against a blue theme */
					--destructive:       255 90 60;
					--destructive-foreground:8 12 24;

					--radius: 0.5rem;
				}

				/* Sidebar */
				.theme-blue .border-r {
					background: rgb(4 9 18) !important;
					border-color: rgb(35 65 95) !important;
				}

				/* Panels / cards */
				.theme-blue .bg-white,
				.theme-blue .dark\\:bg-neutral-900,
				.theme-blue .dark\\:bg-neutral-950 {
					background-color: rgb(10 20 34) !important;
				}

				/* Borders */
				.theme-blue .border,
				.theme-blue .border-border {
					border-color: rgb(35 65 95) !important;
				}

				/* Blue glow on focused inputs */
				.theme-blue input:focus,
				.theme-blue select:focus {
					outline: none;
					box-shadow: 0 0 0 2px rgba(59,130,246,0.45);
				}

				/* Tab active underline — blue */
				.theme-blue .border-foreground {
					border-color: #3B82F6 !important;
					color: #3B82F6 !important;
				}

				/* Scrollbar */
				.theme-blue ::-webkit-scrollbar-track { background: rgb(6 12 24); }
				.theme-blue ::-webkit-scrollbar-thumb { background: rgb(35 65 95); border-radius: 4px; }
				.theme-blue ::-webkit-scrollbar-thumb:hover { background: #3B82F6; }

				/* Sensor bars base bg */
				.theme-blue .bg-muted { background-color: rgb(14 28 46) !important; }

				/* Button primary style override — electric blue */
				.theme-blue button[class*="bg-primary"],
				.theme-blue [class*="bg-primary"] {
					background-color: #2563EB !important;
					color: rgb(240 247 255) !important;
				}

				/* Subtle circuit-board background pattern on the main content area */
				.theme-blue > div:last-child {
					background-image:
						linear-gradient(rgba(59,130,246,0.04) 1px, transparent 1px),
						linear-gradient(90deg, rgba(59,130,246,0.04) 1px, transparent 1px);
					background-size: 32px 32px;
				}
			`}</style>
		)}
			{/* Sidebar */}
			<div className="border-r border-border bg-gray-100 dark:bg-neutral-950 overflow-hidden">
				<div className="h-full w-full grid grid-rows-[auto_1fr]">
					<div className="p-3 border-b border-border flex items-center justify-between">
						{showInstallBanner ? (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="size-8 shrink-0"
										onClick={() => (canInstall ? install() : setInstallDismissed(true))}
										aria-label={canInstall ? "Install app" : "Install instructions"}
									>
										<Download className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent side="right" className="max-w-48">
									{canInstall ? (
										<p>Install Awakened Animus as an app</p>
									) : showIOSInstall ? (
										<p>
											Install as an app: tap <Share className="size-3 inline mx-0.5" /> then "Add to Home Screen"
										</p>
									) : null}
								</TooltipContent>
							</Tooltip>
						) : (
							<div className="size-8 shrink-0" />
						)}
						<h2 className="relative text-xl font-bold flex-1 text-center leading-tight select-none" style={{ lineHeight: 1.15 }}>
							{/* Animated aura -- a soft breathing halo plus two blurred
							    color blobs that visibly orbit the logo at different
							    speeds/directions, so the aura actually appears to move
							    rather than just glow in place. Colored from
							    rgb(var(--primary))/rgb(var(--accent)) so it automatically
							    follows whichever theme (Light/Dark/Animus/Ruby/Purple/
							    Blue) is currently active, with no extra per-theme wiring. */}
							<div aria-hidden="true" className="absolute inset-0 pointer-events-none overflow-visible">
								{/* Soft central glow, slowly breathing in size/opacity */}
								<div
									className="absolute inset-0 rounded-2xl blur-2xl"
									style={{
										background: "linear-gradient(90deg, rgb(var(--primary)), rgb(var(--accent)))",
										opacity: 0.28,
										animation: "aura-pulse 3s ease-in-out infinite",
									}}
								/>
								{/* Primary-colored blob orbiting one way */}
								<div className="absolute inset-0" style={{ animation: "aura-orbit 6s linear infinite" }}>
									<div
										className="absolute top-1/2 left-1/2 rounded-full blur-xl"
										style={{ width: 38, height: 38, marginLeft: -19, marginTop: -32, background: "rgb(var(--primary))", opacity: 0.55 }}
									/>
								</div>
								{/* Accent-colored blob orbiting the other way, at a different speed */}
								<div className="absolute inset-0" style={{ animation: "aura-orbit-reverse 4.5s linear infinite" }}>
									<div
										className="absolute top-1/2 left-1/2 rounded-full blur-xl"
										style={{ width: 32, height: 32, marginLeft: 20, marginTop: 24, background: "rgb(var(--accent))", opacity: 0.5 }}
									/>
								</div>
								{/* Small sparks drifting upward past the logo, matching the
								    aura's own colors -- see AURA_PARTICLES for the per-spark
								    timing/position config. */}
								{AURA_PARTICLES.map((p, i) => (
									<div
										key={i}
										className="absolute bottom-0 rounded-full"
										style={{
											left: p.left,
											width: p.size,
											height: p.size,
											background: `rgb(var(--${p.color}))`,
											boxShadow: `0 0 4px rgb(var(--${p.color}))`,
											opacity: 0,
											animation: `particle-rise ${p.duration}s ease-in infinite`,
											animationDelay: `${p.delay}s`,
										}}
									/>
								))}
							</div>
							<span style={{
								backgroundImage: activeLogoGradient.awakened,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								backgroundClip: "text",
								color: "transparent",
								fontWeight: 800,
								letterSpacing: "0.01em",
								display: "block",
								fontSize: "0.78rem",
								textTransform: "uppercase",
								opacity: 0.85,
							}}>Awakened</span>
							<span style={{
								backgroundImage: activeLogoGradient.animus,
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								backgroundClip: "text",
								color: "transparent",
								fontWeight: 900,
								letterSpacing: "0.12em",
								display: "block",
								fontSize: "1.15rem",
								textTransform: "uppercase",
								textShadow: activeLogoGradient.textShadow,
							}}>Animus</span>
						</h2>
						<Button
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							onClick={toggleTheme}
							aria-label={
								animusTheme ? "Switch to Ruby mode"
								: rubyTheme ? "Switch to Purple mode"
								: purpleTheme ? "Switch to Blue mode"
								: blueTheme ? "Switch to Light mode"
								: resolvedTheme === "dark" ? "Switch to Animus mode"
								: "Switch to Dark mode"
							}
							title={
								animusTheme ? "Animus theme — click for Ruby"
								: rubyTheme ? "Ruby theme — click for Purple"
								: purpleTheme ? "Purple theme — click for Blue"
								: blueTheme ? "Blue theme — click for Light"
								: resolvedTheme === "dark" ? "Dark theme — click for Animus"
								: "Light theme — click for Dark"
							}
						>
							{animusTheme ? (
								/* Animus icon: a small crystal/gem shape in teal+gold */
								<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
									<polygon points="12,2 20,8 17,20 7,20 4,8" fill="rgba(0,229,204,0.18)" stroke="#C9A227" strokeWidth={1.5}/>
									<polygon points="12,5 17,9 15,18 9,18 7,9" fill="rgba(0,229,204,0.35)" stroke="rgba(0,229,204,0.8)" strokeWidth={1}/>
									<line x1="12" y1="2" x2="12" y2="22" stroke="rgba(0,229,204,0.5)" strokeWidth={0.8}/>
								</svg>
							) : rubyTheme ? (
								/* Ruby icon: same crystal/gem shape in an all-red ember two-tone (no gold) */
								<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
									<polygon points="12,2 20,8 17,20 7,20 4,8" fill="rgba(220,38,38,0.22)" stroke="#FF5F5F" strokeWidth={1.5}/>
									<polygon points="12,5 17,9 15,18 9,18 7,9" fill="rgba(230,57,79,0.45)" stroke="rgba(255,107,107,0.9)" strokeWidth={1}/>
									<line x1="12" y1="2" x2="12" y2="22" stroke="rgba(255,107,107,0.55)" strokeWidth={0.8}/>
								</svg>
							) : purpleTheme ? (
								/* Purple icon: same crystal/gem shape in a violet/lavender two-tone */
								<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
									<polygon points="12,2 20,8 17,20 7,20 4,8" fill="rgba(147,51,234,0.22)" stroke="#C084FC" strokeWidth={1.5}/>
									<polygon points="12,5 17,9 15,18 9,18 7,9" fill="rgba(216,180,254,0.45)" stroke="rgba(216,180,254,0.9)" strokeWidth={1}/>
									<line x1="12" y1="2" x2="12" y2="22" stroke="rgba(216,180,254,0.55)" strokeWidth={0.8}/>
								</svg>
							) : blueTheme ? (
								/* Blue icon: same crystal/gem shape in an electric blue/cyan two-tone */
								<svg className="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
									<polygon points="12,2 20,8 17,20 7,20 4,8" fill="rgba(37,99,235,0.22)" stroke="#60A5FA" strokeWidth={1.5}/>
									<polygon points="12,5 17,9 15,18 9,18 7,9" fill="rgba(34,211,238,0.45)" stroke="rgba(96,165,250,0.9)" strokeWidth={1}/>
									<line x1="12" y1="2" x2="12" y2="22" stroke="rgba(96,165,250,0.55)" strokeWidth={0.8}/>
								</svg>
							) : resolvedTheme === "dark" ? (
								<Sun className="size-4" />
							) : (
								<Moon className="size-4" />
							)}
						</Button>
					</div>

					<CustomScrollArea>
						<div className="p-4 flex flex-col gap-3">
							<Button onClick={handleConnectionToggle} className="w-full" disabled={!isSupported}>
								{connected ? "Disconnect from Pad" : "Connect to Pad"}
							</Button>

							<Button
								variant="outline"
								onClick={() => {
									setPairingModalOpen(true);
									if (!remoteConnected && !remoteConnecting) {
										if (lastCode) {
											setShowCodeChoice(true);
										} else {
											connectRemote();
										}
									}
								}}
								className="w-full gap-2"
							>
								<Smartphone className="size-4" />
								{remoteConnected ? "Mobile Connected" : "Pair Mobile Device"}
							</Button>

							<div className="grid grid-cols-2 gap-1 text-xs text-center">
								<div className="font-medium">
									Pad:{" "}
									<span className={`${connected ? "text-green-500" : "text-destructive"}`}>
										{connected ? " Connected" : " Disconnected"}
									</span>
								</div>

								<div className="font-medium">
									ITG: <span className={"text-destructive"}>Disconnected</span>
								</div>

								<div className="font-medium col-span-2">
									HR Monitor:{" "}
									<span className={`${connectedHR ? "text-green-500" : "text-destructive"}`}>
										{connectingHR ? "Attempting connection..." : connectedHR ? " Connected" : " Disconnected"}
									</span>
								</div>
							</div>

							{connectionError && <div className="text-sm text-destructive">Error connecting to device: {connectionError}</div>}

							{heartrateError && <div className="text-sm text-destructive">Error with HR monitor: {heartrateError}</div>}

							<div className="p-3 border rounded bg-white dark:bg-neutral-900">
								<div className="flex items-center justify-between">
									<span className="text-xs text-gray-600 dark:text-gray-400">Requests/sec:</span>
									<span className="text-sm font-medium">{requestsPerSecond}</span>
								</div>
							</div>

							{/* ── LED PANEL SECTION ── */}
							<LedSection
								connected={connected}
								sendText={sendTextStable}
								thresholds={thresholds}
								displayOrder={effectiveDisplayOrder}
								moveDisplayPosition={moveDisplayPosition}
								numSensors={numSensors}
							/>

							{/* ── SENSOR TUNING SECTION ──
							    Kept in the sidebar -- this component is styled for a
							    narrow column, and the wide main-content area broke its
							    layout. Gain/Release Debounce/Button Group are pulled OUT
							    of these cards and live as compact inline controls under
							    each sensor's wave instead (SensorMiniControls in the main
							    grid), alongside a simple toggle button up top. */}
							<SensorTuningSection
								connected={connected}
								sendText={sendTextStable}
								numSensors={numSensors}
								latestValues={latestData?.values ?? []}
								sensorLabels={sensorLabels}
								advancedEnabled={advancedTuningEnabled}
								onToggleAdvancedMode={toggleAdvancedTuningMode}
								onTuningValuesChange={onTuningValuesChangeStable}
								displayOrder={effectiveDisplayOrder}
								moveDisplayPosition={moveDisplayPosition}
								deviceId={deviceId}
							/>

							{/* ── FIRMWARE UPDATE SECTION ── */}
							<FirmwareUpdateSection connected={connected} sendText={sendTextStable} connect={connect} disconnect={disconnect} onDeviceIdChange={onDeviceIdChangeStable} />

							<ProfilesSection
								profiles={profiles}
								activeProfile={activeProfile}
								activeProfileId={activeProfileId}
								isProfileLoading={isProfileLoading}
								profileError={profileError}
								createProfile={createProfileStable}
								deleteProfile={deleteProfileStable}
								updateProfile={updateProfileStable}
								setActiveProfileById={setActiveProfileByIdStable}
								resetProfileToDefaults={resetProfileToDefaultsStable}
							/>

							{/* Export/import the active profile as a portable .json file --
							    separate from FirmwareUpdateSection's EEPROM backup (that one
							    is a pre-OTA-update safety snapshot; this one is meant for
							    sharing a full setup or keeping an offline copy of it).
							    Stacked full-width, matching Firmware Update's own button
							    layout just above -- the sidebar column is too narrow for the
							    label + two buttons to share one row (that squeezed "Load"
							    against the edge and wrapped the label). */}
							<div className="flex flex-col gap-2 p-3 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm">
								<span className="text-sm font-medium">Profile File</span>
								<Button variant="outline" size="sm" onClick={exportProfileToJson} className="w-full gap-1.5">
									<Download className="size-3.5" />
									Save as JSON
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => profileImportInputRef.current?.click()}
									className="w-full gap-1.5"
								>
									<Upload className="size-3.5" />
									Load from JSON
								</Button>
								{profileImportStatus && (
									<p className="text-xs text-muted-foreground">{profileImportStatus}</p>
								)}
								<input
									ref={profileImportInputRef}
									type="file"
									accept="application/json"
									className="hidden"
									onChange={(e) => {
										const file = e.target.files?.[0];
										if (file) void importProfileFromJson(file);
										e.target.value = "";
									}}
								/>
							</div>

							<OBSSection
								obsConnected={obsConnected}
								obsConnecting={obsConnecting}
								obsError={obsError}
								obsSendRate={generalSettings.obsSendRate}
								setObsSendRate={generalSettings.setObsSendRate}
								onToggle={onObsToggleStable}
								onCreateComponent={onCreateComponent}
								autoConnectEnabled={obsAutoConnectEnabled}
								nextRetryInMs={obsNextRetryInMs}
								onToggleAutoConnect={onToggleAutoConnectStable}
								password={obsPassword}
								onPasswordChange={setobsPassword}
								activeProfile={activeProfile}
								activeProfileId={activeProfileId}
								updateProfile={updateProfileStable}
							/>

							<GeneralSettingsSection generalSettings={generalSettings} />

							<HeartRateMonitorSection
								heartrateSettings={heartrateSettings}
								onToggle={handleHeartrateToggle}
								connectedHR={connectedHR}
								isBluetoothSupported={isBluetoothSupported}
								heartrateDevice={heartrateDevice}
							/>

							{/* Alternative HR source: HypeRate (phone app streams heart rate over
							    the internet, avoiding WebBluetooth/Windows BLE stack issues).
							    No login/token needed -- just a free Session ID from the app. */}
							<div className="p-3 border rounded bg-white dark:bg-neutral-900 space-y-2">
								<div className="text-sm font-medium">HypeRate (phone HR)</div>
								<input
									type="text"
									value={hyperateSessionId}
									onChange={(e) => setHyperateSessionId(e.target.value)}
									placeholder="HypeRate Session ID"
									className="w-full px-2 py-1 text-sm rounded border bg-transparent"
									disabled={hyperateConnected}
								/>
								<Button
									onClick={() => (hyperateConnected ? disconnectHypeRate() : connectHypeRate())}
									className="w-full gap-2"
									disabled={hyperateConnecting || (!hyperateConnected && !hyperateSessionId.trim())}
								>
									{hyperateConnecting ? "Connecting…" : hyperateConnected ? "Disconnect HypeRate" : "Connect HypeRate"}
								</Button>
								{hyperateSessionId && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											if (hyperateConnected) disconnectHypeRate();
											clearHyperateSessionId();
										}}
										className="w-full text-xs"
									>
										Forget Session ID
									</Button>
								)}
								<div className="text-xs text-gray-500">
									Open the free HypeRate app on your phone, connect your HR monitor, and copy the Session ID from
									Settings -- no account or token needed.
								</div>
								{hyperateError && <div className="text-sm text-destructive">{hyperateError}</div>}
							</div>

							<VisualSettingsSection
								numSensors={numSensors}
								sensorLabels={sensorLabels}
								onLabelChange={onLabelChangeStable}
								openColorPickers={openColorPickers}
								setOpenColorPickers={setOpenColorPickers}
							/>

							{import.meta.env.DEV && (
								<div className="p-3 border rounded bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800">
									<label className="flex items-center gap-2 text-xs cursor-pointer">
										<input
											type="checkbox"
											checked={devHideOverlay}
											onChange={(e) => setDevHideOverlay(e.target.checked)}
											className="rounded"
										/>
										<span className="text-yellow-800">Hide overlay</span>
									</label>
								</div>
							)}

							<div className="pt-1 pb-1 flex flex-col items-center gap-0.5">
								<Button
									variant="link"
									size="sm"
									className="text-xs text-muted-foreground"
									onClick={() => setAboutOpen(true)}
									aria-label="About Awakened Animus"
								>
									About Awakened Animus
								</Button>
								<span className="text-[10px] text-muted-foreground font-mono opacity-70 break-all text-center">
									{__BUILD_TIMESTAMP__}
								</span>
							</div>
						</div>
					</CustomScrollArea>
				</div>
			</div>

			{/* Main content */}
			<div className="h-full overflow-hidden">
				<div className="h-full flex flex-col overflow-hidden p-2 relative">
					{/* ── TOP TAB BAR ── */}
					<div className="shrink-0 mb-2 flex items-center gap-1 border-b border-border">
						<button
							type="button"
							onClick={() => setMainTab("sensors")}
							className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
								mainTab === "sensors"
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
						>
							Sensors
						</button>
						<button
							type="button"
							onClick={() => setMainTab("leds")}
							className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
								mainTab === "leds"
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
						>
							LEDs
						</button>
						<button
							type="button"
							onClick={() => setMainTab("songs")}
							className={`px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
								mainTab === "songs"
									? "border-foreground text-foreground"
									: "border-transparent text-muted-foreground hover:text-foreground"
							}`}
						>
							HR/Songs stats
						</button>
					</div>

					{mainTab === "leds" ? (
						<LedPadPreview />
					) : mainTab === "songs" ? (
						<div className="flex-1 min-h-0 overflow-y-auto">
							<SongHistorySection
								songs={songHistory.songs}
								hrSamples={songHistory.hrSamples}
								folder={songHistory.folder}
								installFolder={songHistory.installFolder}
								bannerFolders={songHistory.bannerFolders}
								addBannerFolder={songHistory.addBannerFolder}
								removeBannerFolder={songHistory.removeBannerFolder}
								mediaBaseUrl={songHistory.mediaBaseUrl}
								isSupported={songHistory.isSupported}
								selectFolder={songHistory.selectFolder}
								selectInstallFolder={songHistory.selectInstallFolder}
								biometrics={biometrics}
								setBiometrics={setBiometrics}
							/>
						</div>
					) : (
					<>
					{latestData ? (
						<div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-y-auto overflow-x-hidden">
							{/* ── SENSOR TUNING TOGGLE -- a simple button, not the full
							    panel (that stays in the sidebar). Flips the same
							    advancedTuningEnabled flag the sidebar's own toggle
							    controls. ── */}
							<div className="shrink-0 mb-2 flex items-center gap-2">
								<Button
									variant={advancedTuningEnabled ? "default" : "outline"}
									size="sm"
									onClick={toggleAdvancedTuningMode}
									className="gap-1.5"
								>
									Sensor Tuning: {advancedTuningEnabled ? "On" : "Off"}
								</Button>
								<Button
									variant={graphVisible ? "default" : "outline"}
									size="sm"
									onClick={toggleGraphVisible}
									className="gap-1.5"
									title="Show or hide the wave signal graph"
								>
									Graph: {graphVisible ? "On" : "Off"}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={undoLastThresholdChange}
									disabled={undoDepth === 0}
									className="gap-1.5"
									title="Undo last Trigger/Release change (Ctrl+Z)"
								>
									Undo{undoDepth > 0 ? ` (${undoDepth})` : ""}
								</Button>
							</div>

							{/* min-h-[420px] is now ALWAYS applied, not just when Advanced
						    Tuning is on -- toggling used to resize this container,
						    which is very likely what SensorBar's own internal sizing
						    was mismeasuring on that transition. min-h-[450px] ->
						    min-h-[550px]: bumped to fit the mini-controls slot's own
						    the mini-controls slot's height plus everything already accounted
						    for above. */}
						<ResizableSensorPanel numSensors={numSensors} reservedWidth={heartrateSettings.showHeartrateMonitor ? 270 : 0}>
								<div className="px-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm grow min-w-0 flex flex-col overflow-x-auto overflow-y-hidden">
									{advancedTuningEnabled && (
										<p className="text-[11px] text-amber-500 px-1 pt-2 shrink-0">
											Sensor Tuning is on — drag the green dashed line to adjust
											Release. The red line (Trigger/sensitivity) works the same
											as always and isn't affected by this toggle.
										</p>
									)}
									<div
										className="grid grid-flow-col grid-rows-1 auto-cols-fr gap-4 flex-1 min-h-0 w-full py-2"
										style={{ minWidth: numSensors * SENSOR_MIN_COL_W + Math.max(0, numSensors - 1) * 16 }}
									>{sensorBars}</div>
								</div>

								{heartrateSettings.showHeartrateMonitor && (
									<div className="p-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm h-full w-64 shrink min-w-[9rem] max-w-[30%] overflow-hidden flex flex-col items-center justify-center gap-2">
										<div
											className={`flex ${heartrateSettings.verticalAlignHeartrate ? "flex-col" : "flex-row"} items-center gap-4 w-full h-full justify-center`}
										>
											<Heart
												className={`${heartrateSettings.verticalAlignHeartrate ? "size-24" : "size-20"} ${connectedHR ? "text-red-500" : "text-muted-foreground"}`}
												fill={heartrateSettings.fillHeartIcon ? (connectedHR ? "currentColor" : "none") : "none"}
												style={connectedHR && heartrateData ? heartBeatStyle : {}}
											/>
											{connectedHR && heartrateData ? (
												<div className="text-center">
													<p className={`font-bold ${heartrateSettings.showBpmText ? "text-5xl" : "text-7xl"} leading-tight`}>
														{heartrateData.heartrate}
													</p>
													{heartrateSettings.showBpmText && <p className="text-lg text-muted-foreground mt-1">BPM</p>}
													{heartrateSettings.showCalories && caloriesBurned !== null && (
														<p className="text-lg text-muted-foreground mt-1">🔥 {caloriesBurned} kcal</p>
													)}
												</div>
											) : (
												<p className="text-muted-foreground text-center text-lg">
													{isBluetoothSupported
														? connectedHR
															? "Waiting for heartrate data..."
															: "Heartrate monitor not connected"
														: "WebBluetooth not supported"}
												</p>
											)}
										</div>
									</div>
								)}
							</ResizableSensorPanel>

							{graphVisible && (
								<ResizableGraphPanel>
									<TimeSeriesGraph
										latestData={latestData}
										timeWindow={graphSettings.timeWindow}
										thresholds={thresholds}
										sensorLabels={sensorLabels}
										sensorColors={colorSettings.sensorColors}
										showGridLines={graphSettings.showGridLines}
										showThresholdLines={graphSettings.showThresholdLines}
										thresholdLineOpacity={graphSettings.thresholdLineOpacity}
										showLegend={graphSettings.showLegend}
										showBorder={graphSettings.showGraphBorder}
										showActivation={graphSettings.showGraphActivation}
										activationColor={colorSettings.graphActivationColor}
										theme={resolvedTheme}
									/>
								</ResizableGraphPanel>
							)}
						</div>
					) : (
						<>
							<div className="flex gap-2 shrink-0 h-100">
								<div className="px-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm grow">
									<div className="grid grid-flow-col auto-cols-fr gap-4 h-full w-full py-2">
										{Array.from({ length: MOCK_SENSOR_COUNT }, (_, index) => (
											<SensorBar
												key={`mock-sensor-${index}`}
												value={MOCK_SENSOR_VALUES[index]}
												index={index}
												threshold={MOCK_THRESHOLDS[index]}
												onThresholdChange={() => {}}
												label={MOCK_SENSOR_LABELS[index]}
												color={
													barSettings.useSingleColor
														? colorSettings.singleBarColor
														: colorSettings.sensorColors[index % colorSettings.sensorColors.length] || "#ff0000"
												}
												showThresholdText={barSettings.showBarThresholdText}
												showValueText={barSettings.showBarValueText}
												thresholdColor={colorSettings.thresholdColor}
												useThresholdColor={barSettings.useThresholdColor}
												useGradient={barSettings.useBarGradient}
												isLocked={true}
												theme={resolvedTheme}
											/>
										))}
									</div>
								</div>

								{heartrateSettings.showHeartrateMonitor && (
									<div className="p-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm h-full w-64 shrink min-w-[9rem] max-w-[30%] overflow-hidden flex flex-col items-center justify-center gap-2">
										<div
											className={`flex ${heartrateSettings.verticalAlignHeartrate ? "flex-col" : "flex-row"} items-center gap-4 w-full h-full justify-center`}
										>
											<Heart
												className={`${heartrateSettings.verticalAlignHeartrate ? "size-24" : "size-20"} ${connectedHR ? "text-red-500" : "text-muted-foreground"}`}
												fill={heartrateSettings.fillHeartIcon ? (connectedHR ? "currentColor" : "none") : "none"}
												style={connectedHR && heartrateData ? heartBeatStyle : {}}
											/>
											{connectedHR && heartrateData ? (
												<div className="text-center">
													<p className={`font-bold ${heartrateSettings.showBpmText ? "text-5xl" : "text-7xl"} leading-tight`}>
														{heartrateData.heartrate}
													</p>
													{heartrateSettings.showBpmText && <p className="text-lg text-muted-foreground mt-1">BPM</p>}
													{heartrateSettings.showCalories && caloriesBurned !== null && (
														<p className="text-lg text-muted-foreground mt-1">🔥 {caloriesBurned} kcal</p>
													)}
												</div>
											) : (
												<p className="text-muted-foreground text-center text-lg">
													{isBluetoothSupported
														? connectedHR
															? "Waiting for heartrate data..."
															: "Heartrate monitor not connected"
														: "WebBluetooth not supported"}
												</p>
											)}
										</div>
									</div>
								)}
							</div>

							<div className="p-1 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm mt-2 grow min-h-0">
								<div className="h-full">
									<TimeSeriesGraph
										latestData={null}
										timeWindow={graphSettings.timeWindow}
										thresholds={MOCK_THRESHOLDS}
										sensorLabels={MOCK_SENSOR_LABELS}
										sensorColors={colorSettings.sensorColors}
										showGridLines={graphSettings.showGridLines}
										showThresholdLines={graphSettings.showThresholdLines}
										thresholdLineOpacity={graphSettings.thresholdLineOpacity}
										showLegend={graphSettings.showLegend}
										showBorder={graphSettings.showGraphBorder}
										showActivation={graphSettings.showGraphActivation}
										activationColor={colorSettings.graphActivationColor}
										initialData={generateMockTimeSeriesData(graphSettings.timeWindow)}
										theme={resolvedTheme}
									/>
								</div>
							</div>

							{!devHideOverlay && (
								<div className="absolute inset-0 flex items-center justify-center bg-black/25 backdrop-blur-[1px]">
									{!isSupported ? (
										<div className="max-w-md px-8 py-5 rounded-xl border border-destructive bg-background shadow-xl flex flex-col items-center gap-2">
											<div className="flex items-center gap-3 text-destructive">
												<AlertTriangle className="h-5 w-5" />
												<h2 className="text-lg font-semibold">WebSerial Not Supported</h2>
											</div>
											<p className="text-sm text-destructive text-center">
												Your browser does not support the WebSerial API. Try a modern Chromium-based browser.
											</p>
										</div>
									) : (
										<div className="px-8 py-5 rounded-xl border bg-background shadow-xl flex flex-col items-center gap-2">
											<div className="flex items-center gap-3">
												<Unplug className="h-5 w-5 text-muted-foreground" />
												<h2 className="text-lg font-semibold">Disconnected</h2>
											</div>
											<p className="text-sm text-muted-foreground">Connect your device and allow access to view data</p>
										</div>
									)}
								</div>
							)}
						</>
					)}
					</>
					)}
				</div>
			</div>

			<OBSComponentDialog
	open={obsComponentDialogOpen}
	onOpenChange={setObsComponentDialogOpen}
	password={obsPassword}
	liveValues={latestData?.values}
	liveThresholds={thresholds}
/>

			<AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} />

			<PairingQRModal
				open={pairingModalOpen}
				onOpenChange={(open) => {
					setPairingModalOpen(open);
					if (!open) {
						setShowCodeChoice(false);
					}
				}}
				code={remoteCode}
				isConnected={remoteConnected}
				isConnecting={remoteConnecting}
				onDisconnect={disconnectRemote}
				lastCode={lastCode}
				showCodeChoice={showCodeChoice}
				onUseLastCode={() => {
					setShowCodeChoice(false);
					if (lastCode) {
						connectRemote(lastCode);
					}
				}}
				onUseNewCode={() => {
					setShowCodeChoice(false);
					connectRemote();
				}}
			/>
		</main>
	);
};

export default Dashboard;
