/**
 * DOCX 提取
 *
 * 主路径 mammoth（保留段落结构、支持表格文本），图片从 OOXML 包的 word/media/ 取原始字节。
 * mammoth 不可用时回退到自带的 ZIP 解析 + word/document.xml 轻量抽取。
 */

import path from 'node:path';
import { AgentError } from '../errors.mjs';
import { readZip } from '../zip.mjs';
import { textStats, safeBaseName } from '../util.mjs';

const IMAGE_MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};

function collectImages(zip) {
  const assets = [];
  for (const [name, data] of zip) {
    if (!/^word\/media\//.test(name)) continue;
    const ext = path.extname(name).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (!mime) continue;
    assets.push({ name: path.basename(name), mime, data });
  }
  return assets;
}

function xmlToText(xml) {
  const paragraphs = xml.split(/<\/w:p>/);
  const lines = [];
  for (const p of paragraphs) {
    let line = '';
    const tokens = p.match(/<w:t[^>]*>[\s\S]*?<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g) || [];
    for (const token of tokens) {
      if (token === '<w:tab/>') line += '\t';
      else if (token === '<w:br/>' || token === '<w:cr/>') line += '\n';
      else {
        const m = token.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
        if (m) {
          line += m[1]
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
        }
      }
    }
    line = line.replace(/[ \t]+$/g, '');
    if (line.trim()) lines.push(line);
  }
  return lines.join('\n');
}

function extractWithZipFallback(buffer) {
  const zip = readZip(buffer);
  const doc = zip.get('word/document.xml');
  if (!doc) throw new AgentError('LA003', 'DOCX 缺少 word/document.xml');
  return { text: xmlToText(doc.toString('utf8')), assets: collectImages(zip) };
}

export async function extractDocx(buffer, { file = '', title = '' } = {}) {
  const zip = readZip(buffer);
  if (!zip.has('word/document.xml')) {
    throw new AgentError('LA002', '不是有效的 DOCX（缺少 word/document.xml）');
  }
  const assets = collectImages(zip);
  let text = '';
  let method = 'mammoth';
  let messages = [];

  try {
    const mammoth = await import('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    text = result.value || '';
    messages = (result.messages || []).map((m) => m.message);
  } catch (err) {
    if (err instanceof AgentError) throw err;
    method = 'zip-fallback';
    text = extractWithZipFallback(buffer).text;
    messages = [`mammoth 不可用，已回退内置解析：${err.message}`];
  }

  text = text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const stats = textStats(text);
  return {
    title: title || safeBaseName(file).replace(/\.docx?$/i, ''),
    text,
    stats,
    assets,
    method,
    warnings: text ? messages : [...messages, 'DOCX 正文为空'],
    messageCount: messages.length
  };
}
