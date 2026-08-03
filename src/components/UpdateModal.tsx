import { useEffect, useState } from "react";
import { Download, X, Clock, SkipForward, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button";

// ---------------------------------------------------------------------------
// Wire-up: render <UpdateModal animusTheme={animusTheme} rubyTheme={rubyTheme} />
// once, near the top of your app tree (same level as the sidebar), so its
// `position: fixed` overlay sits above everything. It reads window.electronAPI
// (exposed by preload.cjs) and stays invisible unless an update is available,
// downloading, downloaded, or errored — checking/up-to-date are silent.
// ---------------------------------------------------------------------------

type UpdaterStatus =
	| { status: "checking" }
	| { status: "up-to-date" }
	| { status: "available"; version: string; releaseNotes: string | null; releaseDate: string | null }
	| { status: "downloading"; percent: number }
	| { status: "downloaded"; version: string }
	| { status: "error"; message: string };

declare global {
	interface Window {
		electronAPI?: {
			onUpdaterStatus: (callback: (payload: UpdaterStatus) => void) => () => void;
			downloadUpdate: () => Promise<void>;
			installUpdate: () => Promise<void>;
			skipUpdateVersion: (version: string) => Promise<void>;
			checkForUpdatesAgain: () => Promise<void>;
		};
	}
}

export type UpdateModalProps = {
	animusTheme?: boolean;
	rubyTheme?: boolean;
};

export default function UpdateModal({ animusTheme = false, rubyTheme = false }: UpdateModalProps) {
	const [state, setState] = useState<UpdaterStatus>({ status: "up-to-date" });
	const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

	useEffect(() => {
		if (!window.electronAPI) return;
		const unsubscribe = window.electronAPI.onUpdaterStatus((payload) => setState(payload));
		return unsubscribe;
	}, []);

	const version = state.status === "available" || state.status === "downloaded" ? state.version : null;

	// Nothing to show: silent states, or the user already hit "Remind me later" this session
	const visible =
		(state.status === "available" || state.status === "downloading" || state.status === "downloaded" || state.status === "error") &&
		!(version && dismissedVersion === version);

	if (!visible) return null;

	const handleRemindLater = () => {
		if (version) setDismissedVersion(version);
	};

	const handleSkip = async () => {
		if (version) {
			await window.electronAPI?.skipUpdateVersion(version);
			setDismissedVersion(version);
		}
	};

	const handleUpdateNow = () => {
		if (state.status === "downloaded") {
			window.electronAPI?.installUpdate();
		} else {
			window.electronAPI?.downloadUpdate();
		}
	};

	const wordmarkGradient = rubyTheme
		? "linear-gradient(135deg, #7A0C1E 0%, #E6394F 35%, #FF4D4D 70%, #FF8A5B 100%)"
		: animusTheme
			? "linear-gradient(135deg, #C9A227 0%, #E8B830 35%, #00E5CC 70%, #00BFAA 100%)"
			: "linear-gradient(135deg, #6B7280 0%, #374151 100%)";

	const glow = rubyTheme
		? "0 0 8px rgba(255,59,59,0.6), 0 0 20px rgba(200,20,40,0.4)"
		: animusTheme
			? "0 0 6px rgba(0,229,204,0.35)"
			: "none";

	const accentSolid = rubyTheme ? "#DC2626" : animusTheme ? "#C9A227" : "var(--primary)";

	return (
		<div
			className="fixed inset-0 z-[999] flex items-center justify-center p-4"
			style={{ background: "rgba(0,0,0,0.55)", backdropFilter: "blur(2px)" }}
		>
			<div
				className="relative w-full max-w-sm rounded-lg border shadow-2xl"
				style={{
					background: "rgb(var(--card))",
					borderColor: "rgb(var(--border))",
					color: "rgb(var(--card-foreground))",
				}}
			>
				<button
					className="absolute top-3 right-3 size-6 flex items-center justify-center rounded-full opacity-50 hover:opacity-100 transition-opacity"
					onClick={handleRemindLater}
					aria-label="Dismiss (remind me later)"
				>
					<X className="size-4" />
				</button>

				{/* Header */}
				<div className="p-5 pb-3 text-center border-b" style={{ borderColor: "rgb(var(--border))" }}>
					<span
						style={{
							backgroundImage: wordmarkGradient,
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
							backgroundClip: "text",
							color: "transparent",
							fontWeight: 900,
							letterSpacing: "0.1em",
							display: "block",
							fontSize: "0.95rem",
							textTransform: "uppercase",
							textShadow: glow,
						}}
					>
						Awakened Animus
					</span>

					<div className="mt-3 flex items-center justify-center gap-2">
						{state.status === "error" ? (
							<AlertTriangle className="size-5" style={{ color: "#EF4444" }} />
						) : (
							<Download className="size-5" style={{ color: accentSolid }} />
						)}
						<h2 className="text-base font-semibold">
							{state.status === "error"
								? "Update Check Failed"
								: state.status === "downloaded"
									? "Update Ready to Install"
									: state.status === "downloading"
										? "Downloading Update…"
										: "Update Available"}
						</h2>
					</div>
				</div>

				{/* Body */}
				<div className="p-5 pt-4 space-y-3">
					{state.status === "error" ? (
						<p className="text-sm" style={{ color: "rgb(var(--muted-foreground))" }}>
							{state.message}
						</p>
					) : (
						<>
							{version && (
								<p className="text-sm text-center">
									Version <span className="font-semibold">{version}</span> is ready
									{state.status === "downloaded" ? " to install." : "."}
								</p>
							)}

							{state.status === "available" && state.releaseNotes && (
								<div
									className="text-xs rounded p-2 max-h-32 overflow-y-auto"
									style={{ background: "rgb(var(--muted))", color: "rgb(var(--muted-foreground))" }}
									dangerouslySetInnerHTML={{ __html: state.releaseNotes }}
								/>
							)}

							{state.status === "downloading" && (
								<div className="space-y-1.5">
									<div
										className="h-2 rounded-full overflow-hidden"
										style={{ background: "rgb(var(--muted))" }}
									>
										<div
											className="h-full rounded-full transition-all"
											style={{ width: `${state.percent}%`, background: accentSolid }}
										/>
									</div>
									<p className="text-xs text-center" style={{ color: "rgb(var(--muted-foreground))" }}>
										{state.percent}%
									</p>
								</div>
							)}
						</>
					)}
				</div>

				{/* Actions */}
				<div className="p-5 pt-2 flex flex-col gap-2">
					{state.status === "error" ? (
						<Button className="w-full" onClick={() => window.electronAPI?.checkForUpdatesAgain()}>
							<RefreshCw className="size-4 mr-1.5" />
							Try Again
						</Button>
					) : state.status === "downloading" ? (
						<Button className="w-full" disabled>
							<Download className="size-4 mr-1.5" />
							Downloading…
						</Button>
					) : (
						<>
							<Button className="w-full" onClick={handleUpdateNow}>
								<Download className="size-4 mr-1.5" />
								{state.status === "downloaded" ? "Restart & Install Now" : "Update Now"}
							</Button>
							<div className="flex gap-2">
								<Button variant="outline" size="sm" className="flex-1" onClick={handleRemindLater}>
									<Clock className="size-3.5 mr-1.5" />
									Remind Me Later
								</Button>
								<Button variant="outline" size="sm" className="flex-1" onClick={handleSkip}>
									<SkipForward className="size-3.5 mr-1.5" />
									Skip This Version
								</Button>
							</div>
						</>
					)}
				</div>
			</div>
		</div>
	);
}
