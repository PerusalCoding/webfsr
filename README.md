<div align="center">
  <h1 style="border-bottom: none;">
    <a href="https://perusalcoding.github.io/webfsr/">Awakened Animus - WebFSR</a>
  </h1>
</div>

<div align="center">
  <h3 style="border-bottom: none;">
    Web client for managing custom FSR dance pads running the <a href="https://github.com/PerusalCoding/webfsr/tree/main/Fsr_Public%20Ino%20file">teejusb FSR firmware</a>.
  </h3>
</div>

## Features

- **Advanced Sensor Tuning:**
  - Dual-threshold **Trigger** (red line) and **Release** (green line) adjustments with lockable release toggles.
  - Per-sensor **Gain** and **Debounce** rate fine-tuning.
  - **Sensor Grouping** to assign individual FSRs to share or map to specific pad buttons.
- **Custom LED Panels & Lighting:**
  - Dedicated **LEDs tab** to configure panel lighting, arrow counts, and custom LED mapping.
  - Automatic arrow pairing: naming a secondary FSR with a `2` (e.g., `Up 2`, `Left 2`) automatically maps it to the primary arrow panel for dynamic Hue shifts and color changes.
  - Preset support for **Default 4**, **Default 6**, **DDR**, **Fire**, and **Ice** presets, plus custom preset creation and pad sync.
- **Microcontroller Integration:** Connect directly to your pad over WebSerial (requires a Chromium-based browser).
- **OBS Browser Source Integration:** Dedicated websocket server links to stream sensor bars, live graphs, or heart rate monitoring directly into OBS.
- **External Device Control:** Pair mobile devices via peer-to-peer WebRTC to tweak thresholds on the fly.
- **Installable PWA & Profile Support:** Save profiles locally using IndexedDB and run as a standalone desktop app.

## Screenshots

### Sensor Tuning
<img src="./screenshot.png" alt="Awakened Animus Sensor Tuning" />

### LED Panel & Arrow Mapping
<img src="./screenshot-leds.png" alt="Awakened Animus LED Configuration" />

## PWA Installation

WebFSR is installable as a PWA. This will allow you to run it offline and in a separate window, which is more convenient than managing it in a browser tab.

To install it as a PWA, find a button in the top-right corner of your browser which says "Install WebFSR":

<img src="./pwa.png" alt="Install Awakened Animus as PWA button" />

## Managing thresholds from an external device

> [!NOTE]
> Direct WebRTC connections may not always be possible on certain restrictive networks (e.g. universities, mobile). If you self-host, trystero allows adding a TURN server to proxy connections. Additionally, check your browser's WebRTC settings if the devices are failing to connect (for example, Helium Browser's #webrtc-ip-handling-policy flag needs to be set to "Default").

A mobile device can be paired to control the thresholds of the connected pad. This is completely peer-to-peer, using WebRTC for communication. 

The initial signaling handshake is done using [trystero](https://github.com/dmotz/trystero) with the BitTorrent backend, using open torrent trackers as the signaling server to match peers and exchange WebRTC SDP needed to make a connection. Per trystero documentation, all signaling communication is encrypted using the unique app and room ID. 

## OBS Browser Source Components

> [!IMPORTANT]
> Minimizing or occluding the page will likely cause the websocket connection to be heavily throttled. Until a good mitigation for this is found, bring the tab/PWA into focus, and then open ITG without focusing any other window.

Each visualization can be loaded in a separate route to display in an OBS Browser Source. This allows for high quality stream elements without resorting to using Window Capture.

This feature works by using the websocket server built into OBS. Each route connects as a client, and the main page sends data to each of the component pages through obs-websocket.

Steps to use the OBS Browser Source components:

1. Enable the OBS websocket server by going to Tools > WebSocket Server Settings > Enable WebSocket Server
2. Copy the password under Server Password
3. In the main page under the OBS section, paste the password
4. Customize a component using the "Create component" button in the OBS section
5. Copy the generated link and paste that into the source URL for an OBS Browser Source

Components are located at the route `/obs/{visualization}/`.

List of the current routes:

- `/obs/sensors/`
- `/obs/graph/`
- `/obs/heartrate/`

## Future TODO

- Integration with ITGmania
   - Send real-time theme data to the client. This would allow for more in-depth statistical analysis which would support in pad debugging. For example, each miss can be sent to the client, connecting a miss in game with a specific sensor value.
   - This would be accomplished with a websocket server running locally on the machine, which will receive data from a theme module and pass it along to the client.
- Import profiles saved from teejusb FSR web UI.

## Development

### Prerequisites

- pnpm

### Setup

1. Clone the repo
2. Install dependencies:
```bash
pnpm install