/**
 * PDF 文本提取（pdfjs-dist）
 *
 * - 逐页 getTextContent，按 hasEOL 还原换行；
 * - NFKC 归一化，修掉部分 PDF 字体把汉字映射到康熙部首（如 ⽹ → 网）的问题；
 * - 文本密度过低时判定为扫描件，给出「转图片 OCR」的明确告警。
 */

import { AgentError } from '../errors.mjs';
import { textStats, safeBaseName } from '../util.mjs';

function normalize(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function extractPdf(buffer, { file = '', title = '' } = {}) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (err) {
    throw new AgentError('LA014', '缺少 pdfjs-dist，无法解析 PDF', {
      hint: '在 platform/aimcram-agent 执行 npm install',
      cause: err
    });
  }

  const data = new Uint8Array(buffer);
  let loadingTask;
  let doc;
  try {
    loadingTask = pdfjs.getDocument({
      data,
      useSystemFonts: true,
      disableFontFace: true,
      isEvalSupported: false,
      verbosity: 0
    });
    doc = await loadingTask.promise;
  } catch (err) {
    throw new AgentError('LA003', `PDF 解析失败：${err.message}`, {
      hint: '若 PDF 已加密，请先解除密码保护',
      cause: err
    });
  }

  const pageCount = doc.numPages;
  const pages = [];
  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let pageText = '';
    for (const item of content.items) {
      if (typeof item.str !== 'string') continue;
      pageText += item.str;
      if (item.hasEOL) pageText += '\n';
    }
    pages.push(normalize(pageText));
    page.cleanup();
  }
  await loadingTask.destroy();

  const text = normalize(pages.filter(Boolean).join('\n\n'));
  const stats = textStats(text);
  const warnings = [];
  if (!text || stats.meaningful < Math.max(80, pageCount * 40)) {
    warnings.push('PDF 文本密度过低，可能是扫描件；请将页面导出为图片后作为输入源以走 OCR');
  }

  return {
    title: title || safeBaseName(file).replace(/\.pdf$/i, ''),
    text,
    pageCount,
    stats,
    warnings
  };
}
