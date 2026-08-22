import { useState, useCallback } from "react";

const LS_HYPERATE_SESSION_KEY = "";

// Unlike Pulsoid, HypeRate needs no login/OAuth at all -- the user just
// opens the free HypeRate app, copies their Session ID from Settings, and
// pastes it in. This hook is just persistence for that string.
export function useHypeRateSessionId() {
	const [sessionId, setSessionIdState] = useState<string>(() => {
		try {
			return localStorage.getItem(LS_HYPERATE_SESSION_KEY) ?? "";
		} catch {
			return "";
		}
	});

	const setSessionId = useCallback((next: string) => {
		const trimmed = next.trim();
		setSessionIdState(trimmed);
		try {
			if (trimmed) localStorage.setItem(LS_HYPERATE_SESSION_KEY, trimmed);
			else localStorage.removeItem(LS_HYPERATE_SESSION_KEY);
		} catch {
			// Ignore storage errors.
		}
	}, []);

	const clearSessionId = useCallback(() => setSessionId(""), [setSessionId]);

	return { sessionId, setSessionId, clearSessionId };
}
