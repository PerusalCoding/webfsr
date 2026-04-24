// ============================================================
// DROP-IN REPLACEMENT for the LedSection component and its
// supporting types/constants inside your webfsr Dashboard.tsx
//
// HOW TO USE:
//   1. Find the "LED PANEL — types and helpers" block in your
//      Dashboard.tsx and replace everything from that comment
//      down to (and including) the closing brace of LedSection.
//   2. Paste this entire file's contents in its place.
//   3. The <LedSection ... /> call in the JSX stays the same,
//      but add the latestValues prop:
//        <LedSection
//          connected={connected}
//          sendText={sendTextStable}
//          thresholds={thresholds}
//          latestValues={latestData?.values ?? []}
//        />
// ============================================================

/*===========================================================================*/
// LED PANEL — types and helpers

const NUM_PANELS = 4;
const PANEL_NAMES = ["Left", "Down", "Up", "Right"] as const;
const DEFAULT_PANEL_COLORS: string[] = ["#e84040", "#4a7fff", "#ff9020", "#3fcf6e"];
const LS_CUSTOM_PRESETS_KEY = "webfsr_led_custom_presets";
const LS_ZONE_MAP_KEY = "webfsr_led_zone_map_v2";

// One entry per panel — maps directly to firmware panelLedOffset / panelLedCount.
interface PanelZone {
  ledCount: number;   // how many LEDs to light (1 to LEDS_PER_PANEL)
  ledOffset: number;  // starting LED index within the panel section (0-based)
}

interface LedPreset {
  name: string;
  colors: string[];
  brightness: number;
  zones?: PanelZone[]; // optional — presets can also save zone settings
}

const DEFAULT_ZONES: PanelZone[] = [
  { ledOffset: 0, ledCount: 4 },
  { ledOffset: 0, ledCount: 4 },
  { ledOffset: 0, ledCount: 4 },
  { ledOffset: 0, ledCount: 4 },
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
function loadZoneMap(): PanelZone[] {
  try {
    const raw = localStorage.getItem(LS_ZONE_MAP_KEY);
    return raw ? (JSON.parse(raw) as PanelZone[]) : DEFAULT_ZONES;
  } catch { return DEFAULT_ZONES; }
}
function saveZoneMap(zones: PanelZone[]) {
  localStorage.setItem(LS_ZONE_MAP_KEY, JSON.stringify(zones));
}

/*===========================================================================*/
// LED Section component

interface LedSectionProps {
  connected: boolean;
  sendText: (text: string) => void;
  thresholds: number[];
  latestValues: number[];
}

function LedSection({ connected, sendText }: LedSectionProps) {
  const [panelColors, setPanelColors] = useState<string[]>(DEFAULT_PANEL_COLORS);
  const [brightness, setBrightness] = useState<number>(200);
  const [zones, setZones] = useState<PanelZone[]>(loadZoneMap);
  const [ledOpen, setLedOpen] = useState<boolean>(true);
  const [zoneOpen, setZoneOpen] = useState<boolean>(false);

  // Custom presets
  const [customPresets, setCustomPresets] = useState<LedPreset[]>(loadCustomPresets);
  const [newPresetName, setNewPresetName] = useState<string>("");
  const [showSaveInput, setShowSaveInput] = useState<boolean>(false);

  // Query pad config on connect
  const hasQueriedRef = useRef(false);
  useEffect(() => {
    if (connected && !hasQueriedRef.current) {
      hasQueriedRef.current = true;
      setTimeout(() => sendText("q\n"), 400);
    }
    if (!connected) hasQueriedRef.current = false;
  }, [connected, sendText]);

  // Parse "c" response from firmware.
  // New format: c r g b r g b r g b r g b <brightness> <off0> <cnt0> ... <off3> <cnt3>
  // Old format: c r g b r g b r g b r g b <brightness>   (still accepted)
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

    // Parse zone data if present (nums[13..20])
    if (nums.length >= 21) {
      const newZones: PanelZone[] = [];
      for (let i = 0; i < NUM_PANELS; i++) {
        newZones.push({ ledOffset: nums[13 + i * 2], ledCount: nums[14 + i * 2] });
      }
      setZones(newZones);
      saveZoneMap(newZones);
    }
    return true;
  };

  // Send color for one panel
  const sendColor = (index: number, hex: string) => {
    if (!connected) return;
    const { r, g, b } = hexToRgb(hex);
    sendText(`l ${index} ${r} ${g} ${b}\n`);
  };

  // Send brightness
  const sendBrightness = (val: number) => {
    if (!connected) return;
    sendText(`b ${val}\n`);
  };

  // Send zone (offset + count) for one panel — new "z" command
  const sendZone = (index: number, zone: PanelZone) => {
    if (!connected) return;
    sendText(`z ${index} ${zone.ledOffset} ${zone.ledCount}\n`);
  };

  // Color change handlers
  const onColorChange = (index: number, hex: string) => {
    const next = [...panelColors];
    next[index] = hex;
    setPanelColors(next);
  };
  const onColorCommit = (index: number, hex: string) => sendColor(index, hex);
  const onBrightnessCommit = (val: number) => { setBrightness(val); sendBrightness(val); };

  // Zone change handlers
  const onZoneChange = (index: number, field: keyof PanelZone, raw: number) => {
    const LEDS_PER_PANEL = 4; // must match firmware
    let value = isNaN(raw) ? 0 : raw;

    // Clamp values
    if (field === "ledOffset") value = Math.max(0, Math.min(LEDS_PER_PANEL - 1, value));
    if (field === "ledCount")  value = Math.max(1, Math.min(LEDS_PER_PANEL, value));

    const updated = zones.map((z, i) => i === index ? { ...z, [field]: value } : z);
    setZones(updated);
    saveZoneMap(updated);
    sendZone(index, updated[index]);
  };

  const resetZones = () => {
    setZones(DEFAULT_ZONES);
    saveZoneMap(DEFAULT_ZONES);
    DEFAULT_ZONES.forEach((z, i) => sendZone(i, z));
  };

  // Preset handlers
  const applyPreset = (preset: LedPreset) => {
    setPanelColors([...preset.colors]);
    setBrightness(preset.brightness);
    preset.colors.forEach((c, i) => sendColor(i, c));
    sendBrightness(preset.brightness);
    if (preset.zones) {
      setZones([...preset.zones]);
      saveZoneMap([...preset.zones]);
      preset.zones.forEach((z, i) => sendZone(i, z));
    }
  };

  const saveCurrentAsPreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const preset: LedPreset = { name, colors: [...panelColors], brightness, zones: [...zones] };
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

  // Expose handleLedLine for parent to call when it receives serial data
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

          {/* LED Zone mapping — now actually sends z commands */}
          <div className="flex flex-col gap-1 border border-border rounded p-2">
            <button
              className="flex items-center justify-between w-full text-left"
              onClick={() => setZoneOpen((o) => !o)}
            >
              <span className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide">LED Zone per Panel</span>
              <span className="text-xs text-muted-foreground">{zoneOpen ? "▲" : "▼"}</span>
            </button>

            {zoneOpen && (
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-[11px] text-muted-foreground">
                  Control exactly which LEDs light up per panel. Changes send immediately to the pad.
                </p>

                {/* Visual preview row */}
                <div className="grid grid-cols-4 gap-1.5 mb-1">
                  {PANEL_NAMES.map((name, pi) => {
                    const zone = zones[pi];
                    const LEDS_PER_PANEL = 4;
                    return (
                      <div key={name} className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">{name}</span>
                        <div className="flex gap-0.5">
                          {Array.from({ length: LEDS_PER_PANEL }, (_, li) => {
                            const active = li >= zone.ledOffset && li < zone.ledOffset + zone.ledCount;
                            return (
                              <div
                                key={li}
                                className="w-3 h-3 rounded-sm border border-border"
                                style={{ background: active ? panelColors[pi] : "transparent" }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Zone inputs */}
                <div className="flex flex-col gap-1.5">
                  <div className="grid grid-cols-[3rem_1fr_1fr] gap-1 text-[10px] text-muted-foreground font-medium uppercase tracking-wide px-0.5">
                    <span>Panel</span>
                    <span>Offset</span>
                    <span>Count</span>
                  </div>
                  {PANEL_NAMES.map((name, pi) => (
                    <div key={name} className="grid grid-cols-[3rem_1fr_1fr] gap-1 items-center">
                      <span className="text-[11px] text-muted-foreground">{name}</span>
                      <input
                        type="number" min={0} max={3} value={zones[pi].ledOffset}
                        className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
                        onChange={(e) => onZoneChange(pi, "ledOffset", parseInt(e.target.value))}
                      />
                      <input
                        type="number" min={1} max={4} value={zones[pi].ledCount}
                        className="text-xs font-mono bg-transparent border border-border rounded px-1 py-0.5 w-full focus:outline-none focus:ring-1 focus:ring-ring text-center"
                        onChange={(e) => onZoneChange(pi, "ledCount", parseInt(e.target.value))}
                      />
                    </div>
                  ))}
                </div>

                <p className="text-[10px] text-muted-foreground">
                  Offset = first LED to light (0–3). Count = how many LEDs from there (1–4).
                </p>

                <Button variant="outline" size="sm" className="text-xs w-full" onClick={resetZones}>
                  Reset all zones to default (0 offset, 4 LEDs)
                </Button>
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
