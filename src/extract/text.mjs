/**
 * 纯文本 / Markdown 提取
 */

import fs from 'node:fs';
import { textStats, safeBaseName } from '../util.mjs';

function parseFrontMatter(raw) {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return { meta: {}, body: raw };
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { meta: {}, body: raw };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(match[0].length) };
}

export function extractText(buffer, { file = '', title = '' } = {}) {
  let raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  raw = raw.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const { meta, body } = parseFrontMatter(raw);
  const heading = body.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim() || '';
  const inferred = title || meta.title || heading || safeBaseName(file).replace(/\.[^.]+$/, '');
  const text = body.replace(/^\s+|\s+$/g, '');
  return {
    title: inferred,
    text,
    frontMatter: meta,
    stats: textStats(text),
    warnings: text ? [] : ['文本为空']
  };
}

export function readTextFile(file, opts = {}) {
  return extractText(fs.readFileSync(file), { ...opts, file });
}
