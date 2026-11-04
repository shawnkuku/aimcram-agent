/**
 * 主题检索（可插拔 provider）
 *
 * 默认按 provider 链尝试：wikipedia → duckduckgo → searxng。
 * - wikipedia：使用官方 REST 搜索接口，稳定、条款清晰；
 * - duckduckgo：html.duckduckgo.com 的 HTML 结果页（robots 允许）；
 * - searxng：自建实例的 JSON 接口，最推荐的生产用法（LA_SEARXNG_URL）。
 *
 * 检索请求同样经过 robots 检查与限速；返回结果只是候选，正文仍逐页走 Crawler.fetchPage。
 */

import { load } from 'cheerio';
import { AgentError } from '../errors.mjs';
import { uniqueBy } from '../util.mjs';

const SEARCH_QUERIES = [
  (topic) => `${topic} 核心概念 原理`,
  (topic) => `${topic} 教程 基础知识`,
  (topic) => `${topic} 高频考点 总结`
];

async function guardedText(crawler, url, { trusted = false } = {}) {
  // 自建检索服务（SearXNG / 自定义网关）由使用者自己运维，其 robots 中的
  // `Disallow: /*?*q=*` 是用来劝阻搜索引擎爬虫的，不适用于 API 客户端；
  // 第三方公开检索源（DDG / Wikipedia）仍严格检查 robots。
  let crawlDelay = 0;
  if (!trusted) {
    const verdict = await crawler.checkRobots(url);
    if (!verdict.allowed) {
      throw new AgentError('LA005', `robots 禁止检索接口：${url}`, { details: verdict.reason });
    }
    crawlDelay = verdict.crawlDelay;
  }
  await crawler.throttle(url, crawlDelay);
  // 检索地址来自固定 provider 或用户配置，允许指向本机 SearXNG；正文抓取仍按公网规则校验。
  return crawler.fetchText(url, {
    accept: 'application/json,text/html;q=0.9,text/plain;q=0.5',
    allowPrivate: trusted
  });
}

function decodeDdgRedirect(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const target = u.searchParams.get('uddg');
    return target ? decodeURIComponent(target) : u.toString();
  } catch {
    return href;
  }
}

async function searchDuckDuckGo(crawler, query, limit) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await guardedText(crawler, url);
  const $ = load(html);
  const results = [];
  $('.result, .web-result').each((_, el) => {
    const a = $(el).find('.result__a').first();
    const href = a.attr('href');
    if (!href) return;
    results.push({
      title: a.text().replace(/\s+/g, ' ').trim(),
      url: decodeDdgRedirect(href),
      snippet: $(el).find('.result__snippet').text().replace(/\s+/g, ' ').trim()
    });
  });
  if (!results.length) {
    throw new AgentError('LA006', 'DuckDuckGo 未返回结果（可能触发了反爬验证）', {
      hint: '改用 --search searxng 并配置 LA_SEARXNG_URL，或直接提供 --source'
    });
  }
  return results.slice(0, limit);
}

async function searchSearxng(crawler, query, limit, baseUrl) {
  if (!baseUrl) {
    throw new AgentError('LA012', '缺少 LA_SEARXNG_URL', { hint: '例如 LA_SEARXNG_URL=https://searx.example.com' });
  }
  const url = `${baseUrl.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json&language=zh-CN`;
  const body = await guardedText(crawler, url, { trusted: true });
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AgentError('LA006', 'SearXNG 未返回 JSON（实例可能禁用了 format=json）');
  }
  return (data.results || []).slice(0, limit).map((r) => ({
    title: String(r.title || '').trim(),
    url: String(r.url || '').trim(),
    snippet: String(r.content || '').replace(/\s+/g, ' ').trim()
  }));
}

async function searchWikipedia(crawler, query, limit, lang = 'zh') {
  const url = `https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${Math.min(limit, 8)}`;
  const body = await guardedText(crawler, url);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AgentError('LA006', 'Wikipedia 搜索接口未返回 JSON');
  }
  return (data.pages || []).map((p) => ({
    title: String(p.title || p.key || '').trim(),
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(p.key || p.title)}`,
    snippet: String(p.description || p.excerpt || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  })).slice(0, limit);
}

async function searchCustom(crawler, query, limit, cfg) {
  if (!cfg.searchEndpoint) {
    throw new AgentError('LA012', '缺少 LA_SEARCH_ENDPOINT', {
      hint: '把 {query} 占位符放进自建检索网关地址，返回 SearXNG 兼容 JSON'
    });
  }
  const url = cfg.searchEndpoint.includes('{query}')
    ? cfg.searchEndpoint.replace('{query}', encodeURIComponent(query))
    : `${cfg.searchEndpoint}${cfg.searchEndpoint.includes('?') ? '&' : '?'}q=${encodeURIComponent(query)}`;
  const body = await guardedText(crawler, url, { trusted: true });
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new AgentError('LA006', '自定义检索网关未返回 JSON');
  }
  const list = Array.isArray(data) ? data : data.results || data.items || [];
  return list.slice(0, limit).map((r) => ({
    title: String(r.title || '').trim(),
    url: String(r.url || r.link || '').trim(),
    snippet: String(r.snippet || r.content || r.description || '').replace(/\s+/g, ' ').trim()
  }));
}

const PROVIDERS = {
  duckduckgo: { search: (crawler, q, limit, cfg) => searchDuckDuckGo(crawler, q, limit) },
  searxng: { search: (crawler, q, limit, cfg) => searchSearxng(crawler, q, limit, cfg.searxngUrl) },
  wikipedia: { search: (crawler, q, limit, cfg) => searchWikipedia(crawler, q, limit, cfg.wikiLang || 'zh') },
  custom: { search: (crawler, q, limit, cfg) => searchCustom(crawler, q, limit, cfg) }
};

/**
 * @param {string} topic
 * @param {import('./fetch.mjs').Crawler} crawler
 * @param {{provider?: string, limit?: number, queries?: string[]}} [opts]
 */
export async function searchTopic(topic, crawler, opts = {}) {
  const cfg = crawler.config;
  const requested = opts.provider || cfg.searchProvider || 'auto';
  const chain = requested === 'auto'
    ? ['wikipedia', 'duckduckgo', 'searxng']
    : requested.split(',').map((s) => s.trim()).filter(Boolean);
  const limit = opts.limit || Math.min(cfg.maxPages * 2, 12);
  const queries = opts.queries?.length ? opts.queries : SEARCH_QUERIES.slice(0, 2).map((f) => f(topic));
  const attempts = [];

  for (const name of chain) {
    const provider = PROVIDERS[name];
    if (!provider) {
      attempts.push({ provider: name, ok: false, error: '未知 provider' });
      continue;
    }
    const collected = [];
    for (const query of queries) {
      try {
        const results = await provider.search(crawler, query, limit, cfg);
        collected.push(...results.map((r) => ({ ...r, provider: name, query })));
      } catch (err) {
        attempts.push({ provider: name, query, ok: false, error: err.message, code: err.code });
        break;
      }
    }
    const valid = collected.filter((r) => /^https?:\/\//i.test(r.url));
    if (valid.length) {
      attempts.push({ provider: name, ok: true, count: valid.length });
      return {
        provider: name,
        results: uniqueBy(valid, (r) => r.url.split('#')[0]).slice(0, limit),
        attempts
      };
    }
  }

  throw new AgentError('LA006', '所有检索服务均未返回结果', {
    hint: '配置自建 SearXNG（LA_SEARXNG_URL + --search searxng），或直接提供本地文件 / URL 输入源',
    details: attempts
  });
}

export { SEARCH_QUERIES };
