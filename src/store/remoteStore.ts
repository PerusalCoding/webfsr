import { create } from "zustand";

// Message protocol types

// Desktop → Mobile
export type DesktopMessage =
	| { type: "sync"; payload: ProfileSyncPayload }
	| { type: "values"; payload: { values: number[]; timestamp: number } }
	| { type: "ping" };

export type ProfileSyncPayload = {
	thresholds: number[];
	sensorLabels: string[];
	sensorColors: string[];
	thresholdColor: string;
	useThresholdColor: boolean;
	useSingleColor: boolean;
	singleBarColor: string;
	isLocked: boolean;
	theme: "light" | "dark";
	// Advanced Sensor Tuning fields. When advancedTuningEnabled is false,
	// the mobile UI behaves exactly as before (single threshold marker,
	// "threshold" messages). When true, liveTriggerValues/
	// liveReleaseValues carry the dual-threshold values the desktop is
	// currently using, and mobile should show both markers and send
	// "trigger"/"release" messages instead of the legacy "threshold" one.
	advancedTuningEnabled?: boolean;
	liveTriggerValues?: number[];
	liveReleaseValues?: number[];
};

// Mobile → Desktop
export type MobileMessage =
	| { type: "threshold"; index: number; value: number }
	// New: sent instead of "threshold" when advancedTuningEnabled is true
	// on the synced profile -- desktop maps these straight onto the same
	// "y"/"r" firmware commands Advanced mode already uses locally.
	| { type: "trigger"; index: number; value: number }
	| { type: "release"; index: number; value: number }
	| { type: "pong" }
	| { type: "ready" };

// Store state for mobile-side received data
interface RemoteState {
	// Received from desktop
	remoteSensorValues: number[];
	remoteThresholds: number[];
	remoteSensorLabels: string[];
	remoteSensorColors: string[];
	remoteThresholdColor: string;
	remoteUseThresholdColor: boolean;
	remoteUseSingleColor: boolean;
	remoteSingleBarColor: string;
	remoteIsLocked: boolean;
	remoteTheme: "light" | "dark";
	lastSyncTimestamp: number;
	// Advanced Sensor Tuning mirrors of the above
	remoteAdvancedTuningEnabled: boolean;
	remoteLiveTriggerValues: number[];
	remoteLiveReleaseValues: number[];

	// Actions
	updateRemoteData: (data: ProfileSyncPayload) => void;
	updateSensorValues: (values: number[]) => void;
	reset: () => void;
}

const initialState = {
	remoteSensorValues: [],
	remoteThresholds: [],
	remoteSensorLabels: [],
	remoteSensorColors: [],
	remoteThresholdColor: "#ff0000",
	remoteUseThresholdColor: false,
	remoteUseSingleColor: false,
	remoteSingleBarColor: "#ff0000",
	remoteIsLocked: false,
	remoteTheme: "dark" as const,
	lastSyncTimestamp: 0,
	remoteAdvancedTuningEnabled: false,
	remoteLiveTriggerValues: [],
	remoteLiveReleaseValues: [],
};

export const useRemoteStore = create<RemoteState>((set) => ({
	...initialState,

	updateRemoteData: (data) =>
		set({
			remoteThresholds: data.thresholds,
			remoteSensorLabels: data.sensorLabels,
			remoteSensorColors: data.sensorColors,
			remoteThresholdColor: data.thresholdColor,
			remoteUseThresholdColor: data.useThresholdColor,
			remoteUseSingleColor: data.useSingleColor,
			remoteSingleBarColor: data.singleBarColor,
			remoteIsLocked: data.isLocked,
			remoteTheme: data.theme,
			lastSyncTimestamp: Date.now(),
			remoteAdvancedTuningEnabled: data.advancedTuningEnabled ?? false,
			remoteLiveTriggerValues: data.liveTriggerValues ?? [],
			remoteLiveReleaseValues: data.liveReleaseValues ?? [],
		}),

	updateSensorValues: (values) =>
		set({
			remoteSensorValues: values,
		}),

	reset: () => set(initialState),
}));

// Selectors for common combinations
export const useRemoteSensorValues = () => useRemoteStore((state) => state.remoteSensorValues);
export const useRemoteThresholds = () => useRemoteStore((state) => state.remoteThresholds);
export const useRemoteSensorLabels = () => useRemoteStore((state) => state.remoteSensorLabels);
export const useRemoteTheme = () => useRemoteStore((state) => state.remoteTheme);
export const useRemoteIsLocked = () => useRemoteStore((state) => state.remoteIsLocked);
export const useRemoteAdvancedTuningEnabled = () => useRemoteStore((state) => state.remoteAdvancedTuningEnabled);
export const useRemoteLiveTriggerValues = () => useRemoteStore((state) => state.remoteLiveTriggerValues);
export const useRemoteLiveReleaseValues = () => useRemoteStore((state) => state.remoteLiveReleaseValues);
