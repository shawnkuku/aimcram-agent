/**
 * 主题抓取编排：DeepSeek 检索 → 逐页 Fetch（Markdown 正文）→ 质量筛选 → 去重。
 *
 * 设计原则：
 * - 任何单页失败都不终止整体，失败原因写入报告；检索本身失败则直接抛错（不静默回退）；
 * - 质量门槛可配置，宁缺毋滥：正文过短、主题相关性低、重复度高的页面直接丢弃；
 * - 抓取页数与深度有硬上限，避免无界爬取。
 */

import { DeepSeekTools } from './deepseek-tools.mjs';
import { searchTopic } from './search.mjs';
import { extractMarkdownSource } from '../extract/index.mjs';
import { jaccard, shingles, keywords, textStats, isoNow } from '../util.mjs';
import { AgentError } from '../errors.mjs';

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return 'invalid-url';
  }
}

function topicBigrams(topic) {
  const cjk = String(topic).match(/[\u4e00-\u9fff]{2,}/g) || [];
  const grams = new Set();
  for (const seg of cjk) {
    for (let i = 0; i + 2 <= seg.length; i++) grams.add(seg.slice(i, i + 2));
  }
  const latin = String(topic).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
  latin.forEach((w) => grams.add(w));
  return [...grams];
}

/**
 * 主题词表：二字词权重低、三到六字词权重高。
 * 长页面很容易包含大量「安全」「驾驶」这类通用二字词，
 * 只按二字词算相关度会让无关长文刷分；三字以上强词能区分主题。
 */
function topicProfile(topic) {
  const terms = new Map();
  const cjk = String(topic).toLowerCase().match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const seg of cjk) {
    for (const n of [2, 3, 4, 5, 6]) {
      for (let i = 0; i + n <= seg.length; i++) {
        const term = seg.slice(i, i + n);
        const weight = n === 2 ? 1 : n === 3 ? 2 : n === 4 ? 3 : 4;
        if ((terms.get(term) || 0) < weight) terms.set(term, weight);
      }
    }
  }
  for (const word of String(topic).toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []) {
    if ((terms.get(word) || 0) < 3) terms.set(word, 3);
  }
  return terms;
}

/**
 * 主题相关度：标题 + 正文前 6000 字内，按主题词加权命中率计算。
 * 必须命中至少一个三字以上主题词，否则直接判 0，避免长文靠通用词过关。
 * 导出给测试与抓取报告复用。
 */
export function relevance(topic, text, title = '') {
  const terms = topicProfile(topic);
  if (!terms.size) return 1;
  const hay = `${title || ''}\n${String(text || '').slice(0, 6000)}`.toLowerCase();
  let hit = 0;
  let total = 0;
  let strongHit = false;
  for (const [term, weight] of terms) {
    total += weight;
    if (!hay.includes(term)) continue;
    hit += weight;
    if (term.length >= 3) strongHit = true;
  }
  return strongHit ? hit / total : 0;
}

const MD_LINK = /\[[^\]]*\]\(([^)\s]+)[^)]*\)/g;
const BINARY_EXT = /\.(?:pdf|zip|rar|7z|exe|dmg|mp4|mp3|png|jpe?g|gif|svg|webp|docx?|xlsx?|pptx?)$/i;

/** 从 Markdown 正文提取 `[label](url)` 链接，按主题二元组打分取前 limit 个。 */
function contextualLinks(markdown, finalUrl, topic, limit, { sameHostOnly = true } = {}) {
  const base = new URL(finalUrl);
  const seen = new Set();
  const links = [];
  for (const m of String(markdown || '').matchAll(MD_LINK)) {
    const href = m[1];
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue;
    let abs;
    try {
      abs = new URL(href, base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(abs.protocol)) continue;
    if (BINARY_EXT.test(abs.pathname)) continue;
    if (sameHostOnly && abs.hostname !== base.hostname) continue;
    abs.hash = '';
    const url = abs.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const label = m[0].slice(1, m[0].indexOf(']')).replace(/\s+/g, ' ').trim();
    links.push({ url, label });
  }
  const grams = topicBigrams(topic).map((g) => g.toLowerCase());
  return links
    .map((l) => {
      const hay = (l.label + ' ' + l.url).toLowerCase();
      const score = grams.reduce((n, g) => n + (hay.includes(g) ? 1 : 0), 0);
      return { ...l, score };
    })
    .sort((a, b) => b.score - a.score)
    .filter((l) => l.score > 0)
    .slice(0, limit);
}

/**
 * @param {string} topic
 * @param {import('../config.mjs').DEFAULTS} config
 * @param {{reporter?: any, seeds?: string[], maxPages?: number, depth?: number, tools?: DeepSeekTools}} [opts]
 */
export async function crawlTopic(topic, config, opts = {}) {
  const reporter = opts.reporter;
  const tools = opts.tools || new DeepSeekTools(config);
  const maxPages = opts.maxPages || config.maxPages;
  const depth = opts.depth ?? config.maxDepth;
  const seeds = (opts.seeds || []).filter(Boolean);

  let candidates = seeds.map((url) => ({ url, title: '', snippet: '', provider: 'seed' }));
  let searchReport = { provider: 'seed', attempts: [], count: candidates.length };

  if (!candidates.length) {
    reporter?.stage('crawl', 4, '检索候选页面…');
    const found = await searchTopic(topic, tools, { limit: maxPages * 2 });
    candidates = found.results;
    searchReport = { provider: found.provider, attempts: found.attempts, count: found.results.length };
  }

  const accepted = [];
  const rejected = [];
  const seenUrls = new Set();
  const seenShingles = [];
  const queue = candidates.map((c) => ({ ...c, depth: 0 }));

  while (queue.length && accepted.length < maxPages) {
    const item = queue.shift();
    const url = item.url;
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    reporter?.stage('crawl', 8 + Math.round((accepted.length / Math.max(1, maxPages)) * 26),
      `抓取 ${accepted.length + 1}/${maxPages} · ${hostnameOf(url)}`);

    let page;
    try {
      page = await tools.fetchPage(url);
    } catch (err) {
      rejected.push({ url, reason: err.code || 'LA006', message: err.message });
      if (err.code === 'LA005') {
        reporter?.warn(`跳过（站点策略拒绝）：${url} · ${err.message}`);
      }
      continue;
    }

    const source = extractMarkdownSource({
      url,
      finalUrl: page.finalUrl,
      markdown: page.markdown,
      title: page.title || item.title,
      fetchedAt: isoNow()
    });
    source.id = `web-${accepted.length + 1}`;
    source.meta.searchProvider = searchReport.provider;
    source.meta.query = item.query || '';

    const stats = textStats(source.text);
    if (stats.meaningful < config.minContentChars) {
      rejected.push({ url, reason: 'too-short', message: `正文有效字符 ${stats.meaningful} < ${config.minContentChars}` });
      continue;
    }

    const rel = relevance(topic, source.text, source.title);
    if (rel < 0.05) {
      rejected.push({ url, reason: 'low-relevance', message: `主题相关度 ${(rel * 100).toFixed(0)}%` });
      continue;
    }

    const sh = shingles(source.text, 5);
    const dup = seenShingles.find((prev) => jaccard(prev.set, sh) > 0.72);
    if (dup) {
      rejected.push({ url, reason: 'duplicate', message: `与 ${dup.url} 内容重复度较高` });
      continue;
    }

    seenShingles.push({ url, set: sh });
    source.meta.relevance = Number(rel.toFixed(3));
    source.meta.keywords = keywords(source.text, 8).map((k) => k.word);
    source.quality.relevance = Number(rel.toFixed(3));
    accepted.push(source);
    reporter?.stage('crawl', 8 + Math.round((accepted.length / Math.max(1, maxPages)) * 26),
      `已采纳 ${accepted.length} 篇 · ${source.title.slice(0, 24)}`);

    if (depth > 0 && item.depth < depth && accepted.length < maxPages) {
      const links = contextualLinks(page.markdown, page.finalUrl, topic, 3, { sameHostOnly: config.sameHostOnly });
      for (const link of links) {
        if (seenUrls.has(link.url)) continue;
        queue.push({ url: link.url, title: link.label, depth: item.depth + 1, provider: searchReport.provider });
      }
    }
  }

  if (!accepted.length) {
    throw new AgentError('LA011', '抓取完成但没有可用内容', {
      hint: '换用更具体的主题，或直接提供本地文件 / URL 输入源',
      details: { rejected: rejected.slice(0, 10), search: searchReport }
    });
  }

  return {
    sources: accepted,
    tools,
    report: {
      topic,
      search: searchReport,
      requested: candidates.length,
      accepted: accepted.length,
      rejected,
      tools: { ...tools.stats }
    }
  };
}
