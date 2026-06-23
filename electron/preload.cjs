const { contextBridge, ipcRenderer } = require('electron')

// Exposes a minimal, safe bridge from the renderer (dashboard.tsx) to the
// main process's ITGMania WebSocket server. The renderer never gets raw
// Node/IPC access -- just this one function.
//
// Usage in dashboard.tsx:
//   window.itgManiaBridge?.broadcast({
//     values: latestData.values,
//     triggered: [...],   // boolean per sensor, computed from thresholds
//     timestamp: Date.now(),
//   })
contextBridge.exposeInMainWorld('itgManiaBridge', {
  broadcast: (payload) => ipcRenderer.send('itgmania-bridge:broadcast', payload),
  getPort: () => ipcRenderer.invoke('itgmania-bridge:get-port'),
})
