import { useState, useCallback } from "react";

const LS_LIVE_FEED_OPT_IN_KEY = "webfsr_live_feed_opt_in";

// Deliberately separate from usePublishOptIn -- publishing a finished
// score after the fact and broadcasting "I am playing this song right
// now" are different privacy considerations (live presence vs. a delayed
// historical record), so they get independent toggles rather than being
// bundled under one switch.
export function useLiveFeedOptIn() {
	const [liveFeedEnabled, setLiveFeedEnabledState] = useState<boolean>(() => {
		try {
			return localStorage.getItem(LS_LIVE_FEED_OPT_IN_KEY) === "true";
		} catch {
			return false;
		}
	});

	const setLiveFeedEnabled = useCallback((enabled: boolean) => {
		setLiveFeedEnabledState(enabled);
		try {
			localStorage.setItem(LS_LIVE_FEED_OPT_IN_KEY, String(enabled));
		} catch {
			// Ignore storage errors.
		}
	}, []);

	return { liveFeedEnabled, setLiveFeedEnabled };
}
