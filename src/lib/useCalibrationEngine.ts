import { useCallback, useEffect, useRef, useState } from "react";

// ── FSR Calibration Suggestion Engine ───────────────────────────────────────
//
// Cross-references ITGMania's per-song judgment log (written once per song
// by FSRCalibrationLogger.lua, forwarded here via the Electron IPC bridge)
// against a rolling circular buffer of raw FSR serial readings, to suggest
// Trigger/Release/Gain/Debounce adjustments for specific physical sensors.
//
// CLOCK ALIGNMENT: ITGMania's judgment timestamps are offsets (in seconds)
// from GetTimeSinceStart(), the engine's own internal clock -- which has
// no relationship to wall-clock time on its own. FSRCalibrationLogger.lua
// solves this by also capturing os.time() (true Unix epoch seconds) at
// the EXACT SAME instant as its GetTimeSinceStart() anchor, then writing
// that wall-clock anchor as a "START_TIME: <epoch_ms>" header at the top
// of fsr_match.log. Since our FSR buffer here is timestamped with
// Date.now() (also Unix epoch ms), converting any event's offset back to
// a directly-comparable wall-clock moment is simple, exact arithmetic --
// `anchorMs + offsetSeconds * 1000` -- no drift, no guessing, no
// tolerance window needed for the alignment itself. (A small
// ANALYSIS_WINDOW_MS is still used below, but only to capture the brief
// real-world trough/spike pattern around a hit, not to compensate for
// clock uncertainty.)

// ─────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────

export interface SensorReading {
	timestamp: number; // Date.now() wall-clock ms when this sample arrived
	values: number[];  // raw 0-1023 reading per sensor index, same order as firmware kSensors[]
}

interface JudgmentEvent {
	kind: "TAP" | "HOLD";
	songSeconds: number; // offset in seconds from the log's START_TIME anchor (see parseLogContents)
	track: number;       // 0=Left, 1=Down, 2=Up, 3=Right (or more columns)
	value: string;        // raw TapNoteScore string, or "LetGo"/"Held"/"MissedHold"
}

// Maps a logical TRACK (what ITGMania reports) to the one or more physical
// SENSOR INDEXES (what the firmware/dashboard actually controls) that make
// up that track's button group. This is the piece that's specific to your
// 4-FSR, shared Up/Down layout -- update this if your wiring changes.
//
// Example for your stated layout (2 FSRs shared on Down, 2 shared on Up):
//   track 0 (Left)  -> sensor 0
//   track 1 (Down)  -> sensors 1 and 2
//   track 2 (Up)    -> sensors 3 and 4
//   track 3 (Right) -> sensor 5
//
// Adjust the indices below to match your actual kSensors[]/button_group_
// assignments in fsr_buttongroups.ino and the order sensors report in the
// firmware's "v" data line.
export const TRACK_TO_SENSOR_INDEXES: Record<number, number[]> = {
	0: [0],
	1: [1, 2],
	2: [3, 4],
	3: [5],
};

export interface CalibrationSuggestion {
	id: string;                 // stable key for de-duplication in the UI
	sensorIndex: number;        // which physical sensor this targets
	track: number;              // which logical track it belongs to, for display
	kind: "held-miss" | "stream-miss";
	field: "trigger" | "release" | "releaseDebounceMs";
	currentValue: number;
	suggestedValue: number;
	reason: string;             // human-readable explanation shown in the UI
	occurrences: number;        // how many times this exact suggestion was reinforced this session
}

// ─────────────────────────────────────────────────────────────────────────
// Circular buffer for raw FSR readings
// ─────────────────────────────────────────────────────────────────────────

const BUFFER_DURATION_MS = 5000; // keep the last ~5 seconds, per the spec

class SensorReadingRingBuffer {
	private readings: SensorReading[] = [];

	push(reading: SensorReading) {
		this.readings.push(reading);
		// Trim from the front -- readings arrive in roughly chronological
		// order (each one is a fresh serial sample), so this is O(1)
		// amortized rather than a full filter() on every push, which
		// matters since this runs at the serial port's polling rate
		// (potentially 60-100+ times/sec).
		const cutoff = reading.timestamp - BUFFER_DURATION_MS;
		while (this.readings.length > 0 && this.readings[0].timestamp < cutoff) {
			this.readings.shift();
		}
	}

	// Returns all readings within [centerMs - windowMs, centerMs + windowMs].
	getWindow(centerMs: number, windowMs: number): SensorReading[] {
		const lo = centerMs - windowMs;
		const hi = centerMs + windowMs;
		// Buffer is at most a few hundred entries for 5 seconds at typical
		// polling rates, so a linear scan here is cheap and avoids the
		// complexity of a binary search for a buffer this small.
		return this.readings.filter((r) => r.timestamp >= lo && r.timestamp <= hi);
	}

	getAll(): SensorReading[] {
		return this.readings;
	}

	clear() {
		this.readings = [];
	}
}

// ─────────────────────────────────────────────────────────────────────────
// Log parsing
// ─────────────────────────────────────────────────────────────────────────

// Parses the raw fsr_match.log contents into a wall-clock anchor plus
// structured JudgmentEvent objects. Expected format (written by
// FSRCalibrationLogger.lua):
//
//   START_TIME: <epoch_ms>          <- first line, the precise anchor
//   TAP|<offset_seconds>|<track>|<tns>
//   HOLD|<offset_seconds>|<track>|<result>
//
// The anchor is captured in Lua at the SAME instant as the engine clock
// used for every event's offset, so converting an event's offset back
// to real wall-clock time is just `anchorMs + offsetSeconds * 1000` --
// no drift, no guessing (see the big comment at the top of this file
// for why earlier approaches needed a tolerance window for this).
//
// Tolerates blank lines and malformed lines by skipping them rather than
// throwing, since a single corrupted line shouldn't break analysis of
// the rest of the song's data. If START_TIME is missing entirely (e.g.
// an old log written before this anchor system existed, or a malformed
// write), returns anchorMs: null -- callers should skip analysis for
// that log rather than guessing, since a wrong guess is worse than no
// suggestion at all.
function parseLogContents(contents: string): { anchorMs: number | null; events: JudgmentEvent[] } {
	const events: JudgmentEvent[] = [];
	let anchorMs: number | null = null;
	const lines = contents.split("\n");

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0) continue;

		if (line.startsWith("START_TIME:")) {
			const parsed = Number.parseInt(line.slice("START_TIME:".length).trim(), 10);
			if (!Number.isNaN(parsed)) anchorMs = parsed;
			continue;
		}

		const parts = line.split("|");
		if (parts.length !== 4) continue;

		const [kindStr, secondsStr, trackStr, value] = parts;
		if (kindStr !== "TAP" && kindStr !== "HOLD") continue;

		const songSeconds = Number.parseFloat(secondsStr);
		const track = Number.parseInt(trackStr, 10);
		if (Number.isNaN(songSeconds) || Number.isNaN(track)) continue;

		events.push({ kind: kindStr, songSeconds, track, value });
	}

	return { anchorMs, events };
}

// ─────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────

// Tolerance window (ms) for finding the relevant slice of the FSR
// buffer around a judgment's now-PRECISE wall-clock moment (computed
// directly from the log's START_TIME anchor -- see parseLogContents).
// This is no longer compensating for clock drift/guesswork; it's just a
// small analysis window to capture the actual trough/spike pattern
// around the hit (foot lift/press takes a small but nonzero number of
// milliseconds), tight enough to stay specific to the actual miss rather
// than picking up unrelated nearby presses on a dense stream.
const ANALYSIS_WINDOW_MS = 150;

interface SensorTuningSnapshot {
	trigger: number;
	release: number;
	releaseDebounceMs: number;
}

// Analyzes ONE judgment event against the FSR buffer, for ONE candidate
// physical sensor (a track can map to multiple sensors when they share a
// button group -- see TRACK_TO_SENSOR_INDEXES -- so this gets called once
// per sensor in that group, and the caller decides which sensor's result
// is most relevant).
function analyzeEventForSensor(
	event: JudgmentEvent,
	sensorIndex: number,
	buffer: SensorReadingRingBuffer,
	logAnchorMs: number,
	tuning: SensorTuningSnapshot,
): CalibrationSuggestion | null {
	const approxWallClockMs = logAnchorMs + event.songSeconds * 1000;
	const window = buffer.getWindow(approxWallClockMs, ANALYSIS_WINDOW_MS);
	if (window.length === 0) return null;

	const valuesForSensor = window
		.map((r) => r.values[sensorIndex])
		.filter((v): v is number => typeof v === "number");
	if (valuesForSensor.length === 0) return null;

	const minValue = Math.min(...valuesForSensor);
	const maxValue = Math.max(...valuesForSensor);

	if (event.kind === "HOLD" && event.value === "LetGo") {
		// HELD MISS: the hold was dropped. If the trough during this window
		// dipped only slightly below the Release line (not all the way to
		// near-zero), that's consistent with brief pressure noise crossing
		// the debounce-protected Release threshold rather than a genuine
		// foot-lift -- suggesting either the Release threshold is sitting
		// too close to normal resting pressure, or the debounce window is
		// too short to absorb that specific dip.
		if (minValue < tuning.release) {
			const dipDepth = tuning.release - minValue;
			const isShallowDip = dipDepth < tuning.release * 0.25; // dipped <25% of the way to zero relative to the release line

			if (isShallowDip) {
				// Shallow, brief dip -- debounce is the more targeted fix,
				// since lowering Release further would reduce sensitivity
				// for genuine taps too.
				return {
					id: `held-miss-debounce-${sensorIndex}`,
					sensorIndex,
					track: event.track,
					kind: "held-miss",
					field: "releaseDebounceMs",
					currentValue: tuning.releaseDebounceMs,
					suggestedValue: Math.min(100, tuning.releaseDebounceMs + 10),
					reason: `Hold dropped on a brief, shallow pressure dip (down to ${minValue}, Release is ${tuning.release}). Likely resting-pressure noise -- try increasing Release Debounce.`,
					occurrences: 1,
				};
			}

			// Deeper dip -- more consistent with an intentional partial
			// lift that just barely crossed the line. Lowering Release
			// gives more headroom before that counts as a release.
			return {
				id: `held-miss-release-${sensorIndex}`,
				sensorIndex,
				track: event.track,
				kind: "held-miss",
				field: "release",
				currentValue: tuning.release,
				suggestedValue: Math.max(0, tuning.release - 50),
				reason: `Hold dropped, pressure dipped to ${minValue} (Release is ${tuning.release}). Try lowering Release so brief partial lifts don't count as a full release.`,
				occurrences: 1,
			};
		}
	}

	if (event.kind === "TAP" && event.value === "TapNoteScore_Miss") {
		// STREAM/JACK MISS: the tap was missed. If the value never actually
		// dropped below the Release threshold before this miss, that's
		// consistent with the player not fully lifting their foot between
		// two fast hits on the SAME panel -- the sensor never re-armed
		// because it never crossed back below Release. Raising Release
		// makes it easier to re-arm with a smaller lift.
		if (minValue >= tuning.release && minValue < tuning.trigger) {
			return {
				id: `stream-miss-release-${sensorIndex}`,
				sensorIndex,
				track: event.track,
				kind: "stream-miss",
				field: "release",
				currentValue: tuning.release,
				suggestedValue: Math.min(tuning.trigger - 50, tuning.release + 50),
				reason: `Missed tap -- pressure only dropped to ${minValue} without crossing back below Release (${tuning.release}) before the next hit. Try raising Release so a smaller foot-lift re-arms the sensor.`,
				occurrences: 1,
			};
		}
	}

	return null;
}

// Merges newly-found suggestions into the existing list, combining exact
// duplicates (same sensor + field + kind) by incrementing occurrences and
// averaging the suggested value, so repeated instances of the same issue
// across a song reinforce one suggestion rather than spamming the UI with
// near-identical entries.
function mergeSuggestions(
	existing: CalibrationSuggestion[],
	fresh: CalibrationSuggestion[],
): CalibrationSuggestion[] {
	const merged = [...existing];

	for (const suggestion of fresh) {
		const matchIndex = merged.findIndex((s) => s.id === suggestion.id);
		if (matchIndex === -1) {
			merged.push(suggestion);
		} else {
			const existingSugg = merged[matchIndex];
			merged[matchIndex] = {
				...existingSugg,
				occurrences: existingSugg.occurrences + 1,
				// Average the suggested value across occurrences so a couple
				// of outlier samples don't swing the recommendation wildly.
				suggestedValue: Math.round(
					(existingSugg.suggestedValue * existingSugg.occurrences + suggestion.suggestedValue) /
						(existingSugg.occurrences + 1),
				),
			};
		}
	}

	return merged;
}

// ─────────────────────────────────────────────────────────────────────────
// Public hook
// ─────────────────────────────────────────────────────────────────────────

export interface UseCalibrationEngineOptions {
	// Called every time new serial values arrive -- wire this into the
	// SAME callback dashboard.tsx already passes to useSerialPort, so the
	// circular buffer fills continuously during play with zero additional
	// serial traffic.
	getCurrentTuningForSensor: (sensorIndex: number) => SensorTuningSnapshot;
}

// Plain-language status for the calibration pipeline, shown directly in
// the webfsr UI so a non-technical user (or their spouse/teammate) can
// tell what's happening without ever needing to check a terminal or log
// file. Each stage is tracked independently so the UI can say exactly
// where things stand, e.g. "Waiting for your first song" vs "No misses
// found yet" vs "3 suggestions ready".
export type CalibrationPipelineStage =
	| "not_in_app"        // running in plain browser webfsr, bridge unavailable
	| "waiting_for_song"  // bridge available, no song log received yet
	| "no_anchor"         // log received but missing/invalid START_TIME
	| "no_misses"         // log analyzed successfully, but nothing to suggest
	| "has_suggestions";  // log analyzed, at least one suggestion produced

export interface CalibrationStatus {
	stage: CalibrationPipelineStage;
	lastLogReceivedAt: number | null;
	lastEventCount: number;
	lastMissCount: number;
}

export function useCalibrationEngine({ getCurrentTuningForSensor }: UseCalibrationEngineOptions) {
	const bufferRef = useRef(new SensorReadingRingBuffer());
	const [suggestions, setSuggestions] = useState<CalibrationSuggestion[]>([]);
	const [lastAnalyzedAt, setLastAnalyzedAt] = useState<number | null>(null);
	const [status, setStatus] = useState<CalibrationStatus>({
		stage: "not_in_app",
		lastLogReceivedAt: null,
		lastEventCount: 0,
		lastMissCount: 0,
	});

	// Call this from the same per-reading callback used for the live
	// sensor bars/ITGMania overlay bridge -- adds the reading to the
	// rolling buffer. Cheap (array push + occasional shift), safe to call
	// at full polling rate.
	const recordReading = useCallback((values: number[]) => {
		bufferRef.current.push({ timestamp: Date.now(), values });
	}, []);

	// Processes one fsr_match.log payload (called from the Electron IPC
	// listener below). Reads the log's own START_TIME anchor (captured in
	// Lua at the exact same instant as the engine clock used for every
	// event offset -- see FSRCalibrationLogger.lua), then analyzes each
	// tap-miss/held-miss against the buffer for every physical sensor in
	// that track's button group, merging any findings into `suggestions`.
	const analyzeLogContents = useCallback(
		(contents: string) => {
			const { anchorMs, events } = parseLogContents(contents);
			const now = Date.now();

			if (anchorMs === null) {
				// Log has no START_TIME header -- either an old log from
				// before this anchor system existed, or a malformed write.
				// Skip analysis entirely rather than guessing at alignment;
				// a wrong guess produces misleading suggestions, which is
				// worse than producing none for this song.
				setLastAnalyzedAt(now);
				setStatus((prev) => ({ ...prev, stage: "no_anchor", lastLogReceivedAt: now, lastEventCount: events.length }));
				return;
			}

			const fresh: CalibrationSuggestion[] = [];
			let missCount = 0;

			for (const event of events) {
				const isRelevant =
					(event.kind === "HOLD" && event.value === "LetGo") ||
					(event.kind === "TAP" && event.value === "TapNoteScore_Miss");
				if (!isRelevant) continue;
				missCount++;

				const sensorIndexes = TRACK_TO_SENSOR_INDEXES[event.track] ?? [];
				for (const sensorIndex of sensorIndexes) {
					const tuning = getCurrentTuningForSensor(sensorIndex);
					const result = analyzeEventForSensor(
						event,
						sensorIndex,
						bufferRef.current,
						anchorMs,
						tuning,
					);
					if (result) fresh.push(result);
				}
			}

			if (fresh.length > 0) {
				setSuggestions((prev) => mergeSuggestions(prev, fresh));
			}
			setLastAnalyzedAt(now);
			setStatus({
				stage: fresh.length > 0 ? "has_suggestions" : "no_misses",
				lastLogReceivedAt: now,
				lastEventCount: events.length,
				lastMissCount: missCount,
			});
		},
		[getCurrentTuningForSensor],
	);

	// Subscribe to the Electron IPC bridge (see preload.cjs /
	// fsr_calibration_watcher.cjs) -- fires once per song, right after
	// FSRCalibrationLogger.lua writes fsr_match.log at the Evaluation
	// transition.
	useEffect(() => {
		const bridge = (window as unknown as {
			fsrCalibrationBridge?: { onLogUpdated: (cb: (data: { contents: string; timestamp: number }) => void) => () => void };
		}).fsrCalibrationBridge;

		if (!bridge) {
			// Not running inside the Electron app (e.g. plain browser
			// webfsr) -- calibration engine simply has nothing to listen
			// to. Not an error, just inactive. Status stays "not_in_app"
			// (its initial value) so the UI can explain this plainly.
			return;
		}

		// Bridge exists -- we're inside the Electron app and the watcher
		// is live, just hasn't seen a song yet.
		setStatus((prev) => (prev.stage === "not_in_app" ? { ...prev, stage: "waiting_for_song" } : prev));

		const unsubscribe = bridge.onLogUpdated((data) => {
			analyzeLogContents(data.contents);
		});

		return unsubscribe;
	}, [analyzeLogContents]);

	const dismissSuggestion = useCallback((id: string) => {
		setSuggestions((prev) => prev.filter((s) => s.id !== id));
	}, []);

	const clearAllSuggestions = useCallback(() => {
		setSuggestions([]);
	}, []);

	return {
		recordReading,
		suggestions,
		dismissSuggestion,
		clearAllSuggestions,
		lastAnalyzedAt,
		status,
		// Exposed mainly for debugging/testing -- lets you inspect what's
		// actually in the buffer without needing to add temporary logging.
		getBufferSnapshot: () => bufferRef.current.getAll(),
	};
}
