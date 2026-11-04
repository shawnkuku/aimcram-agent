#!/usr/bin/env node
/**
 * aimcram-agent CLI
 *
 * 生成：node cli.mjs generate --topic "主题" [--source a.md,b.png,https://…] [--mock]
 * 校验：node cli.mjs verify dist/xxx-1.0.0.zip --strict
 * 解包：node cli.mjs unpack dist/xxx-1.0.0.zip -o work/
 * 自检：node cli.mjs doctor
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AgentError, errorPayload } from './src/errors.mjs';
import { VERSION, resolveConfig, maskSecret } from './src/config.mjs';
import { createReporter } from './src/log.mjs';
import { runPipeline } from './src/pipeline.mjs';
import { createInteractHooks } from './src/interactive.mjs';
import { verifyPack, unpackPack } from './src/pack.mjs';
import { buildCollection, verifyCollection, isCollection } from './src/collection.mjs';
import { ocrCapability } from './src/extract/image.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function usage(code = 0) {
  const text = `
AimCram 智能学习库生成 Agent v${VERSION}

用法：
  node cli.mjs generate [选项]            生成学习库（三模式）
  node cli.mjs interact [选项]           交互式生成：先出大纲交你确认，再逐章生成
  node cli.mjs bundle <包...> [-o 合集.zip]
                                          把多个学习库包打成一个 ZIP 合集
  node cli.mjs verify <包目录|zip>        校验 kshare-pack/v1 学习库包或合集
  node cli.mjs unpack <zip> -o <目录>     解包
  node cli.mjs doctor                     环境自检
  node cli.mjs eval                       内容提取质量评测

bundle 选项：
  <包...>                     目录或 ZIP，可给多个（也支持 --source 列表）
  -o, --out <文件|目录>       输出 ZIP 路径；给目录时写 <name>-<version>.zip
  --name <合集名>             根目录名（默认 aimcram-collection）
  --version <x.y.z>           合集版本（默认 1.0.0）
  --title <标题>              合集标题
  --force                     覆盖同名合集

generate 选项：
  --topic <主题>              学习主题（模式一可省略，自动取首个来源标题）
  --source <列表>             输入源：本地文件 / 图片 / URL / text:... / @clipboard
                              可重复，也可用逗号分隔
  --mode <auto|sources|web|combined>
                              auto：有输入源走模式一，否则模式二；combined 为模式三
  --seed <URL>                模式二 / 三的种子页面（可重复）
  --with-web                  模式一同时做自主抓取（等价于 --mode combined）
  --search <provider>         auto / wikipedia / duckduckgo / searxng
  --pages <N>                 最多抓取页数（默认 8）
  --depth <N>                 站内跟进深度（默认 1）
  --per-section <N>           每节题目数（默认 2）
  --questions <N>             题目总数（精确值，按小节分摊后逐节补齐/裁剪）
  --cases <N>                 案例精析数量（精确值，默认 0 表示不生成）
  --outline <文件>            沿用已有目录（JSON：{title, chapters:[{name, sections:[{name}]}]}）
  --out <目录>                产物目录（默认 ./out）
  --slug <slug>               学习库标识（默认由主题生成）
  --version <x.y.z>           内容版本（默认 1.0.0）
  --title / --subject / --category / --license / --exam / --year / --author
  --tags <a,b>                标签
  --mock                      不调用 LLM，使用本地确定性生成（离线 / 测试）
  --emit <app>                同时生成 App 运行数据（data.js / kb.js）
  --app-dir <目录>            --emit app 的输出目录（必填）
  --json-progress             进度以 NDJSON 输出（适合被上层 Agent 消费）
  --quiet                     静默模式
  --force                     覆盖同 slug+version 的已有产物

示例：
  # 模式一：本地 md + 图片 + 网页
  node cli.mjs generate --topic 网络体系结构 \\
    --source ./samples/architecture-notes.md,./screenshots/osi.png,https://example.com/osi

  # 模式二：只给主题，自主检索抓取
  node cli.mjs generate --topic "系统架构设计" --pages 6

  # 模式三：本地资料 + 自主补充
  node cli.mjs generate --topic "数据库系统" --source ./db.md --mode combined --pages 4

  # 离线跑通全链路
  node cli.mjs generate --topic 示例主题 --source ./samples/architecture-notes.md --mock --out ./out

  # 多学科合并成一个 ZIP（方便传输 / 备份）
  node cli.mjs bundle dist/jiakao-subject1-1.0.0 dist/jiakao-subject4-1.0.0 \\
    --name jiakao --title 驾考学习库 -o dist/
`;
  (code ? process.stderr : process.stdout).write(text.trimStart() + '\n');
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { cmd: 'help', sources: [], seeds: [], tags: [], meta: {}, positionals: [] };
  if (!argv.length) return opts;
  opts.cmd = argv[0];
  const take = (i, val) => (val != null ? val : argv[i + 1] ?? '');
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    switch (key) {
      case '--topic': opts.topic = take(i, inline); if (inline == null) i++; break;
      case '--source':
      case '--sources': {
        const value = take(i, inline);
        if (inline == null) i++;
        String(value).split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => opts.sources.push(s));
        break;
      }
      case '--seed': {
        const value = take(i, inline);
        if (inline == null) i++;
        String(value).split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => opts.seeds.push(s));
        break;
      }
      case '--mode': opts.mode = take(i, inline); if (inline == null) i++; break;
      case '--search': opts.searchProvider = take(i, inline); if (inline == null) i++; break;
      case '--pages': opts.pages = Number(take(i, inline)); if (inline == null) i++; break;
      case '--depth': opts.depth = Number(take(i, inline)); if (inline == null) i++; break;
      case '--per-section': opts.perSection = Number(take(i, inline)); if (inline == null) i++; break;
      case '--questions': opts.questionCount = Number(take(i, inline)); if (inline == null) i++; break;
      case '--cases': opts.caseCount = Number(take(i, inline)); if (inline == null) i++; break;
      case '--outline': opts.outlineFile = take(i, inline); if (inline == null) i++; break;
      case '--out':
      case '-o': opts.out = take(i, inline); if (inline == null) i++; break;
      case '--slug': opts.meta.slug = take(i, inline); if (inline == null) i++; break;
      case '--name': opts.name = take(i, inline); if (inline == null) i++; break;
      case '--version': opts.meta.version = take(i, inline); if (inline == null) i++; break;
      case '--title': opts.meta.title = take(i, inline); if (inline == null) i++; break;
      case '--subject': opts.meta.subject = take(i, inline); if (inline == null) i++; break;
      case '--category': opts.meta.category = take(i, inline); if (inline == null) i++; break;
      case '--license': opts.meta.license = take(i, inline); if (inline == null) i++; break;
      case '--exam': opts.meta.exam = take(i, inline); if (inline == null) i++; break;
      case '--year': opts.meta.year = Number(take(i, inline)); if (inline == null) i++; break;
      case '--author': opts.meta.author = take(i, inline); if (inline == null) i++; break;
      case '--tags': {
        const value = take(i, inline);
        if (inline == null) i++;
        String(value).split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => opts.tags.push(s));
        break;
      }
      case '--rate-limit': opts.rateLimitMs = Number(take(i, inline)); if (inline == null) i++; break;
      case '--mock': opts.mock = true; break;
      case '--with-web': opts.withWeb = true; break;
      case '--emit': opts.emit = take(i, inline); if (inline == null) i++; break;
      case '--app-dir': opts.appDir = take(i, inline); if (inline == null) i++; break;
      case '--json-progress': opts.jsonProgress = true; break;
      case '--json': opts.json = true; break;
      case '--quiet': opts.quiet = true; break;
      case '--force': opts.force = true; break;
      case '--strict': opts.strict = true; break;
      case '--app-version': opts.appVersion = take(i, inline); if (inline == null) i++; break;
      case '--threshold': opts.threshold = Number(take(i, inline)); if (inline == null) i++; break;
      case '-h':
      case '--help': opts.cmd = 'help'; break;
      default:
        if (key.startsWith('-')) {
          process.stderr.write(`未知参数：${a}\n`);
          process.exit(2);
        }
        opts.positionals.push(a);
    }
  }
  return opts;
}

function fail(err, reporter) {
  const payload = errorPayload(err);
  if (reporter) reporter.error(err);
  else {
    process.stderr.write(`\n✗ [${payload.code}] ${payload.message}\n`);
    if (payload.hint) process.stderr.write(`  提示：${payload.hint}\n`);
    if (payload.details) process.stderr.write(`  详情：${JSON.stringify(payload.details).slice(0, 1500)}\n`);
  }
  process.exitCode = 1;
}

async function cmdGenerate(opts) {
  const reporter = createReporter({ json: opts.jsonProgress, quiet: opts.quiet });
  const config = resolveConfig({
    outDir: opts.out,
    searchProvider: opts.searchProvider,
    maxPages: opts.pages,
    maxDepth: opts.depth,
    questionsPerSection: opts.perSection,
    rateLimitMs: opts.rateLimitMs
  });
  if (opts.emit === 'app' && !opts.appDir) {
    throw new AgentError('LA012', '--emit app 需要同时指定 --app-dir');
  }
  if (opts.sources.some((s) => s === '@clipboard')) {
    // 允许，由 pipeline 处理
  }
  let presetOutline = null;
  if (opts.outlineFile) {
    try {
      presetOutline = JSON.parse(fs.readFileSync(opts.outlineFile, 'utf8'));
    } catch (e) {
      throw new AgentError('LA012', '无法读取 --outline 目录文件：' + e.message);
    }
  }
  const result = await runPipeline({
    topic: opts.topic,
    inputs: opts.sources,
    seeds: opts.seeds,
    mode: opts.withWeb ? 'combined' : opts.mode,
    config,
    reporter,
    mock: opts.mock,
    meta: { ...opts.meta, tags: opts.tags },
    outDir: config.outDir,
    emitAppDir: opts.emit === 'app' ? opts.appDir : '',
    searchProvider: opts.searchProvider,
    force: opts.force,
    questionCount: opts.questionCount,
    caseCount: opts.caseCount,
    presetOutline
  });

  if (opts.jsonProgress) {
    reporter.result({
      ok: true,
      topic: result.topic,
      mode: result.mode,
      slug: result.slug,
      version: result.version,
      stats: { ...result.stats, llm: result.llm || null },
      coverage: { sources: result.coverage.sources, totalChars: result.coverage.totalChars },
      paths: result.paths
    });
  } else if (!opts.quiet) {
    const r = result;
    const out = [];
    out.push('');
    out.push('学习库已生成');
    out.push(`  模式      ${r.mode}`);
    out.push(`  主题      ${r.topic}`);
    out.push(`  标识      ${r.slug} ${r.version}`);
    out.push(`  规模      ${r.stats.chapters} 章 / ${r.stats.sections} 节 / ${r.stats.questions} 题 / ${r.stats.cases || 0} 案例 / ${r.stats.plates} 知识板块`);
    const q = r.stats.quality;
    if (q) {
      const flags = [
        `目标 ${q.planChapters} 章 → 实际 ${q.actualChapters} 章`,
        q.outlineRetried ? '大纲补足 1 次' : '',
        q.outlineStaged ? '分步大纲' : '',
        q.shellDropped ? `空壳题剔除 ${q.shellDropped}` : '',
        q.sectionsFilled ? `兜底题 ${q.sectionsFilled}` : ''
      ].filter(Boolean);
      out.push(`  质量      ${flags.join('，')}`);
    }
    out.push(`  来源      ${r.coverage.sources} 个（${Object.entries(r.coverage.byType).map(([k, v]) => `${k} ${v}`).join('，')}），有效 ${r.coverage.totalChars} 字`);
    if (r.crawl) out.push(`  抓取      ${r.crawl.accepted ?? 0} 篇采纳 / ${r.crawl.rejected?.length ?? 0} 篇丢弃，robots 拦截 ${r.crawl.robotsBlocked ?? 0} 次`);
    out.push(`  生成器    ${r.generator}`);
    if (r.verification.warnings.length) {
      out.push(`  警告      ${r.verification.warnings.length} 条`);
      r.verification.warnings.slice(0, 5).forEach((w) => out.push(`            ${w.code} ${w.path} ${w.message}`));
    }
    out.push(`  包目录    ${r.paths.dir}`);
    out.push(`  ZIP       ${r.paths.zip}`);
    out.push(`  Markdown  ${r.paths.md}`);
    out.push(`  报告      ${r.paths.report}`);
    if (r.appFiles) out.push(`  App 数据  ${r.appFiles.dataJs} / ${r.appFiles.kbJs}`);
    out.push('');
    reporter.info(out.join('\n'));
  }
  return result;
}

function cmdBundle(opts) {
  const targets = [...opts.positionals, ...opts.sources];
  if (!targets.length) {
    throw new AgentError('LA012', 'bundle 需要至少一个学习库包目录或 ZIP');
  }
  const out = opts.out ? path.resolve(opts.out) : '';
  const outFile = out && /\.zip$/i.test(out) ? out : '';
  const outDir = outFile ? '' : (out || process.cwd());
  const result = buildCollection({
    targets,
    outFile,
    outDir,
    name: opts.name || 'aimcram-collection',
    version: opts.meta.version || '1.0.0',
    title: opts.meta.title || '',
    force: opts.force
  });
  const c = result.collection;
  const lines = [];
  lines.push('');
  lines.push('学习库合集已生成');
  lines.push(`  名称      ${c.name} ${c.version}${c.title !== c.name ? ` · ${c.title}` : ''}`);
  lines.push(`  学习库    ${c.counts.packs} 个：${c.packs.map((p) => `${p.slug}（${p.counts?.questions ?? 0} 题）`).join(' / ')}`);
  lines.push(`  规模      ${c.counts.chapters} 章 / ${c.counts.sections} 节 / ${c.counts.questions} 题`);
  lines.push(`  ZIP       ${result.zip}`);
  lines.push(`  结构      ${result.rootName}/collection.json + ${c.counts.packs} 个 kshare-pack/v1`);
  lines.push('');
  if (!opts.quiet) process.stdout.write(lines.join('\n'));
  return result;
}

function cmdVerify(opts, target) {
  if (!target) throw new AgentError('LA012', 'verify 需要学习库包路径');
  const collection = isCollection(target);
  const report = collection
    ? verifyCollection(target, { strict: opts.strict, appVersion: opts.appVersion })
    : verifyPack(target, { strict: opts.strict, appVersion: opts.appVersion });
  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    const lines = [];
    lines.push(`${report.ok ? '✓' : '✗'} ${target}`);
    lines.push(`  错误 ${report.errors.length} · 警告 ${report.warnings.length}${opts.strict ? '（strict）' : ''}`);
    for (const e of report.errors) lines.push(`  E ${e.code}  ${e.path}  ${e.message}${e.innerCode ? `（inner ${e.innerCode}）` : ''}`);
    for (const w of report.warnings) lines.push(`  W ${w.code}  ${w.path}  ${w.message}`);
    if (collection) {
      if (report.collection) lines.push(`  合集：${report.collection.name} ${report.collection.version} · ${report.packs.length} 个学习库`);
      for (const p of report.packs) {
        lines.push(`    ${p.ok ? '✓' : '✗'} ${p.slug} ${p.version} · ${p.title}（${p.counts?.questions ?? 0} 题）`);
      }
    } else if (report.manifest) {
      lines.push(`  包：${report.manifest.slug} ${report.manifest.version} · ${report.manifest.title}`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }
  process.exitCode = report.ok ? 0 : 1;
  return report;
}

function cmdUnpack(opts, target) {
  if (!target) throw new AgentError('LA012', 'unpack 需要 ZIP 路径');
  const outDir = path.resolve(opts.out || path.basename(target, '.zip'));
  const result = unpackPack(target, outDir);
  process.stdout.write(`已解包 ${result.files} 个文件 → ${result.root}\n`);
  return result;
}

async function cmdDoctor(opts) {
  const config = resolveConfig({});
  const deps = {};
  for (const name of ['cheerio', 'jsdom', '@mozilla/readability', 'robots-parser', 'pdfjs-dist', 'mammoth']) {
    try {
      await import(name === 'pdfjs-dist' ? 'pdfjs-dist/legacy/build/pdf.mjs' : name);
      deps[name] = true;
    } catch {
      deps[name] = false;
    }
  }
  const info = {
    version: VERSION,
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
    deps,
    ocr: ocrCapability(),
    llm: {
      apiKey: config.apiKey ? maskSecret(config.apiKey) : '',
      baseUrl: config.baseUrl,
      model: config.model
    },
    crawl: {
      userAgent: config.userAgent,
      rateLimitMs: config.rateLimitMs,
      searchProvider: config.searchProvider,
      maxPages: config.maxPages
    },
    kshare: fs.existsSync(path.resolve(HERE, '../tools/kshare.mjs'))
  };
  const ok = Object.values(deps).every(Boolean) && info.kshare;
  info.ok = ok;
  if (opts.json) process.stdout.write(JSON.stringify(info, null, 2) + '\n');
  else {
    const lines = [
      `aimcram-agent v${VERSION} · node ${process.version} · ${process.platform}`,
      `依赖        ${Object.entries(deps).map(([k, v]) => `${k}${v ? '✓' : '✗'}`).join('  ')}`,
      `kshare      ${info.kshare ? '✓ 已找到 services/tools/kshare.mjs' : '✗ 缺失'}`,
      `OCR         ${info.ocr.vision ? 'macOS Vision ✓' : info.ocr.tesseract ? 'tesseract ✓' : '✗ 不可用'}`,
      `DeepSeek    ${info.llm.apiKey ? `已配置 ${info.llm.apiKey}` : '未配置（可用 --mock 离线生成）'}`,
      `抓取        限速 ${info.crawl.rateLimitMs}ms · 最多 ${info.crawl.maxPages} 页 · 检索 ${info.crawl.searchProvider}`,
      `User-Agent ${info.crawl.userAgent}`
    ];
    process.stdout.write(lines.join('\n') + '\n');
  }
  process.exitCode = ok ? 0 : 1;
}

async function cmdEval(opts) {
  const { runEval } = await import('./tests/eval.mjs');
  const report = await runEval({ threshold: opts.threshold ?? 0.95 });
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else {
    const lines = ['内容提取评测（字符级 F1，归一化后比较）'];
    for (const c of report.cases) {
      lines.push(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(18)} F1 ${(c.f1 * 100).toFixed(1)}%  召回 ${(c.recall * 100).toFixed(1)}%  ${c.note || ''}`);
    }
    lines.push(`  数字文本类平均 F1：${(report.digitalF1 * 100).toFixed(1)}%`);
    if (report.ocrF1 != null) lines.push(`  OCR 平均 F1：${(report.ocrF1 * 100).toFixed(1)}%`);
    lines.push(`  阈值 ${(report.threshold * 100).toFixed(0)}%：${report.ok ? '通过' : '未通过'}`);
    process.stdout.write(lines.join('\n') + '\n');
  }
  process.exitCode = report.ok ? 0 : 1;
  return report;
}

/* 逐行读取 stdin 的 JSON 消息；上层（App 桥 / DSH）按行写 confirm 即可驱动交互。 */
function createStdinReader() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const queue = [];
  const waiters = [];
  rl.on('line', (line) => {
    let msg = null;
    try { msg = JSON.parse(line); } catch { /* 忽略非 JSON 行 */ }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(msg);
    else queue.push(msg);
  });
  rl.on('close', () => { while (waiters.length) waiters.shift().resolve(null); });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve) => waiters.push({ resolve }));
    },
    close() { rl.close(); }
  };
}

async function cmdInteract(opts) {
  const reporter = createReporter({ json: true, quiet: false });
  const config = resolveConfig({
    outDir: opts.out,
    searchProvider: opts.searchProvider,
    maxPages: opts.pages,
    maxDepth: opts.depth,
    questionsPerSection: opts.perSection,
    rateLimitMs: opts.rateLimitMs
  });
  if (opts.emit === 'app' && !opts.appDir) {
    throw new AgentError('LA012', '--emit app 需要同时指定 --app-dir');
  }
  const reader = createStdinReader();
  try {
    const io = {
      write: (obj) => process.stdout.write(JSON.stringify(obj) + '\n'),
      awaitMessage: async (type) => {
        while (true) {
          const msg = await reader.next();
          if (msg == null) return null;           // stdin 关闭：当作取消
          if (msg.type === type) return msg;
        }
      }
    };
    const hooks = createInteractHooks(io);
    const result = await runPipeline({
      topic: opts.topic,
      inputs: opts.sources,
      seeds: opts.seeds,
      mode: opts.withWeb ? 'combined' : opts.mode,
      config,
      reporter,
      mock: opts.mock,
      meta: { ...opts.meta, tags: opts.tags },
      outDir: config.outDir,
      emitAppDir: opts.emit === 'app' ? opts.appDir : '',
      searchProvider: opts.searchProvider,
      force: opts.force,
      questionCount: opts.questionCount,
      caseCount: opts.caseCount,
      interact: {
        confirmOutline: hooks.confirmOutline,
        askInsufficient: hooks.askInsufficient,
        confirmChapter: hooks.confirmChapter
      }
    });
    reporter.result({
      ok: true,
      topic: result.topic,
      mode: result.mode,
      slug: result.slug,
      version: result.version,
      stats: { ...result.stats, llm: result.llm || null },
      coverage: { sources: result.coverage.sources, totalChars: result.coverage.totalChars },
      paths: result.paths
    });
    return result;
  } finally {
    reader.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.cmd === 'help' || opts.cmd === '-h' || opts.cmd === '--help') usage(0);
  try {
    if (opts.cmd === 'generate' || opts.cmd === 'run') await cmdGenerate(opts);
    else if (opts.cmd === 'interact') await cmdInteract(opts);
    else if (opts.cmd === 'bundle') cmdBundle(opts);
    else if (opts.cmd === 'verify') cmdVerify(opts, opts.positionals[0]);
    else if (opts.cmd === 'unpack') cmdUnpack(opts, opts.positionals[0]);
    else if (opts.cmd === 'doctor') await cmdDoctor(opts);
    else if (opts.cmd === 'eval') await cmdEval(opts);
    else if (opts.cmd === 'version') process.stdout.write(VERSION + '\n');
    else usage(2);
  } catch (err) {
    fail(err, createReporter({ json: opts.jsonProgress, quiet: opts.quiet }));
  }
}

main();
