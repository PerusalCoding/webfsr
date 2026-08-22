import { useState, useCallback } from "react";

const LS_PUBLISH_OPT_IN_KEY = "webfsr_publish_opt_in";

// Deliberately separate from usePlayerName -- typing a display name
// shouldn't by itself mean "yes, publish my scores publicly." This is an
// explicit second gate, off by default, so publishing is opt-in rather
// than an accidental side effect of filling in a name field.
export function usePublishOptIn() {
	const [publishEnabled, setPublishEnabledState] = useState<boolean>(() => {
		try {
			return localStorage.getItem(LS_PUBLISH_OPT_IN_KEY) === "true";
		} catch {
			return false;
		}
	});

	const setPublishEnabled = useCallback((enabled: boolean) => {
		setPublishEnabledState(enabled);
		try {
			localStorage.setItem(LS_PUBLISH_OPT_IN_KEY, String(enabled));
		} catch {
			// Ignore storage errors.
		}
	}, []);

	return { publishEnabled, setPublishEnabled };
}
