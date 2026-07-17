// Runtime configuration for the mobile screening app.
//
// Secrets (market-data API keys + Supabase credentials) are stored on-device via
// @capacitor/preferences. Before the shared engine is imported, we mirror the
// market-data keys into a `globalThis.process.env` polyfill so the engine's
// existing `process.env.TWELVE_DATA_API_KEY` / `EODHD_API_KEY` reads work with
// zero changes to the shared source.

import { Preferences } from '@capacitor/preferences';

export interface AppConfig {
  TWELVE_DATA_API_KEY: string;
  EODHD_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

const KEYS: (keyof AppConfig)[] = [
  'TWELVE_DATA_API_KEY',
  'EODHD_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
];

const EMPTY: AppConfig = {
  TWELVE_DATA_API_KEY: '',
  EODHD_API_KEY: '',
  SUPABASE_URL: '',
  SUPABASE_ANON_KEY: '',
};

let cached: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (cached) return cached;
  const cfg = { ...EMPTY };
  for (const k of KEYS) {
    const { value } = await Preferences.get({ key: k });
    if (value) cfg[k] = value;
  }
  cached = cfg;
  return cfg;
}

export async function saveConfig(partial: Partial<AppConfig>): Promise<void> {
  for (const k of KEYS) {
    const v = partial[k];
    if (v !== undefined) await Preferences.set({ key: k, value: v });
  }
  cached = null;
}

export function isConfigured(cfg: AppConfig): boolean {
  // Options-only screening needs Yahoo (no key). Price analysis needs at least
  // one price provider. Supabase is required for enrichment/persistence.
  return Boolean((cfg.TWELVE_DATA_API_KEY || cfg.EODHD_API_KEY) && cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
}

/**
 * Install a minimal `process.env` polyfill so the shared engine can read its API
 * keys at import time. MUST be called before dynamically importing the engine.
 */
export function installProcessEnv(cfg: AppConfig): void {
  const g = globalThis as any;
  const env = {
    TWELVE_DATA_API_KEY: cfg.TWELVE_DATA_API_KEY || undefined,
    EODHD_API_KEY: cfg.EODHD_API_KEY || undefined,
    NODE_ENV: 'production',
  };
  if (!g.process) g.process = { env };
  else g.process.env = { ...g.process.env, ...env };
}
