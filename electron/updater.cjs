// updater.cjs
//
// Wraps electron-updater for the Awakened Animus desktop app. Wired up from
// main.cjs (see the require + setupAutoUpdater call there) and exposed to the
// renderer via the electronAPI bridge in preload.cjs.
//
// Requires electron-updater as a dependency:
//   npm install electron-updater
//
// Requires your package.json's electron-builder config to publish to GitHub
// Releases (same repo you'd use for firmware releases, or a separate one --
// either works, electron-updater just reads the "publish" block):
//
//   "build": {
//     "publish": [{ "provider": "github", "owner": "your-username", "repo": "your-repo" }]
//   }
//
// Then ship a new version with: electron-builder build --publish always
// -----------------------------------------------------------------------------

const { autoUpdater } = require("electron-updater");
const { app } = require("electron");
const fs = require("fs");
const path = require("path");

const SKIP_FILE = path.join(app.getPath("userData"), "skipped-update.json");

function getSkippedVersion() {
	try {
		return JSON.parse(fs.readFileSync(SKIP_FILE, "utf8")).version;
	} catch {
		return null;
	}
}

function setSkippedVersion(version) {
	try {
		fs.writeFileSync(SKIP_FILE, JSON.stringify({ version }));
	} catch (err) {
		console.error("Failed to persist skipped update version:", err);
	}
}

/**
 * Wires up electron-updater and streams status to the renderer over
 * "updater:status". Downloading only ever happens after the user explicitly
 * accepts (autoDownload is off), so nothing installs itself without consent.
 */
function setupAutoUpdater(mainWindow) {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;

	const send = (payload) => {
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send("updater:status", payload);
		}
	};

	autoUpdater.on("checking-for-update", () => {
		send({ status: "checking" });
	});

	autoUpdater.on("update-available", (info) => {
		const skipped = getSkippedVersion();
		if (skipped === info.version) {
			// User already chose "Skip this version" — stay quiet until a newer one ships
			return;
		}
		send({
			status: "available",
			version: info.version,
			releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : null,
			releaseDate: info.releaseDate || null,
		});
	});

	autoUpdater.on("update-not-available", () => {
		send({ status: "up-to-date" });
	});

	autoUpdater.on("download-progress", (progress) => {
		send({ status: "downloading", percent: Math.round(progress.percent) });
	});

	autoUpdater.on("update-downloaded", (info) => {
		send({ status: "downloaded", version: info.version });
	});

	autoUpdater.on("error", (err) => {
		send({ status: "error", message: err == null ? "Unknown update error" : (err.message || String(err)) });
	});

	return {
		checkForUpdates: () => autoUpdater.checkForUpdates().catch((err) => send({ status: "error", message: err.message })),
		downloadUpdate: () => autoUpdater.downloadUpdate().catch((err) => send({ status: "error", message: err.message })),
		quitAndInstall: () => autoUpdater.quitAndInstall(),
		skipVersion: (version) => setSkippedVersion(version),
	};
}

module.exports = { setupAutoUpdater };
