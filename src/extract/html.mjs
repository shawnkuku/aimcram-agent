/**
 * 网页正文提取
 *
 * 主路径：@mozilla/readability（与 Firefox 阅读模式同源）。
 * 兜底：Readability 失败或正文过短时，改用容器打分（文本量、标点密度、链接密度）。
 * 再兜底：DOM 相关依赖都加载不了时，用纯文本清洗，保证抓取流程不中断。
 * 各路径都会去掉 script/style/nav/footer 等噪音，并保留标题、站点、发布时间等元数据。
 *
 * 依赖按需加载：部分插件宿主（如 DSH）会拦截/改写模块解析，
 * 顶层静态导入 jsdom / cheerio 会牵连 tr46 的 require('punycode/') 等写法，
 * 导致整个插件激活失败；这里统一改成首次解析网页时再加载。
 */

import { textStats, stripHtmlText } from '../util.mjs';

let domLibs;
function loadDomLibs() {
  if (!domLibs) {
    domLibs = Promise.all([
      import('jsdom').then((m) => ({ JSDOM: m.JSDOM, VirtualConsole: m.VirtualConsole })).catch(() => null),
      import('@mozilla/readability').then((m) => m.Readability).catch(() => null),
      import('cheerio').then((m) => m.load).catch(() => null)
    ]).then(([jsdom, Readability, cheerio]) => ({ jsdom, Readability, cheerio }));
  }
  return domLibs;
}

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

/* 不依赖 DOM 的 meta 读取（readability 主路径也会用到） */
function metaMap(html) {
  const map = {};
  const re = /<meta\b[^>]*>/gi;
  for (const tag of html.match(re) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag);
    if (key && val) {
      const k = key[1].toLowerCase();
      if (!(k in map)) map[k] = val[1];
    }
  }
  return map;
}

function metaContent(html, names) {
  const map = metaMap(html);
  for (const name of names) {
    const v = map[name.toLowerCase()];
    if (v && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Readability 主路径；jsdom / Readability 不可用或解析失败返回 null。 */
function viaReadability(html, url, jsdom, Readability) {
  const { JSDOM, VirtualConsole } = jsdom;
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
    publishedTime: article.publishedTime || metaContent(html, ['article:published_time', 'date', 'pubdate']),
    text,
    method: 'readability',
    language: article.lang || doc.documentElement?.lang || ''
  };
}

/** 容器打分兜底（需要 cheerio）。 */
function viaScoring(html, url, load) {
  const $ = load(html);
  const meta = {
    title: cleanText($('title').first().text() || metaContent(html, ['og:title'])),
    byline: cleanText(metaContent(html, ['author', 'article:author'])),
    siteName: cleanText(metaContent(html, ['og:site_name'])),
    excerpt: cleanText(metaContent(html, ['description', 'og:description'])),
    publishedTime: metaContent(html, ['article:published_time', 'date', 'pubdate'])
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

/** 纯文本兜底：没有任何 DOM 库可用时，按标签切块清洗。 */
function viaPlainHtml(html) {
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe)\b[\s\S]*?<\/\1>/gi, '');
  const markdownish = body
    .replace(/<h([12])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, t) => `\n\n## ${stripHtmlText(t)}\n\n`)
    .replace(/<h([34])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, __, t) => `\n\n### ${stripHtmlText(t)}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${stripHtmlText(t)}`)
    .replace(/<(p|div|section|article|tr|br)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote)>/gi, '\n');
  return {
    title: cleanText(titleTag ? stripHtmlText(titleTag[1]) : ''),
    byline: cleanText(metaContent(html, ['author', 'article:author'])),
    siteName: cleanText(metaContent(html, ['og:site_name'])),
    excerpt: cleanText(metaContent(html, ['description', 'og:description'])),
    publishedTime: metaContent(html, ['article:published_time', 'date', 'pubdate']),
    text: cleanText(stripHtmlText(markdownish)),
    method: 'plain',
    language: ''
  };
}

/**
 * @param {string} html
 * @param {{url?: string, fallbackTitle?: string}} [opts]
 */
export async function extractArticle(html, opts = {}) {
  const { url = '', fallbackTitle = '' } = opts;
  if (!html || typeof html !== 'string') {
    return { title: fallbackTitle, text: '', method: 'none', stats: textStats(''), warnings: ['空 HTML'] };
  }
  const libs = await loadDomLibs();
  let article = null;
  const warnings = [];
  if (libs.jsdom && libs.Readability) {
    try {
      article = viaReadability(html, url, libs.jsdom, libs.Readability);
    } catch (err) {
      warnings.push(`Readability 失败：${err.message}`);
    }
  } else {
    warnings.push('Readability 不可用，已降级容器打分');
  }

  let fallback = null;
  if (libs.cheerio) {
    try {
      fallback = viaScoring(html, url, libs.cheerio);
    } catch (err) {
      warnings.push(`容器打分失败：${err.message}`);
    }
  }
  if (!fallback) {
    fallback = viaPlainHtml(html);
    warnings.push('DOM 解析不可用，已降级纯文本清洗');
  }

  if (!article || textStats(article.text).meaningful < 160) {
    if (fallback.text) {
      article = {
        ...fallback,
        method: article ? 'scoring(short-readability)' : fallback.method
      };
      warnings.push('Readability 正文过短，已回退兜底提取');
    }
  }
  if (!article) article = fallback;
  if (fallbackTitle && !article.title) article.title = fallbackTitle;
  article.text = cleanText(article.text);
  article.stats = textStats(article.text);
  article.warnings = warnings;
  return article;
}

/** 提取可继续抓取的站内链接。 */
export async function extractLinks(html, baseUrl, { sameHostOnly = true, limit = 40 } = {}) {
  const libs = await loadDomLibs();
  const base = new URL(baseUrl);
  const seen = new Set();
  const out = [];
  const push = (href, label) => {
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
    out.push({ url: key, label: cleanText(label) });
  };

  if (libs.cheerio) {
    const $ = libs.cheerio(html);
    $('a[href]').each((_, el) => push($(el).attr('href'), $(el).text()));
  } else {
    const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) push(m[1], stripHtmlText(m[2]));
  }
  return out.slice(0, limit);
}

export { cleanText, stripHtmlText };
