import { useState, useRef, useCallback, useEffect } from "react";

export interface HypeRateHeartrateData {
	heartrate: number;
	timestamp: number; // epoch ms -- HypeRate doesn't send its own timestamp, so we stamp on receipt
}

// Issued to you when HypeRate approved your API access request. Safe to
// ship in client-side code -- HypeRate's own reference client does the
// same (see https://gist.github.com/YannickFricke/e6f036ab6093386178e6998e144b0ac4) --
// but if you'd rather not hardcode it, swap this for an env/config value.
const HYPERATE_API_KEY = "sityIdPMu5jsb7AosH4Qo0SzjgPlxUXvrcBihaCa";

const HYPERATE_WS_URL = "wss://app.hyperate.io/socket/websocket";
const PHOENIX_HEARTBEAT_MS = 15_000; // HypeRate's Phoenix socket expects a keepalive roughly this often
const JOIN_TIMEOUT_MS = 8_000;

function randomRef(): number {
	return Math.round(Math.random() * 1_000_000);
}

// Alternative to usePulsoidHeartrateMonitor -- reads heart rate from
// HypeRate's cloud service instead of Pulsoid. Same shape/return values as
// the Pulsoid version so it drops into the Dashboard with minimal changes;
// the only real difference is what you hand it (a free Session ID from the
// HypeRate app, instead of an access token) and the wire protocol underneath
// (HypeRate speaks raw Phoenix channels, not a pre-built SDK).
export function useHypeRateHeartrateMonitor(sessionId: string) {
	const [heartrateData, setHeartrateData] = useState<HypeRateHeartrateData | null>(null);
	const [isConnected, setIsConnected] = useState(false);
	const [isConnecting, setIsConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const socketRef = useRef<WebSocket | null>(null);
	const heartbeatTimerRef = useRef<number | null>(null);
	const joinTimeoutRef = useRef<number | null>(null);
	const joinRefRef = useRef<number | null>(null);
	const channelRef = useRef<string>("");

	const clearTimers = useCallback(() => {
		if (heartbeatTimerRef.current !== null) {
			window.clearInterval(heartbeatTimerRef.current);
			heartbeatTimerRef.current = null;
		}
		if (joinTimeoutRef.current !== null) {
			window.clearTimeout(joinTimeoutRef.current);
			joinTimeoutRef.current = null;
		}
	}, []);

	const teardown = useCallback(() => {
		clearTimers();
		if (socketRef.current) {
			socketRef.current.onopen = null;
			socketRef.current.onmessage = null;
			socketRef.current.onerror = null;
			socketRef.current.onclose = null;
			socketRef.current.close();
			socketRef.current = null;
		}
	}, [clearTimers]);

	const disconnect = useCallback(async () => {
		teardown();
		setIsConnected(false);
		setIsConnecting(false);
		setHeartrateData(null);
	}, [teardown]);

	const connect = useCallback(async () => {
		const id = sessionId.trim();
		if (!id) {
			setError("Enter your HypeRate Session ID first.");
			return false;
		}
		if (!HYPERATE_API_KEY || HYPERATE_API_KEY === "YOUR_HYPERATE_API_KEY") {
			setError("HypeRate API key isn't configured yet -- add the key from your approval email.");
			return false;
		}

		teardown();
		setError(null);
		setIsConnecting(true);
		channelRef.current = id;

		return new Promise<boolean>((resolve) => {
			const socket = new WebSocket(`${HYPERATE_WS_URL}?token=${encodeURIComponent(HYPERATE_API_KEY)}`);
			socketRef.current = socket;

			const fail = (message: string) => {
				setError(message);
				setIsConnecting(false);
				setIsConnected(false);
				teardown();
				resolve(false);
			};

			socket.onopen = () => {
				// Keep the Phoenix socket alive -- HypeRate closes idle
				// connections that never send a heartbeat frame.
				heartbeatTimerRef.current = window.setInterval(() => {
					if (socket.readyState !== WebSocket.OPEN) return;
					socket.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: 0 }));
				}, PHOENIX_HEARTBEAT_MS);

				const ref = randomRef();
				joinRefRef.current = ref;
				socket.send(
					JSON.stringify({ topic: `hr:${id}`, event: "phx_join", payload: {}, ref }),
				);

				joinTimeoutRef.current = window.setTimeout(() => {
					fail("Timed out waiting for HypeRate to confirm the session -- check the Session ID.");
				}, JOIN_TIMEOUT_MS);
			};

			socket.onmessage = (event) => {
				let parsed: any;
				try {
					parsed = JSON.parse(event.data);
				} catch {
					return;
				}

				switch (parsed.event) {
					case "phx_reply": {
						if (parsed.ref !== joinRefRef.current) return;
						if (joinTimeoutRef.current !== null) {
							window.clearTimeout(joinTimeoutRef.current);
							joinTimeoutRef.current = null;
						}
						if (parsed.payload?.status === "ok") {
							setIsConnecting(false);
							setIsConnected(true);
							resolve(true);
						} else {
							fail("HypeRate rejected that Session ID -- double check it in the HypeRate app.");
						}
						break;
					}
					case "hr_update": {
						const hr = parsed.payload?.hr;
						if (typeof hr === "number") {
							setHeartrateData({ heartrate: Math.round(hr), timestamp: Date.now() });
							setIsConnected(true);
						}
						break;
					}
					default:
						// phx_close and unrecognized events -- nothing to do.
						break;
				}
			};

			socket.onerror = () => {
				if (joinTimeoutRef.current !== null) {
					fail("Couldn't reach HypeRate -- check your internet connection.");
				}
			};

			socket.onclose = () => {
				setIsConnected(false);
				socketRef.current = null;
			};
		});
	}, [sessionId, teardown]);

	// Clean up on unmount.
	useEffect(() => {
		return () => teardown();
	}, [teardown]);

	return {
		connect,
		disconnect,
		heartrateData,
		isConnected,
		isConnecting,
		error,
		isSupported: true, // no browser API dependency, unlike WebBluetooth
	};
}
