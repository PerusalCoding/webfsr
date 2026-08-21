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

// If the phone screen locks or the HypeRate app backgrounds, the socket
// often doesn't actually close -- it just stops delivering hr_update
// messages, since the OS throttles the phone's own network access rather
// than the server tearing down the connection. So "connected but silent
// for a while" gets treated the same as a real disconnect and triggers a
// fresh reconnect, rather than waiting on a close event that may never
// come.
const STALE_DATA_TIMEOUT_MS = 20_000;
const STALE_CHECK_INTERVAL_MS = 5_000;

// Same exponential backoff shape as useOBS.ts, capped at ~15s.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 15_000;
const MAX_BACKOFF_ATTEMPT_EXPONENT = 10;

function randomRef(): number {
	return Math.round(Math.random() * 1_000_000);
}

// Alternative to usePulsoidHeartrateMonitor -- reads heart rate from
// HypeRate's cloud service instead of Pulsoid. Same shape/return values as
// the Pulsoid version so it drops into the Dashboard with minimal changes;
// the only real difference is what you hand it (a free Session ID from the
// HypeRate app, instead of an access token) and the wire protocol underneath
// (HypeRate speaks raw Phoenix channels, not a pre-built SDK).
//
// Auto-reconnect is always-on once you successfully connect (no separate
// toggle needed) -- it only stops once you call disconnect() yourself.
export function useHypeRateHeartrateMonitor(sessionId: string) {
	const [heartrateData, setHeartrateData] = useState<HypeRateHeartrateData | null>(null);
	const [isConnected, setIsConnected] = useState(false);
	const [isConnecting, setIsConnecting] = useState(false);
	const [isReconnecting, setIsReconnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [nextRetryInMs, setNextRetryInMs] = useState(0);

	const socketRef = useRef<WebSocket | null>(null);
	const heartbeatTimerRef = useRef<number | null>(null);
	const joinTimeoutRef = useRef<number | null>(null);
	const joinRefRef = useRef<number | null>(null);
	const channelRef = useRef<string>("");

	const wantsConnectionRef = useRef(false); // true from connect() until an explicit disconnect()
	const lastSessionIdRef = useRef<string>("");
	const lastHrAtRef = useRef<number>(0);
	const backoffAttemptRef = useRef(0);
	const reconnectTimerRef = useRef<number | null>(null);
	const countdownTimerRef = useRef<number | null>(null);
	const staleCheckTimerRef = useRef<number | null>(null);

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

	const clearReconnectTimers = useCallback(() => {
		if (reconnectTimerRef.current !== null) {
			window.clearTimeout(reconnectTimerRef.current);
			reconnectTimerRef.current = null;
		}
		if (countdownTimerRef.current !== null) {
			window.clearInterval(countdownTimerRef.current);
			countdownTimerRef.current = null;
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

	// Forward-declared via ref so scheduleReconnect and the stale-data
	// watchdog can call the latest connect() without a circular reference
	// between the two useCallbacks.
	const connectRef = useRef<() => Promise<boolean>>(async () => false);

	const scheduleReconnect = useCallback(() => {
		clearReconnectTimers();
		setIsReconnecting(true);

		const attempt = backoffAttemptRef.current;
		const delay = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt);
		setNextRetryInMs(delay);

		const start = Date.now();
		countdownTimerRef.current = window.setInterval(() => {
			const remaining = Math.max(0, delay - (Date.now() - start));
			setNextRetryInMs(remaining);
			if (remaining <= 0 && countdownTimerRef.current) {
				window.clearInterval(countdownTimerRef.current);
				countdownTimerRef.current = null;
			}
		}, 1000);

		reconnectTimerRef.current = window.setTimeout(() => {
			if (!wantsConnectionRef.current || !lastSessionIdRef.current) return;
			backoffAttemptRef.current = Math.min(MAX_BACKOFF_ATTEMPT_EXPONENT, backoffAttemptRef.current + 1);
			void connectRef.current();
		}, delay);
	}, [clearReconnectTimers]);

	const disconnect = useCallback(async () => {
		wantsConnectionRef.current = false;
		clearReconnectTimers();
		if (staleCheckTimerRef.current !== null) {
			window.clearInterval(staleCheckTimerRef.current);
			staleCheckTimerRef.current = null;
		}
		teardown();
		setIsConnected(false);
		setIsConnecting(false);
		setIsReconnecting(false);
		setHeartrateData(null);
	}, [teardown, clearReconnectTimers]);

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
		wantsConnectionRef.current = true;
		lastSessionIdRef.current = id;
		channelRef.current = id;

		return new Promise<boolean>((resolve) => {
			const socket = new WebSocket(`${HYPERATE_WS_URL}?token=${encodeURIComponent(HYPERATE_API_KEY)}`);
			socketRef.current = socket;

			const fail = (message: string) => {
				setError(message);
				setIsConnecting(false);
				setIsConnected(false);
				teardown();
				if (wantsConnectionRef.current) scheduleReconnect();
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
				socket.send(JSON.stringify({ topic: `hr:${id}`, event: "phx_join", payload: {}, ref }));

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
							setIsReconnecting(false);
							setError(null);
							backoffAttemptRef.current = 0;
							clearReconnectTimers();
							lastHrAtRef.current = Date.now();
							resolve(true);
						} else {
							fail("HypeRate rejected that Session ID -- double check it in the HypeRate app.");
						}
						break;
					}
					case "hr_update": {
						const hr = parsed.payload?.hr;
						if (typeof hr === "number") {
							lastHrAtRef.current = Date.now();
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
				if (wantsConnectionRef.current) scheduleReconnect();
			};
		});
	}, [sessionId, teardown, scheduleReconnect, clearReconnectTimers]);

	useEffect(() => {
		connectRef.current = connect;
	}, [connect]);

	// Stale-data watchdog: if we think we're connected but haven't heard an
	// hr_update in a while, the phone has likely locked/backgrounded even
	// though the socket never formally closed. Force a fresh reconnect
	// rather than sitting there silently "connected" with no data.
	useEffect(() => {
		staleCheckTimerRef.current = window.setInterval(() => {
			if (!wantsConnectionRef.current) return;
			if (!isConnected) return;
			if (lastHrAtRef.current === 0) return; // haven't received a first sample yet -- give it time
			if (Date.now() - lastHrAtRef.current < STALE_DATA_TIMEOUT_MS) return;

			setIsConnected(false);
			teardown();
			void connectRef.current();
		}, STALE_CHECK_INTERVAL_MS);

		return () => {
			if (staleCheckTimerRef.current !== null) {
				window.clearInterval(staleCheckTimerRef.current);
				staleCheckTimerRef.current = null;
			}
		};
	}, [isConnected, teardown]);

	// Clean up on unmount.
	useEffect(() => {
		return () => {
			wantsConnectionRef.current = false;
			clearReconnectTimers();
			teardown();
		};
	}, [teardown, clearReconnectTimers]);

	return {
		connect,
		disconnect,
		heartrateData,
		isConnected,
		isConnecting: isConnecting || isReconnecting,
		isReconnecting,
		nextRetryInMs,
		error,
		isSupported: true, // no browser API dependency, unlike WebBluetooth
	};
}
