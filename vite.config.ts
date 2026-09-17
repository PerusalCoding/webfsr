import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
	appType: "mpa",
	define: {
		__BUILD_TIMESTAMP__: JSON.stringify(new Date().toISOString()),
		__APP_NAME__: JSON.stringify("WebFSR"),
		__REPO_URL__: JSON.stringify("https://github.com/emkooz/webfsr"),
		__COMMIT_HASH__: JSON.stringify(
			(() => {
				try {
					return execSync("git rev-parse --short HEAD").toString().trim();
				} catch {
					return "";
				}
			})(),
		),
		__BUILD_MODE__: JSON.stringify(process.env.NODE_ENV || "development"),
	},
	plugins: [
		react({
			babel: {
				plugins: [["babel-plugin-react-compiler", {}]],
			},
		}),
		tailwindcss(),
		VitePWA({
			registerType: "autoUpdate",
			// Was "auto" -- that injects the SW registration script into
			// EVERY html entry Vite processes, including the obs/*/index.html
			// overlay pages, not just the main app. Those pages have no
			// business being offline-cached: a Service Worker registered
			// against http://127.0.0.1:<port> keeps serving whatever
			// JS/HTML/PNGs were live the first time OBS loaded that page,
			// indefinitely -- that cache lives in the browser engine's own
			// storage for that origin, not the app's install directory, so
			// reinstalling the app can't clear it. Setting this to false and
			// manually registering only from the main app's own entry file
			// (see the note below) stops the obs pages from ever requesting
			// a Service Worker in the first place.
			injectRegister: false,
			devOptions: {
				enabled: true,
			},
			workbox: {
				navigateFallbackDenylist: [
					/^\/api/,
					/^\/ws/,
					/^\/obs\//,
					/^\/hearts\//,
					/^\/graph\//,
					/^\/sensors\//,
					/^\/heartrate\//,
					/^\/songs\//,
					/^\/pad\//,
				],
				// Keep the obs pages' own bundles and the heart preset
				// images out of the precache manifest entirely, so even a
				// freshly-generated sw.js can't precache stale copies of
				// them for anyone who does end up on an obs/* URL somehow.
				globIgnores: ["**/obs/**", "**/hearts/**"],
			},
			includeAssets: [
				"favicon.ico",
				"apple-touch-icon-180x180.png",
				"pwa-64x64.png",
				"pwa-192x192.png",
				"pwa-512x512.png",
				"maskable-icon-512x512.png",
				"pad-background.png", // Added here
			],
			manifest: {
				name: "WebFSR",
				short_name: "WebFSR",
				description: "WebFSR",
				start_url: "./",
				display: "standalone",
				scope: "./",
				theme_color: "#333333",
				background_color: "#333333",
				icons: [
					{
						src: "pwa-64x64.png",
						sizes: "64x64",
						type: "image/png",
					},
					{
						src: "pwa-192x192.png",
						sizes: "192x192",
						type: "image/png",
					},
					{
						src: "pwa-512x512.png",
						sizes: "512x512",
						type: "image/png",
					},
					{
						src: "maskable-icon-512x512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "maskable",
					},
				],
			},
		}),
	],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"~": path.resolve(__dirname, "./src"),
		},
	},
	build: {
		rollupOptions: {
			input: {
				main: path.resolve(__dirname, "index.html"),
				obsGraph: path.resolve(__dirname, "obs/graph/index.html"),
				obsSensors: path.resolve(__dirname, "obs/sensors/index.html"),
				obsHeartrate: path.resolve(__dirname, "obs/heartrate/index.html"),
				obsSongs: path.resolve(__dirname, "obs/songs/index.html"),
				obsPad: path.resolve(__dirname, "obs/pad/index.html"),
			},
		},
	},
	base: "./",
});
