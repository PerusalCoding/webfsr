const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const http = require('http')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')
const { setupAutoUpdater } = require('./updater.cjs')

// Enable WebSerial and other experimental web platform features
app.commandLine.appendSwitch('enable-experimental-web-platform-features')

// ── ITGMania bridge ──────────────────────────────────────────────────────────
// A tiny local WebSocket server that broadcasts live sensor values and
// trigger state to any connected client -- specifically the ITGMania Lua
// module (see itgmania_module/Scripts/FSROverlay.lua), so the overlay can
// show sensor bars live during gameplay without alt-tabbing back to this
// app.
//
// The renderer (dashboard.tsx) already owns the actual serial connection
// via Web Serial -- it just forwards data into this process via IPC
// whenever new sensor values come in, and this process re-broadcasts that
// over the WebSocket to any listeners (the Lua module).
const ITGMANIA_BRIDGE_PORT = 7777
let wss = null
let bridgeClients = new Set()
let mainWindow = null
let updater = null

function startItgManiaBridge() {
  if (wss) return // already running

  wss = new WebSocketServer({ port: ITGMANIA_BRIDGE_PORT })

  wss.on('connection', (socket) => {
    bridgeClients.add(socket)
    console.log(`[ITGMania bridge] client connected (${bridgeClients.size} total)`)

    socket.on('close', () => {
      bridgeClients.delete(socket)
      console.log(`[ITGMania bridge] client disconnected (${bridgeClients.size} remaining)`)
    })

    socket.on('error', (err) => {
      console.error('[ITGMania bridge] socket error:', err)
      bridgeClients.delete(socket)
    })
  })

  wss.on('error', (err) => {
    // Most common cause: port already in use (e.g. app restarted too
    // quickly, or another instance is already running).
    console.error('[ITGMania bridge] server error:', err)
  })

  console.log(`[ITGMania bridge] listening on ws://localhost:${ITGMANIA_BRIDGE_PORT}`)
}

function broadcastToItgMania(payload) {
  if (!wss) return
  // Wire format: a simple delimited string instead of JSON. ITGMania's
  // built-in Lua API doesn't expose a confirmed JSON decoder (the
  // TwitchChat module itself avoids JSON and parses raw IRC text with
  // string.find/gmatch instead), so we keep parsing trivial on the Lua
  // side with basic string.gmatch over a fixed, simple format:
  //
  //   FSR|v1,v2,v3,...|t1,t2,t3,...|label1,label2,label3,...|timestamp
  //
  // v = raw sensor value (0-1023), t = 1 or 0 for triggered/not,
  // labels are comma separated (no commas allowed in a label).
  const { values = [], triggered = [], labels = [], timestamp = Date.now() } = payload
  const valuesStr = values.join(',')
  const triggeredStr = triggered.map((t) => (t ? '1' : '0')).join(',')
  const labelsStr = labels.map((l) => String(l).replace(/[|,]/g, '')).join(',')
  const message = `FSR|${valuesStr}|${triggeredStr}|${labelsStr}|${timestamp}`

  for (const socket of bridgeClients) {
    if (socket.readyState === socket.OPEN) {
      socket.send(message)
    }
  }
}

function stopItgManiaBridge() {
  if (!wss) return
  for (const socket of bridgeClients) socket.close()
  bridgeClients.clear()
  wss.close()
  wss = null
  console.log('[ITGMania bridge] server stopped')
}

// ── OBS overlay static server ────────────────────────────────────────────
// The OBS Component dialog generates URLs like
// "file:///.../resources/app.asar/dist/obs/sensors/?pwd=..." for people to
// paste into an OBS Browser Source. That silently fails to load ANYTHING:
// Electron patches its own bundled Chromium to transparently read files
// out of app.asar, but OBS's Browser Source runs a separate, plain,
// unmodified CEF (Chromium Embedded Framework) instance that has never
// heard of app.asar -- to it, app.asar just looks like one opaque binary
// file, not a folder it can look inside. The page never loads, so nothing
// on it (including its obs-websocket-js connection) ever gets the chance
// to run -- which is what looked like "the OBS component can't connect
// to the websocket," but was actually "the page never loaded at all."
//
// Fix: serve dist/obs/ over plain HTTP instead. This process (Electron's
// MAIN process, not the renderer) runs under a full Node.js environment,
// and Electron's Node-level `fs` patches (not just its Chromium ones) DO
// transparently support reading out of app.asar -- so a normal Node
// http.Server here can read these files fine even when packaged. OBS's
// Browser Source then just talks plain HTTP to this server like it would
// to any other website, never touching app.asar directly at all.
//
// Deliberately NOT using OBS's own websocket port (4455) -- that's OBS's
// own server that THIS APP connects to as a client (via obs-websocket-js)
// for the broadcast/CustomEvent channel; it's unrelated to serving these
// static pages, and reusing it would conflict with OBS's own listener.
const OBS_STATIC_SERVER_PORT = 47831
const OBS_MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
let obsServer = null

function getObsStaticRoot() {
  // app.getAppPath() resolves consistently to the project root in dev and
  // to the app.asar path once packaged -- Node's fs (see comment above)
  // reads through the latter transparently, so this one path works for
  // both without branching on app.isPackaged.
  return path.join(app.getAppPath(), 'dist', 'obs')
}

function getDistRoot() {
  // The full dist/ root -- needed to serve /assets/ which lives at
  // dist/assets/, one level above dist/obs/ where the overlays live.
  return path.join(app.getAppPath(), 'dist')
}

function startObsStaticServer() {
  if (obsServer) return // already running

  const root = getObsStaticRoot()

  obsServer = http.createServer((req, res) => {
    try {
      // Strip the query string (?pwd=... etc.) before resolving a file
      // path with it -- the OBS pages read that client-side via
      // URLSearchParams once loaded, it's irrelevant to which file to
      // serve.
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0])

      // Directory requests resolve to that directory's index.html, same
      // as a normal web server -- this is what a trailing-slash URL like
      // "/sensors/" needs to actually resolve to a real file.
      if (urlPath.endsWith('/')) urlPath += 'index.html'

      // /assets/ lives at dist/assets/, not dist/obs/assets/ -- resolve
      // these from the dist root instead of the obs root so Vite-built
      // JS/CSS chunks are found correctly.
      const distRoot = getDistRoot()
      let resolveBase = root
      if (urlPath.startsWith('/assets/') || urlPath.startsWith('/registerSW') || urlPath === '/manifest.webmanifest') {
        resolveBase = distRoot
      }

      const filePath = path.join(resolveBase, urlPath)
      const safeBase = resolveBase
      if (!filePath.startsWith(safeBase) && !filePath.startsWith(distRoot)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      fs.readFile(filePath, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const ext = path.extname(filePath).toLowerCase()
        const contentType = OBS_MIME_TYPES[ext] || 'application/octet-stream'

        // HTML files from obs/*/index.html use relative paths like
        // "../../assets/foo.js" which break when served from /sensors/ etc.
        // Also strip the PWA manifest link and registerSW script -- they use
        // "./" paths that resolve to the wrong directory and throw JS errors
        // that prevent the React app from mounting at all.
        // We fix both by rewriting the HTML before sending it.
        let responseData = data
        if (ext === '.html') {
          let html = data.toString('utf8')
          // Fix ../../assets/ -> /assets/ (and any other relative escapes)
          html = html.replace(/src="\.\.\/\.\.\/assets\//g, 'src="/assets/')
          html = html.replace(/href="\.\.\/\.\.\/assets\//g, 'href="/assets/')
          // Remove PWA manifest and registerSW injection -- they don't belong
          // in the OBS overlay pages and break them with bad relative paths.
          html = html.replace(/<link rel="manifest"[^>]*>/g, '')
          html = html.replace(/<script[^>]*vite-plugin-pwa[^>]*>[^<]*<\/script>/g, '')
          html = html.replace(/<script[^>]*registerSW\.js[^>]*><\/script>/g, '')
          responseData = Buffer.from(html, 'utf8')
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
          'Content-Length': responseData.length,
        })
        res.end(responseData)
      })
    } catch (err) {
      console.error('[OBS static server] request error:', err)
      res.writeHead(500)
      res.end('Internal error')
    }
  })

  obsServer.on('error', (err) => {
    // Most common cause: port already in use (e.g. app restarted too
    // quickly, or another instance is already running) -- mirrors the
    // ITGMania bridge's error handling above.
    console.error('[OBS static server] server error:', err)
  })

  obsServer.listen(OBS_STATIC_SERVER_PORT, '127.0.0.1', () => {
    console.log(`[OBS static server] serving ${root} at http://127.0.0.1:${OBS_STATIC_SERVER_PORT}`)
  })
}

function stopObsStaticServer() {
  if (!obsServer) return
  obsServer.close()
  obsServer = null
  console.log('[OBS static server] server stopped')
}

// ── Firmware flashing (WebFsr Update feature) ───────────────────────────────
// Actually writing new firmware to the Teensy happens over raw USB HID to
// its HalfKay bootloader -- a genuinely different, low-level protocol from
// the WebSerial connection the renderer uses for normal operation. Rather
// than hand-rolling that byte-level protocol (real risk of getting it
// subtly wrong), this shells out to PJRC's own official, battle-tested
// `teensy_loader_cli` -- the same tool the real Arduino IDE/Teensyduino
// uses under the hood.
//
// SETUP REQUIRED: download the prebuilt teensy_loader_cli binary for each
// platform you ship from PJRC's own repo:
//   https://github.com/PaulStoffregen/teensy_loader_cli
// and place them at:
//   resources/teensy_loader_cli/win32/teensy_loader_cli.exe
//   resources/teensy_loader_cli/darwin/teensy_loader_cli
//   resources/teensy_loader_cli/linux/teensy_loader_cli
// Then add `resources/teensy_loader_cli` to your electron-builder config's
// `extraResources` so it gets copied into the packaged app (not just work
// in dev). On macOS/Linux the binary also needs its executable bit set
// (`chmod +x`) -- do this once when you add the file, git preserves it.

function getTeensyLoaderPath() {
  const platform = process.platform // 'win32' | 'darwin' | 'linux'
  const binName = platform === 'win32' ? 'teensy_loader_cli.exe' : 'teensy_loader_cli'
  // In dev, resources/ sits next to this file's project root. Once
  // packaged, extraResources land in process.resourcesPath instead.
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'teensy_loader_cli')
    : path.join(__dirname, '..', 'resources', 'teensy_loader_cli')
  return path.join(base, platform, binName)
}

function checkTeensyLoaderAvailable() {
  const loaderPath = getTeensyLoaderPath()
  const exists = fs.existsSync(loaderPath)
  return { available: exists, path: loaderPath, platform: process.platform }
}

// Flashes a .hex file (received from the renderer as raw bytes, since the
// renderer already fetched it from the manifest's hexUrl) onto a Teensy.
// Streams teensy_loader_cli's own stdout/stderr back to the renderer line
// by line via `firmware:flash-progress` so the UI can show live status --
// this includes it waiting for the board to appear in bootloader mode, so
// the customer has time to press the physical button after being prompted.
function flashFirmware(event, hexBytes) {
  return new Promise((resolve, reject) => {
    const loader = checkTeensyLoaderAvailable()
    if (!loader.available) {
      reject(new Error(
        `teensy_loader_cli not found for this platform (expected at ${loader.path}). ` +
        `See the setup comment above getTeensyLoaderPath() in main.cjs.`
      ))
      return
    }

    let tmpHexPath
    try {
      tmpHexPath = path.join(os.tmpdir(), `webfsr-update-${Date.now()}.hex`)
      fs.writeFileSync(tmpHexPath, Buffer.from(hexBytes))
    } catch (err) {
      reject(new Error(`Couldn't write temp firmware file: ${err.message}`))
      return
    }

    const cleanup = () => {
      try { fs.unlinkSync(tmpHexPath) } catch { /* best effort */ }
    }

    // -w  : wait for the Teensy to appear in bootloader mode (gives the
    //       customer time to press the button after being prompted, or
    //       lets an already-triggered board be caught automatically)
    // -v  : verbose, so we get meaningful progress lines to relay
    // --mcu=TEENSY40 : must match your actual board. Change this if you
    //       ever ship on a different Teensy model.
    const child = spawn(loader.path, ['-w', '-v', '--mcu=TEENSY40', tmpHexPath])

    // teensy_loader_cli's exit code isn't fully reliable as a success/fail
    // signal on its own -- on Windows in particular, its final step (briefly
    // reopening the device to confirm the reboot handshake) can time out
    // waiting for the OS to re-enumerate the freshly-rebooted board, even
    // though the actual programming + reboot trigger already completed
    // successfully underneath. That produced exactly this: a genuine
    // success, followed by a spurious non-zero exit and an error shown to
    // the customer for an update that had already worked.
    //
    // "Booting" is the last line teensy_loader_cli prints once it has
    // successfully written the program AND told the board to reboot into
    // it -- everything that actually matters for the update to have taken.
    // Anything after that point (the flaky reopen/verify) doesn't change
    // whether the update itself succeeded, so we treat seeing "Booting" as
    // authoritative and only fall back to the raw exit code if we never
    // saw it (a genuine failure, e.g. device never entered bootloader mode,
    // wrong --mcu, verify mismatch, etc. all exit before printing it).
    let sawBootingLine = false
    const allOutput = []

    const sendProgress = (line) => {
      allOutput.push(line)
      if (line.includes('Booting')) sawBootingLine = true
      if (event?.sender && !event.sender.isDestroyed()) {
        event.sender.send('firmware:flash-progress', line)
      }
    }

    child.stdout.on('data', (data) => {
      String(data).split(/\r?\n/).filter(Boolean).forEach(sendProgress)
    })
    child.stderr.on('data', (data) => {
      String(data).split(/\r?\n/).filter(Boolean).forEach(sendProgress)
    })

    child.on('error', (err) => {
      cleanup()
      reject(new Error(`Failed to launch teensy_loader_cli: ${err.message}`))
    })

    child.on('close', (code) => {
      cleanup()
      if (code === 0 || sawBootingLine) {
        if (code !== 0) {
          console.warn(
            `[firmware] teensy_loader_cli exited with code ${code} but printed ` +
            `"Booting" -- treating as success (see comment above). Full output:\n` +
            allOutput.join('\n')
          )
        }
        resolve({ success: true })
      } else {
        reject(new Error(`teensy_loader_cli exited with code ${code}`))
      }
    })
  })
}

// ── Song + heart rate history ────────────────────────────────────────────
// SongHRLog.lua (itgmania_module/Scripts/) writes one JSON line per played
// song to <ITGMania root>/Save/AwakenedAnimus/SongHRLog.jsonl. We watch
// that file and forward its contents to the renderer, which correlates
// each song's [startTime, endTime] window against heart rate samples it
// forwards to us (via 'heartrate:sample') and logs to a separate file in
// this app's own userData dir -- so both survive an app restart.
const CONFIG_PATH = () => path.join(app.getPath('userData'), 'song-hr-config.json')
const HR_LOG_PATH = () => path.join(app.getPath('userData'), 'HRLog.jsonl')
const HR_LOG_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
let songLogWatcher = null

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'))
  } catch {
    return {}
  }
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH()), { recursive: true })
    fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2))
  } catch (err) {
    console.error('[song-log] failed to save config:', err)
  }
}

function getSongLogPath() {
  const cfg = loadConfig()
  if (!cfg.itgManiaRoot) return null
  return path.join(cfg.itgManiaRoot, 'Save', 'AwakenedAnimus', 'SongHRLog.jsonl')
}

// Shared with SongHRLog.lua's readPublishConfig() -- lets the Lua side
// know the player's display name and publish opt-in without the desktop
// app needing to be open, so it can publish the live "Now Playing"
// indicator directly. Written here whenever either value changes in the
// renderer (see the 'publish-config:save' IPC handler below).
function getPublishConfigPath() {
  const cfg = loadConfig()
  if (!cfg.itgManiaRoot) return null
  return path.join(cfg.itgManiaRoot, 'Save', 'AwakenedAnimus', 'publish_config.json')
}

function savePublishConfig(config) {
  const configPath = getPublishConfigPath()
  if (!configPath) return

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        playerName: typeof config?.playerName === 'string' ? config.playerName : '',
        publishEnabled: !!config?.publishEnabled,
        liveFeedEnabled: !!config?.liveFeedEnabled,
      }),
    )
  } catch (err) {
    console.error('[publish-config] failed to save:', err)
  }
}

// Separate from itgManiaRoot above: on a PORTABLE ITGMania install, Save/
// and Songs/ live together under one folder, so one root would suffice.
// But on an INSTALLED (non-portable) copy, Save/ lives under
// %APPDATA%/ITGmania while Songs/Themes/Program live wherever the game
// was actually installed -- two unrelated folders. itgManiaRoot (above)
// is always the Save-containing one (needed to find SongHRLog.jsonl);
// itgManiaInstallRoot is specifically for resolving banner image paths,
// which are relative to the Songs/ folder.
function getInstallRoot() {
  const cfg = loadConfig()
  return cfg.itgManiaInstallRoot || cfg.itgManiaRoot || null
}

function readSongLog() {
  const logPath = getSongLogPath()
  if (!logPath || !fs.existsSync(logPath)) return []

  try {
    const content = fs.readFileSync(logPath, 'utf8')
    const rawLines = content.split(/\r?\n/).filter(Boolean)

    let dirty = false
    const resolvedLines = []
    const entries = []

    for (const line of rawLines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }

      // SongHRLog.lua can't produce wall-clock timestamps (some ITGMania
      // builds don't expose the `os` library to theme Lua at all -- see
      // the comment in SongHRLog.lua) -- it only writes durationSeconds.
      // The first time we see an entry like that, stamp it with "now" as
      // endTime and derive startTime from the duration, then persist that
      // back to the file so it doesn't drift on every subsequent read.
      if (entry.endTime === undefined && typeof entry.durationSeconds === 'number') {
        const nowSeconds = Math.floor(Date.now() / 1000)
        entry.endTime = nowSeconds
        entry.startTime = nowSeconds - entry.durationSeconds
        dirty = true
      }

      entries.push(entry)
      resolvedLines.push(JSON.stringify(entry))
    }

    if (dirty) {
      try {
        fs.writeFileSync(logPath, resolvedLines.join('\n') + (resolvedLines.length > 0 ? '\n' : ''))
      } catch (err) {
        console.error('[song-log] failed to persist resolved timestamps:', err)
      }
    }

    return entries
  } catch (err) {
    console.error('[song-log] failed to read log:', err)
    return []
  }
}

// Deletes song log entries by startTime (epoch seconds) -- used by "clear
// this play" / "clear this day" / "clear all history" in the UI. Rewrites
// the whole file rather than seeking around in it since it's small and
// this only runs on an explicit user action, not on a hot path.
function deleteSongLogEntries(startTimes) {
  const logPath = getSongLogPath()
  if (!logPath || !fs.existsSync(logPath)) return readSongLog()
  if (!Array.isArray(startTimes) || startTimes.length === 0) return readSongLog()

  const toDelete = new Set(startTimes)

  try {
    const content = fs.readFileSync(logPath, 'utf8')
    const rawLines = content.split(/\r?\n/).filter(Boolean)
    const keptLines = []

    for (const line of rawLines) {
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        // Can't tell if an unparsable line is safe to drop -- keep it.
        keptLines.push(line)
        continue
      }

      if (typeof entry.startTime === 'number' && toDelete.has(entry.startTime)) {
        continue // this is the one being deleted
      }
      keptLines.push(line)
    }

    fs.writeFileSync(logPath, keptLines.join('\n') + (keptLines.length > 0 ? '\n' : ''))
  } catch (err) {
    console.error('[song-log] failed to delete entries:', err)
  }

  return readSongLog()
}

function watchSongLog(win) {
  const logPath = getSongLogPath()
  if (!logPath) return

  if (songLogWatcher) {
    songLogWatcher.close()
    songLogWatcher = null
  }

  // The Lua module creates the file lazily on first song played -- if it
  // doesn't exist yet, watch the parent dir instead so we notice once it
  // shows up, then re-watch the file itself.
  const dir = path.dirname(logPath)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch {
    // Best effort -- the Lua side will also try to create it.
  }

  const sendUpdate = () => {
    win?.webContents.send('song-log:updated', readSongLog())
  }

  try {
    songLogWatcher = fs.watch(dir, { persistent: false }, (eventType, filename) => {
      if (filename === 'SongHRLog.jsonl') sendUpdate()
    })
  } catch (err) {
    console.error('[song-log] failed to watch directory:', err)
  }
}

function trimHrLogOnStartup() {
  const logPath = HR_LOG_PATH()
  if (!fs.existsSync(logPath)) return

  try {
    const cutoff = Date.now() - HR_LOG_MAX_AGE_MS
    const content = fs.readFileSync(logPath, 'utf8')
    const kept = content
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => {
        try {
          const sample = JSON.parse(line)
          return typeof sample.timestamp === 'number' && sample.timestamp >= cutoff
        } catch {
          return false
        }
      })
    fs.writeFileSync(logPath, kept.join('\n') + (kept.length > 0 ? '\n' : ''))
  } catch (err) {
    console.error('[hr-log] failed to trim on startup:', err)
  }
}

function appendHrSample(sample) {
  if (!sample || typeof sample.heartrate !== 'number' || typeof sample.timestamp !== 'number') return
  try {
    fs.mkdirSync(path.dirname(HR_LOG_PATH()), { recursive: true })
    fs.appendFileSync(HR_LOG_PATH(), JSON.stringify(sample) + '\n')
  } catch (err) {
    console.error('[hr-log] failed to append sample:', err)
  }
}

function readHrLog() {
  const logPath = HR_LOG_PATH()
  if (!fs.existsSync(logPath)) return []

  try {
    const content = fs.readFileSync(logPath, 'utf8')
    return content
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  } catch (err) {
    console.error('[hr-log] failed to read log:', err)
    return []
  }
}

// ── Song banner image server ─────────────────────────────────────────────
// SongHRLog.lua logs each song's bannerPath, which is StepMania's *virtual*
// path (e.g. "/Songs/PackName/SongName/bn.png"), not something the renderer
// can load directly -- there's no file:// access for arbitrary paths under
// contextIsolation, and even if there were, cross-origin local file access
// from the Vite dev server origin would be blocked. So: a tiny local HTTP
// server, same trick as the OBS static server above, except this one maps
// requests onto <itgManiaRoot>/<bannerPath> and refuses anything that
// resolves outside that root (a banner path is untrusted input coming from
// a log file, so this containment check matters).
const MEDIA_SERVER_PORT = 47832
let mediaServer = null

function startMediaServer() {
  if (mediaServer) return

  mediaServer = http.createServer((req, res) => {
    try {
      const root = getInstallRoot()
      if (!root) {
        res.writeHead(404)
        res.end('No ITGMania install folder configured')
        return
      }

      const url = new URL(req.url, `http://127.0.0.1:${MEDIA_SERVER_PORT}`)
      const relPath = url.searchParams.get('path')
      if (!relPath) {
        res.writeHead(400)
        res.end('Missing path')
        return
      }

      const resolvedRoot = path.resolve(root)
      const resolvedTarget = path.resolve(resolvedRoot, '.' + path.sep + relPath.replace(/^[/\\]+/, ''))

      if (!resolvedTarget.startsWith(resolvedRoot)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      fs.readFile(resolvedTarget, (err, data) => {
        if (err) {
          res.writeHead(404)
          res.end('Not found')
          return
        }
        const ext = path.extname(resolvedTarget).toLowerCase()
        const contentType = OBS_MIME_TYPES[ext] || 'application/octet-stream'
        res.writeHead(200, { 'Content-Type': contentType })
        res.end(data)
      })
    } catch (err) {
      res.writeHead(500)
      res.end('Server error')
    }
  })

  mediaServer.listen(MEDIA_SERVER_PORT, '127.0.0.1')
}

function stopMediaServer() {
  if (!mediaServer) return
  mediaServer.close()
  mediaServer = null
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  mainWindow = win

  // Show a dialog so the user can pick their COM port
  win.webContents.session.on('select-serial-port', async (event, portList, webContents, callback) => {
    event.preventDefault()

    if (portList.length === 0) {
      callback('')
      return
    }

    // Build the list of buttons from available ports
    const buttons = portList.map(p => p.portName || p.portId)
    buttons.push('Cancel')

    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Select COM Port',
      message: 'Select your dance pad COM port:',
      buttons,
      cancelId: buttons.length - 1,
    })

    // If user clicked Cancel
    if (response === buttons.length - 1) {
      callback('')
    } else {
      callback(portList[response].portId)
    }
  })

  // Show a dialog so the user can pick their heart rate monitor.
  // Electron never shows a Bluetooth device picker on its own -- unlike
  // Chrome, it requires this handler on webContents.session, or
  // navigator.bluetooth.requestDevice() in the renderer (see
  // useHeartrateMonitor.ts) just hangs forever with no UI and no error.
  //
  // NOTE: this event can fire multiple times per scan as new BLE
  // advertisements come in, each time with the full list-so-far -- not
  // just once. We only resolve the callback once the user actually picks
  // something (or the outer scan itself is cancelled by the renderer),
  // so being called again with a longer list before that happens is
  // expected and not treated as an error.
  win.webContents.on('select-bluetooth-device', async (event, deviceList, callback) => {
    console.log(`[bluetooth] select-bluetooth-device fired with ${deviceList.length} device(s):`,
      deviceList.map((d) => d.deviceName || d.deviceId))

    event.preventDefault()

    if (deviceList.length === 0) {
      // No devices found yet -- don't resolve the callback. Resolving
      // with '' here would cancel the whole requestDevice() call the
      // instant the scan starts, before it's had a chance to find
      // anything. We just wait for the next update (more devices found)
      // or for the renderer's own timeout logic to give up.
      console.log('[bluetooth] deviceList empty -- waiting for next update, NOT calling callback')
      return
    }

    console.log('[bluetooth] showing picker dialog now')
    const buttons = deviceList.map((d) => d.deviceName || d.deviceId)
    buttons.push('Cancel')

    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Select Heart Rate Monitor',
      message: 'Select your heart rate monitor:',
      buttons,
      cancelId: buttons.length - 1,
    })

    if (response === buttons.length - 1) {
      console.log('[bluetooth] user clicked Cancel in dialog')
      callback('')
    } else {
      console.log(`[bluetooth] user picked: ${deviceList[response].deviceName || deviceList[response].deviceId}`)
      callback(deviceList[response].deviceId)
    }
  })

  // Allow serial + bluetooth permission checks
  win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    console.log(`[bluetooth] permission check: ${permission}`)
    return permission === 'serial' || permission === 'bluetooth'
  })

  // Allow serial + bluetooth device access
  win.webContents.session.setDevicePermissionHandler((details) => {
    console.log(`[bluetooth] device permission check: ${details.deviceType}`)
    return details.deviceType === 'serial' || details.deviceType === 'bluetooth'
  })

  win.on('closed', () => {
    mainWindow = null
    if (songLogWatcher) {
      songLogWatcher.close()
      songLogWatcher = null
    }
  })

  // Load the built Vite app
  // In development (npm run electron:dev), load the Vite dev server so
  // hot reload works. In production (after `vite build`), load the
  // built dist/index.html instead. Vite/Electron-builder set
  // NODE_ENV=production automatically when packaging; locally it's
  // undefined/"development" unless you've set it yourself.
  const isDev = process.env.NODE_ENV !== 'production' && !app.isPackaged
  if (isDev) {
    win.loadURL('http://localhost:5173')
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'))
  }
}

// ── IPC: renderer -> main, forwarding live sensor data to the bridge ────────
// dashboard.tsx (via the preload bridge below) calls this every time new
// values come in from the Teensy. We just relay it straight out to any
// connected ITGMania Lua client.
ipcMain.on('itgmania-bridge:broadcast', (event, payload) => {
  broadcastToItgMania(payload)
})

ipcMain.handle('itgmania-bridge:get-port', () => ITGMANIA_BRIDGE_PORT)

// ── IPC: OBS overlay static server ───────────────────────────────────────
// Wherever the Component Type dialog currently builds a "file:///..."
// URL, it needs to build "http://127.0.0.1:<port>/obs/<page>/?pwd=..."
// instead -- this exposes the port (and full base URL, so the renderer
// doesn't need to hardcode "http://127.0.0.1" itself) to do that.
ipcMain.handle('obs-server:get-base-url', () => `http://127.0.0.1:${OBS_STATIC_SERVER_PORT}`)

// ── IPC: firmware flashing ───────────────────────────────────────────────
// hexBytes arrives as an ArrayBuffer from the renderer (it already fetched
// the .hex from the manifest's hexUrl); ipcMain.handle auto-marshals it as
// a Buffer-compatible Uint8Array on this side.
ipcMain.handle('firmware:check-loader', () => checkTeensyLoaderAvailable())
ipcMain.handle('firmware:flash', (event, hexBytes) => flashFirmware(event, hexBytes))

// ── IPC: app auto-updates (Update feature) ──────────────────────────────────
// Checking happens automatically (on launch + every 4h below); nothing
// downloads or installs without the user hitting "Update Now" in the modal.
ipcMain.handle('updater:download', () => updater?.downloadUpdate())
ipcMain.handle('updater:install', () => updater?.quitAndInstall())
ipcMain.handle('updater:skip', (event, version) => updater?.skipVersion(version))
ipcMain.handle('updater:check-again', () => updater?.checkForUpdates())

// ── IPC: song + heart rate history ───────────────────────────────────────
ipcMain.handle('song-log:select-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your ITGMania install folder (the one containing Save/)',
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return { path: null, entries: [] }
  }

  const itgManiaRoot = result.filePaths[0]
  saveConfig({ ...loadConfig(), itgManiaRoot })
  watchSongLog(mainWindow)
  return { path: itgManiaRoot, entries: readSongLog() }
})

ipcMain.handle('song-log:get-folder', () => loadConfig().itgManiaRoot || null)

ipcMain.handle('song-log:select-install-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select your ITGMania install folder (the one containing Songs/ and Themes/)',
    properties: ['openDirectory'],
  })

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }

  const itgManiaInstallRoot = result.filePaths[0]
  saveConfig({ ...loadConfig(), itgManiaInstallRoot })
  return itgManiaInstallRoot
})

ipcMain.handle('song-log:get-install-folder', () => getInstallRoot())

ipcMain.handle('song-log:get-all', () => readSongLog())

// Deletes local song history entries by startTime (epoch seconds). Used
// by the "clear this play" / "clear this day" / "clear all history"
// controls in the UI. Returns the updated full entry list so the
// renderer can update instantly, in addition to the normal
// 'song-log:updated' push the file watcher fires from the write.
ipcMain.handle('song-log:delete-entries', (event, startTimes) => deleteSongLogEntries(startTimes))

ipcMain.handle('song-log:get-media-base-url', () => `http://127.0.0.1:${MEDIA_SERVER_PORT}`)

ipcMain.on('heartrate:sample', (event, sample) => {
  appendHrSample(sample)
})

ipcMain.handle('heartrate:get-samples', () => readHrLog())

ipcMain.on('publish-config:save', (event, config) => {
  savePublishConfig(config)
})

app.whenReady().then(() => {
  createWindow()
  startItgManiaBridge()
  startObsStaticServer()
  startMediaServer()
  trimHrLogOnStartup()
  watchSongLog(mainWindow)

  updater = setupAutoUpdater(mainWindow)
  updater.checkForUpdates()
  setInterval(() => updater.checkForUpdates(), 4 * 60 * 60 * 1000) // re-check every 4h
})

app.on('window-all-closed', () => {
  stopItgManiaBridge()
  stopObsStaticServer()
  stopMediaServer()
  if (process.platform !== 'darwin') app.quit()
})
