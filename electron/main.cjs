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

  // Allow serial permission checks
  win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'serial'
  })

  // Allow serial device access
  win.webContents.session.setDevicePermissionHandler((details) => {
    return details.deviceType === 'serial'
  })

  win.on('closed', () => {
    mainWindow = null
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

app.whenReady().then(() => {
  createWindow()
  startItgManiaBridge()
  startObsStaticServer()

  updater = setupAutoUpdater(mainWindow)
  updater.checkForUpdates()
  setInterval(() => updater.checkForUpdates(), 4 * 60 * 60 * 1000) // re-check every 4h
})

app.on('window-all-closed', () => {
  stopItgManiaBridge()
  stopObsStaticServer()
  if (process.platform !== 'darwin') app.quit()
})
