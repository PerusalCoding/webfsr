import type { CSSProperties } from "react";

// Shared between the live OBS "Pad Preview" overlay (obs/pad.tsx) and, if
// you wire it up later, OBSComponentDialog's own preview pane -- one
// implementation of "how a panel gets tinted" instead of a third copy of
// the logic already duplicated between LedPadPreview in the pro/public
// dashboards.

export type Direction = "up" | "down" | "left" | "right";

// Percent-based box (0-100), relative to the pad image's own bounding box.
export interface PanelRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

// The classic symmetric 3x3 dance-pad grid -- fine for the bundled
// pad-background.png (drawn to exactly this grid) but real photos of an
// actual DDR/ITG/travel pad almost never crop this evenly: the panels are
// rarely perfect thirds, and phone photos add perspective. PadConfig's
// optional `panelRects` (see OBSComponentDialog.tsx) overrides any subset
// of these per-direction so someone can drag each panel to line up with
// their own photo without touching code.
export const DEFAULT_PANEL_RECTS: Record<Direction, PanelRect> = {
	up: { top: 0, left: 33.333, width: 33.333, height: 33.333 },
	left: { top: 33.333, left: 0, width: 33.333, height: 33.333 },
	right: { top: 33.333, left: 66.666, width: 33.333, height: 33.333 },
	down: { top: 66.666, left: 33.333, width: 33.333, height: 33.333 },
};

export interface PadSensor {
	index: number; // matches the position in the live values[]/thresholds[] arrays
	label: string;
	color: string;
}

// Same substring match LedPadPreview uses in the dashboard: "Up" matches
// both "Up" and "Up 2", so a second FSR on the same panel is picked up
// automatically without any extra config.
export function findAllByDir(sensors: PadSensor[], dir: Direction): PadSensor[] {
	return sensors.filter((s) => s.label.trim().toLowerCase().includes(dir));
}

export function hexToRgb(hex: string) {
	const c = hex.replace("#", "");
	if (c.length !== 6) return { r: 255, g: 255, b: 255 };
	return { r: parseInt(c.slice(0, 2), 16), g: parseInt(c.slice(2, 4), 16), b: parseInt(c.slice(4, 6), 16) };
}

interface PanelProps {
	direction: Direction;
	matches: PadSensor[];
	isActive: (sensorIndex: number) => boolean;
	idleOpacity: number;
	activeOpacity: number;
	glowEnabled: boolean;
}

// One panel's worth of tint layer(s). Idle panels get a plain white wash
// (mix-blend-mode: overlay -- no hue of its own, just brightens the
// artwork so the pad visibly reads as "off" without implying a color).
// Pressing a panel cross-fades that out and fades in the sensor's own
// color via mix-blend-mode: hue -- same trick LedPadPreview uses so the
// image's own lighting/3D shading survives -- plus an inset glow. Two
// sensors sharing a panel (e.g. "Up" + "Up 2") each get their own
// idle/active pair, split down the middle, same convention as the
// dashboard's own LED preview.
export function Panel({ direction, matches, isActive, idleOpacity, activeOpacity, glowEnabled }: PanelProps) {
	if (matches.length === 0) return null;

	const primary = matches[0];
	const secondary = matches[1];
	const splitIsLeftRight = direction === "up" || direction === "down";

	const halfRect = (half?: "first" | "second"): CSSProperties =>
		secondary
			? splitIsLeftRight
				? half === "first"
					? { top: 0, bottom: 0, left: 0, right: "50%" }
					: { top: 0, bottom: 0, left: "50%", right: 0 }
				: half === "first"
					? { left: 0, right: 0, top: 0, bottom: "50%" }
					: { left: 0, right: 0, top: "50%", bottom: 0 }
			: { inset: 0 };

	const renderSensor = (sensor: PadSensor, half?: "first" | "second") => {
		const active = isActive(sensor.index);
		const { r, g, b } = hexToRgb(sensor.color);
		return (
			<div key={sensor.index} style={{ position: "absolute", ...halfRect(half) }}>
				{/* Idle: plain white wash, no hue -- instantly recognizable as "off" */}
				<div
					style={{
						position: "absolute",
						inset: 0,
						backgroundColor: "#ffffff",
						mixBlendMode: "overlay",
						opacity: active ? 0 : idleOpacity,
						transition: "opacity 60ms linear",
					}}
				/>
				{/* Active: the sensor's own color, fades in on press */}
				<div
					style={{
						position: "absolute",
						inset: 0,
						backgroundColor: sensor.color,
						mixBlendMode: "hue",
						opacity: active ? activeOpacity : 0,
						transition: "opacity 60ms linear",
						boxShadow: active && glowEnabled ? `inset 0 0 24px 6px rgba(${r}, ${g}, ${b}, 0.9)` : "none",
					}}
				/>
			</div>
		);
	};

	return (
		<div className="absolute inset-0 pointer-events-none" style={{ borderRadius: "inherit" }}>
			{renderSensor(primary, secondary ? "first" : undefined)}
			{secondary && renderSensor(secondary, "second")}
		</div>
	);
}

// Renders all four panels positioned over a pad image. Caller is
// responsible for the <img> itself (different sizing/error-fallback needs
// between the live overlay and an in-dialog preview), this just lays the
// tint layers on top at the right spots.
export function PadPanelsOverlay({
	sensors,
	isActive,
	idleOpacity,
	activeOpacity,
	glowEnabled,
	panelRects,
}: {
	sensors: PadSensor[];
	isActive: (sensorIndex: number) => boolean;
	idleOpacity: number;
	activeOpacity: number;
	glowEnabled: boolean;
	// Per-direction overrides on top of DEFAULT_PANEL_RECTS -- pass only
	// the directions that need adjusting, e.g. a photo where just the
	// down panel is a bit off. Undefined/omitted -> the stock grid.
	panelRects?: Partial<Record<Direction, PanelRect>>;
}) {
	const directions: Direction[] = ["up", "down", "left", "right"];

	return (
		<>
			{directions.map((direction) => {
				const matches = findAllByDir(sensors, direction);
				const rect = { ...DEFAULT_PANEL_RECTS[direction], ...panelRects?.[direction] };
				return (
					<div
						key={direction}
						style={{
							position: "absolute",
							top: `${rect.top}%`,
							left: `${rect.left}%`,
							width: `${rect.width}%`,
							height: `${rect.height}%`,
							overflow: "hidden",
						}}
					>
						<Panel
							direction={direction}
							matches={matches}
							isActive={isActive}
							idleOpacity={idleOpacity}
							activeOpacity={activeOpacity}
							glowEnabled={glowEnabled}
						/>
					</div>
				);
			})}
		</>
	);
}
