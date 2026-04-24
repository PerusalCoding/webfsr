import { AlertTriangle, Download, Heart, Moon, Share, Smartphone, Sun, Unplug } from "lucide-react";
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

const NUM_PANELS = 4;
const PANEL_NAMES = ["Left", "Down", "Up", "Right"] as const;
const DEFAULT_PANEL_COLORS: string[] = ["#e84040", "#4a7fff", "#ff9020", "#3fcf6e"];
const LS_CUSTOM_PRESETS_KEY = "webfsr_led_custom_presets";
const LS_SENSOR_MAP_KEY = "webfsr_led_sensor_map";

// One entry per physical FSR sensor zone
interface SensorZone {
	sensorIndex: number;  // 0-based, matches WebFSR sensor order
	panelIndex: number;   // which arrow panel (0=Left,1=Down,2=Up,3=Right)
	ledCount: number;     // how many LEDs this zone controls
	ledOffset: number;    // starting LED index within the panel strip
}

interface LedPreset {
	name: string;
	colors: string[];
	brightness: number;
}

const DEFAULT_SENSOR_MAP: SensorZone[] = [
	{ sensorIndex: 0, panelIndex: 0, ledCount: 4, ledOffset: 0 },
	{ sensorIndex: 1, panelIndex: 1, ledCount: 4, ledOffset: 0 },
	{ sensorIndex: 2, panelIndex: 2, ledCount: 4, ledOffset: 0 },
	{ sensorIndex: 3, panelIndex: 3, ledCount: 4, ledOffset: 0 },
];

const BUILTIN_PRESETS: LedPreset[] = [
	{ name: "Default", colors: ["#e84040", "#4a7fff", "#ff9020", "#3fcf6e"], brightness: 200 },
	{ name: "DDR",     colors: ["#ffcc00", "#0088ff", "#ff2288", "#00ddaa"], brightness: 200 },
	{ name: "White",   colors: ["#ffffff", "#ffffff", "#ffffff", "#ffffff"], brightness: 150 },
	{ name: "Purple",  colors: ["#9966ff", "#cc44ff", "#7744ff", "#bb55ff"], brightness: 200 },
	{ name: "Fire",    colors: ["#ff2200", "#ff6600", "#ffaa00", "#ffdd00"], brightness: 200 },
	{ name: "Ice",     colors: ["#aaddff", "#66bbff", "#2299ff", "#0055cc"], brightness: 180 },
];

function hexToRgb(hex: string): { r: number; g: number; b: number } {
	const clean = hex.replace("#", "");
	return {
		r: parseInt(clean.slice(0, 2), 16),
		g: parseInt(clean.slice(2, 4), 16),
		b: parseInt(clean.slice(4, 6), 16),
	};
}

function loadCustomPresets(): LedPreset[] {
	try {
		const raw = localStorage.getItem(LS_CUSTOM_PRESETS_KEY);
		return raw ? (JSON.parse(raw) as LedPreset[]) : [];
	} catch { return []; }
}
function saveCustomPresets(presets: LedPreset[]) {
	localStorage.setItem(LS_CUSTOM_PRESETS_KEY, JSON.stringify(presets));
}
function loadSensorMap(): SensorZone[] {
	try {
		const raw = localStorage.getItem(LS_SENSOR_MAP_KEY);
		return raw ? (JSON.parse(raw) as SensorZone[]) : DEFAULT_SENSOR_MAP;
	} catch { return DEFAULT_SENSOR_MAP; }
}
function saveSensorMap(map: SensorZone[]) {
	localStorage.setItem(LS_SENSOR_MAP_KEY, JSON.stringify(map));
}

/*===========================================================================*/
// LED Section component

interface LedSectionProps {
	connected: boolean;
	sendText: (text: string) => void;
	thresholds: number[];
}

function LedSection({ connected, sendText }: LedSectionProps) {
	const [panelColors, setPanelColors] = useState<string[]>(DEFAULT_PANEL_COLORS);
	const [brightness, setBrightness] = useState<number>(200);
	const [ledOpen, setLedOpen] = useState<boolean>(true);
	const [mappingOpen, setMappingOpen] = useState<boolean>(false);

	// Custom presets
	const [customPresets, setCustomPresets] = useState<LedPreset[]>(loadCustomPresets);
	const [newPresetName, setNewPresetName] = useState<string>("");
	const [showSaveInput, setShowSaveInput] = useState<boolean>(false);

	// Sensor mapping
	const [sensorMap, setSensorMap] = useState<SensorZone[]>(loadSensorMap);

	// Track which zones are currently lit so we can send off when they release
	const litZonesRef = useRef<Set<number>>(new Set());

	// On first connect query pad config
	const hasQueriedRef = useRef(false);
	useEffect(() => {
		if (connected && !hasQueriedRef.current) {
			hasQueriedRef.current = true;
			setTimeout(() => sendText("q\n"), 400);
		}
		if (!connected) hasQueriedRef.current = false;
	}, [connected, sendText]);

	// Note: LED on/off on press is handled entirely by the firmware.
	// The web app only sends color and brightness commands.
	// The sensor mapping UI is saved locally so users can document their setup.

	const handleLedLine = (line: string) => {
		if (!line.startsWith("c")) return false;
		const nums = line.slice(1).trim().split(/\s+/).map(Number);
		if (nums.length < 13) return false;
		const newColors: string[] = [];
		for (let i = 0; i < NUM_PANELS; i++) {
			const r = nums[i * 3], g = nums[i * 3 + 1], b = nums[i * 3 + 2];
			newColors.push(`#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`);
		}
		setPanelColors(newColors);
		setBrightness(nums[12]);
		return true;
	};

	const sendColor = (index: number, hex: string) => {
		if (!connected) return;
		const { r, g, b } = hexToRgb(hex);
		sendText(`l ${index} ${r} ${g} ${b}\n`);
	};

	const sendBrightness = (val: number) => {
		if (!connected) return;
		sendText(`b ${val}\n`);
	};

	const applyPreset = (preset: LedPreset) => {
		setPanelColors([...preset.colors]);
		setBrightness(preset.brightness);
		preset.colors.forEach((c, i) => sendColor(i, c));
		sendBrightness(preset.brightness);
	};

	const onColorChange = (index: number, hex: string) => {
		const next = [...panelColors];
		next[index] = hex;
		setPanelColors(next);
	};
	const onColorCommit = (index: number, hex: string) => sendColor(index, hex);
	const onBrightnessCommit = (val: number) => { setBrightness(val); sendBrightness(val); };

	const saveCurrentAsPreset = () => {
		const name = newPresetName.trim();
		if (!name) return;
		const preset: LedPreset = { name, colors: [...panelColors], brightness };
		const updated = [...customPresets, preset];
		setCustomPresets(updated);
		saveCustomPresets(updated);
		setNewPresetName("");
		setShowSaveInput(false);
	};

	const deleteCustomPreset = (index: number) => {
		const updated = customPresets.filter((_, i) => i !== index);
		setCustomPresets(updated);
		saveCustomPresets(updated);
	};

	// Sensor map helpers
	const updateZone = (idx: number, field: keyof SensorZone, value: number) => {
		const updated = sensorMap.map((z, i) => i === idx ? { ...z, [field]: value } : z);
		setSensorMap(updated);
		saveSensorMap(updated);
	};

	const addZone = () => {
		const newZone: SensorZone = { sensorIndex: sensorMap.length, panelIndex: 0, ledCount: 2, ledOffset: 0 };
		const updated = [...sensorMap, newZone];
		setSensorMap(updated);
		saveSensorMap(updated);
	};

	const removeZone = (idx: number) => {
		const updated = sensorMap.filter((_, i) => i !== idx);
		setSensorMap(updated);
		saveSensorMap(updated);
	};

	const resetMap = () => {
		setSensorMap(DEFAULT_SENSOR_MAP);
		saveSensorMap(DEFAULT_SENSOR_MAP);
	};

	(LedSection as unknown as { _handleLine: (l: string) => boolean })._handleLine = handleLedLine;

	return (
		<div className="p-3 border rounded bg-white dark:bg-neutral-900">
			<button
				className="flex items-center justify-between w-full text-left mb-0"
				onClick={() => setLedOpen((o) => !o)}
			>
				<span className="text-sm font-semibold">LED Panels</span>
				<span className="text-xs text-muted-foreground">{ledOpen ? "▲" : "▼"}</span>
			</button>

			{ledOpen && (
				<div className="mt-3 flex flex-col gap-3">

					{/* Per-panel color pickers */}
					<div className="grid grid-cols-2 gap-2">
						{PANEL_NAMES.map((name, i) => (
							<div key={name} className="flex flex-col gap-1">
								<label className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">
									{name}
								</label>
								<div className="flex items-center gap-2">
									<div
										className="w-7 h-7 rounded-md border border-border shrink-0 cursor-pointer relative overflow-hidden"
										style={{ background: panelColors[i] }}
									>
										<input
											type="color"
											value={panelColors[i]}
											className="absolute inset-0 opacity-0 w-full h-full cursor-pointer"
											onChange={(e) => onColorChange(i, e.target.value)}
											onBlur={(e) => onColorCommit(i, e.target.value)}
										/>
									</div>
									<input
										type="text"
										value={panelColors[i].toUpperCase()}
										maxLength={7}
										className="flex-1 text-xs font-mono bg-transparent border border-border rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-ring min-w-0"
										onChange={(e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onColorChange(i, e.target.value); }}
										onBlur={(e) => { if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onColorCommit(i, e.target.value); }}
									/>
								</div>
							</div>
						))}
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
							onMouseUp={(e) => onBrightnessCommit(Number((e.target as HTMLInputElement).value))}
							onTouchEnd={(e) => onBrightnessCommit(Number((e.target as HTMLInputElement).value))}
						/>
					</div>

					{/* Sensor Mapping */}
					<div className="flex flex-col gap-1 border border-border rounded p-2">
						<button
							className="flex items-center justify-between w-full text-left"
							onClick={() => setMappingOpen((o) => !o)}
						>
							<span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">Sensor → LED Mapping</span>
							<span className="text-xs text-muted-foreground">{mappingOpen ? "▲" : "▼"}</span>
						</button>

						{mappingOpen && (
							<div className="mt-2 flex flex-col gap-2">
								<p className="text-[11px] text-muted-foreground">
									Map each FSR sensor to a panel and set how many LEDs it controls.
								</p>

								{/* Zone rows */}
								<div className="flex flex-col gap-1.5">
									{/* Header */}
									<div className="grid grid-cols-[1.5rem_2.5rem_3.5rem_2.5rem_3rem_1.2rem] gap-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wide px-0.5">
										<span>#</span>
										<span>FSR</span>
										<span>Panel</span>
										<span>LEDs</span>
										<span>Offset</span>
										<span></span>
									</div>

									{sensorMap.map((zone, idx) => (
										<div key={idx} className="grid grid-cols-[1.5rem_2.5rem_3.5rem_2.5rem_3rem_1.2rem] gap-1 items-center">
											<span className="text-[11px] text-muted-foreground text-center">{idx + 1}</span>
											{/* Sensor index */}
											<input
												type="number" min={0} max={15} value={zone.sensorIndex}
												className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
												onChange={(e) => updateZone(idx, "sensorIndex", parseInt(e.target.value) || 0)}
											/>
											{/* Panel dropdown */}
											<select
												value={zone.panelIndex}
												className="text-xs bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring"
												onChange={(e) => updateZone(idx, "panelIndex", parseInt(e.target.value))}
											>
												{PANEL_NAMES.map((n, pi) => (
													<option key={pi} value={pi}>{n}</option>
												))}
											</select>
											{/* LED count */}
											<input
												type="number" min={1} max={64} value={zone.ledCount}
												className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
												onChange={(e) => updateZone(idx, "ledCount", parseInt(e.target.value) || 1)}
											/>
											{/* LED offset */}
											<input
												type="number" min={0} max={63} value={zone.ledOffset}
												className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
												onChange={(e) => updateZone(idx, "ledOffset", parseInt(e.target.value) || 0)}
											/>
											{/* Delete */}
											<button
												onClick={() => removeZone(idx)}
												className="text-xs text-muted-foreground hover:text-destructive transition-colors text-center"
												title="Remove zone"
											>×</button>
										</div>
									))}
								</div>

								<div className="flex gap-1 mt-1">
									<Button variant="outline" size="sm" className="text-xs flex-1" onClick={addZone}>
										+ Add zone
									</Button>
									<Button variant="outline" size="sm" className="text-xs flex-1" onClick={resetMap}>
										Reset
									</Button>
								</div>

								<p className="text-[10px] text-muted-foreground">
									FSR = sensor number (0-based). Offset = first LED in this zone on the strip.
								</p>
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
										{preset.colors.map((c, ci) => (
											<span key={ci} className="inline-block w-2 h-2 rounded-full" style={{ background: c }} />
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
								onClick={() => setShowSaveInput((v) => !v)}
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
							<p className="text-[11px] text-muted-foreground italic">
								No custom presets yet — set your colors and click "+ Save current"
							</p>
						)}
						<div className="flex flex-wrap gap-1">
							{customPresets.map((preset, idx) => (
								<div key={idx} className="flex items-center gap-0.5">
									<button
										onClick={() => applyPreset(preset)}
										className="flex items-center gap-1 px-2 py-1 text-xs rounded-l border border-border bg-transparent hover:bg-accent hover:text-accent-foreground transition-colors"
									>
										<span className="flex gap-0.5">
											{preset.colors.map((c, ci) => (
												<span key={ci} className="inline-block w-2 h-2 rounded-full" style={{ background: c }} />
											))}
										</span>
										{preset.name}
									</button>
									<button
										onClick={() => deleteCustomPreset(idx)}
										className="px-1.5 py-1 text-xs rounded-r border border-l-0 border-border bg-transparent hover:bg-destructive hover:text-destructive-foreground transition-colors text-muted-foreground"
										title="Delete preset"
									>×</button>
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

const Dashboard = () => {
	const colorSettings = useColorSettings();
	const barSettings = useBarVisualizationSettings();
	const graphSettings = useGraphVisualizationSettings();
	const heartrateSettings = useHeartrateSettings();
	const generalSettings = useGeneralSettings();
	const { updateAllSettings, getAllSettings } = useSettingsBulkActions();

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

		if (connected) {
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

	const sensorBars = Array.from({ length: numSensors }, (_, index) => (
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
		/>
	));

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
								latestValues={latestData?.values ?? []}
								thresholds={thresholds}
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
