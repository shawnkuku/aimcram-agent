import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../src/config.mjs';
import { Crawler } from '../src/web/fetch.mjs';
import { crawlTopic, relevance } from '../src/web/crawl.mjs';
import { searchTopic } from '../src/web/search.mjs';
import { startSite } from './helpers.mjs';

function cfg(overrides = {}) {
  return resolveConfig({
    allowPrivateHosts: true,
    rateLimitMs: 5,
    crawlTimeoutMs: 5000,
    maxPages: 4,
    maxDepth: 0,
    minContentChars: 150,
    ...overrides
  });
}

test('合规抓取：robots、重定向与限额', async (t) => {
  const site = await startSite();
  t.after(() => site.close());

  await t.test('抓取正文并跟随重定向', async () => {
    const crawler = new Crawler(cfg());
    const page = await crawler.fetchPage(`${site.url}/redirect`);
    assert.equal(page.status, 200);
    assert.equal(page.finalUrl, `${site.url}/article`);
    assert.match(page.html, /系统架构设计要点/);
  });

  await t.test('robots 禁止的路径不发起请求', async () => {
    const crawler = new Crawler(cfg());
    await assert.rejects(
      () => crawler.fetchPage(`${site.url}/private/secret`),
      (err) => err.code === 'LA005'
    );
    assert.equal(site.hits['/private/secret'] || 0, 0, 'robots 命中时不应真正请求目标页');
  });

  await t.test('默认拒绝内网地址', async () => {
    const crawler = new Crawler(cfg({ allowPrivateHosts: false }));
    await assert.rejects(
      () => crawler.fetchPage(`${site.url}/article`),
      (err) => err.code === 'LA005'
    );
  });

  await t.test('响应体超限时报 LA006', async () => {
    const crawler = new Crawler(cfg());
    await assert.rejects(
      () => crawler.fetchPage(`${site.url}/article`, { maxBytes: 100 }),
      (err) => err.code === 'LA006'
    );
  });

  await t.test('robots.txt 只读取一次', async () => {
    const crawler = new Crawler(cfg());
    await crawler.fetchPage(`${site.url}/article`);
    const before = site.hits['/robots.txt'];
    await crawler.fetchPage(`${site.url}/article`);
    assert.equal(site.hits['/robots.txt'], before, 'robots 结果应缓存');
  });
});

test('主题抓取：检索 → 抓取 → 质量筛选 → 去重', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const config = cfg({ searchProvider: 'custom', searchEndpoint: `${site.url}/search?q={query}` });

  await t.test('种子抓取会丢弃重复页', async () => {
    const result = await crawlTopic('系统架构设计', config, {
      seeds: [`${site.url}/article`, `${site.url}/article-dup`],
      maxPages: 4,
      depth: 0
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.report.accepted, 1);
    assert.ok(result.report.rejected.some((r) => r.reason === 'duplicate'));
  });

  await t.test('自主检索会过滤 robots 禁止页、短页与重复页', async () => {
    const result = await crawlTopic('系统架构设计', config, { maxPages: 4, depth: 0 });
    assert.equal(result.report.search.provider, 'custom');
    assert.equal(result.sources.length, 1, '只应采纳正文完整的文章');
    const reasons = result.report.rejected.map((r) => r.reason);
    assert.ok(reasons.includes('LA005'), '私有页应被 robots 拦截');
    assert.ok(reasons.includes('too-short'), '短页应被丢弃');
    assert.ok(reasons.includes('duplicate'), '重复页应被丢弃');
    assert.equal(site.hits['/private/secret'] || 0, 0);
    assert.ok(result.report.robotsBlocked >= 1);
    assert.equal(result.sources[0].kind, 'url');
    assert.match(result.sources[0].text, /微服务架构按业务能力拆分服务/);
  });

  await t.test('没有任何可用结果时报 LA011', async () => {
    const empty = cfg({});
    await assert.rejects(
      () => crawlTopic('系统架构设计', empty, { seeds: [`${site.url}/short`], maxPages: 2, depth: 0 }),
      (err) => err.code === 'LA011'
    );
  });
});

test('本地 SearXNG：检索端点放行内网，正文抓取仍严格拒绝', async (t) => {
  const site = await startSite();
  t.after(() => site.close());
  const config = cfg({ allowPrivateHosts: false, searxngUrl: site.url });

  const found = await searchTopic('系统架构设计', new Crawler(config), {
    provider: 'searxng',
    limit: 3
  });
  assert.equal(found.provider, 'searxng');
  assert.ok(found.results.length >= 1);
  assert.ok(found.results.every((r) => /^https?:\/\//.test(r.url)));

  const crawler = new Crawler(config);
  await assert.rejects(
    () => crawler.fetchPage(`${site.url}/article`),
    (err) => err.code === 'LA005'
  );
});


test('主题相关度：长页面不能靠通用二字词刷分', () => {
  const topic = '机动车驾驶证科目四 安全文明驾驶常识';
  const offTopic = ('安全 作业 规范 试题 题库 '.repeat(2000)) + '八大特殊作业安全规范';
  assert.equal(relevance(topic, offTopic, '八大特殊作业安全规范试题题库'), 0);

  const relevant = '科目四考试重点：安全文明驾驶常识，包括礼让行人、恶劣天气、紧急情况处置。';
  assert.ok(relevance(topic, relevant, '科目四安全文明驾驶常识考试重点') > 0.05);
  assert.ok(relevance(topic, relevant, '科目四安全文明驾驶常识考试重点') > relevance(topic, offTopic, '八大特殊作业安全规范试题题库'));
});
