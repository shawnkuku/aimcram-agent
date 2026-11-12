import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';
import { AgentError } from '../src/errors.mjs';
import { DeepSeekTools, toolsUrl } from '../src/web/deepseek-tools.mjs';
import { crawlTopic, relevance } from '../src/web/crawl.mjs';
import { searchTopic, SEARCH_QUERIES } from '../src/web/search.mjs';
import { extractMarkdownSource } from '../src/extract/index.mjs';
import { makeFakeTools, ARTICLE_MD } from './helpers.mjs';

function cfg(overrides = {}) {
  return resolveConfig({
    crawlTimeoutMs: 5000,
    maxPages: 4,
    maxDepth: 0,
    minContentChars: 150,
    ...overrides
  });
}

/** 构造 DeepSeek Tools API 的假响应。 */
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

test('toolsUrl：baseUrl 已带 /v1 时不重复拼接', () => {
  assert.equal(toolsUrl('https://api.deepseek.com', 'search'), 'https://api.deepseek.com/v1/tools/search');
  assert.equal(toolsUrl('https://api.deepseek.com/', 'fetch'), 'https://api.deepseek.com/v1/tools/fetch');
  assert.equal(toolsUrl('https://api.deepseek.com/v1', 'search'), 'https://api.deepseek.com/v1/tools/search');
  assert.equal(toolsUrl('https://api.deepseek.com/v1/', 'fetch'), 'https://api.deepseek.com/v1/tools/fetch');
});

test('DeepSeekTools：缺少 API Key 直接抛 LA007', () => {
  assert.throws(() => new DeepSeekTools(cfg({ apiKey: '' })), (err) => err.code === 'LA007');
});

test('DeepSeekTools.search：鉴权头、请求体与结果归一化', async () => {
  const seen = [];
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test' }), {
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return jsonRes(200, {
        results: [
          { title: ' 系统架构设计要点 ', url: 'https://example.com/a', snippet: '架构\n设计', summary: '' },
          { title: '无 URL 项', url: '', snippet: 'x' }
        ]
      });
    }
  });
  const results = await tools.search('系统架构设计', { count: 5 });
  assert.equal(seen[0].url, 'https://api.deepseek.com/v1/tools/search');
  assert.equal(seen[0].init.method, 'POST');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-test');
  const body = JSON.parse(seen[0].init.body);
  assert.deepEqual(body, { query: '系统架构设计', count: 5, need_content: false });
  assert.equal(results[0].title, '系统架构设计要点');
  assert.equal(results[0].snippet, '架构 设计');
  assert.equal(tools.stats.searchCalls, 1);
});

test('DeepSeekTools.search：空结果返回空数组，不算错误', async () => {
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test' }), { fetchImpl: async () => jsonRes(200, { results: [] }) });
  assert.deepEqual(await tools.search('冷门主题'), []);
});

test('DeepSeekTools.search：查询词超长报 LA012', async () => {
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test' }), { fetchImpl: async () => jsonRes(200, { results: [] }) });
  await assert.rejects(() => tools.search('x'.repeat(200)), (err) => err.code === 'LA012');
});

test('DeepSeekTools.fetchPage：返回 Markdown 正文', async () => {
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test' }), {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
      assert.equal(JSON.parse(init.body).url, 'https://example.com/a');
      return jsonRes(200, { title: '系统架构设计要点', content: ARTICLE_MD });
    }
  });
  const page = await tools.fetchPage('https://example.com/a');
  assert.equal(page.finalUrl, 'https://example.com/a');
  assert.equal(page.title, '系统架构设计要点');
  assert.match(page.markdown, /微服务架构按业务能力拆分服务/);
  assert.ok(page.bytes > 0);
  assert.equal(tools.stats.fetchCalls, 1);
});

test('DeepSeekTools：错误码映射（401/402/403/404/其他 4xx）', async () => {
  const mk = (status, body = '') => new DeepSeekTools(cfg({ apiKey: 'sk-test' }), { fetchImpl: async () => jsonRes(status, body) });

  await assert.rejects(() => mk(401).search('q'), (err) => err.code === 'LA007');
  await assert.rejects(() => mk(402).search('q'), (err) => err.code === 'LA006' && /余额不足/.test(err.message));
  await assert.rejects(() => mk(403).fetchPage('https://example.com/a'), (err) => err.code === 'LA005');
  await assert.rejects(() => mk(404).fetchPage('https://example.com/a'),
    (err) => err.code === 'LA006' && /未能获取可用网页内容/.test(err.message));
  await assert.rejects(() => mk(400).search('q'), (err) => err.code === 'LA006' && /HTTP 400/.test(err.message));
});

test('DeepSeekTools：429 指数退避后成功，重试计入 stats', async () => {
  let calls = 0;
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test', llmRetries: 3 }), {
    fetchImpl: async () => {
      calls++;
      return calls < 3 ? jsonRes(429, 'rate limited') : jsonRes(200, { results: [{ title: 't', url: 'https://example.com/a' }] });
    }
  });
  const results = await tools.search('系统架构设计');
  assert.equal(results.length, 1);
  assert.equal(calls, 3);
  assert.equal(tools.stats.retries, 2);
});

test('DeepSeekTools：5xx 重试耗尽后抛 LA006', async () => {
  const tools = new DeepSeekTools(cfg({ apiKey: 'sk-test', llmRetries: 2 }), {
    fetchImpl: async () => jsonRes(503, 'down')
  });
  await assert.rejects(() => tools.fetchPage('https://example.com/a'),
    (err) => err.code === 'LA006' && /HTTP 503/.test(err.message));
  assert.equal(tools.stats.retries, 1);
});

test('searchTopic：两个查询合并、按 URL 去重、过滤非 http(s)、截断 limit', async () => {
  const tools = makeFakeTools({
    results: [
      { title: 'a', url: 'https://example.com/a#section', snippet: '' },
      { title: 'a2', url: 'https://example.com/a', snippet: '' },
      { title: 'b', url: 'ftp://example.com/b', snippet: '' },
      { title: 'c', url: 'https://example.com/c', snippet: '' }
    ]
  });
  const found = await searchTopic('系统架构设计', tools, { limit: 2 });
  assert.equal(found.provider, 'deepseek');
  assert.equal(tools.stats.searchCalls, 2, '默认依次使用前 2 个查询模板');
  assert.deepEqual(found.results.map((r) => r.url), ['https://example.com/a', 'https://example.com/c']);
  assert.ok(found.attempts.every((a) => a.ok));
});

test('searchTopic：全部为空时抛 LA006，搜索失败直接透传', async () => {
  const empty = makeFakeTools({ results: [] });
  await assert.rejects(() => searchTopic('系统架构设计', empty),
    (err) => err.code === 'LA006' && /DeepSeek 搜索未返回结果/.test(err.message));

  const failing = makeFakeTools({ failSearch: new AgentError('LA007', 'DeepSeek API Key 无效或已失效') });
  await assert.rejects(() => searchTopic('系统架构设计', failing), (err) => err.code === 'LA007');
});

test('extractMarkdownSource：Markdown 原文成 Source', () => {
  const source = extractMarkdownSource({
    id: 'web-1',
    url: 'https://example.com/a',
    finalUrl: 'https://example.com/a',
    markdown: '﻿' + ARTICLE_MD,
    title: '系统架构设计要点',
    fetchedAt: '2026-11-06T00:00:00Z'
  });
  assert.equal(source.kind, 'url');
  assert.equal(source.type, 'markdown');
  assert.equal(source.title, '系统架构设计要点');
  assert.equal(source.meta.method, 'deepseek-fetch');
  assert.equal(source.meta.status, 200);
  assert.equal(source.quality.mode, 'heuristic');
  assert.ok(!source.text.startsWith('﻿'), 'BOM 应被去除');
  assert.match(source.text, /系统架构设计要点/);
});

test('主题抓取：检索 → 抓取 → 质量筛选 → 去重', async () => {
  await ttestSeeds();
  await ttestSearch();
  await ttestDeepLinks();
  await ttestEmpty();

  async function ttestSeeds() {
    const tools = makeFakeTools({
      pages: {
        'https://example.com/article': { title: '系统架构设计要点', markdown: ARTICLE_MD },
        'https://example.com/article-dup': { title: '系统架构设计要点', markdown: ARTICLE_MD }
      }
    });
    const result = await crawlTopic('系统架构设计', cfg(), {
      tools,
      seeds: ['https://example.com/article', 'https://example.com/article-dup'],
      maxPages: 4,
      depth: 0
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.report.accepted, 1);
    assert.ok(result.report.rejected.some((r) => r.reason === 'duplicate'));
    assert.equal(result.report.search.provider, 'seed');
    assert.equal(result.tools.stats.fetchCalls, 2);
  }

  async function ttestSearch() {
    const tools = makeFakeTools({
      results: [
        { title: '系统架构设计要点', url: 'https://example.com/article', snippet: '' },
        { title: '短页', url: 'https://example.com/short', snippet: '' },
        { title: '拒绝页', url: 'https://example.com/denied', snippet: '' }
      ],
      pages: {
        'https://example.com/article': { title: '系统架构设计要点', markdown: ARTICLE_MD },
        'https://example.com/short': { title: '短页', markdown: '系统架构设计简介，内容很短。' }
      }
    });
    // 拒绝页：fetch 抛 LA005（目标站点安全策略拒绝）
    const baseFetch = tools.fetchPage.bind(tools);
    tools.fetchPage = async (url) => {
      if (url.endsWith('/denied')) throw new AgentError('LA005', `目标站点安全策略拒绝抓取：${url}`);
      return baseFetch(url);
    };

    const result = await crawlTopic('系统架构设计', cfg(), { tools, maxPages: 4, depth: 0 });
    assert.equal(result.report.search.provider, 'deepseek');
    assert.equal(result.sources.length, 1, '只应采纳正文完整的文章');
    const reasons = result.report.rejected.map((r) => r.reason);
    assert.ok(reasons.includes('LA005'), '站点策略拒绝应被记录');
    assert.ok(reasons.includes('too-short'), '短页应被丢弃');
    assert.equal(result.sources[0].kind, 'url');
    assert.equal(result.sources[0].type, 'markdown');
    assert.match(result.sources[0].text, /微服务架构按业务能力拆分服务/);
    assert.ok(result.report.tools.searchCalls >= 1);
    assert.ok(result.report.tools.fetchCalls >= 2);
  }

  async function ttestDeepLinks() {
    const linked = `${ARTICLE_MD}\n\n延伸阅读：[微服务架构详解](/micro) 与 [外部链接](https://other.com/x)。`;
    const micro = `# 微服务架构详解\n\n微服务架构按业务能力拆分服务，系统架构设计中常用事件驱动架构配合微服务落地，需要处理分布式事务与链路追踪。${'系统架构设计需要权衡。'.repeat(20)}`;
    const tools = makeFakeTools({
      pages: {
        'https://example.com/article': { title: '系统架构设计要点', markdown: linked },
        'https://example.com/micro': { title: '微服务架构详解', markdown: micro },
        'https://other.com/x': { title: '外部', markdown: micro }
      }
    });
    const result = await crawlTopic('系统架构设计', cfg({ maxDepth: 1 }), {
      tools,
      seeds: ['https://example.com/article'],
      maxPages: 4,
      depth: 1
    });
    const urls = result.sources.map((s) => s.url);
    assert.ok(urls.includes('https://example.com/micro'), 'Markdown 相对链接应被解析并跟进');
    assert.ok(!urls.includes('https://other.com/x'), 'sameHostOnly 默认过滤跨站链接');
  }

  async function ttestEmpty() {
    const tools = makeFakeTools({ pages: { 'https://example.com/short': '系统架构设计简介，内容很短。' } });
    await assert.rejects(
      () => crawlTopic('系统架构设计', cfg(), { tools, seeds: ['https://example.com/short'], maxPages: 2, depth: 0 }),
      (err) => err.code === 'LA011'
    );
  }
});

test('主题相关度：长页面不能靠通用二字词刷分', () => {
  const topic = '机动车驾驶证科目四 安全文明驾驶常识';
  const offTopic = ('安全 作业 规范 试题 题库 '.repeat(2000)) + '八大特殊作业安全规范';
  assert.equal(relevance(topic, offTopic, '八大特殊作业安全规范试题题库'), 0);

  const relevant = '科目四考试重点：安全文明驾驶常识，包括礼让行人、恶劣天气、紧急情况处置。';
  assert.ok(relevance(topic, relevant, '科目四安全文明驾驶常识考试重点') > 0.05);
  assert.ok(relevance(topic, relevant, '科目四安全文明驾驶常识考试重点') > relevance(topic, offTopic, '八大特殊作业安全规范试题题库'));
});

test('SEARCH_QUERIES 模板保留', () => {
  assert.ok(SEARCH_QUERIES.length >= 2);
  assert.ok(SEARCH_QUERIES[0]('主题').includes('主题'));
});
