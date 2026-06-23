const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const path = require('path')
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

app.whenReady().then(() => {
  createWindow()
  startItgManiaBridge()
})

app.on('window-all-closed', () => {
  stopItgManiaBridge()
  if (process.platform !== 'darwin') app.quit()
})
