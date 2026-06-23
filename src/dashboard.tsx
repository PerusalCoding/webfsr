import { AlertTriangle, Download, GripVertical, Heart, Moon, Share, Smartphone, Sun, Unplug } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
import TimeSeriesGraph from "~/components/TimeSeriesGraph";
import { Button } from "~/components/ui/button";
import { CustomScrollArea } from "~/components/ui/custom-scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useHeartrateMonitor } from "~/lib/useHeartrateMonitor";
import { type ObsBroadcastPayload, useOBS } from "~/lib/useOBS";
import { type ProfileData, useProfileManager } from "~/lib/useProfileManager";
import { usePWAInstall } from "~/lib/usePWAInstall";
import { useLastCode, useRemoteControl } from "~/lib/useRemoteControl";
import { useSerialPort } from "~/lib/useSerialPort";
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
}

function LedSection({ connected, sendText, displayOrder, moveDisplayPosition }: LedSectionProps) {
	const [sensors, setSensors]       = useState<SensorZone[]>(loadSensors);
	const [brightness, setBrightness] = useState<number>(60);
	const [ledOpen, setLedOpen]       = useState<boolean>(true);
	const [zoneOpen, setZoneOpen]     = useState<boolean>(false);
	const [customPresets, setCustomPresets] = useState<LedPreset[]>(loadCustomPresets);
	const [newPresetName, setNewPresetName] = useState<string>("");
	const [showSaveInput, setShowSaveInput] = useState<boolean>(false);
	const ledDrag = useRowDragReorder(moveDisplayPosition);

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
		const updated = sensors.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, sensorIndex: idx }));
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
		setSensors([...preset.sensors]);
		saveSensors([...preset.sensors]);
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
						Sync from pad
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

interface SensorTuning {
	trigger: number;     // 0-1023, ON threshold
	release: number;     // 0-1023, OFF threshold (must be < trigger)
	gainX100: number;    // 10-500, where 100 = 1.0x
	buttonGroup: number; // sensors sharing the same group register as ONE
	                     // joystick button to ITGMania. Defaults to the
	                     // sensor's own index (no sharing).
}

const LS_TUNING_KEY = "webfsr_sensor_tuning_v2";

function loadTuning(count: number): SensorTuning[] {
	try {
		const raw = localStorage.getItem(LS_TUNING_KEY);
		const saved = raw ? (JSON.parse(raw) as SensorTuning[]) : null;
		if (saved && saved.length >= count) return saved.slice(0, count);
	} catch {}
	return Array.from({ length: count }, (_, i) => ({ trigger: 700, release: 300, gainX100: 100, buttonGroup: i }));
}
function saveTuning(t: SensorTuning[]) {
	localStorage.setItem(LS_TUNING_KEY, JSON.stringify(t));
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
}: SensorTuningSectionProps) {
	const effectiveCount = numSensors > 0 ? numSensors : 4;
	const [tuning, setTuning] = useState<SensorTuning[]>(() => loadTuning(effectiveCount));
	const [tuningOpen, setTuningOpen] = useState<boolean>(false);
	const tuningDrag = useRowDragReorder(moveDisplayPosition);
	const [expandedSensor, setExpandedSensor] = useState<number | null>(null);

	const toggleAdvancedMode = onToggleAdvancedMode;

	// Report current Trigger AND Release values up to Dashboard every time
	// they change, so the main page sensor bars can reflect what the
	// firmware is actually using once Advanced mode is on.
	useEffect(() => {
		onTuningValuesChange?.(tuning.map((t) => t.trigger), tuning.map((t) => t.release));
	}, [tuning, onTuningValuesChange]);

	// Grow/shrink tuning array if sensor count changes
	useEffect(() => {
		if (effectiveCount !== tuning.length) {
			const next = Array.from({ length: effectiveCount }, (_, i) =>
				tuning[i] ?? { trigger: 700, release: 300, gainX100: 100, buttonGroup: i }
			);
			setTuning(next);
			saveTuning(next);
		}
	}, [effectiveCount]);

	// Parse "p <sensor> <trigger> <release> <gain> <buttonGroup> <liveValue>"
	// responses from the firmware so the UI reflects what's actually saved
	// on the pad.
	const handleTuningLine = (line: string) => {
		if (!line.startsWith("p ")) return false;
		const nums = line.slice(2).trim().split(/\s+/).map(Number);
		if (nums.length < 6) return false;
		const [sensor, trigger, release, gain, buttonGroup] = nums;
		setTuning((prev) => {
			if (sensor < 0 || sensor >= prev.length) return prev;
			const updated = [...prev];
			updated[sensor] = { trigger, release, gainX100: gain, buttonGroup };
			saveTuning(updated);
			return updated;
		});
		return true;
	};

	(SensorTuningSection as unknown as { _handleLine: (l: string) => boolean })._handleLine = handleTuningLine;

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

	const sendTrigger = (i: number, val: number) => { if (connected) sendText(`y ${i} ${val}\n`); };
	const sendRelease = (i: number, val: number) => { if (connected) sendText(`r ${i} ${val}\n`); };
	const sendGain    = (i: number, val: number) => { if (connected) sendText(`g ${i} ${val}\n`); };
	const sendButtonGroup = (i: number, group: number) => { if (connected) sendText(`m ${i} ${group}\n`); };

	const updateTuning = (i: number, patch: Partial<SensorTuning>) => {
		const updated = tuning.map((t, idx) => idx === i ? { ...t, ...patch } : t);
		setTuning(updated);
		saveTuning(updated);
	};

	const commitTrigger = (i: number, val: number) => { updateTuning(i, { trigger: val }); sendTrigger(i, val); };
	const commitRelease = (i: number, val: number) => { updateTuning(i, { release: val }); sendRelease(i, val); };
	const commitGain    = (i: number, val: number) => { updateTuning(i, { gainX100: val }); sendGain(i, val); };
	const commitButtonGroup = (i: number, group: number) => { updateTuning(i, { buttonGroup: group }); sendButtonGroup(i, group); };

	// Quick presets for common situations
	const applyFastRetriggerPreset = (i: number) => {
		// Wide gap, biased toward easy re-arming for rapid double-taps.
		const t = { trigger: 750, release: 250, gainX100: tuning[i]?.gainX100 ?? 100 };
		updateTuning(i, t);
		sendTrigger(i, t.trigger);
		sendRelease(i, t.release);
	};
	const applyStablePreset = (i: number) => {
		// Narrower gap, closer to original single-threshold feel.
		const t = { trigger: 550, release: 450, gainX100: tuning[i]?.gainX100 ?? 100 };
		updateTuning(i, t);
		sendTrigger(i, t.trigger);
		sendRelease(i, t.release);
	};
	const applyWeakFsrBoostPreset = (i: number) => {
		// For UX FSR 406 or other low-output sensors -- boost gain first.
		updateTuning(i, { gainX100: 180 });
		sendGain(i, 180);
	};

	return (
		<div className="p-3 border rounded bg-white dark:bg-neutral-900">
			<button
				className="flex items-center justify-between w-full text-left mb-0"
				onClick={() => setTuningOpen((o) => !o)}
			>
				<span className="text-sm font-semibold">Sensor Tuning</span>
				<span className="text-xs text-muted-foreground">{tuningOpen ? "▲" : "▼"}</span>
			</button>

			{tuningOpen && (
				<div className="mt-3 flex flex-col gap-3">
					{/* Advanced mode toggle — hides trigger/release/gain controls
					    behind an explicit opt-in so casual users aren't shown
					    settings they don't need, while still being one click
					    away for players tuning for very fast play. */}
					<div className="flex items-center justify-between p-2 border border-border rounded bg-muted/30">
						<div className="flex flex-col gap-0.5">
							<span className="text-xs font-medium">Advanced mode</span>
							<span className="text-[10px] text-muted-foreground">
								Per-sensor trigger/release thresholds and gain
							</span>
						</div>
						<button
							role="switch"
							aria-checked={advancedEnabled}
							onClick={toggleAdvancedMode}
							className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
								advancedEnabled ? "bg-foreground" : "bg-muted-foreground/30"
							}`}
						>
							<span
								className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background transition-transform ${
									advancedEnabled ? "translate-x-5" : "translate-x-1"
								}`}
							/>
						</button>
					</div>

					{!advancedEnabled && (
						<p className="text-[11px] text-muted-foreground italic">
							Enable advanced mode to access per-sensor trigger/release thresholds and gain.
							Useful for fixing missed double-taps on fast repeated hits.
						</p>
					)}

					{advancedEnabled && (
						<>
							<p className="text-[11px] text-muted-foreground">
								Fine-tune trigger/release thresholds and gain per sensor. A wider gap between
								Trigger and Release helps catch fast repeated hits (e.g. Down-Up-Down streams)
								that a single threshold can miss.
							</p>

							{Array.from({ length: effectiveCount }, (_, position) => {
								const i = displayOrder.length === effectiveCount ? (displayOrder[position] ?? position) : position;
								const t = tuning[i] ?? { trigger: 700, release: 300, gainX100: 100 };
								const live = latestValues[i] ?? 0;
								const label = sensorLabels[i] || `Sensor ${i + 1}`;
								const isExpanded = expandedSensor === i;
								const gap = t.trigger - t.release;
								const gapWarning = gap < 100;


						return (
							<div
								key={i}
								className={`border border-border rounded p-2 transition-opacity ${tuningDrag.draggingPos === position ? "opacity-40" : ""} ${tuningDrag.dragOverPos === position ? "ring-2 ring-primary" : ""}`}
								onDragOver={tuningDrag.handleDragOver(position)}
								onDrop={tuningDrag.handleDrop(position)}
							>
								<div className="flex items-center gap-1.5">
									<DragHandle
										onDragStart={tuningDrag.handleDragStart(position)}
										onDragEnd={tuningDrag.handleDragEnd}
									/>
									<button
										className="flex items-center justify-between w-full text-left"
										onClick={() => setExpandedSensor(isExpanded ? null : i)}
									>
										<span className="text-xs font-medium">{label} <span className="text-muted-foreground font-mono">#{i}</span></span>
										<div className="flex items-center gap-2">
											<span className="text-[10px] font-mono text-muted-foreground">live: {live}</span>
											<span className="text-xs text-muted-foreground">{isExpanded ? "▲" : "▼"}</span>
										</div>
									</button>
								</div>

								{isExpanded && (
									<div className="mt-2 flex flex-col gap-2">
										{/* Live value bar with trigger/release markers */}
										<div className="relative h-3 bg-muted rounded overflow-hidden">
											<div
												className="absolute inset-y-0 left-0 bg-blue-400/40"
												style={{ width: `${(live / 1023) * 100}%` }}
											/>
											<div
												className="absolute inset-y-0 w-0.5 bg-red-500"
												style={{ left: `${(t.trigger / 1023) * 100}%` }}
												title={`Trigger: ${t.trigger}`}
											/>
											<div
												className="absolute inset-y-0 w-0.5 bg-green-500"
												style={{ left: `${(t.release / 1023) * 100}%` }}
												title={`Release: ${t.release}`}
											/>
										</div>
										<div className="flex justify-between text-[9px] text-muted-foreground">
											<span>0</span><span>1023</span>
										</div>

										{/* Trigger threshold */}
										<div className="flex flex-col gap-1">
											<div className="flex items-center justify-between">
												<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
													Trigger (ON)
												</label>
												<input
													type="number" min={0} max={1023} value={t.trigger}
													className="w-14 text-xs font-mono text-red-500 bg-transparent border border-border rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-ring"
													onChange={(e) => {
														const v = Math.max(0, Math.min(1023, Number(e.target.value) || 0));
														updateTuning(i, { trigger: v });
													}}
													onBlur={(e) => commitTrigger(i, Math.max(0, Math.min(1023, Number(e.target.value) || 0)))}
												/>
											</div>
											<input
												type="range" min={0} max={1023} step={5} value={t.trigger}
												className="w-full h-1.5 accent-red-500 cursor-pointer"
												onChange={(e) => updateTuning(i, { trigger: Number(e.target.value) })}
												onMouseUp={(e) => commitTrigger(i, Number((e.target as HTMLInputElement).value))}
												onTouchEnd={(e) => commitTrigger(i, Number((e.target as HTMLInputElement).value))}
											/>
										</div>

										{/* Release threshold */}
										<div className="flex flex-col gap-1">
											<div className="flex items-center justify-between">
												<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
													Release (OFF)
												</label>
												<input
													type="number" min={0} max={1023} value={t.release}
													className="w-14 text-xs font-mono text-green-500 bg-transparent border border-border rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-ring"
													onChange={(e) => {
														const v = Math.max(0, Math.min(1023, Number(e.target.value) || 0));
														updateTuning(i, { release: v });
													}}
													onBlur={(e) => commitRelease(i, Math.max(0, Math.min(1023, Number(e.target.value) || 0)))}
												/>
											</div>
											<input
												type="range" min={0} max={1023} step={5} value={t.release}
												className="w-full h-1.5 accent-green-500 cursor-pointer"
												onChange={(e) => updateTuning(i, { release: Number(e.target.value) })}
												onMouseUp={(e) => commitRelease(i, Number((e.target as HTMLInputElement).value))}
												onTouchEnd={(e) => commitRelease(i, Number((e.target as HTMLInputElement).value))}
											/>
										</div>

										{gapWarning && (
											<p className="text-[10px] text-amber-500">
												⚠ Trigger and Release are close together ({gap} apart). A narrow gap
												can still miss fast double-taps. Try widening to 300+ apart.
											</p>
										)}

										{/* Gain */}
										<div className="flex flex-col gap-1">
											<div className="flex items-center justify-between">
												<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
													Gain
												</label>
												<div className="flex items-center gap-1">
													<input
														type="number" min={10} max={500} value={t.gainX100}
														className="w-12 text-xs font-mono text-muted-foreground bg-transparent border border-border rounded px-1 py-0.5 text-right focus:outline-none focus:ring-1 focus:ring-ring"
														onChange={(e) => {
															const v = Math.max(10, Math.min(500, Number(e.target.value) || 100));
															updateTuning(i, { gainX100: v });
														}}
														onBlur={(e) => commitGain(i, Math.max(10, Math.min(500, Number(e.target.value) || 100)))}
													/>
													<span className="text-[10px] text-muted-foreground">({(t.gainX100 / 100).toFixed(2)}x)</span>
												</div>
											</div>
											<input
												type="range" min={10} max={500} step={5} value={t.gainX100}
												className="w-full h-1.5 accent-foreground cursor-pointer"
												onChange={(e) => updateTuning(i, { gainX100: Number(e.target.value) })}
												onMouseUp={(e) => commitGain(i, Number((e.target as HTMLInputElement).value))}
												onTouchEnd={(e) => commitGain(i, Number((e.target as HTMLInputElement).value))}
											/>
											<p className="text-[10px] text-muted-foreground">
												Boosts weak FSR signals (e.g. UX FSR 406) before threshold comparison. 1.00x = no change.
											</p>
										</div>

										{/* Button Group -- shares a single joystick button across multiple
										    sensors mapped to the same panel (e.g. two FSRs both on "Down")
										    so ITGMania sees ONE input instead of two separate buttons. */}
										<div className="flex flex-col gap-1">
											<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
												Button Group
											</label>
											{/*
											  NOTE: native <option> elements ignore Tailwind's bg-transparent /
											  dark: utility classes in most browsers -- they're rendered by the
											  OS's own dropdown widget, not the page's CSS box model. Explicit
											  inline styles on both <select> and <option> are needed so the
											  dropdown list doesn't show a stark white background that clashes
											  with the rest of the dark-themed panel.
											*/}
											<select
												value={t.buttonGroup}
												onChange={(e) => commitButtonGroup(i, Number(e.target.value))}
												className="text-xs bg-white dark:bg-neutral-900 border border-border rounded px-2 py-1 w-full focus:outline-none focus:ring-1 focus:ring-ring"
											>
												<option value={i} className="bg-white dark:bg-neutral-900" style={{ backgroundColor: "inherit" }}>
													No sharing (own button)
												</option>
												{Array.from({ length: effectiveCount }, (_, j) => j)
													.filter((j) => j !== i)
													.map((j) => (
														<option key={j} value={j} className="bg-white dark:bg-neutral-900" style={{ backgroundColor: "inherit" }}>
															Share with {sensorLabels[j] || `Sensor ${j + 1}`} (#{j})
														</option>
													))}
											</select>
											{t.buttonGroup !== i && (
												<p className="text-[10px] text-amber-500">
													⚠ This sensor sends the same button as #{t.buttonGroup}. Pressing
													either one (or both) registers as a single input to ITGMania.
												</p>
											)}
											<p className="text-[10px] text-muted-foreground">
												Use this when 2 FSRs are wired to the same panel (e.g. two "Down"
												sensors) so they act as one button instead of two.
											</p>
										</div>

										{/* Quick presets */}
										<div className="flex flex-wrap gap-1 mt-1">
											<Button variant="outline" size="sm" className="text-xs flex-1"
												onClick={() => applyFastRetriggerPreset(i)}>
												Fast re-trigger
											</Button>
											<Button variant="outline" size="sm" className="text-xs flex-1"
												onClick={() => applyStablePreset(i)}>
												Stable / narrow
											</Button>
											<Button variant="outline" size="sm" className="text-xs flex-1"
												onClick={() => applyWeakFsrBoostPreset(i)}>
												Boost weak FSR
											</Button>
										</div>
									</div>
								)}
							</div>
						);
					})}

					<Button variant="outline" size="sm" className="w-full text-xs" disabled={!connected}
						onClick={() => { for (let i = 0; i < effectiveCount; i++) sendText(`p ${i}\n`); }}>
						Sync from pad
					</Button>
						</>
					)}

					{!connected && (
						<p className="text-[11px] text-muted-foreground text-center">Connect to pad to tune sensors</p>
					)}
				</div>
			)}
		</div>
	);
}

const Dashboard = () => {
	const colorSettings = useColorSettings();
	const barSettings = useBarVisualizationSettings();
	const graphSettings = useGraphVisualizationSettings();
	const heartrateSettings = useHeartrateSettings();
	const generalSettings = useGeneralSettings();
	const { updateAllSettings, getAllSettings } = useSettingsBulkActions();

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
		},
	);

	// Wrap sendText so LedSection can use it as a stable callback
	const sendTextStable = useStableCallback((text: string) => sendText(text));

	const numSensors = useSensorCount();

	const {
		connect: connectHR,
		disconnect: disconnectHR,
		heartrateData,
		isConnected: connectedHR,
		isConnecting: connectingHR,
		error: heartrateError,
		isSupported: isBluetoothSupported,
		device: heartrateDevice,
	} = useHeartrateMonitor();

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
	} = useProfileManager();

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
	const toggleTheme = useStableCallback(() => {
		setTheme(resolvedTheme === "dark" ? "light" : "dark");
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

	const handleHeartrateToggle = useStableCallback(async () => {
		if (!isBluetoothSupported) return;

		if (connectedHR) {
			await disconnectHR();
		} else {
			await connectHR();
		}
	});

	const sendAllThresholds = () => {
		if (!connected || !thresholds.length) return;

		thresholds.forEach((value, index) => {
			const message = `${index} ${value}\n`;
			sendText(message);
		});
	};

	useEffect(() => {
		if (connected) sendAllThresholds();
	}, [connected]);

	useEffect(() => {
		if (activeProfileId && connected) sendAllThresholds();
	}, [activeProfileId, connected]);

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
			const defaultThresholds = Array(numSensors).fill(512);
			setThresholds(defaultThresholds);
			if (activeProfileId) void updateThresholds(defaultThresholds);
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
			const newThresholds = Array(numSensors).fill(512);
			setThresholds(newThresholds);

			if (activeProfileId) updateThresholds(newThresholds);
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

	const handleThresholdChange = useStableCallback((index: number, value: number) => {
		const newThresholds = [...thresholds];
		newThresholds[index] = value;
		setThresholds(newThresholds);

		if (activeProfileId) updateThresholds(newThresholds);

		// IMPORTANT: while Advanced Sensor Tuning is on, do NOT send the
		// legacy "<index> <value>" command. Firmware-side, that command
		// sets BOTH trigger and release threshold from a single number
		// (release = trigger - 20), which would silently collapse any
		// wider gap configured in Advanced mode every time this slider
		// is touched. The main page bar still updates visually/locally
		// and still syncs to the active profile, it just stops being the
		// thing that talks to the firmware once Advanced mode owns that.
		if (connected && !advancedTuningEnabled) {
			const message = `${index} ${value}\n`;
			sendText(message);
		}
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

	const sensorBars = Array.from({ length: numSensors }, (_, position) => {
		const index = effectiveDisplayOrder[position] ?? position;
		return (
			<div
				key={`sensor-pos-${position}`}
				className={`relative h-full transition-opacity ${sensorBarsDrag.draggingPos === position ? "opacity-40" : ""} ${sensorBarsDrag.dragOverPos === position ? "ring-2 ring-primary rounded" : ""}`}
				onDragOver={sensorBarsDrag.handleDragOver(position)}
				onDrop={sensorBarsDrag.handleDrop(position)}
			>
				<div className="absolute top-0 left-1/2 -translate-x-1/2 z-10 pt-0.5">
					<DragHandle
						onDragStart={sensorBarsDrag.handleDragStart(position)}
						onDragEnd={sensorBarsDrag.handleDragEnd}
					/>
				</div>
				<SensorBar
					key={`sensor-${index}`}
					value={latestData?.values[index] || 0}
					index={index}
					threshold={advancedTuningEnabled ? (liveTriggerValues[index] ?? thresholds[index] ?? 512) : (thresholds[index] || 512)}
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
					isLocked={generalSettings.lockThresholds || advancedTuningEnabled}
					theme={resolvedTheme}
					secondaryThreshold={advancedTuningEnabled ? liveReleaseValues[index] : undefined}
					secondaryThresholdLabel="Release"
					secondaryThresholdColor="rgba(34, 197, 94, 0.9)"
				/>
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
		<main className="grid grid-cols-[17rem_1fr] h-screen w-screen bg-background text-foreground overflow-hidden">
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
										<p>Install WebFSR as an app</p>
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
						<h2 className="text-xl font-bold flex-1 text-center">WebFSR</h2>
						<Button variant="ghost" size="icon" className="size-8 shrink-0" onClick={toggleTheme} aria-label="Toggle theme">
							{resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
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
							/>

							{/* ── SENSOR TUNING SECTION ── */}
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
							/>

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
									aria-label="About WebFSR"
								>
									About WebFSR
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
					{latestData ? (
						<>
							<div className="flex gap-2 shrink-0 h-100">
								<div className="px-4 border rounded-lg bg-white dark:bg-neutral-900 shadow-sm grow">
									{advancedTuningEnabled && (
										<p className="text-[11px] text-amber-500 px-1 pt-2">
											Advanced Sensor Tuning is on — threshold dragging here is disabled.
											Adjust Trigger/Release in the Sensor Tuning panel instead.
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
