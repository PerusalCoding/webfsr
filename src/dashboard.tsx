import { AlertTriangle, Download, GripVertical, Heart, Moon, RefreshCw, Share, Smartphone, Sun, Unplug, Upload } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
import SensorBar from "~/components/SensorBar";
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

// Bridge shape returned by LedSection's _getLedControls() -- powers the
// LED Pad Preview tab.
interface LedControls {
	sensors: SensorZone[];
	updateSensor: (i: number, patch: Partial<SensorZone>) => void;
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
	const ledDrag = useRowDragReorder(moveDisplayPosition);

	// Publish to the external store consumed by LedPadPreview (LEDs tab).
	useEffect(() => {
		publishLedStore(sensors);
	}, [sensors]);

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

	const updateSensor = (i: number, patch: Partial<SensorZone>) => {
		const updated = sensors.map((s, idx) => idx === i ? { ...s, ...patch } : s);
		setSensors(updated);
		saveSensors(updated);
		const s = updated[i];
		// Always use s.sensorIndex (not i) so firmware gets the correct sensor
		if ("color" in patch || "sensorIndex" in patch) sendColor(s.sensorIndex, s.color);
		if ("ledOffset" in patch || "ledCount" in patch || "sensorIndex" in patch) sendZone(s.sensorIndex, s.ledOffset, s.ledCount);
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

	(LedSection as unknown as { _handleLine: (l: string) => boolean })._handleLine = handleLedLine;
	// Lets FirmwareUpdateSection read current LED zones + brightness for
	// a backup, same reasoning as SensorTuningSection's _getSnapshot above.
	(LedSection as unknown as { _getSnapshot: () => { sensors: SensorZone[]; brightness: number } })._getSnapshot =
		() => ({ sensors, brightness });
	// Lets the LED Pad Preview tab read current zones/colors AND push
	// changes back -- see the matching comment in the personal/dev build.
	(LedSection as unknown as { _getLedControls: () => LedControls })._getLedControls =
		() => ({ sensors, updateSensor });

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

								{/* Strip preview */}
								<div className="flex gap-0.5 flex-wrap">
									{Array.from({ length: totalLeds }, (_, li) => {
										const owner = sensors.findIndex(s => li >= s.ledOffset && li < s.ledOffset + s.ledCount);
										return (
											<div
												key={li}
												className="w-4 h-4 rounded-sm border border-border flex items-center justify-center"
												style={{ background: owner >= 0 ? sensors[owner].color : "transparent" }}
												title={`LED ${li}${owner >= 0 ? ` → ${sensors[owner].label}` : ""}`}
											>
												<span className="text-[8px] text-white/60 font-mono leading-none">{li}</span>
											</div>
										);
									})}
								</div>

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
				tuning[i] ?? { trigger: 700, release: 300, gainX100: 100, buttonGroup: i, releaseDebounceMs: 15 }
			);
			setTuning(next);
			saveTuning(next, deviceId);
		}
	}, [numSensors]);

	// Parse "p <sensor> <trigger> <release> <gain> <buttonGroup>
	//        <releaseDebounceMs> <liveValue>"
	// responses from the firmware so the UI reflects what's actually saved
	// on the pad. Tolerates older firmware sending fewer fields (a
	// not-yet-reflashed pad, or extra dev-build-only fields at the end
	// from a personal/test firmware -- harmless, just ignored here since
	// the public build doesn't have a UI for them).
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
		// presets) has been removed -- it duplicated controls that now live
		// on the main page (the "Sensor Tuning: On/Off" toggle, the bar's
		// Trigger/Release lines, the Release readout + reset, and the
		// always-visible Gain/Debounce/Button Group mini controls). Only
		// "Sync Sensor Tuning from Pad" was unique to this panel, so that's
		// what's kept here -- renamed from the old "Sync from pad" label so
		// it's not visually identical to LedSection's own (different) sync
		// button. All of this component's actual state/logic (tuning,
		// firmware "p" line parsing, the _handleLine/_getSnapshot/
		// _getControls bridges) is untouched -- only the old duplicate UI
		// is gone.
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
	led: { sensors: SensorZone[]; brightness: number };
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
		const ledSnapshot = (LedSection as unknown as { _getSnapshot?: () => { sensors: SensorZone[]; brightness: number } })._getSnapshot?.();
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
								Release, Gain, Button Group, Release Debounce, LED colors/zones) back to
								defaults. Back up your settings below first -- Update Now stays disabled
								until you do, and restoring afterward happens automatically.
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
	const controls = (SensorTuningSection as unknown as { _getControls?: () => SensorTuningControls })._getControls?.();
	if (!controls) return null;
	const { effectiveCount, sensorLabels, commitGain, commitButtonGroup, commitReleaseDebounce } = controls;
	const t = tuning[index] ?? { trigger: 700, release: 300, gainX100: 100, buttonGroup: index, releaseDebounceMs: 15 };

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
		<div className="flex flex-col gap-1.5 px-2 py-1.5 rounded border border-border/60 bg-muted/10 text-[10px]">
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground">Gain</span>
					<div className="flex items-center gap-1">
						<span className="font-mono text-muted-foreground">
							{(t.gainX100 / 100).toFixed(2)}x
							<span className="opacity-60"> (default {(DEFAULT_GAIN_X100 / 100).toFixed(2)}x)</span>
						</span>
						<button
							type="button"
							title={`Reset Gain to default (${(DEFAULT_GAIN_X100 / 100).toFixed(2)}x)`}
							onClick={() => commitGain(index, DEFAULT_GAIN_X100)}
							className="text-muted-foreground hover:text-foreground shrink-0"
						>
							<RefreshCw className="size-2.5" />
						</button>
					</div>
				</div>
				<input
					type="range" min={10} max={500} step={5} value={t.gainX100}
					className="w-full h-1 accent-foreground cursor-pointer"
					onChange={(e) => commitGain(index, Number(e.target.value))}
				/>
			</div>

			{/* Release Debounce */}
			<div className="flex flex-col gap-0.5">
				<div className="flex items-center justify-between">
					<span className="text-muted-foreground" title="Release Debounce (ms)">Debounce</span>
					<div className="flex items-center gap-1">
						<span className="font-mono text-muted-foreground">
							{t.releaseDebounceMs}ms
							<span className="opacity-60"> (default {DEFAULT_RELEASE_DEBOUNCE_MS}ms)</span>
						</span>
						<button
							type="button"
							title={`Reset Debounce to default (${DEFAULT_RELEASE_DEBOUNCE_MS}ms)`}
							onClick={() => commitReleaseDebounce(index, DEFAULT_RELEASE_DEBOUNCE_MS)}
							className="text-muted-foreground hover:text-foreground shrink-0"
						>
							<RefreshCw className="size-2.5" />
						</button>
					</div>
				</div>
				<input
					type="range" min={0} max={100} step={1} value={t.releaseDebounceMs}
					className="w-full h-1 accent-foreground cursor-pointer"
					onChange={(e) => commitReleaseDebounce(index, Number(e.target.value))}
				/>
			</div>

			{/* Button Group — uses localGroup (optimistic) not t.buttonGroup (store)
			    so the dropdown never flickers when the shared store updates. */}
			<div className="flex flex-col gap-0.5">
				<span className="text-muted-foreground">Group</span>
				<select
					value={localGroup}
					onChange={(e) => handleGroupChange(Number(e.target.value))}
					className="w-full text-[10px] bg-white dark:bg-neutral-900 border border-border rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-ring"
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
	const [imageError, setImageError] = useState(false);
	const sensors = useSyncExternalStore(subscribeLedStore, getLedStoreSnapshot);
	const controls = (LedSection as unknown as { _getLedControls?: () => LedControls })._getLedControls?.();

	if (!controls) {
		return <p className="text-sm text-muted-foreground p-4">Connect to your pad to preview its LED layout.</p>;
	}
	const { updateSensor } = controls;

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

	// The sensor currently being edited in the card (if any).
	const editingSensor = selectedSensorIdx !== null ? sensors[selectedSensorIdx] : undefined;

	return (
		<div className="flex flex-col items-center gap-6 p-4 overflow-y-auto">
			<div className="relative w-full max-w-md aspect-square rounded-lg overflow-hidden border border-border bg-muted/20">
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
	const [animusTheme, setAnimusTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_ANIMUS_KEY) === "true"; } catch { return false; }
	});
	const [rubyTheme, setRubyTheme] = useState<boolean>(() => {
		try { return localStorage.getItem(LS_RUBY_KEY) === "true"; } catch { return false; }
	});

	// Keep underlying dark mode in sync with animus/ruby state
	useEffect(() => {
		if (animusTheme || rubyTheme) setTheme("dark");
	}, [animusTheme, rubyTheme]);

	const toggleTheme = useStableCallback(() => {
		if (resolvedTheme === "light" && !animusTheme && !rubyTheme) {
			setTheme("dark");
		} else if (resolvedTheme === "dark" && !animusTheme && !rubyTheme) {
			setAnimusTheme(true);
			try { localStorage.setItem(LS_ANIMUS_KEY, "true"); } catch {}
		} else if (animusTheme) {
			// animus → ruby
			setAnimusTheme(false);
			try { localStorage.setItem(LS_ANIMUS_KEY, "false"); } catch {}
			setRubyTheme(true);
			try { localStorage.setItem(LS_RUBY_KEY, "true"); } catch {}
		} else {
			// ruby → back to light
			setRubyTheme(false);
			try { localStorage.setItem(LS_RUBY_KEY, "false"); } catch {}
			setTheme("light");
		}
	});

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
	// release) that lives in SensorTuningSection. This is separate from
	// FirmwareUpdateSection's "Back Up My Settings": that one is a raw
	// EEPROM snapshot used around OTA firmware updates specifically; this
	// one mirrors a saved Profile, meant for sharing a full setup or keeping
	// an offline copy of it as a portable file.
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
		setLiveReleaseValues((prev) => {
			const next = [...prev];
			next[index] = value;
			return next;
		});
		if (connected) sendText(`r ${index} ${value}\n`);
	});

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
				className={`relative h-full flex flex-col transition-opacity ${sensorBarsDrag.draggingPos === position ? "opacity-40" : ""} ${sensorBarsDrag.dragOverPos === position ? "ring-2 ring-primary rounded" : ""}`}
				onDragOver={sensorBarsDrag.handleDragOver(position)}
				onDrop={sensorBarsDrag.handleDrop(position)}
			>
				<div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 pt-0.5">
					<DragHandle
						onDragStart={sensorBarsDrag.handleDragStart(position)}
						onDragEnd={sensorBarsDrag.handleDragEnd}
					/>
				</div>
				<div className="relative flex-1 min-h-0 overflow-hidden">
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
				<div className="shrink-0 h-[44px] mt-1 flex flex-col items-center justify-center gap-0.5">
					{advancedTuningEnabled && (
						<>
							<div className="flex items-center gap-1 text-[10px] text-muted-foreground">
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
									<RefreshCw className="size-2.5" />
								</button>
							</div>
							<button
								type="button"
								onClick={() => setReleaseLocked((prev) => ({ ...prev, [index]: !prev[index] }))}
								title="When on, moving Trigger also moves Release by the same amount, preserving their gap"
								className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${
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
				    toggles. See the matching comment in the personal/dev
				    build for the full reasoning: the graph above (flex-1)
				    was still resizing on toggle because this sibling's
				    presence/height was conditional, even after the outer box
				    became constant-height. */}
				<div className="shrink-0 h-[152px] mt-1 pt-2 border-t border-border/40">
					{/* Gain / Release Debounce / Button Group are useful regardless
					    of whether Sensor Tuning is on -- they don't touch Trigger or
					    Release, so there's no reason to gate them behind that toggle.
					    Always mounted now instead of only when advancedTuningEnabled. */}
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
		<main className={`grid grid-cols-[17rem_1fr] h-screen w-screen bg-background text-foreground overflow-hidden${animusTheme ? " theme-animus" : ""}${rubyTheme ? " theme-ruby" : ""}`}>
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
						<h2 className="text-xl font-bold flex-1 text-center leading-tight select-none" style={{ lineHeight: 1.15 }}>
							<span style={{
								backgroundImage: rubyTheme
									? "linear-gradient(135deg, #4A0404 0%, #B91C1C 40%, #EF4444 75%, #FF6B6B 100%)"
									: "linear-gradient(135deg, #C9A227 0%, #F0CC55 40%, #00E5CC 75%, #00BFAA 100%)",
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
								backgroundImage: rubyTheme
									? "linear-gradient(135deg, #7A0C1E 0%, #E6394F 35%, #FF4D4D 70%, #FF8A5B 100%)"
									: "linear-gradient(135deg, #C9A227 0%, #E8B830 35%, #00E5CC 70%, #00BFAA 100%)",
								WebkitBackgroundClip: "text",
								WebkitTextFillColor: "transparent",
								backgroundClip: "text",
								color: "transparent",
								fontWeight: 900,
								letterSpacing: "0.12em",
								display: "block",
								fontSize: "1.15rem",
								textTransform: "uppercase",
								textShadow: rubyTheme
									? "0 0 8px rgba(255,59,59,0.6), 0 0 20px rgba(200,20,40,0.4)"
									: "0 0 6px rgba(0,229,204,0.35)",
							}}>Animus</span>
						</h2>
						<Button
							variant="ghost"
							size="icon"
							className="size-8 shrink-0"
							onClick={toggleTheme}
							aria-label={animusTheme ? "Switch to Ruby mode" : rubyTheme ? "Switch to Light mode" : resolvedTheme === "dark" ? "Switch to Animus mode" : "Switch to Dark mode"}
							title={animusTheme ? "Animus theme — click for Ruby" : rubyTheme ? "Ruby theme — click for Light" : resolvedTheme === "dark" ? "Dark theme — click for Animus" : "Light theme — click for Dark"}
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
						<>
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
							</div>

							{/* min-h-[420px] is now ALWAYS applied, not just when Advanced
						    Tuning is on -- see the matching comment in the personal/
						    dev build for the full reasoning (toggling used to resize
						    this container, which is very likely what SensorBar's own
						    internal sizing was mismeasuring on that transition). */}
						<div className="flex gap-2 shrink-0 h-100 min-h-[450px]">
								<div className="px-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm grow">
									{advancedTuningEnabled && (
										<p className="text-[11px] text-amber-500 px-1 pt-2">
											Sensor Tuning is on — drag the green dashed line to adjust
											Release. The red line (Trigger/sensitivity) works the same
											as always and isn't affected by this toggle.
										</p>
									)}
									<div className="grid grid-flow-col auto-cols-fr gap-4 h-full w-full py-2">{sensorBars}</div>
								</div>

								{heartrateSettings.showHeartrateMonitor && (
									<div className="p-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm aspect-square h-full flex flex-col items-center justify-center gap-2 min-w-64">
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
								</div>
							</div>
						</>
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
									<div className="p-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm aspect-square h-full flex flex-col items-center justify-center gap-2 min-w-64">
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

			<OBSComponentDialog open={obsComponentDialogOpen} onOpenChange={setObsComponentDialogOpen} password={obsPassword} />

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
