/**
 * 通用工具：路径、哈希、规范化 JSON、文本统计、去重相似度。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AgentError } from './errors.mjs';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new AgentError('LA009', `${file} 不是合法 JSON：${err.message}`, { cause: err });
  }
}

export function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return file;
}

export function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha1Hex(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/** 递归字典序 + 无空白 + 保留数组顺序，用于 fingerprint。 */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function isoNow(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  const s = text.trim();
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}

export function slugify(input, fallback = 'study') {
  const ascii = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (ascii.length >= 2) return ascii.slice(0, 56);
  const digest = sha1Hex(String(input || '')).slice(0, 8);
  return `${fallback}-${digest}`;
}

export function safeBaseName(input) {
  return String(input || '')
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'source';
}

/** 中日韩字符占比 + 有效字符数，用于质量判断与覆盖率估算。 */
export function textStats(text) {
  const s = String(text || '');
  const chars = [...s];
  let cjk = 0;
  let ascii = 0;
  let space = 0;
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) cjk++;
    else if (/[A-Za-z0-9]/.test(ch)) ascii++;
    else if (/\s/.test(ch)) space++;
  }
  const total = chars.length;
  return {
    chars: total,
    cjk,
    ascii,
    space,
    meaningful: cjk + ascii,
    cjkRatio: total ? cjk / total : 0,
    meaningfulRatio: total ? (cjk + ascii) / total : 0
  };
}

/** 按标点/换行切句，过滤噪音，供大纲与题目生成使用。 */
export function splitSentences(text, { min = 8, max = 160 } = {}) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/(?<=[。！？；!?;])\s*|\n{2,}/)
    .map((s) => s.replace(/^[\s>*#\-]+|[\s]+$/g, ''))
    .filter((s) => s.length >= min && s.length <= max)
    .filter((s) => !/^(?:图|表|资料来源|来源|责任编辑|copyright|©)/i.test(s));
}

export function keywords(text, limit = 12) {
  const stop = new Set(['我们', '可以', '通过', '以及', '进行', '一个', '没有', '这个', '因此', '但是', '如果', '就是', '不是', '这种', '其中', '主要', '对于', '相关', '需要', '使用', 'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were', 'will', 'have', 'has', 'you', 'your', 'not', 'can', 'all', 'any', 'but', 'how', 'what']);
  const freq = new Map();
  const textStr = String(text || '');
  const en = textStr.toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
  for (const w of en) if (!stop.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
  const zh = textStr.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  for (const w of zh) {
    if (stop.has(w) || w.length < 2) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word, count]) => ({ word, count }));
}

export function normalizeForDedupe(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export function shingles(text, size = 5) {
  const s = normalizeForDedupe(text);
  const set = new Set();
  if (s.length <= size) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i + size <= s.length; i++) set.add(s.slice(i, i + size));
  return set;
}

export function jaccard(a, b) {
  const A = a instanceof Set ? a : new Set(a);
  const B = b instanceof Set ? b : new Set(b);
  if (!A.size && !B.size) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function uniqueBy(list, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function pct(n) {
  return `${Math.round(clamp(n, 0, 1) * 100)}%`;
}

export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true;
  if (/^fc00:|^fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  return false;
}

export function stripHtmlText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 在并发上限内执行异步任务，结果按输入顺序返回；limit 取 1 时等价于串行。 */
export async function mapLimit(items, limit, fn) {
  const list = Array.from(items || []);
  const out = new Array(list.length);
  const workers = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const i = next++;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return out;
}
