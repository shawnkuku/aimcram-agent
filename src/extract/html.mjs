/**
 * 网页正文提取
 *
 * 主路径：@mozilla/readability（与 Firefox 阅读模式同源）。
 * 兜底：Readability 失败或正文过短时，改用容器打分（文本量、标点密度、链接密度）。
 * 两条路径都会去掉 script/style/nav/footer 等噪音，并保留标题、站点、发布时间等元数据。
 */

import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { load } from 'cheerio';
import { textStats, stripHtmlText } from '../util.mjs';

const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas', 'form',
  'nav', 'footer', 'aside', 'header',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.nav', '.navbar', '.menu', '.sidebar', '.footer', '.header', '.advert',
  '.advertisement', '.ads', '.share', '.related', '.comment', '.comments',
  '.breadcrumb', '.pagination', '.copyright', '.toolbar'
];

function cleanText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t\u00a0\u3000]+/g, ' ').replace(/ {2,}/g, ' ').trim())
    .filter((line, idx, arr) => line || (idx > 0 && arr[idx - 1]))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function metaContent($, names) {
  for (const name of names) {
    const v =
      $(`meta[property="${name}"]`).attr('content') ||
      $(`meta[name="${name}"]`).attr('content');
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Readability 主路径；失败返回 null。 */
function viaReadability(html, url) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const dom = new JSDOM(html, { url: url || 'https://example.invalid/', virtualConsole });
  const doc = dom.window.document;
  const article = new Readability(doc, {
    charThreshold: 160,
    keepClasses: false,
    disableJSONLD: false
  }).parse();
  const text = cleanText(article?.textContent || '');
  if (!text) return null;
  return {
    title: cleanText(article.title || doc.title || ''),
    byline: cleanText(article.byline || ''),
    siteName: cleanText(article.siteName || ''),
    excerpt: cleanText(article.excerpt || ''),
    publishedTime: article.publishedTime || metaContent(load(html), ['article:published_time', 'date', 'pubdate']),
    text,
    method: 'readability',
    language: article.lang || doc.documentElement?.lang || ''
  };
}

/** 容器打分兜底。 */
function viaScoring(html, url) {
  const $ = load(html);
  const meta = {
    title: cleanText($('title').first().text() || metaContent($, ['og:title'])),
    byline: cleanText(metaContent($, ['author', 'article:author'])),
    siteName: cleanText(metaContent($, ['og:site_name'])),
    excerpt: cleanText(metaContent($, ['description', 'og:description'])),
    publishedTime: metaContent($, ['article:published_time', 'date', 'pubdate'])
  };
  NOISE_SELECTORS.forEach((sel) => $(sel).remove());

  let best = null;
  let bestScore = 0;
  $('article, main, [role="main"], div, section').each((_, el) => {
    const node = $(el);
    const text = cleanText(node.text());
    if (text.length < 120) return;
    const linkText = node.find('a').text().length;
    const linkDensity = text.length ? linkText / text.length : 1;
    const paragraphs = node.find('p, li, h2, h3, h4').length;
    const punctuation = (text.match(/[。！？；：,.!?;]/g) || []).length;
    const score =
      text.length * (1 - Math.min(0.9, linkDensity)) +
      paragraphs * 25 +
      Math.min(punctuation, 300) * 2 +
      (node.is('article, main, [role="main"]') ? 400 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = node;
    }
  });

  const container = best || $('body');
  const parts = [];
  container.find('h1, h2, h3, h4, p, li, blockquote, pre, td').each((_, el) => {
    const node = $(el);
    if (node.find('p, li, h2, h3').length) return;
    const t = cleanText(node.text());
    if (!t || t.length < 2) return;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'h1' || tag === 'h2') parts.push(`## ${t}`);
    else if (tag === 'h3' || tag === 'h4') parts.push(`### ${t}`);
    else if (tag === 'li') parts.push(`- ${t}`);
    else parts.push(t);
  });
  let text = cleanText(parts.join('\n\n'));
  if (!text) text = cleanText(container.text());
  if (!text) text = cleanText($('body').text());
  return { ...meta, text, method: 'scoring', language: $('html').attr('lang') || '' };
}

/**
 * @param {string} html
 * @param {{url?: string, fallbackTitle?: string}} [opts]
 */
export function extractArticle(html, opts = {}) {
  const { url = '', fallbackTitle = '' } = opts;
  if (!html || typeof html !== 'string') {
    return { title: fallbackTitle, text: '', method: 'none', stats: textStats(''), warnings: ['空 HTML'] };
  }
  let article = null;
  let warning = null;
  try {
    article = viaReadability(html, url);
  } catch (err) {
    warning = `Readability 失败：${err.message}`;
  }
  const fallback = viaScoring(html, url);
  if (!article || textStats(article.text).meaningful < 160) {
    if (fallback.text) {
      article = {
        ...fallback,
        method: article ? 'scoring(short-readability)' : 'scoring'
      };
      if (!warning) warning = 'Readability 正文过短，已回退容器打分';
    }
  }
  if (!article) article = { ...fallback, method: 'scoring' };
  if (fallbackTitle && !article.title) article.title = fallbackTitle;
  article.text = cleanText(article.text);
  article.stats = textStats(article.text);
  article.warnings = warning ? [warning] : [];
  return article;
}

/** 提取可继续抓取的站内链接。 */
export function extractLinks(html, baseUrl, { sameHostOnly = true, limit = 40 } = {}) {
  const $ = load(html);
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      return;
    }
    if (!/^https?:$/.test(abs.protocol)) return;
    if (/\.(?:pdf|zip|rar|7z|exe|dmg|mp4|mp3|png|jpe?g|gif|svg|webp|docx?|xlsx?|pptx?)$/i.test(abs.pathname)) return;
    if (sameHostOnly && abs.hostname !== base.hostname) return;
    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) return;
    seen.add(key);
    const label = cleanText($(el).text());
    out.push({ url: key, label });
  });
  return out.slice(0, limit);
}

export { cleanText, stripHtmlText };
