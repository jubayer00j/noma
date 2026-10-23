import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.noma.notes",
  appName: "Noma",
  webDir: ".output/public",
  plugins: {
    StatusBar: {
      // MainActivity owns the window: it runs edge-to-edge via
      // WindowCompat and hides/shows both bars itself during the splash.
      // The plugin is used from the web layer for bar *appearance* only
      // (icon contrast follows the in-app theme — see system-bars.ts), so
      // its load-time defaults are pinned to no-ops: overlaysWebView=false
      // keeps its legacy systemUiVisibility flags out of MainActivity's
      // way, and a transparent background stops it painting the bar black
      // on load.
      overlaysWebView: false,
      backgroundColor: "#00000000",
    },
  },
};

export default config;
