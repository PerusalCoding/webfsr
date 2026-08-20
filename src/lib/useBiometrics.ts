import { useState, useCallback } from "react";
import type { Biometrics } from "./calorieEstimate";

// Standalone for now, localStorage-backed like the other settings hooks in
// dashboard.tsx (LS_ADVANCED_MODE_KEY etc.) -- wire into the real profile
// sync system later if you want this to travel with a profile instead of
// being per-install.
const LS_BIOMETRICS_KEY = "webfsr_biometrics";

const DEFAULT_BIOMETRICS: Biometrics = {
	weightKg: 70,
	age: 30,
	sex: "male",
};

export function useBiometrics() {
	const [biometrics, setBiometricsState] = useState<Biometrics>(() => {
		try {
			const raw = localStorage.getItem(LS_BIOMETRICS_KEY);
			if (!raw) return DEFAULT_BIOMETRICS;
			return { ...DEFAULT_BIOMETRICS, ...JSON.parse(raw) };
		} catch {
			return DEFAULT_BIOMETRICS;
		}
	});

	const setBiometrics = useCallback((next: Biometrics) => {
		setBiometricsState(next);
		try {
			localStorage.setItem(LS_BIOMETRICS_KEY, JSON.stringify(next));
		} catch {
			// Ignore storage errors (e.g. private browsing).
		}
	}, []);

	return { biometrics, setBiometrics };
}
