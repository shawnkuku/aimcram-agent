import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/pipeline.mjs';
import { verifyPack } from '../src/pack.mjs';
import { createReporter } from '../src/log.mjs';
import { makeTempDir, makeFakeTools, FIXTURE_TEXT, ARTICLE_MD } from './helpers.mjs';

function writeNotes(dir, name = 'notes.md') {
  const file = path.join(dir, name);
  const parts = FIXTURE_TEXT.split('\n\n');
  fs.writeFileSync(file, [
    `# ${parts[0]}`,
    `## 分层模型\n${parts[1]}`,
    `## 传输协议\n${parts[2]}`,
    `## 网络安全\n${parts[3]}`,
    `## 网络管理\n${parts[4]}`
  ].join('\n\n'), 'utf8');
  return file;
}

function baseConfig(overrides = {}) {
  return {
    crawlTimeoutMs: 5000,
    maxPages: 3,
    maxDepth: 0,
    minContentChars: 150,
    ...overrides
  };
}

test('模式一：指定输入源 → 学习库包', async (t) => {
  const root = makeTempDir('la-pipe-sources-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const md = writeNotes(root);
  const outDir = path.join(root, 'out');
  const events = [];
  const reporter = createReporter({ quiet: true, onProgress: (e) => events.push(e) });

  const result = await runPipeline({
    topic: '网络体系结构',
    inputs: [md],
    mode: 'auto',
    mock: true,
    config: baseConfig(),
    reporter,
    outDir,
    meta: { slug: 'pipe-sources', version: '1.0.0' }
  });

  await t.test('产物与包校验', () => {
    assert.equal(result.mode, 'sources');
    assert.equal(result.slug, 'pipe-sources');
    assert.equal(result.verification.ok, true);
    assert.deepEqual(result.verification.errors, []);
    assert.ok(result.stats.chapters >= 1);
    assert.ok(result.stats.sections >= 2);
    assert.ok(result.stats.questions >= result.stats.sections, '每节至少 1 题');
    assert.ok(fs.existsSync(result.paths.zip));
    assert.ok(fs.existsSync(result.paths.dir));
    assert.ok(fs.existsSync(result.paths.md));
    assert.ok(fs.existsSync(result.paths.report));

    const report = JSON.parse(fs.readFileSync(result.paths.report, 'utf8'));
    assert.equal(report.mode, 'sources');
    assert.equal(report.sources.length, 1);
    assert.equal(report.sources[0].type, 'markdown');

    const again = verifyPack(result.paths.zip, { strict: true, appVersion: '1.0.0' });
    assert.equal(again.ok, true);
  });

  await t.test('进度事件覆盖全部阶段并到达 100%', () => {
    const stages = new Set(events.map((e) => e.stage));
    for (const s of ['extract', 'dedupe', 'outline', 'questions', 'pack', 'verify', 'done']) {
      assert.ok(stages.has(s), `缺少阶段 ${s}`);
    }
    assert.equal(events.at(-1).percent, 100);
    assert.ok(events.every((e) => e.percent >= 0 && e.percent <= 100));
    assert.ok(events.every((e) => typeof e.label === 'string' && e.label.length > 0));
  });

  await t.test('--emit app 生成 App 运行数据', async () => {
    const appDir = path.join(root, 'app');
    const emitted = await runPipeline({
      topic: '网络体系结构',
      inputs: [md],
      mode: 'sources',
      mock: true,
      config: baseConfig(),
      outDir: path.join(root, 'out-app'),
      emitAppDir: appDir
    });
    assert.ok(emitted.appFiles);
    assert.ok(fs.existsSync(path.join(appDir, 'data.js')));
    assert.ok(fs.existsSync(path.join(appDir, 'kb.js')));
    assert.ok(fs.statSync(path.join(appDir, 'data.js')).size > 0);
  });
});

test('模式二：只给主题，通过 DeepSeek 检索抓取生成学习库', async (t) => {
  const root = makeTempDir('la-pipe-web-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const tools = makeFakeTools({
    results: [
      { title: '系统架构设计要点', url: 'https://example.com/article', snippet: '' },
      { title: '短页', url: 'https://example.com/short', snippet: '' }
    ],
    pages: {
      'https://example.com/article': { title: '系统架构设计要点', markdown: ARTICLE_MD },
      'https://example.com/short': { title: '短页', markdown: '系统架构设计简介，内容很短。' }
    }
  });

  const result = await runPipeline({
    topic: '系统架构设计',
    inputs: [],
    mode: 'web',
    mock: true,
    config: baseConfig(),
    tools,
    outDir: path.join(root, 'out'),
    meta: { slug: 'pipe-web', version: '1.0.0' }
  });

  assert.equal(result.mode, 'web');
  assert.equal(result.verification.ok, true);
  assert.ok(result.coverage.sources >= 1);
  assert.ok(result.crawl, '应包含抓取报告');
  assert.equal(result.crawl.search.provider, 'deepseek');
  assert.equal(result.crawl.accepted, 1);
  assert.ok(result.crawl.rejected.some((r) => r.reason === 'too-short'), '短页应被丢弃');
  assert.ok(result.crawl.tools.searchCalls >= 1);
  assert.ok(result.crawl.tools.fetchCalls >= 1);
  assert.ok(fs.existsSync(result.paths.zip));
  assert.equal(verifyPack(result.paths.zip, { strict: true }).ok, true);
});

test('模式三：本地资料 + DeepSeek 抓取合并生成', async (t) => {
  const root = makeTempDir('la-pipe-combined-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const md = writeNotes(root);

  const tools = makeFakeTools({
    pages: {
      'https://example.com/article': { title: '系统架构设计要点', markdown: ARTICLE_MD }
    }
  });

  const result = await runPipeline({
    topic: '系统架构设计',
    inputs: [md],
    seeds: ['https://example.com/article'],
    mode: 'combined',
    mock: true,
    config: baseConfig(),
    tools,
    outDir: path.join(root, 'out'),
    meta: { slug: 'pipe-combined', version: '1.0.0' }
  });

  assert.equal(result.mode, 'combined');
  assert.equal(result.verification.ok, true);
  assert.equal(result.coverage.sources, 2, '本地文档 + 抓取文章');
  assert.ok(result.coverage.byType.markdown >= 2, '本地 md 与抓取的 Markdown 都计入');
  assert.equal(result.crawl.accepted, 1);
  assert.equal(verifyPack(result.paths.zip, { strict: true }).ok, true);
});

test('参数校验与错误码', async (t) => {
  await t.test('模式一缺少输入源报 LA001', async () => {
    await assert.rejects(
      () => runPipeline({ topic: 'x', inputs: [], mode: 'sources', mock: true }),
      (err) => err.code === 'LA001'
    );
  });

  await t.test('模式二缺少主题与种子报 LA001', async () => {
    await assert.rejects(
      () => runPipeline({ inputs: [], mode: 'web', mock: true }),
      (err) => err.code === 'LA001'
    );
  });

  await t.test('抓取不到足够内容报 LA011', async () => {
    const tools = makeFakeTools({
      results: [{ title: '系统架构设计要点', url: 'https://example.com/article', snippet: '' }],
      pages: { 'https://example.com/article': { title: '系统架构设计要点', markdown: ARTICLE_MD } }
    });
    await assert.rejects(
      () => runPipeline({
        topic: '系统架构设计',
        inputs: [],
        mode: 'web',
        mock: true,
        // 门槛抬高到远超示例页正文，模拟「抓到页但内容不足」的场景
        config: baseConfig({ minContentChars: 10_000 }),
        tools,
        outDir: path.join(makeTempDir('la-pipe-err-'), 'out'),
        meta: { slug: 'pipe-err' }
      }),
      (err) => err.code === 'LA011'
    );
  });
});
