/**
 * 运行配置：全部可通过环境变量覆盖，CLI 参数优先级最高。
 */

import os from 'node:os';
import path from 'node:path';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const VERSION = '1.0.0';

export const DEFAULTS = {
  // LLM
  apiKey: process.env.DEEPSEEK_API_KEY || '',
  baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
  model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
  llmTimeoutMs: num(process.env.DEEPSEEK_TIMEOUT_MS, 240_000),
  llmRetries: num(process.env.DEEPSEEK_RETRIES, 3),
  /* 并发出题 / 出案例的请求数；单批最多输出 8000 token，需要更长的超时配合 */
  llmConcurrency: num(process.env.AIMCRAM_LLM_CONCURRENCY, 10),

  // 联网检索与抓取限额（统一走 DeepSeek Search/Fetch API，按次计费）
  crawlTimeoutMs: num(process.env.LA_CRAWL_TIMEOUT_MS, 20_000),
  maxBytes: num(process.env.LA_MAX_BYTES, 5 * 1024 * 1024),
  maxPages: num(process.env.LA_MAX_PAGES, 8),
  maxDepth: num(process.env.LA_MAX_DEPTH, 1),
  minContentChars: num(process.env.LA_MIN_CONTENT_CHARS, 400),
  sameHostOnly: process.env.LA_SAME_HOST_ONLY !== '0',

  // 产物
  outDir: process.env.LA_OUT_DIR || path.join(process.cwd(), 'out'),
  minAppVersion: '1.0.0',
  generator: 'aimcram-agent',

  // 生成规模
  questionsPerSection: num(process.env.LA_QUESTIONS_PER_SECTION, 2),
  maxSections: num(process.env.LA_MAX_SECTIONS, 12),
  maxSourceChars: num(process.env.LA_MAX_SOURCE_CHARS, 60_000),

  // OCR
  ocrCacheDir: process.env.LA_OCR_CACHE_DIR || path.join(os.tmpdir(), 'aimcram-agent')
};

export function resolveConfig(overrides = {}) {
  const cfg = { ...DEFAULTS };
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined && v !== null && v !== '') cfg[k] = v;
  }
  cfg.outDir = path.resolve(cfg.outDir);
  return cfg;
}

export function maskSecret(value) {
  if (!value) return '';
  const s = String(value);
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}****${s.slice(-2)}`;
}
