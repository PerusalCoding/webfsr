const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { WebSocketServer } = require('ws')

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

    const sendProgress = (line) => {
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
      if (code === 0) {
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

// ── IPC: firmware flashing ───────────────────────────────────────────────
// hexBytes arrives as an ArrayBuffer from the renderer (it already fetched
// the .hex from the manifest's hexUrl); ipcMain.handle auto-marshals it as
// a Buffer-compatible Uint8Array on this side.
ipcMain.handle('firmware:check-loader', () => checkTeensyLoaderAvailable())
ipcMain.handle('firmware:flash', (event, hexBytes) => flashFirmware(event, hexBytes))

app.whenReady().then(() => {
  createWindow()
  startItgManiaBridge()
})

app.on('window-all-closed', () => {
  stopItgManiaBridge()
  if (process.platform !== 'darwin') app.quit()
})
