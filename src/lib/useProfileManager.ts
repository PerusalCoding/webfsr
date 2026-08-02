import { type IDBPDatabase, openDB } from "idb";
import { useEffect, useRef, useState } from "react";

// Database configuration
const DB_NAME = "webfsr";
const DB_VERSION = 1;
const PROFILES_STORE = "profiles";
const SETTINGS_STORE = "settings";
const LAST_ACTIVE_PROFILE_KEY = "lastActiveProfileId";

// Scopes the "last active profile" settings-store key to a specific
// physical board. Without this, "lastActiveProfileId" was a single global
// setting shared by every connected pad -- switching profiles (or even
// just the normal startup flow) on one pad's tab could silently pull
// ANOTHER pad's tab onto the wrong profile the next time it read this
// setting, which looked like settings randomly "resetting" whenever
// either pad reconnected. Falls back to the plain unscoped key when
// deviceId is null (older firmware without a chip ID, or before the
// async identify response has come back yet) -- this is also exactly
// what every single-pad user saw before this existed, so it's a safe,
// unchanged fallback for them.
function scopedSettingsKey(base: string, deviceId: string | null): string {
	return deviceId ? `${base}:${deviceId}` : base;
}

// Interface for profile data
export interface ProfileData {
	id?: number;
	name: string;
	createdAt: number;
	updatedAt: number;
	sensorColors: string[];
	showBarThresholdText: boolean;
	showBarValueText: boolean;
	thresholdColor: string;
	useThresholdColor: boolean;
	useSingleColor: boolean;
	singleBarColor: string;
	useBarGradient: boolean;
	showGridLines: boolean;
	showThresholdLines: boolean;
	thresholdLineOpacity: number;
	showLegend: boolean;
	showGraphBorder: boolean;
	timeWindow: number;
	thresholds: number[];
	sensorLabels: string[];
	showHeartrateMonitor: boolean;
	lockThresholds: boolean;
	showGraphActivation: boolean;
	graphActivationColor: string;
	verticalAlignHeartrate: boolean;
	fillHeartIcon: boolean;
	showBpmText: boolean;
	animateHeartbeat: boolean;
	pollingRate: number;
	useUnthrottledPolling: boolean;
	obsPassword?: string;
	obsSendRate?: number;
	obsAutoConnect?: boolean;
	// Maps DISPLAY POSITION -> actual sensor index. e.g. [3, 1, 0, 2] means
	// "show sensor 3 first, then sensor 1, then sensor 0, then sensor 2"
	// in the main sensor bars, LED Panels list, and Sensor Tuning list.
	// Purely a display/ordering concern -- never changes which physical
	// FSR maps to which firmware sensor index, LED zone, button group,
	// etc. Lets someone whose physical wiring doesn't match webfsr's
	// default Left/Down/Up/Right order fix that visually without
	// resoldering or reflashing. Defaults to [] (meaning "use natural
	// 0,1,2,... order") if never set.
	displayOrder?: number[];
}

export const DEFAULT_PROFILE: Omit<ProfileData, "id" | "createdAt" | "updatedAt"> = {
	name: "Default Profile",
	sensorColors: [
		"#3a7da3", // blue
		"#d4607c", // pink
		"#8670d4", // purple
		"#d49b20", // gold
		"#459ea0", // teal
		"#d45478", // coral
	],
	showBarThresholdText: true,
	showBarValueText: true,
	thresholdColor: "#4dd253",
	useThresholdColor: true,
	useSingleColor: true,
	singleBarColor: "#3a7da3", // Same as first sensor color
	useBarGradient: true,
	showGridLines: true,
	showThresholdLines: true,
	thresholdLineOpacity: 0.3,
	showLegend: true,
	showGraphBorder: true,
	timeWindow: 1000,
	thresholds: [],
	sensorLabels: [],
	showHeartrateMonitor: false,
	lockThresholds: false,
	showGraphActivation: true,
	graphActivationColor: "#4dd253",
	verticalAlignHeartrate: false,
	fillHeartIcon: true,
	showBpmText: true,
	animateHeartbeat: true,
	pollingRate: 100,
	useUnthrottledPolling: false,
	obsPassword: "",
	obsSendRate: 60,
	obsAutoConnect: true,
	displayOrder: [],
};

export function useProfileManager(deviceId: string | null = null) {
	const [db, setDb] = useState<IDBPDatabase | null>(null);
	const [profiles, setProfiles] = useState<ProfileData[]>([]);
	const [activeProfileId, setActiveProfileId] = useState<number | null>(null);
	const [activeProfile, setActiveProfile] = useState<ProfileData | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	// Helper function to save the last active profile ID, scoped per
	// physical board via deviceId (falls back to the plain unscoped key
	// when deviceId is null -- see scopedSettingsKey above).
	const saveLastActiveProfileId = async (database: IDBPDatabase, profileId: number, forDeviceId: string | null) => {
		try {
			const key = scopedSettingsKey(LAST_ACTIVE_PROFILE_KEY, forDeviceId);
			// Check if we already have a setting
			const existingSetting = await database.getFromIndex(SETTINGS_STORE, "key", key);

			if (existingSetting) {
				// Update existing setting
				await database.put(SETTINGS_STORE, {
					...existingSetting,
					value: profileId,
				});
			} else {
				// Create new setting
				await database.add(SETTINGS_STORE, {
					key,
					value: profileId,
				});
			}
		} catch (err) {
			console.error("Failed to save last active profile ID:", err);
		}
	};

	// Initialize the database
	useEffect(() => {
		const initDb = async () => {
			try {
				const database = await openDB(DB_NAME, DB_VERSION, {
					upgrade(db) {
						// Create object stores if they don't exist
						if (!db.objectStoreNames.contains(PROFILES_STORE)) {
							const profileStore = db.createObjectStore(PROFILES_STORE, {
								keyPath: "id",
								autoIncrement: true,
							});
							profileStore.createIndex("name", "name", { unique: false });
							profileStore.createIndex("updatedAt", "updatedAt", {
								unique: false,
							});
						}

						if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
							const settingsStore = db.createObjectStore(SETTINGS_STORE, {
								keyPath: "id",
								autoIncrement: true,
							});
							settingsStore.createIndex("key", "key", { unique: true });
						}
					},
				});

				setDb(database);

				// Load all profiles
				let allProfiles = await database.getAll(PROFILES_STORE);
				setProfiles(allProfiles as ProfileData[]);

				const lastActiveProfileSetting = await database.getFromIndex(
					SETTINGS_STORE,
					"key",
					scopedSettingsKey(LAST_ACTIVE_PROFILE_KEY, deviceId),
				);

				// If we don't have any profiles or a last active profile, create a default profile
				if (allProfiles.length === 0) {
					let shouldCreateDefault = false;

					try {
						// Attempt to mark bootstrap
						await database.add(SETTINGS_STORE, {
							key: "bootstrapped",
							value: Date.now(),
						});
						shouldCreateDefault = true;
					} catch {
						shouldCreateDefault = false;
					}

					if (shouldCreateDefault) {
						const timestamp = Date.now();
						const defaultProfileWithTimestamps = {
							...DEFAULT_PROFILE,
							createdAt: timestamp,
							updatedAt: timestamp,
						};

						const id = await database.add(PROFILES_STORE, defaultProfileWithTimestamps);
						const newProfile = {
							...defaultProfileWithTimestamps,
							id: id as number,
						};

						setProfiles([newProfile]);
						setActiveProfileId(id as number);
						setActiveProfile(newProfile);

						await saveLastActiveProfileId(database, id as number, deviceId);
					} else {
						// Another instance is bootstrapping; refetch
						await new Promise((r) => setTimeout(r, 50));
						allProfiles = (await database.getAll(PROFILES_STORE)) as ProfileData[];
						setProfiles(allProfiles);
					}
				} else if (lastActiveProfileSetting) {
					// We have a last active profile, load it
					const profileId = lastActiveProfileSetting.value as number;
					const profile = await database.get(PROFILES_STORE, profileId);

					if (profile) {
						setActiveProfileId(profileId);
						setActiveProfile(profile as ProfileData);
					} else {
						// If the profile doesn't exist anymore, use the first available profile
						const firstId = allProfiles[0].id;

						if (firstId !== undefined) {
							setActiveProfileId(firstId as number);
							setActiveProfile(allProfiles[0] as ProfileData);
							await saveLastActiveProfileId(database, firstId as number, deviceId);
						}
					}
				} else {
					// No last active profile setting, use the first profile
					const firstId = allProfiles[0].id;

					if (firstId !== undefined) {
						setActiveProfileId(firstId as number);
						setActiveProfile(allProfiles[0] as ProfileData);
						await saveLastActiveProfileId(database, firstId as number, deviceId);
					}
				}

				setIsLoading(false);
			} catch (err) {
				console.error("Failed to initialize IndexedDB:", err);
				setError("Failed to initialize profile database");
				setIsLoading(false);
			}
		};

		// Deliberately mount-only ([] deps, deviceId intentionally omitted):
		// this reads whatever deviceId was known at the very first render,
		// which is almost always null (identify hasn't resolved yet this
		// early). The effect below handles switching to the right profile
		// once the real deviceId comes in, so this one doesn't need to
		// re-run on every deviceId change too.
		initDb();
	}, []);

	// Once the board's real deviceId is known (or changes -- e.g. a
	// different pad got connected in this same tab/window), switch to
	// THAT board's own last-active profile instead of staying on
	// whatever the pre-identify fallback (or a previous board's) loaded.
	// If this board has never been seen before, deliberately does NOT
	// force a profile switch (there's nothing device-specific to switch
	// TO yet) -- it just starts tracking this device's active profile
	// under its own scoped key from now on, using whatever's currently
	// active as the starting point.
	const prevDeviceIdRef = useRef<string | null>(null);
	useEffect(() => {
		if (!db || deviceId === prevDeviceIdRef.current) return;
		const isFirstDeviceIdAfterMount = prevDeviceIdRef.current === null;
		prevDeviceIdRef.current = deviceId;
		if (!deviceId) return;

		(async () => {
			try {
				const setting = await db.getFromIndex(SETTINGS_STORE, "key", scopedSettingsKey(LAST_ACTIVE_PROFILE_KEY, deviceId));

				if (setting) {
					const profileId = setting.value as number;
					const profile = await db.get(PROFILES_STORE, profileId);
					if (profile) {
						setActiveProfileId(profileId);
						setActiveProfile(profile as ProfileData);
						return;
					}
				}

				// No saved profile for this specific board yet. Only back-fill
				// from whatever's currently active if this is the FIRST
				// deviceId this hook has seen after mount -- if it's a later
				// switch to a genuinely new/different board mid-session,
				// leaving the currently active profile in place (rather than
				// silently claiming it as "this board's" profile too) avoids
				// two boards ending up sharing a profile by accident just
				// because of connection order.
				if (isFirstDeviceIdAfterMount && activeProfileId !== null) {
					await saveLastActiveProfileId(db, activeProfileId, deviceId);
				}
			} catch (err) {
				console.error("Failed to resolve per-device active profile:", err);
			}
		})();
	}, [deviceId, db]);

	// Create a new profile
	const createProfile = async (name: string, baseProfileId?: number) => {
		if (!db) return null;

		try {
			let baseProfile: Partial<ProfileData> = DEFAULT_PROFILE;

			// If a base profile ID is provided, use that profile as a base
			if (baseProfileId) {
				const existingProfile = await db.get(PROFILES_STORE, baseProfileId);

				if (existingProfile) {
					// Remove id to create a new profile
					const { id: _id, ...rest } = existingProfile as ProfileData;
					baseProfile = rest;
				}
			}

			const timestamp = Date.now();
			const newProfile = {
				...baseProfile,
				name,
				createdAt: timestamp,
				updatedAt: timestamp,
			};

			const id = await db.add(PROFILES_STORE, newProfile);
			const profileWithId = { ...newProfile, id: id as number };

			setProfiles((prev) => [...prev, profileWithId as ProfileData]);

			return profileWithId as ProfileData;
		} catch (err) {
			console.error("Failed to create profile:", err);
			setError("Failed to create profile");
			return null;
		}
	};

	// Delete a profile
	const deleteProfile = async (id: number) => {
		if (!db) return;

		try {
			// Don't allow deleting the last profile
			if (profiles.length <= 1) {
				setError("Cannot delete the last profile");
				return;
			}

			await db.delete(PROFILES_STORE, id);

			// Update profiles state
			setProfiles((prev) => prev.filter((profile) => profile.id !== id));

			// If the active profile is being deleted, switch to another profile
			if (activeProfileId === id) {
				const remainingProfiles = profiles.filter((profile) => profile.id !== id);

				if (remainingProfiles.length > 0) {
					const newActiveProfile = remainingProfiles[0];
					const newId = newActiveProfile.id;

					if (newId !== undefined) {
						setActiveProfileId(newId);
						setActiveProfile(newActiveProfile);
						await saveLastActiveProfileId(db, newId, deviceId);
					}
				}
			}
		} catch (err) {
			console.error("Failed to delete profile:", err);
			setError("Failed to delete profile");
		}
	};

	// Update a profile
	const updateProfile = async (id: number, updates: Partial<Omit<ProfileData, "id" | "createdAt" | "updatedAt">>) => {
		if (!db) return;

		try {
			const existingProfile = await db.get(PROFILES_STORE, id);
			if (!existingProfile) {
				setError("Profile not found");
				return;
			}

			const updatedProfile = {
				...existingProfile,
				...updates,
				updatedAt: Date.now(),
			};

			await db.put(PROFILES_STORE, updatedProfile);

			// Update profiles state
			setProfiles((prev) => prev.map((profile) => (profile.id === id ? (updatedProfile as ProfileData) : profile)));

			// If this is the active profile, update the active profile state
			if (activeProfileId === id) setActiveProfile(updatedProfile as ProfileData);
		} catch (err) {
			console.error("Failed to update profile:", err);
			setError("Failed to update profile");
		}
	};

	// Set active profile
	const setActiveProfileById = async (id: number) => {
		if (!db) return;

		try {
			const profile = await db.get(PROFILES_STORE, id);

			if (!profile) {
				setError("Profile not found");
				return;
			}

			setActiveProfileId(id);
			setActiveProfile(profile as ProfileData);

			await saveLastActiveProfileId(db, id, deviceId);
		} catch (err) {
			console.error("Failed to set active profile:", err);
			setError("Failed to set active profile");
		}
	};

	// Update thresholds for active profile
	const updateThresholds = async (newThresholds: number[]) => {
		if (!activeProfileId || !db) return;

		try {
			await updateProfile(activeProfileId, { thresholds: newThresholds });
		} catch (err) {
			console.error("Failed to update thresholds:", err);
		}
	};

	// Update sensor labels for active profile
	const updateSensorLabels = async (newLabels: string[]) => {
		if (!activeProfileId || !db) return;

		try {
			await updateProfile(activeProfileId, { sensorLabels: newLabels });
		} catch (err) {
			console.error("Failed to update sensor labels:", err);
		}
	};

	// Update display order for active profile -- maps display position to
	// actual sensor index, used to visually reorder sensor bars/LED rows/
	// tuning rows to match physical pad wiring without touching firmware.
	const updateDisplayOrder = async (newOrder: number[]) => {
		if (!activeProfileId || !db) return;

		try {
			await updateProfile(activeProfileId, { displayOrder: newOrder });
		} catch (err) {
			console.error("Failed to update display order:", err);
		}
	};

	// Reset profile to default values except name, id, timestamps
	const resetProfileToDefaults = async (id: number) => {
		if (!db) return null;

		try {
			const existingProfile = await db.get(PROFILES_STORE, id);
			if (!existingProfile) {
				setError("Profile not found");
				return null;
			}

			const { name, id: profileId, createdAt } = existingProfile as ProfileData;

			const updatedProfile = {
				...DEFAULT_PROFILE,
				thresholds: existingProfile.thresholds,
				sensorLabels: existingProfile.sensorLabels,
				displayOrder: (existingProfile as ProfileData).displayOrder ?? [],
				obsPassword: (existingProfile as ProfileData).obsPassword ?? "",
				obsSendRate: (existingProfile as ProfileData).obsSendRate ?? 30,
				obsAutoConnect: (existingProfile as ProfileData).obsAutoConnect ?? false,
				name,
				id: profileId,
				createdAt,
				updatedAt: Date.now(),
			};

			await db.put(PROFILES_STORE, updatedProfile);

			// Update profiles state
			setProfiles((prev) => prev.map((profile) => (profile.id === id ? (updatedProfile as ProfileData) : profile)));

			// If this is the active profile, update the active profile state
			if (activeProfileId === id) setActiveProfile(updatedProfile as ProfileData);

			return updatedProfile as ProfileData;
		} catch (err) {
			console.error("Failed to reset profile:", err);
			setError("Failed to reset profile");
			return null;
		}
	};

	return {
		profiles,
		activeProfile,
		activeProfileId,
		isLoading,
		error,
		createProfile,
		deleteProfile,
		updateProfile,
		setActiveProfileById,
		updateThresholds,
		updateSensorLabels,
		updateDisplayOrder,
		resetProfileToDefaults,
	};
}
