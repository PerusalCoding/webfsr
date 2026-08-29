import { useState, useEffect, useCallback, useRef } from "react";
import { estimateCalories, type Biometrics } from "./calorieEstimate";

export interface SongLogEntry {
	title: string;
	artist: string;
	pack: string;
	difficulty: number;
	difficultyName: string; // e.g. "Challenge" (raw ToEnumShortString output)
	style: string; // e.g. "single" / "double"
	score: string; // percent dance points, e.g. "91.77"
	grade: string; // raw ToEnumShortString output, e.g. "Tier02"
	bannerPath: string; // StepMania virtual path, resolve via mediaBaseUrl
	startTime: number; // epoch seconds
	endTime: number; // epoch seconds
	passed: boolean;
	// Present only if SongHRLog.lua successfully published this play
	// directly to Supabase (ArrowCloud-style, works without the desktop
	// app open) -- when set, usePublishSongs merges HR/calories into that
	// same row via UPDATE instead of inserting a duplicate.
	supabaseId?: string;
}

export interface HeartrateSample {
	heartrate: number;
	timestamp: number; // epoch ms
}

export interface SongWithStats extends SongLogEntry {
	avgHr: number | null;
	maxHr: number | null;
	calories: number | null;
	durationSeconds: number;
}

// Shared by the local (Electron) song list and the Supabase publish
// pipeline -- both need the same avg/max HR + calorie numbers per song.
export function computeSongStats(
	song: SongLogEntry,
	hrSamples: HeartrateSample[],
	biometrics: Biometrics,
): SongWithStats {
	const startMs = song.startTime * 1000;
	const endMs = song.endTime * 1000;
	const samplesInRange = hrSamples.filter((s) => s.timestamp >= startMs && s.timestamp <= endMs);
	const durationSeconds = Math.max(0, song.endTime - song.startTime);

	if (samplesInRange.length === 0) {
		return { ...song, avgHr: null, maxHr: null, calories: null, durationSeconds };
	}

	const sum = samplesInRange.reduce((acc, s) => acc + s.heartrate, 0);
	const avgHr = Math.round(sum / samplesInRange.length);
	const maxHr = Math.max(...samplesInRange.map((s) => s.heartrate));
	const calories = estimateCalories(avgHr, durationSeconds, biometrics);

	return { ...song, avgHr, maxHr, calories, durationSeconds };
}

// Minimal shape of what preload.cjs needs to expose for this feature.
// Add this alongside the existing electronAPI/itgManiaBridge globals.
interface SongHistoryBridge {
	selectFolder: () => Promise<{ path: string | null; entries: SongLogEntry[] }>;
	getFolder: () => Promise<string | null>;
	selectInstallFolder: () => Promise<string | null>;
	getInstallFolder: () => Promise<string | null>;
	getAllSongs: () => Promise<SongLogEntry[]>;
	deleteEntries: (startTimes: number[]) => Promise<SongLogEntry[]>;
	onSongLogUpdate: (callback: (entries: SongLogEntry[]) => void) => () => void;
	sendHeartrateSample: (sample: HeartrateSample) => void;
	savePublishConfig: (config: { playerName: string; publishEnabled: boolean; liveFeedEnabled: boolean }) => void;
	getAllHeartrateSamples: () => Promise<HeartrateSample[]>;
	getMediaBaseUrl: () => Promise<string>;
}

declare global {
	interface Window {
		songHistoryBridge?: SongHistoryBridge;
	}
}

export function useSongHistory() {
	const [songs, setSongs] = useState<SongLogEntry[]>([]);
	const [hrSamples, setHrSamples] = useState<HeartrateSample[]>([]);
	const [folder, setFolder] = useState<string | null>(null);
	const [installFolder, setInstallFolder] = useState<string | null>(null);
	const [mediaBaseUrl, setMediaBaseUrl] = useState<string | null>(null);
	const [isSupported] = useState(() => typeof window !== "undefined" && !!window.songHistoryBridge);
	const lastSampleAtRef = useRef<number>(0);

	useEffect(() => {
		const bridge = window.songHistoryBridge;
		if (!bridge) return;

		let cancelled = false;

		(async () => {
			const [savedFolder, savedInstallFolder, initialSongs, initialSamples, baseUrl] = await Promise.all([
				bridge.getFolder(),
				bridge.getInstallFolder(),
				bridge.getAllSongs(),
				bridge.getAllHeartrateSamples(),
				bridge.getMediaBaseUrl(),
			]);
			if (cancelled) return;
			setFolder(savedFolder);
			setInstallFolder(savedInstallFolder);
			setSongs(initialSongs);
			setHrSamples(initialSamples);
			setMediaBaseUrl(baseUrl);
		})();

		const unsubscribe = bridge.onSongLogUpdate((entries) => {
			setSongs(entries);
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const selectFolder = useCallback(async () => {
		const bridge = window.songHistoryBridge;
		if (!bridge) return;
		const { path, entries } = await bridge.selectFolder();
		setFolder(path);
		setSongs(entries);
	}, []);

	const selectInstallFolder = useCallback(async () => {
		const bridge = window.songHistoryBridge;
		if (!bridge) return;
		const path = await bridge.selectInstallFolder();
		setInstallFolder(path);
	}, []);

	// Deletes one or more local history entries by startTime (epoch
	// seconds) -- used by the "clear this play" / "clear this day" /
	// "clear all history" controls. Rewrites the underlying log file on
	// the main-process side; the file watcher will also push a
	// 'song-log:updated' event from that write, but we set state directly
	// here too so the UI updates instantly rather than waiting on it.
	const deleteEntries = useCallback(async (startTimes: number[]) => {
		const bridge = window.songHistoryBridge;
		if (!bridge || startTimes.length === 0) return;
		const updated = await bridge.deleteEntries(startTimes);
		setSongs(updated);
	}, []);

	// Call this whenever a new HR sample comes in from useHeartrateMonitor.
	// Throttled to ~1/sec -- that's plenty of resolution for per-song
	// avg/max HR and keeps the log file from growing too fast.
	const recordHeartrateSample = useCallback((heartrate: number, timestamp: number) => {
		if (timestamp - lastSampleAtRef.current < 1000) return;
		lastSampleAtRef.current = timestamp;

		const sample: HeartrateSample = { heartrate, timestamp };
		setHrSamples((prev) => [...prev, sample]);
		window.songHistoryBridge?.sendHeartrateSample(sample);
	}, []);

	return {
		songs,
		hrSamples,
		folder,
		installFolder,
		mediaBaseUrl,
		isSupported,
		selectFolder,
		selectInstallFolder,
		recordHeartrateSample,
		deleteEntries,
	};
}

// Builds the <img src> for a song's banner from its virtual bannerPath.
// Returns null if there's no banner path or no media server available yet
// (e.g. browser version, or bridge not ready) -- callers should fall back
// to a placeholder in that case.
export function bannerUrl(mediaBaseUrl: string | null, bannerPath: string | undefined): string | null {
	if (!mediaBaseUrl || !bannerPath) return null;
	return `${mediaBaseUrl}/banner?path=${encodeURIComponent(bannerPath)}`;
}
