import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

// The shared screening engine lives in ../src/services (CommonJS). We import it
// directly (single source of truth) and alias its Node-only dependencies to
// lightweight browser stubs so nothing native (DuckDB/ONNX/fs) enters the bundle.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const stub = (name: string) => path.resolve(repoRoot, 'mobile/src/stubs', name);

export default defineConfig({
  root: '.',
  // Allow Vite to read the shared engine that lives outside mobile/
  server: {
    fs: { allow: [repoRoot] },
  },
  resolve: {
    alias: [
      // Node-only engine deps → browser-safe stubs
      { find: /^\.\/embeddings$/, replacement: stub('embeddings.js') },
      { find: 'duckdb', replacement: stub('empty.js') },
      // yahoo-finance2 v3 drags in @deno/shim-deno (fs/net/child_process); swap
      // it for a lightweight browser-native implementation of .options().
      { find: /^yahoo-finance2$/, replacement: stub('yahoo-finance2.js') },
    ],
  },
  define: {
    // CJS deps expect a Node-style global. The engine's process.env.* reads are
    // left intact and satisfied at runtime by a process polyfill (see main.ts),
    // so we deliberately do NOT statically replace process.env here.
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['simple-statistics', '@supabase/supabase-js', 'chart.js'],
  },
  build: {
    outDir: 'dist',
    target: 'es2020',
    commonjsOptions: {
      // The engine files are CommonJS and live outside node_modules.
      include: [/src\/services/, /node_modules/],
      transformMixedEsModules: true,
    },
  },
});
