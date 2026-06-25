import { Minus, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

// Maximum value possible from sensors
const maxSensorVal = 1023;

interface SensorBarProps {
	value: number;
	index: number;
	maxValue?: number;
	threshold: number;
	onThresholdChange: (index: number, value: number) => void;
	label: string;
	color: string;
	showThresholdText: boolean;
	showValueText: boolean;
	thresholdColor: string;
	useThresholdColor: boolean;
	useGradient: boolean;
	isLocked?: boolean;
	hideLabel?: boolean;
	hideControls?: boolean;
	backgroundColor?: string;
	labelColor?: string;
	labelTextSize?: number;
	labelTextColor?: string;
	thresholdTextSize?: number;
	thresholdTextColor?: string;
	valueTextSize?: number;
	valueTextColor?: string;
	theme?: "light" | "dark";
	// Optional second threshold line, used to show the Release (OFF)
	// value alongside the main Trigger (ON) line when Advanced Sensor
	// Tuning mode is active. Entirely optional -- omitting it (the
	// default/casual-mode case) draws exactly as before, single line.
	secondaryThreshold?: number;
	secondaryThresholdLabel?: string;
	secondaryThresholdColor?: string;
	// When provided alongside secondaryThreshold, the bar becomes
	// draggable for BOTH lines: a click/drag grabs whichever line
	// (Trigger or Release) is closer to the pointer at mousedown time.
	// Without this, the bar only ever drags the primary `threshold`
	// (the original single-line behavior), even if secondaryThreshold
	// is being displayed for reference.
	onSecondaryThresholdChange?: (index: number, value: number) => void;
}

// Component for individual sensor bar
const SensorBar = ({
	value,
	index,
	maxValue = maxSensorVal,
	threshold,
	onThresholdChange,
	label,
	color,
	showThresholdText,
	showValueText,
	thresholdColor,
	useThresholdColor,
	useGradient,
	isLocked = false,
	hideLabel = false,
	hideControls = false,
	backgroundColor,
	labelColor = "inherit",
	labelTextSize = 12,
	labelTextColor,
	thresholdTextSize = 11,
	thresholdTextColor,
	valueTextSize = 12,
	valueTextColor,
	theme,
	secondaryThreshold,
	secondaryThresholdLabel = "Release",
	secondaryThresholdColor = "rgba(0, 200, 120, 0.9)",
	onSecondaryThresholdChange,
}: SensorBarProps) => {
	const isDarkMode = theme === "dark";
	const defaultBgColor = backgroundColor || (isDarkMode ? "#171717" : "white");
	const resolvedLabelColor = labelTextColor ?? labelColor;
	const resolvedThresholdTextColor = thresholdTextColor ?? (isDarkMode ? "white" : "black");
	const resolvedValueTextColor = valueTextColor ?? (isDarkMode ? "white" : "black");
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const isDragging = useRef<boolean>(false);
	// Which line is currently being dragged -- only meaningful when
	// onSecondaryThresholdChange is provided (dual-line mode). "primary"
	// is the original `threshold` (Trigger), "secondary" is
	// `secondaryThreshold` (Release).
	const draggingLine = useRef<"primary" | "secondary">("primary");
	const [inputValue, setInputValue] = useState<string>(threshold.toString());
	const [dimensions, setDimensions] = useState<{ width: number; height: number }>({
		width: 0,
		height: 0,
	});

	const yToValue = (y: number): number | null => {
		const canvas = canvasRef.current;
		if (!canvas) return null;

		const rect = canvas.getBoundingClientRect();
		const height = rect.height;

		const raw = Math.round(maxValue * (1 - (y - rect.top) / height));
		return Math.max(0, Math.min(maxValue, raw));
	};

	const updateThreshold = (y: number) => {
		if (isLocked) return;

		const clampedValue = yToValue(y);
		if (clampedValue === null) return;

		onThresholdChange(index, clampedValue);
	};

	// Decides which line (primary/Trigger or secondary/Release) a
	// mousedown at the given Y position should grab -- whichever line's
	// pixel position is closer to the click point. Only relevant when
	// dual-line dragging is active (onSecondaryThresholdChange provided
	// and secondaryThreshold has an actual value).
	const pickNearestLine = (y: number): "primary" | "secondary" => {
		if (secondaryThreshold === undefined || !onSecondaryThresholdChange) return "primary";

		const canvas = canvasRef.current;
		if (!canvas) return "primary";

		const rect = canvas.getBoundingClientRect();
		const height = rect.height;

		const primaryY = rect.top + height - (threshold / maxValue) * height;
		const secondaryY = rect.top + height - (secondaryThreshold / maxValue) * height;

		return Math.abs(y - secondaryY) < Math.abs(y - primaryY) ? "secondary" : "primary";
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		if (isLocked) return;

		isDragging.current = true;
		draggingLine.current = pickNearestLine(e.clientY);

		if (draggingLine.current === "secondary" && onSecondaryThresholdChange) {
			const v = yToValue(e.clientY);
			if (v !== null) onSecondaryThresholdChange(index, v);
		} else {
			updateThreshold(e.clientY);
		}
	};

	const handleMouseMove = (e: React.MouseEvent) => {
		if (!isDragging.current) return;

		if (draggingLine.current === "secondary" && onSecondaryThresholdChange) {
			const v = yToValue(e.clientY);
			if (v !== null) onSecondaryThresholdChange(index, v);
		} else {
			updateThreshold(e.clientY);
		}
	};

	// Update input value when threshold changes
	useEffect(() => {
		setInputValue(threshold.toString());
	}, [threshold]);

	// Mirrors inputValue above, but for the secondary (Release) line --
	// only meaningful when secondaryThreshold/onSecondaryThresholdChange
	// are provided.
	const [secondaryInputValue, setSecondaryInputValue] = useState<string>(
		secondaryThreshold !== undefined ? secondaryThreshold.toString() : "",
	);
	useEffect(() => {
		if (secondaryThreshold !== undefined) {
			setSecondaryInputValue(secondaryThreshold.toString());
		}
	}, [secondaryThreshold]);

	const validateAndUpdateThreshold = () => {
		if (isLocked) return;

		const newValue = Number.parseInt(inputValue, 10);
		if (!Number.isNaN(newValue) && newValue >= 0 && newValue <= maxValue) {
			onThresholdChange(index, newValue);
		} else {
			// Reset input to current threshold if invalid
			setInputValue(threshold.toString());
		}
	};

	const validateAndUpdateSecondaryThreshold = () => {
		if (isLocked || !onSecondaryThresholdChange) return;

		const newValue = Number.parseInt(secondaryInputValue, 10);
		if (!Number.isNaN(newValue) && newValue >= 0 && newValue <= maxValue) {
			onSecondaryThresholdChange(index, newValue);
		} else if (secondaryThreshold !== undefined) {
			setSecondaryInputValue(secondaryThreshold.toString());
		}
	};

	const handleIncrement = () => {
		if (isLocked) return;
		const newValue = Math.min(threshold + 1, maxValue);
		onThresholdChange(index, newValue);
	};

	const handleDecrement = () => {
		if (isLocked) return;
		const newValue = Math.max(threshold - 1, 0);
		onThresholdChange(index, newValue);
	};

	const handleSecondaryIncrement = () => {
		if (isLocked || !onSecondaryThresholdChange || secondaryThreshold === undefined) return;
		onSecondaryThresholdChange(index, Math.min(secondaryThreshold + 1, maxValue));
	};

	const handleSecondaryDecrement = () => {
		if (isLocked || !onSecondaryThresholdChange || secondaryThreshold === undefined) return;
		onSecondaryThresholdChange(index, Math.max(secondaryThreshold - 1, 0));
	};

	useEffect(() => {
		const onMouseMove = (e: MouseEvent) => {
			if (!isDragging.current) return;
			if (draggingLine.current === "secondary" && onSecondaryThresholdChange) {
				const v = yToValue(e.clientY);
				if (v !== null) onSecondaryThresholdChange(index, v);
			} else {
				updateThreshold(e.clientY);
			}
		};

		const onMouseUp = () => {
			isDragging.current = false;
		};

		// Add global event listeners to track mouse movements outside the component
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);

		return () => {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseup", onMouseUp);
		};
	}, [updateThreshold, onSecondaryThresholdChange, secondaryThreshold, threshold]);

	// Set up the resize observer to detect container size changes
	useEffect(() => {
		const canvasContainer = containerRef.current?.querySelector(".canvas-container");
		if (!canvasContainer) return;

		// Function to handle resize
		const updateCanvasSize = () => {
			const rect = canvasContainer.getBoundingClientRect();
			setDimensions({
				width: rect.width,
				height: rect.height,
			});
		};

		// Initial size calculation
		updateCanvasSize();

		// Create resize observer
		const resizeObserver = new ResizeObserver(updateCanvasSize);
		resizeObserver.observe(canvasContainer);

		return () => {
			resizeObserver.disconnect();
		};
	}, []);

	// Draw the canvas when dimensions, value, or threshold changes
	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || dimensions.width === 0 || dimensions.height === 0) return;

		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const isDarkMode = theme === "dark";

		// Manage pixel ratio
		const dpr = window.devicePixelRatio || 1;
		const width = Math.floor(dimensions.width);
		const height = Math.floor(dimensions.height);

		// Set canvas dimensions with pixel ratio
		canvas.width = width * dpr;
		canvas.height = height * dpr;

		canvas.style.width = `${width}px`;
		canvas.style.height = `${height}px`;

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		ctx.imageSmoothingEnabled = false;

		ctx.clearRect(0, 0, width, height);

		// Use threshold color if enabled and value meets or exceeds threshold
		const activeColor = useThresholdColor && value >= threshold ? thresholdColor : color;

		// Draw bar
		const barHeight = (value / maxValue) * height;

		if (useGradient) {
			const grad = ctx.createLinearGradient(0, 0, 0, height);
			// Support both hex and rgba input colors
			const parseColor = (c: string): { r: number; g: number; b: number; a: number } => {
				if (c.startsWith("rgba")) {
					const m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
					if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] ? Number(m[4]) : 1 };
				}
				if (c.startsWith("#")) {
					const r = Number.parseInt(c.slice(1, 3), 16);
					const g = Number.parseInt(c.slice(3, 5), 16);
					const b = Number.parseInt(c.slice(5, 7), 16);
					return { r, g, b, a: 1 };
				}
				return { r: 0, g: 0, b: 0, a: 1 };
			};

			const { r, g, b, a } = parseColor(activeColor);
			grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, ${a})`);
			grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${Math.max(0, Math.min(1, a * 0.3))})`);
			ctx.fillStyle = grad;
		} else {
			ctx.fillStyle = activeColor;
		}

		ctx.fillRect(0, height - barHeight, width, barHeight);

		// Draw threshold line (Trigger / ON in Advanced mode, or the
		// single legacy threshold in casual mode)
		const thresholdY = Math.round(height - (threshold / maxValue) * height);
		ctx.beginPath();
		ctx.moveTo(0, thresholdY);
		ctx.lineTo(width, thresholdY);
		ctx.strokeStyle = "rgba(255, 0, 0, 0.8)";
		ctx.lineWidth = 2;
		ctx.stroke();

		// Draw secondary (Release / OFF) threshold line if provided. Dashed
		// so it's visually distinct from the solid Trigger line even at a
		// glance, and drawn in a different color (green by default) to
		// match the Release slider's color in the Sensor Tuning panel.
		let secondaryThresholdY: number | null = null;
		if (secondaryThreshold !== undefined) {
			secondaryThresholdY = Math.round(height - (secondaryThreshold / maxValue) * height);
			ctx.beginPath();
			ctx.setLineDash([5, 4]);
			ctx.moveTo(0, secondaryThresholdY);
			ctx.lineTo(width, secondaryThresholdY);
			ctx.strokeStyle = secondaryThresholdColor;
			ctx.lineWidth = 2;
			ctx.stroke();
			ctx.setLineDash([]); // reset so it doesn't leak into other strokes
		}

		// Draw border
		ctx.strokeStyle = isDarkMode ? "rgba(255, 255, 255, 0.2)" : "rgba(0, 0, 0, 0.2)";
		ctx.lineWidth = 1;
		ctx.strokeRect(0, 0, width, height);

		// Draw value text
		if (showValueText) {
			ctx.fillStyle = resolvedValueTextColor;
			ctx.font = `${valueTextSize}px sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "top";

			// Position text at integer coordinates
			const valueTextX = Math.floor(width / 2);
			const valueTextY = 4;

			ctx.fillText(value.toString(), valueTextX, valueTextY);
		}

		// Draw threshold value text
		if (showThresholdText) {
			ctx.fillStyle = resolvedThresholdTextColor;
			ctx.font = `${thresholdTextSize}px sans-serif`;
			ctx.textAlign = "center";
			ctx.textBaseline = "bottom";

			// Position text at integer coordinates
			const thresholdTextX = Math.floor(width / 2);
			const thresholdTextY = thresholdY - 2;

			ctx.fillText(`${threshold}`, thresholdTextX, thresholdTextY);
		}

		// Draw secondary threshold value text + label, positioned to avoid
		// overlapping the main threshold text when the two lines are close
		// together (a common case right when someone starts narrowing the
		// gap back down).
		if (showThresholdText && secondaryThresholdY !== null && secondaryThreshold !== undefined) {
			const labelsCollide = Math.abs(secondaryThresholdY - thresholdY) < thresholdTextSize + 4;
			ctx.fillStyle = secondaryThresholdColor;
			ctx.font = `${thresholdTextSize}px sans-serif`;
			ctx.textAlign = "center";
			// If close to the main line, push the label to the opposite
			// side (top vs bottom) of its own line so the two labels don't
			// stack directly on top of each other.
			ctx.textBaseline = labelsCollide
				? (secondaryThresholdY > thresholdY ? "top" : "bottom")
				: "bottom";
			const secondaryTextX = Math.floor(width / 2);
			const secondaryTextY = labelsCollide
				? secondaryThresholdY + (secondaryThresholdY > thresholdY ? 2 : -2)
				: secondaryThresholdY - 2;
			ctx.fillText(`${secondaryThresholdLabel}: ${secondaryThreshold}`, secondaryTextX, secondaryTextY);
		}
	}, [
		dimensions,
		value,
		maxValue,
		threshold,
		color,
		showThresholdText,
		showValueText,
		thresholdColor,
		thresholdTextSize,
		resolvedThresholdTextColor,
		useThresholdColor,
		useGradient,
		theme,
		valueTextSize,
		resolvedValueTextColor,
		secondaryThreshold,
		secondaryThresholdLabel,
		secondaryThresholdColor,
	]);

	return (
		<div className="flex flex-col items-center select-none h-full px-4" ref={containerRef}>
			{!hideLabel && (
				<div
					className="font-medium mb-1 text-center leading-tight"
					style={{ color: resolvedLabelColor, fontSize: `${labelTextSize}px` }}
				>
					{label}
				</div>
			)}
			{/*
			  FIX: removed the hardcoded `min-h-[200px]` that used to be on this
			  container. That min-height had nothing to do with how much space
			  the parent grid actually allocates per sensor bar -- it was a
			  fixed floor that could fight the parent's height, especially
			  during the brief remount/measure gap when sensor count changes
			  live (e.g. clicking "+ Add FSR sensor"). Before the
			  ResizeObserver below has fired with real dimensions, this div
			  would fall back to its min-height, visually overlapping
			  whatever sits below the sensor bar row in the page layout.
			  `flex-1` alone is enough to fill the available space correctly
			  once the parent's height is established.
			*/}
			<div className={`relative flex-1 w-full flex flex-col ${!hideControls ? "mb-2" : ""} canvas-container`}>
				<canvas
					ref={canvasRef}
					className={`border border-border rounded w-full h-full ${isLocked ? "cursor-not-allowed" : "cursor-pointer"}`}
					style={{ backgroundColor: defaultBgColor }}
					aria-label={label}
					onMouseDown={handleMouseDown}
					onMouseMove={handleMouseMove}
				/>
			</div>
			{!hideControls && (
				<div className="flex items-center gap-1.5 w-full justify-center">
					{/* Trigger (primary) controls -- colored red to match
					    the solid red line on the bar when dual-line mode
					    is active (secondaryThreshold provided). In casual
					    single-line mode this just looks like the original
					    neutral control row. */}
					<div className="flex items-center gap-0.5">
						<Button
							variant="link"
							size="icon"
							className="size-6 shrink-0 p-0 hover:cursor-pointer"
							onClick={handleDecrement}
							disabled={isLocked}
							aria-label="Decrease threshold"
						>
							<Minus className={`size-3 ${secondaryThreshold !== undefined ? "text-red-500" : ""}`} />
						</Button>
						<Input
							type="text"
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							onBlur={() => validateAndUpdateThreshold()}
							onKeyDown={(e) => {
								if (e.key === "Enter") validateAndUpdateThreshold();
							}}
							disabled={isLocked}
							className={`h-6 text-xs text-center px-0.5 w-12 min-w-12 shadow-none rounded-sm ${secondaryThreshold !== undefined ? "border-red-500/60 text-red-500 focus-visible:ring-red-500/40" : ""}`}
							aria-label={`Trigger threshold value for ${label}`}
							title="Trigger (ON)"
						/>
						<Button
							variant="link"
							size="icon"
							className="size-6 shrink-0 p-0 hover:cursor-pointer"
							onClick={handleIncrement}
							disabled={isLocked}
							aria-label="Increase threshold"
						>
							<Plus className={`size-3 ${secondaryThreshold !== undefined ? "text-red-500" : ""}`} />
						</Button>
					</div>

					{/* Release (secondary) controls -- only rendered when
					    dual-line mode is active. Colored green to match
					    the dashed green Release line on the bar. */}
					{secondaryThreshold !== undefined && onSecondaryThresholdChange && (
						<div className="flex items-center gap-0.5">
							<Button
								variant="link"
								size="icon"
								className="size-6 shrink-0 p-0 hover:cursor-pointer"
								onClick={handleSecondaryDecrement}
								disabled={isLocked}
								aria-label="Decrease release threshold"
							>
								<Minus className="size-3 text-green-500" />
							</Button>
							<Input
								type="text"
								value={secondaryInputValue}
								onChange={(e) => setSecondaryInputValue(e.target.value)}
								onBlur={() => validateAndUpdateSecondaryThreshold()}
								onKeyDown={(e) => {
									if (e.key === "Enter") validateAndUpdateSecondaryThreshold();
								}}
								disabled={isLocked}
								className="h-6 text-xs text-center px-0.5 w-12 min-w-12 shadow-none rounded-sm border-green-500/60 text-green-500 focus-visible:ring-green-500/40"
								aria-label={`Release threshold value for ${label}`}
								title="Release (OFF)"
							/>
							<Button
								variant="link"
								size="icon"
								className="size-6 shrink-0 p-0 hover:cursor-pointer"
								onClick={handleSecondaryIncrement}
								disabled={isLocked}
								aria-label="Increase release threshold"
							>
								<Plus className="size-3 text-green-500" />
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

export default SensorBar;
export { maxSensorVal };
