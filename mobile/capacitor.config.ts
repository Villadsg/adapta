import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.adapta.screening',
  appName: 'Adapta Screening',
  webDir: 'dist',
  server: {
    // Allow cleartext during dev if pointing at a local server; production uses bundled assets.
    androidScheme: 'https',
  },
  plugins: {
    // Patch the global fetch/XHR to route through native HTTP. This bypasses
    // webview CORS for Twelve Data / EODHD / Yahoo so the engine's fetch() calls
    // (and yahoo-finance2's internal fetch) work unchanged.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
