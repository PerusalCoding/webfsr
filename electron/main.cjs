const { app, BrowserWindow, dialog } = require('electron')
const path = require('path')

// Enable WebSerial and other experimental web platform features
app.commandLine.appendSwitch('enable-experimental-web-platform-features')

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
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
  win.loadFile(path.join(__dirname, '../dist/index.html'))
}

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
