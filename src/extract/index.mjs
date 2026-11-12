/**
 * 输入源统一提取入口
 *
 * 统一 Source 模型（所有模式共用）：
 * {
 *   id, kind: 'file'|'url'|'text', type: 'markdown'|'text'|'html'|'pdf'|'docx'|'image',
 *   title, text, url, path,
 *   meta: { bytes, ext, method, pageCount?, ocr?, fetchedAt?, status? },
 *   quality: { mode: 'lossless'|'heuristic'|'ocr', confidence: number|null, chars, cjkRatio },
 *   warnings: string[],
 *   assets: [{ name, mime, data }]   // 内容中可复用的图片（如 docx 内嵌图）
 * }
 */

import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from '../errors.mjs';
import { textStats, safeBaseName } from '../util.mjs';
import { extractText } from './text.mjs';
import { extractPdf } from './pdf.mjs';
import { extractDocx } from './docx.mjs';
import { extractImage, guessImageMime } from './image.mjs';
import { extractArticle } from './html.mjs';

const TEXT_EXTS = new Set(['.md', '.markdown', '.mdx', '.txt', '.text', '.log', '.csv', '.tsv', '.json', '.yaml', '.yml']);
const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function magic(buffer) {
  if (!buffer || buffer.length < 4) return 'empty';
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04) return 'zip';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) return 'ole';
  return 'unknown';
}

export function detectType(file, buffer) {
  const ext = path.extname(file || '').toLowerCase();
  const magicType = magic(buffer);
  if (magicType === 'pdf') return 'pdf';
  if (magicType === 'zip') return 'docx';
  if (['png', 'jpeg', 'gif', 'webp', 'bmp'].includes(magicType)) return 'image';
  if (magicType === 'ole') {
    throw new AgentError('LA002', '这是旧版 .doc / .xls 二进制格式', { hint: '请另存为 .docx 后重试' });
  }
  if (HTML_EXTS.has(ext)) return 'html';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.md' || ext === '.markdown' || ext === '.mdx') return 'markdown';
  if (TEXT_EXTS.has(ext)) return 'text';
  // 无扩展名：按文本嗅探
  const head = buffer.subarray(0, 1024).toString('utf8');
  if (/^\s*(?:<!doctype html|<html|<head|<body)/i.test(head)) return 'html';
  if (/[\u4e00-\u9fff]|[\x20-\x7e]/.test(head) && !head.includes('\u0000')) return 'text';
  throw new AgentError('LA002', `无法识别文件类型：${file || '(未命名)'}`, {
    details: { ext, magic: magicType }
  });
}

function buildSource({ id, kind, type, title, text, file, url, meta, quality, warnings, assets }) {
  const stats = textStats(text);
  return {
    id: id || null,
    kind,
    type,
    title: String(title || '').trim() || safeBaseName(file || url || '未命名来源'),
    text: String(text || '').trim(),
    path: file ? path.resolve(file) : '',
    url: url || '',
    meta: { bytes: Buffer.byteLength(text || '', 'utf8'), ...meta },
    quality: {
      mode: quality?.mode || 'lossless',
      confidence: quality?.confidence ?? null,
      chars: stats.chars,
      cjkRatio: Number(stats.cjkRatio.toFixed(3)),
      ...quality
    },
    warnings: warnings || [],
    assets: assets || []
  };
}

/**
 * 从本地文件提取。
 * @param {string} file
 * @param {{id?: string, title?: string, cacheDir?: string}} [opts]
 */
export async function extractFile(file, opts = {}) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    throw new AgentError('LA004', `输入源不存在：${file}`);
  }
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new AgentError('LA004', `不是文件：${file}`);
  if (stat.size === 0) throw new AgentError('LA011', `文件为空：${file}`);
  const buffer = fs.readFileSync(abs);
  const type = detectType(abs, buffer);
  const baseTitle = opts.title || safeBaseName(path.basename(abs, path.extname(abs)));

  if (type === 'markdown' || type === 'text') {
    const r = extractText(buffer, { file: abs, title: opts.title || '' });
    return buildSource({
      id: opts.id, kind: 'file', type, title: r.title, text: r.text, file: abs,
      meta: { ext: path.extname(abs).toLowerCase(), bytes: stat.size, method: 'utf8' },
      quality: { mode: 'lossless', confidence: 1 }, warnings: r.warnings
    });
  }

  if (type === 'html') {
    const r = extractArticle(buffer.toString('utf8'), { url: '', fallbackTitle: baseTitle });
    return buildSource({
      id: opts.id, kind: 'file', type: 'html', title: r.title || baseTitle, text: r.text, file: abs,
      meta: { ext: path.extname(abs).toLowerCase(), bytes: stat.size, method: r.method },
      quality: { mode: 'heuristic', confidence: null }, warnings: r.warnings
    });
  }

  if (type === 'pdf') {
    const r = await extractPdf(buffer, { file: abs, title: baseTitle });
    return buildSource({
      id: opts.id, kind: 'file', type: 'pdf', title: r.title, text: r.text, file: abs,
      meta: { ext: '.pdf', bytes: stat.size, method: 'pdfjs', pageCount: r.pageCount },
      quality: { mode: 'lossless', confidence: 1 }, warnings: r.warnings
    });
  }

  if (type === 'docx') {
    const r = await extractDocx(buffer, { file: abs, title: baseTitle });
    return buildSource({
      id: opts.id, kind: 'file', type: 'docx', title: r.title, text: r.text, file: abs,
      meta: { ext: '.docx', bytes: stat.size, method: r.method },
      quality: { mode: 'lossless', confidence: 1 }, warnings: r.warnings, assets: r.assets
    });
  }

  if (type === 'image') {
    const r = extractImage(buffer, { file: abs, title: baseTitle, cacheDir: opts.cacheDir });
    return buildSource({
      id: opts.id, kind: 'file', type: 'image', title: r.title, text: r.text, file: abs,
      meta: { ext: path.extname(abs).toLowerCase(), bytes: stat.size, method: r.ocr.engine, ocr: r.ocr },
      quality: { mode: 'ocr', confidence: r.ocr.meanConfidence }, warnings: r.warnings, assets: r.assets
    });
  }

  throw new AgentError('LA002', `不支持的输入类型：${type}`);
}

/** 直接文本 / @clipboard 之外的内联输入。 */
export function extractInlineText(value, opts = {}) {
  const text = String(value || '').replace(/^\uFEFF/, '');
  const r = extractText(text, { title: opts.title || '内联文本' });
  return buildSource({
    id: opts.id, kind: 'text', type: 'text', title: r.title, text: r.text, file: '',
    meta: { ext: '', bytes: Buffer.byteLength(text, 'utf8'), method: 'inline' },
    quality: { mode: 'lossless', confidence: 1 }, warnings: r.warnings
  });
}

/** DeepSeek Fetch 返回的 Markdown 正文 → Source。 */
export function extractMarkdownSource({ id, url, finalUrl, markdown, title, fetchedAt }) {
  const text = String(markdown || '').replace(/^\uFEFF/, '').trim(); // 去 BOM
  return buildSource({
    id, kind: 'url', type: 'markdown', title: title || url, text, url: finalUrl || url,
    meta: { ext: '.md', method: 'deepseek-fetch', status: 200, fetchedAt },
    quality: { mode: 'heuristic', confidence: null }
  });
}

export { guessImageMime };
