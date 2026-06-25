import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";

const maxSensorVal = 1023;

interface MobileSensorCardProps {
	label: string;
	value: number;
	threshold: number;
	color: string;
	thresholdColor: string;
	useThresholdColor: boolean;
	index: number;
	onThresholdChange: (index: number, value: number) => void;
	isLocked?: boolean;
	theme?: "light" | "dark";
	// Optional second marker + stepper group, shown only when Advanced
	// Sensor Tuning is active on the synced desktop profile. Mirrors the
	// dual-line treatment added to SensorBar.tsx on desktop -- omitting
	// these props renders exactly the original single-threshold card.
	secondaryThreshold?: number;
	onSecondaryThresholdChange?: (index: number, value: number) => void;
}

const MobileSensorCard = ({
	label,
	value,
	threshold,
	color,
	thresholdColor,
	useThresholdColor,
	index,
	onThresholdChange,
	isLocked = false,
	theme,
	secondaryThreshold,
	onSecondaryThresholdChange,
}: MobileSensorCardProps) => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
	const hasDualLine = secondaryThreshold !== undefined && !!onSecondaryThresholdChange;

	// Which line a touch-drag is currently moving -- only meaningful in
	// dual-line mode. Mirrors the desktop SensorBar's draggingLine ref,
	// just adapted to a horizontal bar (X position) instead of a
	// vertical one (Y position).
	const isDragging = useRef(false);
	const draggingLine = useRef<"primary" | "secondary">("primary");

	const handleAdjust = (step: number) => {
		if (isLocked) return;

		const newValue = Math.max(0, Math.min(threshold + step, maxSensorVal));
		onThresholdChange(index, newValue);
	};

	const handleSecondaryAdjust = (step: number) => {
		if (isLocked || !onSecondaryThresholdChange || secondaryThreshold === undefined) return;

		const newValue = Math.max(0, Math.min(secondaryThreshold + step, maxSensorVal));
		onSecondaryThresholdChange(index, newValue);
	};

	// Converts a touch's clientX into a 0-maxSensorVal value based on its
	// horizontal position within the canvas.
	const xToValue = (clientX: number): number | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;

		const rect = canvas.getBoundingClientRect();
		const raw = Math.round(maxSensorVal * ((clientX - rect.left) / rect.width));
		return Math.max(0, Math.min(maxSensorVal, raw));
	};

	// Decides whether a touch at the given X should grab the Trigger
	// (primary) or Release (secondary) line -- whichever line's pixel
	// position is closer to the touch point. Same logic as desktop
	// SensorBar's pickNearestLine, just X-based instead of Y-based.
	const pickNearestLine = (clientX: number): "primary" | "secondary" => {
		if (!hasDualLine || secondaryThreshold === undefined) return "primary";

		const canvas = canvasRef.current;
		if (!canvas) return "primary";

		const rect = canvas.getBoundingClientRect();
		const primaryX = rect.left + (threshold / maxSensorVal) * rect.width;
		const secondaryX = rect.left + (secondaryThreshold / maxSensorVal) * rect.width;

		return Math.abs(clientX - secondaryX) < Math.abs(clientX - primaryX) ? "secondary" : "primary";
	};

	const applyDragValue = (clientX: number, line: "primary" | "secondary") => {
		const value = xToValue(clientX);
		if (value === null) return;

		if (line === "secondary" && onSecondaryThresholdChange) {
			onSecondaryThresholdChange(index, value);
		} else {
			onThresholdChange(index, value);
		}
	};

	const handleTouchStart = (e: React.TouchEvent) => {
		if (isLocked) return;
		const touch = e.touches[0];
		if (!touch) return;

		isDragging.current = true;
		draggingLine.current = pickNearestLine(touch.clientX);
		applyDragValue(touch.clientX, draggingLine.current);
	};

	const handleTouchMove = (e: React.TouchEvent) => {
		if (!isDragging.current || isLocked) return;
		const touch = e.touches[0];
		if (!touch) return;

		// Prevent the page from scrolling while dragging on the bar.
		e.preventDefault();
		applyDragValue(touch.clientX, draggingLine.current);
	};

	const handleTouchEnd = () => {
		isDragging.current = false;
	};

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const updateSize = () => {
			const rect = container.getBoundingClientRect();
			setDimensions({ width: rect.width, height: rect.height });
		};

		updateSize();
		const observer = new ResizeObserver(updateSize);
		observer.observe(container);

		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || dimensions.width === 0 || dimensions.height === 0) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const isDarkMode = theme === "dark";
		const dpr = window.devicePixelRatio || 1;
		const width = Math.floor(dimensions.width);
		const height = Math.floor(dimensions.height);

		canvas.width = width * dpr;
		canvas.height = height * dpr;
		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;
		ctx.scale(dpr, dpr);
		ctx.imageSmoothingEnabled = false;

		ctx.clearRect(0, 0, width, height);

		// Background
		ctx.fillStyle = isDarkMode ? "#1a1a1a" : "#fafafa";
		ctx.fillRect(0, 0, width, height);

		// Bar fill (horizontal)
		const activeColor = useThresholdColor && value >= threshold ? thresholdColor : color;
		const barWidth = (value / maxSensorVal) * width;
		ctx.fillStyle = activeColor;
		ctx.fillRect(0, 0, barWidth, height);

		// Threshold marker (vertical line) -- Trigger in dual-line mode,
		// the only marker in legacy single-threshold mode.
		const thresholdX = (threshold / maxSensorVal) * width;
		ctx.beginPath();
		ctx.moveTo(thresholdX, 0);
		ctx.lineTo(thresholdX, height);
		ctx.strokeStyle = "rgba(255, 0, 0, 0.9)";
		ctx.lineWidth = 3;
		ctx.stroke();

		// Secondary (Release) marker -- dashed green line, only drawn
		// when dual-line mode is active. Matches the desktop SensorBar
		// styling so the same concept looks consistent across both UIs.
		if (hasDualLine && secondaryThreshold !== undefined) {
			const secondaryX = (secondaryThreshold / maxSensorVal) * width;
			ctx.save();
			ctx.setLineDash([6, 4]);
			ctx.beginPath();
			ctx.moveTo(secondaryX, 0);
			ctx.lineTo(secondaryX, height);
			ctx.strokeStyle = "rgba(34, 197, 94, 0.9)";
			ctx.lineWidth = 3;
			ctx.stroke();
			ctx.restore();
		}

		// Border
		ctx.strokeStyle = isDarkMode ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.15)";
		ctx.lineWidth = 1;
		ctx.strokeRect(0, 0, width, height);
	}, [dimensions, value, threshold, color, thresholdColor, useThresholdColor, theme, hasDualLine, secondaryThreshold]);

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-sm">
			<div className="mb-3 text-sm font-semibold text-foreground">{label}</div>

			{/* Horizontal bar */}
			<div
				ref={containerRef}
				className="h-10 w-full rounded-lg overflow-hidden mb-3 touch-none"
				onTouchStart={handleTouchStart}
				onTouchMove={handleTouchMove}
				onTouchEnd={handleTouchEnd}
				onTouchCancel={handleTouchEnd}
			>
				<canvas ref={canvasRef} className="w-full h-full" />
			</div>

			{/* Value and threshold display */}
			<div className="flex justify-between text-xs text-muted-foreground mb-1 font-mono tabular-nums">
				<span>Value: {value}</span>
				<span className={hasDualLine ? "text-red-500" : ""}>
					{hasDualLine ? "Trigger" : "Threshold"}: {threshold}
				</span>
			</div>
			{hasDualLine && (
				<div className="flex justify-end text-xs text-green-500 mb-3 font-mono tabular-nums">
					<span>Release: {secondaryThreshold}</span>
				</div>
			)}
			{!hasDualLine && <div className="mb-3" />}

			{/* Trigger/Threshold stepper buttons -- red label when in
			    dual-line mode, otherwise unchanged from the original
			    neutral styling. */}
			<div className="flex gap-2">
				<Button
					variant="outline"
					className={`flex-1 h-14 text-lg font-medium active:scale-95 transition-transform ${hasDualLine ? "border-red-500/50 text-red-500" : ""}`}
					onClick={() => handleAdjust(-10)}
					disabled={isLocked || threshold <= 0}
					aria-label={`Decrease ${hasDualLine ? "trigger" : "threshold"} by 10 for ${label}`}
				>
					-10
				</Button>
				<Button
					variant="outline"
					className={`flex-1 h-14 text-lg font-medium active:scale-95 transition-transform ${hasDualLine ? "border-red-500/50 text-red-500" : ""}`}
					onClick={() => handleAdjust(-1)}
					disabled={isLocked || threshold <= 0}
					aria-label={`Decrease ${hasDualLine ? "trigger" : "threshold"} by 1 for ${label}`}
				>
					-1
				</Button>
				<Button
					variant="outline"
					className={`flex-1 h-14 text-lg font-medium active:scale-95 transition-transform ${hasDualLine ? "border-red-500/50 text-red-500" : ""}`}
					onClick={() => handleAdjust(1)}
					disabled={isLocked || threshold >= maxSensorVal}
					aria-label={`Increase ${hasDualLine ? "trigger" : "threshold"} by 1 for ${label}`}
				>
					+1
				</Button>
				<Button
					variant="outline"
					className={`flex-1 h-14 text-lg font-medium active:scale-95 transition-transform ${hasDualLine ? "border-red-500/50 text-red-500" : ""}`}
					onClick={() => handleAdjust(10)}
					disabled={isLocked || threshold >= maxSensorVal}
					aria-label={`Increase ${hasDualLine ? "trigger" : "threshold"} by 10 for ${label}`}
				>
					+10
				</Button>
			</div>

			{/* Release stepper buttons -- only rendered in dual-line mode. */}
			{hasDualLine && (
				<div className="flex gap-2 mt-2">
					<Button
						variant="outline"
						className="flex-1 h-14 text-lg font-medium active:scale-95 transition-transform border-green-500/50 text-green-500"
						onClick={() => handleSecondaryAdjust(-10)}
						disabled={isLocked || (secondaryThreshold ?? 0) <= 0}
						aria-label={`Decrease release by 10 for ${label}`}
					>
						-10
					</Button>
					<Button
						variant="outline"
						className="flex-1 h-14 text-lg font-medium active:scale-95 transition-transform border-green-500/50 text-green-500"
						onClick={() => handleSecondaryAdjust(-1)}
						disabled={isLocked || (secondaryThreshold ?? 0) <= 0}
						aria-label={`Decrease release by 1 for ${label}`}
					>
						-1
					</Button>
					<Button
						variant="outline"
						className="flex-1 h-14 text-lg font-medium active:scale-95 transition-transform border-green-500/50 text-green-500"
						onClick={() => handleSecondaryAdjust(1)}
						disabled={isLocked || (secondaryThreshold ?? 0) >= maxSensorVal}
						aria-label={`Increase release by 1 for ${label}`}
					>
						+1
					</Button>
					<Button
						variant="outline"
						className="flex-1 h-14 text-lg font-medium active:scale-95 transition-transform border-green-500/50 text-green-500"
						onClick={() => handleSecondaryAdjust(10)}
						disabled={isLocked || (secondaryThreshold ?? 0) >= maxSensorVal}
						aria-label={`Increase release by 10 for ${label}`}
					>
						+10
					</Button>
				</div>
			)}
		</div>
	);
};

export default MobileSensorCard;
