import { useState, useCallback } from "react";

const LS_PLAYER_NAME_KEY = "webfsr_player_name";

export function usePlayerName() {
	const [playerName, setPlayerNameState] = useState<string>(() => {
		try {
			return localStorage.getItem(LS_PLAYER_NAME_KEY) ?? "";
		} catch {
			return "";
		}
	});

	const setPlayerName = useCallback((name: string) => {
		setPlayerNameState(name);
		try {
			localStorage.setItem(LS_PLAYER_NAME_KEY, name);
		} catch {
			// Ignore storage errors (e.g. private browsing).
		}
	}, []);

	return { playerName, setPlayerName };
}
