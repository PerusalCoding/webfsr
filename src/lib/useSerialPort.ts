import { useEffect, useRef, useState } from "react";
import { useDataStore } from "~/store/dataStore";

export interface SerialData {
	rawData: string;
	values: number[];
}

export const useSerialPort = (
	pollingRate = 100,
	useUnthrottledPolling = false,
	onValues?: (values: number[]) => void,
	onLine?: (line: string) => void,
) => {
	const [port, setPort] = useState<SerialPort | null>(null);
	const [connected, setConnected] = useState<boolean>(false);
	const [connectionError, setConnectionError] = useState<string>("");
	const [latestData, setLatestData] = useState<SerialData | null>(null);
	const [requestsPerSecond, setRequestsPerSecond] = useState<number>(0);

	const setNumSensors = useDataStore((state) => state.setNumSensors);

	const readerRef = useRef<ReadableStreamDefaultReader | null>(null);
	const writerRef = useRef<WritableStreamDefaultWriter | null>(null);
	const isReadingRef = useRef<boolean>(false);
	const requestCountRef = useRef<number>(0);
	const pollingRateRef = useRef<number>(pollingRate);
	const useUnthrottledPollingRef = useRef<boolean>(useUnthrottledPolling);
	const onValuesRef = useRef<typeof onValues>(onValues);
	const onLineRef = useRef<typeof onLine>(onLine);

	// Command for requesting sensor data
	const requestData = new Uint8Array([118, 10]);

	// Calculate requests per second every second
	useEffect(() => {
		if (!connected) return;

		const interval = setInterval(() => {
			setRequestsPerSecond(requestCountRef.current);
			requestCountRef.current = 0;
		}, 1000);

		return () => clearInterval(interval);
	}, [connected]);

	useEffect(() => {
		pollingRateRef.current = pollingRate;
		useUnthrottledPollingRef.current = useUnthrottledPolling;
		onValuesRef.current = onValues;
		onLineRef.current = onLine;
	}, [pollingRate, useUnthrottledPolling, onValues, onLine]);

	const connect = async () => {
		if (!("serial" in navigator)) {
			setConnectionError("WebSerial is not supported in this browser");
			return;
		}

		if (connected) return;

		try {
			const selectedPort = await navigator.serial.requestPort();
			await selectedPort.open({ baudRate: 9600 });

			setPort(selectedPort);
			setConnected(true);
			setConnectionError("");
			requestCountRef.current = 0;

			startReading(selectedPort);
		} catch (error) {
			setConnectionError(error instanceof Error ? error.message : "Failed to connect to device");
		}
	};

	const disconnect = async () => {
		if (!connected || !port) return;

		try {
			isReadingRef.current = false;

			if (readerRef.current) readerRef.current.releaseLock();
			if (writerRef.current) writerRef.current.releaseLock();

			await port.close();

			setPort(null);
			setConnected(false);
			setConnectionError("");
			setRequestsPerSecond(0);
			setLatestData(null);
		} catch (error) {
			setConnectionError(error instanceof Error ? error.message : "Failed to disconnect from device");
		}
	};

	// Function to send text directly to the serial port
	const sendText = async (text: string) => {
		if (!connected || !writerRef.current) return;

		try {
			const encoder = new TextEncoder();
			const data = encoder.encode(text);

			await writerRef.current.write(data);
		} catch (error) {
			console.error("Error sending message:", error);
		}
	};

	const startReading = async (serialPort: SerialPort) => {
		if (!serialPort.readable || !serialPort.writable) return;

		const decoder = new TextDecoder();
		let buffer = "";

		isReadingRef.current = true;

		const readLoop = async () => {
			try {
				while (serialPort.readable && isReadingRef.current) {
					readerRef.current = serialPort.readable.getReader();
					writerRef.current = serialPort.writable.getWriter();

					try {
						let shouldRequestData = true;

						while (isReadingRef.current) {
							if (shouldRequestData) {
								try {
									await writerRef.current.write(requestData);
									requestCountRef.current++;
									shouldRequestData = false;
								} catch (writeErr) {
									console.error("Write error:", writeErr);
									break;
								}
							}

							// Read data
							try {
								if (!readerRef.current) break;

								const { value, done } = await readerRef.current.read();

								if (done) break;

								if (value) {
									buffer += decoder.decode(value, { stream: true });

									// CRITICAL FIX: a single read() can return MULTIPLE complete
									// lines at once (e.g. the firmware firing off several rapid
									// "c" responses back-to-back from consecutive z/l commands).
									// The old code only checked buffer.endsWith("\n") and then
									// treated the ENTIRE accumulated buffer as one line -- if two
									// "c" lines arrived in the same chunk, they'd get concatenated
									// together and parsed as one garbled line with double the
									// numbers, which is exactly what caused the LED Panels list to
									// explode to 50+ entries after rapid sensor add/remove clicks.
									//
									// Fix: split on every "\n", process each complete line on its
									// own, and keep any trailing partial line (no newline yet) in
									// the buffer for the next read() call.
									if (buffer.includes("\n")) {
										const lines = buffer.split("\n");
										// The last element is whatever's after the final "\n" --
										// either empty string (chunk ended exactly on a newline) or
										// a partial line still waiting for more data.
										buffer = lines.pop() ?? "";

										let requestedThisBatch = false;

										for (const rawLine of lines) {
											const trimmedLine = rawLine.trim();
											if (trimmedLine.length === 0) continue;

											// for now we ignore the returns of the new threshold value
											// later on we should update the thresholds based on the real value
											if (trimmedLine.startsWith("v")) {
												const values = trimmedLine
													.split(" ")
													.slice(1)
													.map((v) => Number.parseInt(v, 10));

												// Update numSensors whenever the firmware reports a different
												// count than what we currently have -- not just the first time
												// it goes from 0 to something. This lets the dashboard pick up
												// FSRs added live via "n <count>" (e.g. clicking "+ Add FSR
												// sensor") without requiring a full page reload to re-detect.
												const numSensors = useDataStore.getState().numSensors;
												if (values.length > 0 && values.length !== numSensors) {
													setNumSensors(values.length);
												}

												setLatestData({
													rawData: trimmedLine,
													values,
												});

												// Notify callback on every read
												try {
													onValuesRef.current?.(values);
												} catch (cbErr) {
													console.error("onValues callback error", cbErr);
												}

												requestedThisBatch = true;
											} else {
												// Any non-"v" line (c ..., p ..., q_ok, z_ok, n_ok, s ..., t ...,
												// y_err, etc.) is forwarded here so sections like LedSection and
												// SensorTuningSection can parse their own config sync responses.
												// Previously these lines were silently dropped, which meant
												// "Sync from pad" never actually pulled real firmware state.
												try {
													onLineRef.current?.(trimmedLine);
												} catch (cbErr) {
													console.error("onLine callback error", cbErr);
												}
											}
										}

										// Apply throttling if not using unthrottled polling. Only
										// throttle/re-request once per batch of lines processed,
										// not once per line, to avoid over-delaying when multiple
										// lines legitimately arrive together.
										if (requestedThisBatch) {
											if (!useUnthrottledPollingRef.current && pollingRateRef.current > 0) {
												const delayMs = 1000 / pollingRateRef.current;
												await new Promise((resolve) => setTimeout(resolve, delayMs));
											}
											shouldRequestData = true;
										}
									}
								}
							} catch (readErr) {
								if (isReadingRef.current) console.error("Read error:", readErr);
								break;
							}
						}
					} finally {
						if (readerRef.current) {
							readerRef.current.releaseLock();
							readerRef.current = null;
						}
					}
				}
			} catch (error) {
				if (isReadingRef.current) setConnectionError(error instanceof Error ? error.message : "Error reading from serial port");
			}
		};

		readLoop();
	};

	return {
		connect,
		disconnect,
		connected,
		connectionError,
		latestData,
		isSupported: "serial" in navigator,
		requestsPerSecond,
		sendText,
	};
};
