// Entry point: settings, multi-ticker screening run, and results rendering.

import { Preferences } from '@capacitor/preferences';
import { loadConfig, saveConfig, isConfigured, type AppConfig } from './adapters/config';
import { getEngine, resetEngine, type DatabaseLike } from './adapters/engine';
import { nullDatabase } from './adapters/nullDatabase';
import { createSupabaseDatabase } from './adapters/supabaseDatabase';
import { screenTicker, type ScreenResult } from './screening';
import { renderResults } from './ui/results';

const $ = (id: string) => document.getElementById(id) as HTMLElement;
const val = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
const setVal = (id: string, v: string) => ((document.getElementById(id) as HTMLInputElement).value = v);
const LAST_TICKERS = 'last_tickers';

// ------------------------------------------------------------------ settings
async function initSettings() {
  const cfg = await loadConfig();
  setVal('cfg-twelve', cfg.TWELVE_DATA_API_KEY);
  setVal('cfg-eodhd', cfg.EODHD_API_KEY);
  setVal('cfg-supabase-url', cfg.SUPABASE_URL);
  setVal('cfg-supabase-key', cfg.SUPABASE_ANON_KEY);
  reflectConfigStatus(cfg);
  if (!isConfigured(cfg)) $('settings-panel').classList.remove('hidden');

  $('toggle-settings').addEventListener('click', () => $('settings-panel').classList.toggle('hidden'));

  $('save-config').addEventListener('click', async () => {
    await saveConfig({
      TWELVE_DATA_API_KEY: val('cfg-twelve'),
      EODHD_API_KEY: val('cfg-eodhd'),
      SUPABASE_URL: val('cfg-supabase-url'),
      SUPABASE_ANON_KEY: val('cfg-supabase-key'),
    });
    resetEngine();
    reflectConfigStatus(await loadConfig());
  });

  const { value } = await Preferences.get({ key: LAST_TICKERS });
  if (value) setVal('tickers', value);
}

function reflectConfigStatus(cfg: AppConfig) {
  const el = $('config-status');
  if (isConfigured(cfg)) {
    el.textContent = 'Settings saved ✓';
    el.className = 'status';
  } else {
    el.textContent = 'Need a price key (Twelve Data or EODHD) + Supabase URL & anon key.';
    el.className = 'status err';
  }
}

// ------------------------------------------------------------------ screening
function parseTickers(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\s,;]+/)
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean),
    ),
  );
}

async function run() {
  const status = $('run-status');
  const progress = $('progress');
  const bar = progress.firstElementChild as HTMLElement;
  const btn = document.getElementById('run') as HTMLButtonElement;

  const tickers = parseTickers(val('tickers'));
  if (tickers.length === 0) {
    status.textContent = 'Enter at least one ticker.';
    status.className = 'status err';
    return;
  }
  await Preferences.set({ key: LAST_TICKERS, value: tickers.join(', ') });

  const cfg = await loadConfig();
  const database: DatabaseLike = isConfigured(cfg) ? createSupabaseDatabase(cfg) : nullDatabase;
  const opts = {
    days: parseInt(val('period')) || 200,
    holdDays: parseInt(val('hold-days')) || 60,
    analyzeOptions: (document.getElementById('opt-options') as HTMLInputElement).checked,
  };

  btn.disabled = true;
  progress.classList.remove('hidden');
  status.className = 'status';
  const results: ScreenResult[] = [];
  const errors: string[] = [];

  try {
    const engine = await getEngine(cfg, database);
    for (let i = 0; i < tickers.length; i++) {
      const t = tickers[i];
      bar.style.width = `${Math.round((i / tickers.length) * 100)}%`;
      try {
        const r = await screenTicker(engine, database, t, opts, (m) => {
          status.textContent = `(${i + 1}/${tickers.length}) ${m}`;
        });
        results.push(r);
        renderResults(results); // progressive render
      } catch (e: any) {
        console.error(`${t} failed`, e);
        errors.push(`${t}: ${e?.message ?? e}`);
      }
    }
    bar.style.width = '100%';
    const persisted = isConfigured(cfg) ? ' · enriched Supabase' : ' · not persisted (configure Supabase)';
    status.textContent = `Done: ${results.length}/${tickers.length} screened${persisted}` + (errors.length ? ` · ${errors.length} failed` : '');
    if (errors.length) {
      status.className = 'status err';
      console.warn('Failures:\n' + errors.join('\n'));
    }
  } catch (e: any) {
    status.className = 'status err';
    status.textContent = `Failed: ${e?.message ?? String(e)}`;
    console.error(e);
  } finally {
    btn.disabled = false;
    setTimeout(() => progress.classList.add('hidden'), 800);
  }
}

$('run').addEventListener('click', run);
initSettings();
