/**
 * LabInsightsService - Local LLM narration for the Model Lab
 *
 * Turns structured search/dataset results into short plain-language insights
 * ("these removals make sense because…", "this one looks risky…") using a
 * local LLM. Two backends, tried in order:
 *
 * 1. llama.cpp (preferred): a CUDA llama-server is spawned on demand with
 *    the configured GGUF (default Qwen3.5-9B Q8_0), queried over its
 *    OpenAI-compatible HTTP API, and shut down after an idle timeout so the
 *    GPU is freed for TimesFM searches.
 * 2. transformers.js fallback: a small instruct model on the CPU (same
 *    dependency as the embedding service) when llama.cpp or the GGUF is not
 *    available.
 *
 * All numbers shown to the user come from the search itself; the model is
 * instructed to ground every claim in the provided data and to label
 * interpretation as such. Output is advisory text only.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SYSTEM_PROMPT = [
  'You are a careful quantitative analyst reviewing feature-selection results',
  'for two small forecasting models (direction of a stock on the next',
  'trading day, and probability of a rare high-impact day).',
  'Hard rules: Use ONLY the numbers and feature descriptions provided — never',
  'invent statistics. Feature names appear in backticks and are exact;',
  'mentioning any feature name that is not listed makes your answer wrong.',
  'Mark interpretation with words like "plausibly" or "reads like".',
  'No markdown, no bullet characters, no headers — plain short sentences only.',
].join(' ');

const LLAMA_IDLE_SHUTDOWN_MS = 3 * 60 * 1000;

class LabInsightsService {
  constructor(options = {}) {
    this.projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..');

    // llama.cpp backend configuration (env-overridable).
    this.llamaBin = options.llamaBin || process.env.LLAMA_SERVER_BIN ||
      path.join(os.homedir(), '.local', 'bin', 'llama-server');
    this.llamaModel = options.llamaModel || process.env.LAB_INSIGHTS_GGUF ||
      path.join(this.projectRoot, 'models', 'Qwen3.5-9B-Q8_0.gguf');
    this.llamaPort = parseInt(options.llamaPort || process.env.LAB_INSIGHTS_LLAMA_PORT || '8023', 10);
    this.llamaCtx = parseInt(options.llamaCtx || process.env.LAB_INSIGHTS_LLAMA_CTX || '8192', 10);

    // transformers.js fallback model.
    this.modelName = options.modelName || process.env.LAB_INSIGHTS_MODEL || 'onnx-community/Qwen2.5-1.5B-Instruct';
    this.dtype = options.dtype || process.env.LAB_INSIGHTS_DTYPE || 'q4';

    this.pipe = null;
    this.loadPromise = null;
    this.busy = false;
    this.llamaChild = null;
    this.llamaStarting = null;
    this.llamaIdleTimer = null;
    this.llamaUnavailableLogged = false;
  }

  // ---- llama.cpp backend -------------------------------------------------

  get llamaUrl() {
    return `http://127.0.0.1:${this.llamaPort}`;
  }

  llamaConfigured() {
    return fs.existsSync(this.llamaBin) && fs.existsSync(this.llamaModel);
  }

  async _health(msTimeout = 1500) {
    try {
      const res = await fetch(`${this.llamaUrl}/health`, {
        signal: AbortSignal.timeout(msTimeout),
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  async _ensureLlama() {
    if (await this._health()) return true;
    if (!this.llamaConfigured()) {
      if (!this.llamaUnavailableLogged) {
        console.log(`[Insights] llama.cpp not configured (need ${this.llamaBin} and ${this.llamaModel}) — using CPU fallback`);
        this.llamaUnavailableLogged = true;
      }
      return false;
    }
    if (!this.llamaStarting) this.llamaStarting = this._startLlama();
    try {
      return await this.llamaStarting;
    } catch (err) {
      console.error(`[Insights] llama-server failed to start: ${err.message}`);
      this.llamaStarting = null;
      return false;
    }
  }

  async _startLlama() {
    const binDir = path.dirname(this.llamaBin);
    const child = spawn(this.llamaBin, [
      '-m', this.llamaModel,
      '--port', String(this.llamaPort),
      '--host', '127.0.0.1',
      '-ngl', '999',           // offload all layers to the GPU
      '-c', String(this.llamaCtx),
      '--parallel', '1',
      '--no-webui',
    ], { cwd: binDir, env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    this.llamaChild = child;
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { this._llamaDied(); throw err; });
    child.on('close', () => { this._llamaDied(); });

    console.log(`[Insights] starting llama-server (${path.basename(this.llamaModel)}, port ${this.llamaPort})...`);
    const deadline = Date.now() + 180000; // cold model load can take a while
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`llama-server exited early: ${stderr.split('\n').filter(Boolean).slice(-3).join(' | ')}`);
      if (await this._health(800)) {
        console.log('[Insights] llama-server ready');
        return true;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    this.shutdown();
    throw new Error('llama-server did not become healthy within 180s');
  }

  _llamaDied() {
    this.llamaChild = null;
    this.llamaStarting = null;
    clearTimeout(this.llamaIdleTimer);
    this.llamaIdleTimer = null;
  }

  _touchLlamaIdle() {
    clearTimeout(this.llamaIdleTimer);
    // Free the GPU again after a quiet period so searches are never blocked.
    this.llamaIdleTimer = setTimeout(() => {
      console.log('[Insights] llama-server idle — shutting down to free the GPU');
      this.shutdown();
    }, LLAMA_IDLE_SHUTDOWN_MS);
    if (this.llamaIdleTimer.unref) this.llamaIdleTimer.unref();
  }

  shutdown() {
    if (this.llamaChild) {
      this.llamaChild.kill('SIGTERM');
      this.llamaChild = null;
    }
    this._llamaDied();
  }

  async _llamaGenerate(system, user, maxNewTokens) {
    if (!(await this._ensureLlama())) return null;
    this._touchLlamaIdle();
    const res = await fetch(`${this.llamaUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(300000),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // Qwen3.5 is a thinking model; disable the reasoning block so the
        // answer lands directly in content (and tokens are not wasted).
        chat_template_kwargs: { enable_thinking: false },
        max_tokens: maxNewTokens + 80,
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!res.ok) throw new Error(`llama-server HTTP ${res.status}`);
    const data = await res.json();
    const message = data?.choices?.[0]?.message || {};
    let text = message.content || '';
    // Safety net in case a template ever emits explicit reasoning anyway.
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^<think>[\s\S]*$/, '').trim();
    if (!text && message.reasoning_content) {
      throw new Error('model answered only with reasoning content');
    }
    return text || null;
  }

  // ---- transformers.js fallback backend ----------------------------------

  async _pipeline() {
    if (this.pipe) return this.pipe;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = (async () => {
      const t0 = Date.now();
      console.log(`[Insights] Loading local fallback model ${this.modelName}...`);
      const transformers = await import('@huggingface/transformers');
      transformers.env.allowLocalModels = false;
      transformers.env.useBrowserCache = false;
      const pipe = await transformers.pipeline('text-generation', this.modelName, {
        dtype: this.dtype,
      });
      this.pipe = pipe;
      console.log(`[Insights] Fallback model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return pipe;
    })();
    try {
      return await this.loadPromise;
    } catch (err) {
      this.loadPromise = null;
      throw new Error(`Insight model unavailable: ${err.message}`);
    }
  }

  async _transformersGenerate(system, user, maxNewTokens) {
    const pipe = await this._pipeline();
    const out = await pipe([
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], { max_new_tokens: maxNewTokens, temperature: 0.2, do_sample: false });
    const text = out && out[0] && out[0].generated_text;
    if (Array.isArray(text)) {
      const last = text[text.length - 1];
      return (last && last.content || '').trim();
    }
    return String(text || '').trim();
  }

  // ---- shared ------------------------------------------------------------

  async _generate(userPrompt, maxNewTokens) {
    if (this.busy) throw new Error('An insight request is already running');
    this.busy = true;
    try {
      try {
        const text = await this._llamaGenerate(SYSTEM_PROMPT, userPrompt, maxNewTokens);
        if (text) return text;
      } catch (err) {
        console.error(`[Insights] llama.cpp route failed, falling back to CPU model: ${err.message}`);
      }
      return await this._transformersGenerate(SYSTEM_PROMPT, userPrompt, maxNewTokens);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Narrate a finished feature search. One grounded generation per target —
   * short prompts keep small models on-topic; long combined prompts make
   * them drift into generic finance knowledge.
   * @param {Object} payload - { targets: { direction, event }, descriptions }
   *   where each target block is the search result (auroc, decisions) plus a
   *   title.
   * @returns {Promise<string>} insight text, one labeled paragraph per target
   */
  async searchInsights(payload) {
    const descriptions = payload.descriptions || {};
    const parts = [];
    for (const target of ['direction', 'event']) {
      const t = (payload.targets || {})[target];
      if (!t || !Array.isArray(t.decisions) || !t.decisions.length) continue;
      const decisions = t.decisions || [];
      const removed = decisions.filter(d => !d.kept).slice(0, 10);
      // The kept features whose removal hurts most — enough context to judge
      // riskiness without bloating the prompt.
      const kept = decisions.filter(d => d.kept)
        .sort((a, b) => a.delta_auroc - b.delta_auroc).slice(0, 5);
      const lines = [`A feature search for the "${t.title || target}" model tested these ` +
        `features (names in backticks are exact):`];
      const fmt = (d, label) => `- \`${d.channel}\` ${label}, removing it changed AUROC by ` +
        `${d.delta_auroc >= 0 ? '+' : ''}${d.delta_auroc}. ${descriptions[d.channel] || ''}`;
      for (const d of removed) lines.push(fmt(d, 'REMOVED'));
      for (const d of kept) lines.push(fmt(d, 'KEPT'));
      lines.push(`The model went from ${t.baseline_n_channels} features (AUROC ${t.baseline_auroc ?? '?'}) ` +
        `to ${t.n_channels} features (AUROC ${t.auroc ?? '?'}).`);
      lines.push('');
      lines.push('Answer in order, under 90 words: (1) which removals make intuitive sense and why; ' +
        '(2) does any removal look risky given its delta; (3) which removed features have no ' +
        'intuitive reason to ever work. Only mention listed names.');
      const text = await this._generate(lines.join('\n'), 240);
      if (text) parts.push(`[${t.title || target}]\n${text}`);
    }
    if (!parts.length) throw new Error('No search targets to narrate');
    return parts.join('\n\n');
  }

  /**
   * Narrate a dataset health check.
   * @param {Object} info - the dataset-info JSON (db, options, targets, warnings)
   * @returns {Promise<string>} insight text
   */
  async datasetInsights(info) {
    const lines = ['A dataset health check for a forecasting feature search found:', ''];
    if (info.db) {
      lines.push(`Price history: ${info.db.tickers} tickers, ${info.db.date_min} to ${info.db.date_max}, ${info.db.price_rows} rows.`);
    }
    if (info.options && info.db) {
      lines.push(`Options data: ${info.options.tickers_with_options} of ${info.db.tickers} tickers have any.`);
    }
    // ci/options-coverage.json (written by ci/backfill-marketdata.js --maintenance)
    // separates "vendor confirmed options-less" (real prune candidates) from
    // "pending backfill" (never fetched — a data hole, not an optionless ticker).
    try {
      const cov = JSON.parse(fs.readFileSync(path.join(this.projectRoot, 'ci', 'options-coverage.json'), 'utf-8'));
      const prunable = (cov.details?.confirmed_missing || []).map(r => r.ticker);
      lines.push(`Options coverage breakdown (report from ${cov.generated}): ` +
        `${cov.covered} covered, ${cov.stale} stale, ` +
        `${cov.pending_backfill} pending backfill (never fetched — NOT optionless), ` +
        `${cov.confirmed_missing} confirmed options-less by the data vendor` +
        (prunable.length ? ` (prune candidates: ${prunable.slice(0, 15).join(', ')}${prunable.length > 15 ? ', …' : ''})` : '') + '.');
    } catch (_) { /* no coverage report yet */ }
    for (const [target, r] of Object.entries(info.targets || {})) {
      if (!r || !r.available) continue;
      lines.push(`${target} target: ${r.samples} samples over ${r.tickers} tickers, ` +
        `${(r.positive_rate * 100).toFixed(1)}% positive, options data missing on ${r.options_missing_pct}% of feature days.`);
    }
    lines.push('');
    if ((info.warnings || []).length) {
      lines.push('Warnings from the checker:');
      for (const w of info.warnings) lines.push(`- ${w}`);
    } else {
      lines.push('No warnings were raised.');
    }
    lines.push('');
    lines.push('In under 90 words: explain the biggest data-quality risk in plain language and give two concrete suggestions (universe pruning, refreshing data, or reliability of search results). Only use the numbers above.');
    return this._generate(lines.join('\n'), 240);
  }
}

module.exports = LabInsightsService;
