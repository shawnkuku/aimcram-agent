/**
 * 三模式流水线
 *
 * 模式一 sources：用户给定本地文档 / 图片 / 网页链接 → 提取 → 生成 → 组包
 * 模式二 web：只给主题 → DeepSeek 检索 + 抓取 → 去重筛选 → 生成 → 组包
 * 模式三 combined：本地/指定源 + 自主抓取，合并后生成
 *
 * 所有模式共用同一套 Source 模型、同一套生成器与同一个 kshare-pack/v1 产物。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.mjs';
import { resolveConfig, VERSION } from './config.mjs';
import { createLLM } from './llm.mjs';
import { MockLLM } from './mock.mjs';
import { DeepSeekTools } from './web/deepseek-tools.mjs';
import { crawlTopic } from './web/crawl.mjs';
import { extractFile, extractInlineText, extractMarkdownSource } from './extract/index.mjs';
import { generateStudyLibrary, generateOutlineRaw, normalizePresetOutline } from './generate.mjs';
import { importLibrary } from './import.mjs';
import { suggestDepth } from './interactive.mjs';
import { buildPack, verifyPack } from './pack.mjs';
import { emitAppData } from './exports.mjs';
import {
  slugify, today, isoNow, ensureDir, writeJson, textStats, shingles, jaccard, uniqueBy
} from './util.mjs';
import { spawnSync } from 'node:child_process';

function isUrl(value) {
  return /^https?:\/\//i.test(String(value || '').trim());
}

function resolveMode(mode, hasInputs) {
  if (mode === 'auto') return hasInputs ? 'sources' : 'web';
  if (!['sources', 'web', 'combined', 'import'].includes(mode)) {
    throw new AgentError('LA012', `未知模式：${mode}`, { hint: '可选 auto / sources / web / combined / import' });
  }
  return mode;
}

async function readClipboard() {
  const r = spawnSync('pbpaste', [], { encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw new AgentError('LA004', '读取剪贴板失败（仅 macOS 支持 @clipboard）');
  return extractInlineText(r.stdout, { title: '剪贴板文本' });
}

/**
 * @param {{
 *  topic?: string, inputs?: string[], mode?: string, seeds?: string[],
 *  config?: object, reporter?: any, mock?: boolean, llm?: any,
 *  meta?: object, emitAppDir?: string, withWeb?: boolean,
 *  outlineHook?: (outline: object) => Promise<object|null>,
 *  interact?: {
 *    confirmOutline?: (outline: object, suggest?: object) => Promise<object|null>,
 *    askInsufficient?: (info: object) => Promise<'continue'|'abort'>,
 *    confirmChapter?: (info: object) => Promise<'ok'|'abort'|'ok-all'>
 *  }
 * }} params
 */
export async function runPipeline(params = {}) {
  const started = Date.now();
  const config = resolveConfig(params.config || {});
  const reporter = params.reporter;
  const inputs = (params.inputs || []).map((s) => String(s).trim()).filter(Boolean);
  const seeds = (params.seeds || []).map((s) => String(s).trim()).filter(Boolean);
  let topic = String(params.topic || '').trim();
  let mode = resolveMode(params.mode || 'auto', inputs.length > 0);
  if (mode === 'sources' && !inputs.length) {
    throw new AgentError('LA001', '模式一需要至少一个输入源', { hint: '--source 文件路径 / 图片 / URL，可重复或逗号分隔' });
  }
  if (mode === 'import' && !inputs.length) {
    throw new AgentError('LA001', '题库直采需要至少一个 JSONL / JSON 文件');
  }
  if (mode === 'web' && !topic && !seeds.length) {
    throw new AgentError('LA001', '模式二需要指定学习主题', { hint: '--topic 例如「系统架构设计」' });
  }
  if (mode === 'combined' && !inputs.length && !seeds.length) {
    throw new AgentError('LA001', '模式三需要输入源或种子 URL');
  }

  const sources = [];
  const notes = [];
  // 联网搜索 / 网页抓取统一走 DeepSeek Search/Fetch；只在真正需要时才构造（无 Key 抛 LA007）
  let tools = params.tools || null;
  const getTools = () => (tools ||= new DeepSeekTools(config));

  /* ---------------------------- 1. 输入源解析 ---------------------------- */
  if (inputs.length) {
    reporter?.stage('resolve', 3, `解析 ${inputs.length} 个输入源`);
    for (const [idx, input] of inputs.entries()) {
      const label = input.length > 60 ? input.slice(0, 57) + '…' : input;
      reporter?.stage('extract', 4 + Math.round((idx / inputs.length) * 12), `提取 ${idx + 1}/${inputs.length} · ${label}`);
      try {
        let source;
        if (isUrl(input)) {
          const page = await getTools().fetchPage(input);
          source = extractMarkdownSource({
            url: input,
            finalUrl: page.finalUrl,
            markdown: page.markdown,
            title: page.title,
            fetchedAt: isoNow()
          });
        } else if (input === '@clipboard') {
          source = await readClipboard();
        } else if (input.startsWith('text:')) {
          source = extractInlineText(input.slice(5), { title: topic || '内联文本' });
        } else {
          source = await extractFile(input, { cacheDir: config.ocrCacheDir });
        }
        source.id = source.id || `src-${sources.length + 1}`;
        sources.push(source);
        for (const w of source.warnings || []) reporter?.warn(`[${source.title}] ${w}`);
      } catch (err) {
        if (err instanceof AgentError && err.code === 'LA005') {
          reporter?.warn(`跳过（合规限制）：${label} · ${err.message}`);
          notes.push({ input, skipped: true, code: err.code, message: err.message });
          continue;
        }
        if (inputs.length === 1) throw err;
        reporter?.warn(`跳过 ${label}：${err.message}`);
        notes.push({ input, skipped: true, code: err.code || 'LA003', message: err.message });
      }
    }
  }

  /* ---------------------------- 2. 自主抓取 ---------------------------- */
  let crawlReport = null;
  if (mode === 'web' || mode === 'combined') {
    if (!topic) {
      topic = sources[0]?.title || '';
      if (!topic) throw new AgentError('LA001', '无法确定学习主题', { hint: '请显式设置 --topic' });
    }
    reporter?.stage('crawl', 8, `检索并抓取「${topic}」相关内容`);
    try {
      const crawled = await crawlTopic(topic, config, {
        reporter,
        seeds,
        maxPages: config.maxPages,
        tools: getTools()
      });
      crawlReport = crawled.report;
      for (const s of crawled.sources) sources.push(s);
    } catch (err) {
      if (mode === 'combined' && sources.length) {
        reporter?.warn(`自主抓取未成功，继续使用已有输入源：${err.message}`);
        crawlReport = { error: err.message, code: err.code };
      } else {
        throw err;
      }
    }
  }

  /* ---------------------------- 3. 去重与质量门槛 ---------------------------- */
  reporter?.stage('dedupe', 36, '去重与质量筛选');
  const deduped = [];
  const seen = [];
  for (const s of sources) {
    const stats = textStats(s.text);
    if (stats.meaningful < 80) {
      notes.push({ source: s.title, skipped: true, code: 'LA011', message: `有效字符仅 ${stats.meaningful}` });
      continue;
    }
    const sh = shingles(s.text, 6);
    const dup = seen.find((prev) => jaccard(prev.set, sh) > 0.86);
    if (dup) {
      notes.push({ source: s.title, skipped: true, code: 'dup', message: `与「${dup.title}」高度重复` });
      continue;
    }
    seen.push({ title: s.title, set: sh });
    deduped.push(s);
  }
  sources.length = 0;
  sources.push(...deduped);

  const totalChars = sources.reduce((n, s) => n + textStats(s.text).meaningful, 0);
  /* 直采按题量判断有效性，不受正文字数下限限制 */
  if (mode !== 'import' && (!sources.length || totalChars < config.minContentChars)) {
    let proceed = false;
    if (typeof params.interact?.askInsufficient === 'function') {
      reporter?.stage('dedupe', 38, '有效内容不足，等待用户决策');
      proceed = (await params.interact.askInsufficient({
        totalChars,
        minContentChars: config.minContentChars,
        sources: sources.length,
        hint: `有效内容需不少于 ${config.minContentChars} 字符；扫描件请先用图片模式 OCR`,
        notes: notes.slice(0, 10)
      })) === 'continue';
    }
    if (!proceed) {
      throw new AgentError('LA011', `没有足够的有效内容（${totalChars} 字符）`, {
        hint: `有效内容需不少于 ${config.minContentChars} 字符；扫描件请先用图片模式 OCR`,
        details: notes.slice(0, 10)
      });
    }
  }
  if (!topic) topic = sources[0].title;

  const coverage = {
    sources: sources.length,
    totalChars,
    byType: sources.reduce((acc, s) => {
      acc[s.type] = (acc[s.type] || 0) + 1;
      return acc;
    }, {}),
    ocr: sources.filter((s) => s.type === 'image').map((s) => ({
      title: s.title,
      engine: s.meta?.ocr?.engine || s.meta?.method,
      meanConfidence: s.meta?.ocr?.meanConfidence ?? null,
      lines: s.meta?.ocr?.lines ?? null
    })),
    lowConfidence: sources.filter((s) => s.quality?.confidence != null && s.quality.confidence < 0.6).map((s) => s.title),
    warnings: sources.flatMap((s) => (s.warnings || []).map((w) => ({ source: s.title, warning: w })))
  };

  /* ---------------------------- 4. 生成 ---------------------------- */
  const useMock = Boolean(params.mock);
  let llm = params.llm;
  if (!llm) {
    if (mode === 'import') {
      /* 直采不强制调用模型；有 Key 时用于题量不足的补题 */
      llm = { name: 'aimcram-agent/import', stats: {} };
      if (!useMock && config.apiKey) {
        try {
          llm = createLLM(config);
        } catch {
          /* Key 异常时退回纯直采 */
        }
      }
    } else if (useMock) {
      llm = new MockLLM({ sources, topic, config });
    } else {
      llm = createLLM(config);
    }
  }

  const slug = slugify(params.meta?.slug || topic, 'study');
  const version = params.meta?.version || '1.0.0';
  const updated = params.meta?.updated || today();
  const outDir = params.outDir ? path.resolve(params.outDir) : config.outDir;
  ensureDir(outDir);
  const workDir = path.join(outDir, '.work', `${slug}-${version}`);
  ensureDir(workDir);

  const meta = {
    slug,
    version,
    updated,
    license: params.meta?.license || 'CC-BY-NC-4.0',
    exam: params.meta?.exam || '',
    year: params.meta?.year || '',
    author: params.meta?.author || 'AimCram Learning Agent',
    tags: params.meta?.tags || [],
    // 显式元数据必须在生成前就位：md frontmatter 与 manifest 同源，避免 E112
    title: params.meta?.title || '',
    subject: params.meta?.subject || '',
    category: params.meta?.category || '',
    mode,
    generator: useMock || llm.name?.startsWith('mock') ? 'aimcram-agent/mock' : 'aimcram-agent',
    generatorVersion: VERSION,
    workDir,
    minAppVersion: config.minAppVersion
  };

  // 交互式流程：先出大纲交用户确认（附带内容等级建议），再逐章出题。
  // 确认回调返回「确认后的大纲」（可微调），或 { outline, questionsPerSection }（采纳等级）；
  // 返回 null 表示用户取消。逐章确认经 chapterHook 转发。
  let outline = null;
  let outlineQuality = null;
  let questionsPerSectionOverride = null;
  let questionCount = Number(params.questionCount) || 0;
  let caseCount = Number(params.caseCount) || 0;
  const confirmOutline = params.interact?.confirmOutline || params.outlineHook;
  if (mode === 'import') {
    /* 直采模式不需要大纲确认，按源题库原样导入 */
  } else if (params.presetOutline && typeof params.presetOutline === 'object') {
    /* App 里已经有用户确认过的目录：直接沿用，不再让模型重新拆分章节 */
    outline = normalizePresetOutline(params.presetOutline, { topic });
    outlineQuality = { outlinePreset: true };
    reporter?.stage('outline', 50, `使用用户确认的目录：${outline.chapters.length} 章`);
  } else if (typeof confirmOutline === 'function') {
    const pre = await generateOutlineRaw({ topic, sources, llm, config, reporter, meta });
    reporter?.stage('confirm', 57, '等待用户确认大纲');
    const confirmed = await confirmOutline(pre.outline, suggestDepth(totalChars));
    if (confirmed == null) {
      throw new AgentError('LA016', '用户未确认大纲', { hint: '重新发起并确认大纲即可继续' });
    }
    if (confirmed && typeof confirmed === 'object' && !Array.isArray(confirmed)
      && confirmed.outline && typeof confirmed.outline === 'object') {
      outline = confirmed.outline;
      if (confirmed.questionsPerSection) questionsPerSectionOverride = confirmed.questionsPerSection;
      if (Number(confirmed.questionCount) > 0) questionCount = Number(confirmed.questionCount);
      if (Number(confirmed.caseCount) > 0) caseCount = Number(confirmed.caseCount);
      if (typeof confirmed.note === 'string' && confirmed.note.trim()) {
        const notePath = path.join(workDir, 'outline-note.md');
        fs.writeFileSync(notePath, '# 用户补充要求\n\n' + confirmed.note.trim() + '\n', 'utf8');
        sources.push(notePath);
      }
    } else {
      outline = confirmed;
    }
    outlineQuality = pre.quality;
  }

  const generated = mode === 'import'
    ? await importLibrary({
      topic,
      sources,
      workDir,
      meta,
      reporter,
      questionCount,
      questionsPerSection: questionsPerSectionOverride ?? config.questionsPerSection,
      caseCount,
      llm,
      config
    })
    : await generateStudyLibrary({
      topic,
      sources,
      llm,
      config,
      reporter,
      meta,
      outline,
      outlineQuality,
      questionsPerSectionOverride,
      questionCount,
      caseCount,
      chapterHook: params.interact?.confirmChapter
    });

  // manifest 与 content/meta 必须同源：显式参数已在渲染前覆盖 outline，
  // 这里只做回读，不再二次覆盖，否则 strict 校验会报 E112。
  meta.title = generated.outline.title;
  meta.subject = generated.outline.subject;
  meta.category = generated.outline.category;
  meta.description = generated.outline.description;
  if (!meta.tags.length) meta.tags = [topic.slice(0, 20), generated.outline.category.split('/')[0].trim()].filter(Boolean);

  /* ---------------------------- 5. 组包与校验 ---------------------------- */
  reporter?.stage('pack', 84, '组装 kshare-pack/v1');
  const built = buildPack({
    workDir,
    meta,
    libraryJson: generated.libraryJson,
    outDir,
    sourceMd: generated.md,
    force: Boolean(params.force)
  });

  reporter?.stage('verify', 92, '校验学习库包');
  const verification = verifyPack(built.zip, { strict: mode !== 'import', appVersion: config.minAppVersion });

  const report = {
    ok: verification.ok,
    generatedAt: isoNow(),
    durationMs: Date.now() - started,
    mode,
    topic,
    slug,
    version,
    generator: meta.generator,
    llm: { name: llm.name, ...llm.stats },
    stats: generated.stats,
    coverage,
    crawl: crawlReport,
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      kind: s.kind,
      url: s.url,
      path: s.path,
      quality: s.quality,
      warnings: s.warnings
    })),
    notes,
    pack: {
      dir: built.root,
      zip: built.zip,
      fingerprint: built.fingerprint,
      manifest: built.manifest
    },
    verification: {
      ok: verification.ok,
      errors: verification.errors,
      warnings: verification.warnings
    }
  };

  writeJson(path.join(workDir, 'sources.json'), {
    topic,
    mode,
    coverage,
    crawl: crawlReport,
    sources: sources.map((s) => ({
      id: s.id,
      title: s.title,
      type: s.type,
      kind: s.kind,
      url: s.url,
      path: s.path,
      quality: s.quality,
      warnings: s.warnings,
      text: s.text
    })),
    notes
  });
  writeJson(path.join(outDir, `${slug}-${version}.report.json`), report);

  let appFiles = null;
  if (params.emitAppDir && verification.ok) {
    reporter?.stage('pack', 96, '生成 App 运行数据（data.js / kb.js）');
    appFiles = emitAppData({
      libraryJsonPath: path.join(built.root, 'content/library.json'),
      appDir: path.resolve(params.emitAppDir)
    });
    report.appFiles = appFiles;
    writeJson(path.join(outDir, `${slug}-${version}.report.json`), report);
  }

  if (!verification.ok) {
    throw new AgentError('LA010', '学习库包校验未通过', {
      hint: '查看报告中的 errors',
      details: verification.errors.slice(0, 20)
    });
  }

  reporter?.stage('done', 100, `完成：${path.basename(built.zip)}`);
  return { ...report, appFiles, paths: { dir: built.root, zip: built.zip, report: path.join(outDir, `${slug}-${version}.report.json`), md: path.join(workDir, 'library.md') } };
}

export { uniqueBy };
