// ============================================================
// PRELOAD SCRIPT -- runs with Node access, exposes a safe, minimal
// API to the renderer (dashboard.tsx) via contextBridge, since
// main.cjs has contextIsolation: true / nodeIntegration: false.
//
// IMPORTANT: main.cjs didn't come with a preload.cjs, so this is a
// best-effort reconstruction covering:
//   1. The ITGMania bridge calls main.cjs already expects
//      ('itgmania-bridge:broadcast', 'itgmania-bridge:get-port')
//   2. The firmware flashing calls added for the firmware Update feature
//   3. The app auto-update calls added for the electron-updater integration
//
// If you already have a preload.cjs with other exposed methods,
// merge the `electronAPI` object below into it rather than
// overwriting -- don't run two separate contextBridge.exposeInMainWorld
// calls under the same key ('electronAPI'), the second will just
// clobber the first.
// ============================================================

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // ── ITGMania bridge (inferred from main.cjs's existing handlers) ──
  broadcastToItgMania: (payload) => ipcRenderer.send('itgmania-bridge:broadcast', payload),
  getItgManiaBridgePort: () => ipcRenderer.invoke('itgmania-bridge:get-port'),

  // ── OBS overlay static server ──────────────────────────────────────
  // Returns e.g. "http://127.0.0.1:47831" -- the base URL of the local
  // HTTP server main.cjs runs to serve dist/obs/* pages for OBS Browser
  // Sources. Whatever builds the Component Type dialog's copyable URL
  // should use this (+ "/obs/<page>/?pwd=...") instead of a "file://"
  // path, since OBS's own Chromium (CEF) can't read files out of
  // app.asar the way Electron's patched one can -- see the longer
  // writeup on startObsStaticServer() in main.cjs.
  getObsServerBaseUrl: () => ipcRenderer.invoke('obs-server:get-base-url'),

  // ── Firmware flashing ──────────────────────────────────────────────
  // Checks whether the bundled teensy_loader_cli binary is actually
  // present for this platform BEFORE attempting a flash, so the UI can
  // show a clear "not set up" message instead of a cryptic spawn error.
  checkFirmwareLoaderAvailable: () => ipcRenderer.invoke('firmware:check-loader'),

  // hexBytes: an ArrayBuffer of the .hex file's raw contents (the
  // renderer fetches this itself from the manifest's hexUrl and passes
  // it straight through -- main.cjs just needs the bytes, it doesn't
  // need to know where they came from).
  // Returns a Promise that resolves { success: true } or rejects with
  // an Error if teensy_loader_cli isn't found, fails to launch, or
  // exits with a non-zero code.
  flashFirmware: (hexBytes) => ipcRenderer.invoke('firmware:flash', hexBytes),

  // Subscribes to live progress lines from teensy_loader_cli while a
  // flash is in progress (e.g. "Waiting for Teensy device...",
  // "Programming...", "Booting..."). Returns an unsubscribe function --
  // call it in a useEffect cleanup to avoid leaking listeners across
  // multiple flash attempts.
  onFirmwareFlashProgress: (callback) => {
    const handler = (_event, line) => callback(line)
    ipcRenderer.on('firmware:flash-progress', handler)
    return () => ipcRenderer.removeListener('firmware:flash-progress', handler)
  },

  // ── App auto-updates (Update feature) ──────────────────────────────────
  // Subscribes to updater status changes (checking / available / downloading
  // / downloaded / up-to-date / error). Returns an unsubscribe function --
  // call it in a useEffect cleanup.
  onUpdaterStatus: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('updater:status', handler)
    return () => ipcRenderer.removeListener('updater:status', handler)
  },
  // Starts downloading the update the user just accepted.
  downloadUpdate: () => ipcRenderer.invoke('updater:download'),
  // Quits and installs an already-downloaded update.
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  // Persists "don't ask about this version again" so it won't reappear
  // until a newer version ships.
  skipUpdateVersion: (version) => ipcRenderer.invoke('updater:skip', version),
  // Manually re-triggers a check (e.g. the "Try Again" button after an error).
  checkForUpdatesAgain: () => ipcRenderer.invoke('updater:check-again'),
})

// ── Song history + heart rate (HR/Songs stats tab) ───────────────────────
// Separate exposeInMainWorld key from electronAPI above, matching the
// existing convention of splitting concerns (see itgManiaBridge in
// dashboard.tsx) rather than growing electronAPI indefinitely.
contextBridge.exposeInMainWorld('songHistoryBridge', {
  selectFolder: () => ipcRenderer.invoke('song-log:select-folder'),
  getFolder: () => ipcRenderer.invoke('song-log:get-folder'),
  selectInstallFolder: () => ipcRenderer.invoke('song-log:select-install-folder'),
  getInstallFolder: () => ipcRenderer.invoke('song-log:get-install-folder'),
  getAllSongs: () => ipcRenderer.invoke('song-log:get-all'),
  onSongLogUpdate: (callback) => {
    const listener = (_event, entries) => callback(entries)
    ipcRenderer.on('song-log:updated', listener)
    return () => ipcRenderer.removeListener('song-log:updated', listener)
  },
  sendHeartrateSample: (sample) => ipcRenderer.send('heartrate:sample', sample),
  getAllHeartrateSamples: () => ipcRenderer.invoke('heartrate:get-samples'),
  getMediaBaseUrl: () => ipcRenderer.invoke('song-log:get-media-base-url'),
})
