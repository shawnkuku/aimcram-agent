/**
 * DeepSeek Harness（DSH）插件：把学习库生成能力注册为原生工具。
 *
 * 加载方式（profile 的 cordis.patch.yml 或 --patch 覆盖层）：
 *
 *   - insert:
 *       - id: aimcram-agent
 *         name: '/绝对路径/services/aimcram-agent/dsh-plugin/index.mjs'
 *
 * 暴露的工具：
 *   study_library_generate  三模式生成（sources / web / combined）
 *   study_library_bundle    把多个学习库包打成一个 ZIP 合集（方便传输）
 *   study_library_verify    校验 kshare-pack/v1 学习库包或合集
 *   study_library_doctor    环境自检（依赖 / OCR / DeepSeek / 抓取配置）
 *
 * 设计约束：
 * - 不引入额外依赖，工具定义采用 DSH 的原始 ToolDefinition 形态
 *   （name / description / parameters / output / execute）；
 * - 所有耗时步骤都在 execute 内完成，进度事件实时写入 stderr，
 *   返回值只保留结构化摘要，避免把大段正文塞进模型上下文；
 * - 错误统一转换成带错误码的单行消息，便于模型自我修正。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPipeline } from '../src/pipeline.mjs';
import { verifyPack } from '../src/pack.mjs';
import { buildCollection, verifyCollection, isCollection } from '../src/collection.mjs';
import { HarnessLLM } from '../src/llm-harness.mjs';
import { resolveConfig, VERSION, APP_URL, maskSecret } from '../src/config.mjs';
import { createReporter } from '../src/log.mjs';
import { ocrCapability } from '../src/extract/image.mjs';
import { detectApp, importUrl, openUrl } from '../src/app.mjs';
import { AgentError, errorPayload } from '../src/errors.mjs';

export const name = 'aimcram-agent';
export const inject = ['tools'];

/**
 * 权限声明（能力清单）。
 *
 * 这是给 App / 上层看的「许可声明」，说明本插件用到了哪些 Harness 内置服务与能力；
 * 真正的「要不要批准」由 `ctx.approval.request()`（见 requireApproval）在执行时按会话
 * 权限档（ask / never）裁决。DSH 的插件契约不强制导出本字段，这里仅作自描述与 UI 用。
 */
export const permissions = [
  { capability: 'llm:use', service: 'llm', description: '复用 Harness 当前会话所选模型生成大纲与题目' },
  { capability: 'fs:read', service: 'workingDirectory', description: '读取用户指定的本地文档 / 图片' },
  { capability: 'fs:write', service: 'workingDirectory', description: '写出学习库包、报告与 App 运行数据' },
  { capability: 'web:fetch', service: 'web', description: '模式二/三联网检索与抓取（DeepSeek Search/Fetch API，按次计费）' },
  { capability: 'approval:ask', service: 'approval', description: '生成与打包动作要求一次性用户授权' },
  { capability: 'interact:ask', service: 'userQuestions', description: '向导式建设时向用户提问（大纲确认）' }
];

const HERE = path.dirname(fileURLToPath(import.meta.url));

// apply() 注入的 Harness 上下文；工具 execute 里据此取 llm / agentDefaultModel 服务
let host = null;

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true };

function textResult(value) {
  return {
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  };
}

function fail(err) {
  const p = errorPayload(err);
  const error = new Error(`[${p.code}] ${p.message}${p.hint ? `｜提示：${p.hint}` : ''}`);
  error.code = p.code;
  error.details = p.details;
  return error;
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
}

/**
 * 工具参数里的相对路径按「当前会话的工作目录」解析，而不是 Host 进程的 cwd。
 * DSH 的 execute 只给 agent/signal，工作目录要经 workingDirectory 服务取。
 */
function sessionCwd(exec) {
  try {
    const wd = host?.get?.('workingDirectory');
    const agent = exec?.agent || host?.get?.('agents')?.currentInitiator?.();
    const session = agent?.session;
    if (session && wd && typeof wd.get === 'function') {
      const dir = wd.get(session);
      if (dir) return dir;
    }
    const fromSession = session?.header?.cwd || session?.cwd;
    if (fromSession) return fromSession;
    if (wd?.defaultDirectory) return wd.defaultDirectory;
  } catch { /* 取不到就退回进程 cwd，保持旧行为 */ }
  return process.cwd();
}

/** 保留 URL / text: / @clipboard 这类非路径输入，其余相对路径拼到 cwd。 */
function resolveUserPath(value, cwd) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s) || s === '@clipboard' || s.startsWith('text:')) return s;
  return path.isAbsolute(s) ? s : path.resolve(cwd, s);
}

/**
 * 解析“本次会话实际使用的模型”。
 *
 * 取值顺序（与 DSH 内置 subagent 工具一致）：
 *   1. agent.session.requestHeader().config —— 用户在会话里当前选中的 provider/model；
 *   2. agent.options —— 创建 Agent 时的显式配置；
 *   3. agentDefaultModel.currentSelection() —— 仅作为“未指定模型时的 profile 默认值”，
 *      它不是用户的选择，不能优先使用（否则永远拿到 deepseek-flash）。
 *
 * @returns {{provider: string, model: string, reasoningEffort?: string, source: string} | null}
 */
export function resolveModelSelection(agent, fallback) {
  try {
    const config = agent?.session?.requestHeader?.()?.config;
    if (config?.provider && config?.model) {
      return {
        provider: config.provider,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        source: 'session'
      };
    }
  } catch { /* 忽略读取失败，继续下一层 */ }

  const options = agent?.options;
  if (options?.provider && options?.model) {
    return {
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      source: 'agent'
    };
  }

  try {
    const config = fallback?.currentSelection?.();
    if (config?.provider && config?.model) {
      return { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort, source: 'default' };
    }
  } catch { /* 忽略 */ }
  return null;
}

/**
 * 复用 Harness 自身的模型与凭据：只用当前会话选中的模型，不自己持有 Key。
 * 任何一环缺失（未加载 dsh-llm / 无法解析模型）都返回 null，由调用方回落到原逻辑。
 */
function harnessLLM(exec) {
  try {
    const llm = host?.get?.('llm');
    if (!llm) return null;
    const selection = resolveModelSelection(exec?.agent, host?.get?.('agentDefaultModel'));
    if (!selection) return null;
    return new HarnessLLM({
      llm,
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
      signal: exec?.signal
    });
  } catch {
    return null;
  }
}

function progressReporter(events) {
  return createReporter({
    quiet: true,
    onProgress: (event) => {
      events.push({ stage: event.stage, percent: event.percent, message: event.message });
      process.stderr.write(`[${String(event.percent).padStart(3)}%] ${event.label}${event.message ? ' · ' + event.message : ''}\n`);
    }
  });
}

/**
 * 要求一次性用户授权（DSH approval 缝）。
 *
 * - composition 未挂载 approval 服务时直接放行（等价 CLI / 无头回退，兼容旧测试与直连运行）；
 * - 挂载后走 `ctx.approval.request()`，只有返回 `allowed-once` 才继续，其余（rejected / cancelled /
 *   unavailable）按「未授权」处理并抛 LA017，让模型看到可重试的错误而不是静默失败。
 */
async function requireApproval(exec, toolName, reason) {
  // 斜杠命令由用户主动输入，语义上已授权，不再弹权限提示
  if (exec?.skipApproval) return;
  const approval = host?.get?.('approval');
  if (!approval || typeof approval.request !== 'function') return;
  const outcome = await approval.request({
    agent: exec?.agent,
    toolName,
    callId: exec?.callId,
    reason,
    signal: exec?.signal
  });
  if (outcome !== 'allowed-once') {
    throw new AgentError('LA017', `操作未获授权：${toolName}`, {
      hint: '在权限提示中选择「允许」后重试'
    });
  }
}

/** doctor 探测:摆放哪些 Harness 内置服务可用（用于向导式交互与权限说明）。 */
function harnessServices() {
  const names = ['llm', 'workingDirectory', 'agents', 'subagents', 'userQuestions', 'approval', 'agentDefaultModel', 'web'];
  const out = {};
  for (const n of names) {
    out[n] = Boolean(host?.get?.(n));
  }
  return out;
}

const generate = {
  name: 'study_library_generate',
  description:
    '生成 AimCram 学习库包（kshare-pack/v1）。三种模式：sources=用户指定的本地文档/图片/网页；'
    + 'web=仅给主题，经 DeepSeek Search/Fetch 联网检索抓取；combined=两者结合。默认复用 Harness 当前所选模型生成；'
    + '返回包目录、ZIP、报告路径与规模统计。',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '学习主题，如「系统架构设计」；模式一可省略，取首个来源标题' },
      sources: {
        type: 'array',
        items: { type: 'string' },
        description: '输入源列表：本地文件、图片、http(s) URL、text:开头的内联文本、@clipboard'
      },
      mode: { type: 'string', enum: ['auto', 'sources', 'web', 'combined'], description: '默认 auto' },
      seeds: { type: 'array', items: { type: 'string' }, description: '模式二/三的种子页面 URL' },
      withWeb: { type: 'boolean', description: '模式一同时做自主抓取（等价 combined）' },
      pages: { type: 'number', description: '最多抓取页数' },
      depth: { type: 'number', description: '站内跟进深度' },
      perSection: { type: 'number', description: '每节题目数' },
      outDir: { type: 'string', description: '产物目录，默认 ./out' },
      slug: { type: 'string' },
      version: { type: 'string' },
      title: { type: 'string' },
      subject: { type: 'string' },
      category: { type: 'string' },
      license: { type: 'string' },
      exam: { type: 'string' },
      year: { type: 'number' },
      author: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      mock: { type: 'boolean', description: '离线确定性生成（不调用 DeepSeek）' },
      emitAppDir: { type: 'string', description: '同时输出 data.js / kb.js 的目录' },
      force: { type: 'boolean', description: '覆盖同 slug+version 的已有产物' }
    },
    required: [],
    additionalProperties: false
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [textResult(value)]
  },
  async execute(args = {}, exec = {}) {
    if (exec?.signal?.aborted) throw new Error('调用已取消');
    const events = [];
    const reporter = progressReporter(events);
    const cwd = sessionCwd(exec);
    const outDir = args.outDir ? resolveUserPath(args.outDir, cwd) : path.join(cwd, 'out');
    const emitAppDir = args.emitAppDir ? resolveUserPath(args.emitAppDir, cwd) : '';
    try {
      await requireApproval(exec, 'study_library_generate',
        args.mock ? '本地离线生成学习库，需写入产物目录' : '生成学习库，需写入文件并使用会话模型' + (args.mode === 'web' || args.withWeb ? '、检索抓取网络内容' : ''));
      const result = await runPipeline({
        llm: args.mock ? null : harnessLLM(exec),
        topic: args.topic,
        inputs: asArray(args.sources).map((s) => resolveUserPath(s, cwd)),
        seeds: asArray(args.seeds).map((s) => resolveUserPath(s, cwd)),
        mode: args.withWeb ? 'combined' : args.mode,
        config: resolveConfig({
          outDir,
          maxPages: args.pages,
          maxDepth: args.depth,
          questionsPerSection: args.perSection
        }),
        reporter,
        mock: args.mock,
        outDir,
        emitAppDir,
        force: Boolean(args.force),
        meta: {
          slug: args.slug,
          version: args.version,
          title: args.title,
          subject: args.subject,
          category: args.category,
          license: args.license,
          exam: args.exam,
          year: args.year,
          author: args.author,
          tags: asArray(args.tags)
        }
      });
      return {
        ok: true,
        mode: result.mode,
        model: result.llm?.name || '',
        topic: result.topic,
        slug: result.slug,
        version: result.version,
        generator: result.generator,
        stats: result.stats,
        coverage: {
          sources: result.coverage.sources,
          totalChars: result.coverage.totalChars,
          byType: result.coverage.byType,
          lowConfidence: result.coverage.lowConfidence
        },
        crawl: result.crawl
          ? {
              accepted: result.crawl.accepted,
              rejected: result.crawl.rejected?.length ?? 0,
              search: result.crawl.search?.provider,
              tools: result.crawl.tools
            }
          : null,
        verification: {
          ok: result.verification.ok,
          errors: result.verification.errors.length,
          warnings: result.verification.warnings.length
        },
        appFiles: result.appFiles
          ? { dataJs: result.appFiles.dataJs, kbJs: result.appFiles.kbJs }
          : null,
        paths: result.paths,
        progress: events.slice(-6)
      };
    } catch (err) {
      throw fail(err);
    }
  }
};

const bundle = {
  name: 'study_library_bundle',
  description:
    '把多个已生成的学习库包（目录或 ZIP）打成一个 ZIP 合集（kshare-collection/v1），'
    + '分发时只需要传一个文件；合集只做打包，不改写子包内容。',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: '学习库包目录或 ZIP 路径列表（至少一个）'
      },
      outFile: { type: 'string', description: '输出 ZIP 的完整路径' },
      outDir: { type: 'string', description: '输出目录；未给 outFile 时写 <name>-<version>.zip' },
      name: { type: 'string', description: '合集名，也是根目录前缀，默认 aimcram-collection' },
      version: { type: 'string', description: '合集版本，默认 1.0.0' },
      title: { type: 'string', description: '合集标题' },
      force: { type: 'boolean', description: '覆盖同名合集' }
    },
    required: ['paths'],
    additionalProperties: false
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [textResult(value)]
  },
  async execute(args = {}, exec = {}) {
    const cwd = sessionCwd(exec);
    const targets = asArray(args.paths).map((p) => resolveUserPath(p, cwd));
    if (!targets.length) throw new Error('[LA012] 需要 paths：至少一个学习库包目录或 ZIP');
    try {
      await requireApproval(exec, 'study_library_bundle', '把多个学习库包合并成一个合集 ZIP，需写入输出目录');
      const result = buildCollection({
        targets,
        outFile: args.outFile ? resolveUserPath(args.outFile, cwd) : '',
        outDir: args.outDir ? resolveUserPath(args.outDir, cwd) : cwd,
        name: args.name,
        version: args.version,
        title: args.title,
        force: Boolean(args.force)
      });
      const c = result.collection;
      return {
        ok: true,
        zip: result.zip,
        root: result.rootName,
        counts: c.counts,
        packs: c.packs.map((p) => ({
          slug: p.slug,
          version: p.version,
          title: p.title,
          questions: p.counts?.questions ?? 0,
          path: p.path
        }))
      };
    } catch (err) {
      throw fail(err);
    }
  }
};

const verify = {
  name: 'study_library_verify',
  description: '校验 kshare-pack/v1 学习库包或 kshare-collection/v1 合集（目录或 ZIP），返回错误码清单与摘要。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '学习库包 / 合集的目录或 ZIP 路径' },
      strict: { type: 'boolean', description: '严格模式：警告也视为失败' },
      appVersion: { type: 'string', description: '当前 App 版本，用于兼容性校验' }
    },
    required: ['path'],
    additionalProperties: false
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [textResult(value)]
  },
  async execute(args = {}, exec = {}) {
    if (!args.path) throw new Error('[LA012] 需要 path 参数：学习库包或合集的目录 / ZIP');
    const target = resolveUserPath(args.path, sessionCwd(exec));
    try {
      if (isCollection(target)) {
        const report = verifyCollection(target, { strict: Boolean(args.strict), appVersion: args.appVersion });
        return {
          ok: report.ok,
          file: target,
          collection: report.collection
            ? { name: report.collection.name, version: report.collection.version, title: report.collection.title }
            : null,
          packs: report.packs,
          errors: report.errors,
          warnings: report.warnings
        };
      }
      const report = verifyPack(target, { strict: Boolean(args.strict), appVersion: args.appVersion });
      return {
        ok: report.ok,
        file: target,
        manifest: report.manifest
          ? {
              slug: report.manifest.slug,
              version: report.manifest.version,
              title: report.manifest.title,
              counts: report.manifest.counts,
              fingerprint: report.manifest.content?.fingerprint
            }
          : null,
        errors: report.errors,
        warnings: report.warnings
      };
    } catch (err) {
      throw fail(err);
    }
  }
};

const doctor = {
  name: 'study_library_doctor',
  description: '检查学习库生成环境：Node 版本、解析依赖、OCR 引擎、DeepSeek 配置与抓取参数。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [textResult(value)]
  },
  async execute() {
    const config = resolveConfig({});
    const deps = {};
    for (const dep of ['cheerio', 'jsdom', '@mozilla/readability', 'pdfjs-dist', 'mammoth']) {
      try {
        await import(dep === 'pdfjs-dist' ? 'pdfjs-dist/legacy/build/pdf.mjs' : dep);
        deps[dep] = true;
      } catch {
        deps[dep] = false;
      }
    }
    return {
      ok: Object.values(deps).every(Boolean) && fs.existsSync(path.resolve(HERE, '../src/vendor/kshare.mjs')),
      version: VERSION,
      node: process.version,
      platform: process.platform,
      plugin: HERE,
      deps,
      ocr: ocrCapability(),
      llm: (() => {
        // doctor 不绑定会话，只能看到默认选择；真正的会话模型在 generate 执行时读取
        const selection = resolveModelSelection(undefined, host?.get?.('agentDefaultModel'));
        return {
          viaHarness: Boolean(selection) && Boolean(host?.get?.('llm')),
          modelSource: selection?.source || 'none',
          model: selection?.model || config.model,
          configured: Boolean(config.apiKey),
          apiKey: config.apiKey ? maskSecret(config.apiKey) : '',
          baseUrl: config.baseUrl
        };
      })(),
      crawl: {
        provider: 'deepseek',
        maxPages: config.maxPages,
        maxDepth: config.maxDepth,
        maxBytes: config.maxBytes,
        crawlTimeoutMs: config.crawlTimeoutMs
      },
      harness: harnessServices(),
      permissions
    };
  }
};

/**
 * 把学习库导入 AimCram 桌面 App。
 * 只在用户明确要求“导入 AimCram / 用 App 打开”时调用，不主动推荐；
 * App 未安装时只返回官网地址，不尝试其它打开方式。
 */
const importPack = {
  name: 'aimcram_import',
  description:
    '把本地学习库包（目录或 .json/.jsonl 文件）导入 AimCram 桌面 App，通过 aimcram:// 协议唤起。'
    + '仅在用户明确要求把学习库导入 AimCram 时使用；未安装 App 时返回官网下载地址。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '学习库包目录（含 content/library.json）或单个 .json/.jsonl 文件' }
    },
    required: ['path'],
    additionalProperties: false
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [textResult(value)]
  },
  async execute(args = {}, exec = {}) {
    if (!args.path) throw new Error('[LA012] 需要 path 参数：学习库包目录或 .json/.jsonl 文件');
    const target = resolveUserPath(args.path, sessionCwd(exec));
    if (!fs.existsSync(target)) throw new Error('[LA012] 路径不存在：' + target);
    if (fs.statSync(target).isDirectory()) {
      if (!fs.existsSync(path.join(target, 'content', 'library.json'))) {
        throw new Error('[LA012] 目录里没有 content/library.json，不是可导入的学习库包');
      }
    } else if (!/\.(json|jsonl)$/i.test(target)) {
      throw new Error('[LA012] 只支持学习库包目录或 .json/.jsonl 文件');
    }

    const app = detectApp();
    if (!app.installed) {
      return {
        ok: false,
        installed: false,
        download: APP_URL,
        message: '未检测到 AimCram App，可从官网下载安装后再导入'
      };
    }

    const protocol = importUrl(target);
    try {
      await openUrl(protocol);
    } catch (err) {
      throw new Error('无法唤起 AimCram：' + (err?.message || err));
    }
    return {
      ok: true,
      installed: true,
      app: app.path,
      path: target,
      protocol,
      message: '已打开 AimCram 并请求导入「' + path.basename(target) + '」'
    };
  }
};

/**
 * 斜杠命令：/aimcram <主题>
 * 等价于生成工具的联网模式，由用户主动输入，视为已授权，不再弹权限提示。
 */
const aimcramCommand = {
  name: 'aimcram',
  description: '用 AimCram Agent 生成学习库',
  input: { hint: '<主题>' },
  async handler(invocation = {}) {
    const topic = String(invocation.rawInput || '').trim();
    if (!topic) {
      return { kind: 'error', text: '用法：/aimcram <主题>，例如 /aimcram 系统架构设计' };
    }
    const exec = {
      agent: invocation.agent,
      callId: invocation.commandId,
      signal: invocation.signal,
      skipApproval: true
    };
    try {
      const result = await generate.execute({ topic, mode: 'auto' }, exec);
      const stats = result.stats || {};
      const lines = [
        `已生成「${result.topic || topic}」（${result.mode || 'web'}）`,
        `章节 ${stats.chapters ?? '-'} · 小节 ${stats.sections ?? '-'} · 题目 ${stats.questions ?? '-'}`,
        `目录：${result.paths?.dir || ''}`
      ];
      if (result.verification && result.verification.ok === false) {
        lines.push(`校验：${result.verification.errors} 个错误`);
      }
      return { kind: 'success', text: lines.join('\n') };
    } catch (err) {
      return { kind: 'error', text: err?.message || String(err) };
    }
  }
};

/** commands 服务由桌面端提供，插件加载时可能尚未就绪，故允许延迟注册。 */
function registerCommand(ctx) {
  const register = (scope) => {
    let commands;
    try {
      // 未 inject 时访问服务会抛错；无头环境本来就没有 commands，静默跳过
      commands = scope?.commands;
    } catch {
      return false;
    }
    if (!commands || typeof commands.register !== 'function') return false;
    try {
      commands.register(aimcramCommand);
      return true;
    } catch (err) {
      console.warn(`[aimcram-agent] /aimcram 注册失败：${err?.message || err}`);
      return false;
    }
  };
  if (register(ctx)) return;
  if (typeof ctx.inject === 'function') {
    try {
      // 桌面端 commands 服务可能晚于本插件就绪，注入后再注册
      ctx.inject(['commands'], (scope) => register(scope));
    } catch (err) {
      console.warn(`[aimcram-agent] 等待 commands 服务失败：${err?.message || err}`);
    }
  }
}

export function apply(ctx) {
  host = ctx;
  for (const tool of [generate, bundle, verify, doctor, importPack]) {
    try {
      ctx.tools.register(tool);
    } catch (err) {
      // 与 archprep-learning-agent 这类同功能旧插件共存时，后加载的一方会因工具重名注册失败。
      // 跳过重名工具，避免整个插件因单个冲突而不激活。
      if (!/already registered/i.test(err?.message || '')) throw err;
      console.warn(`[aimcram-agent] 工具 ${tool.name} 已被其他插件注册，跳过`);
    }
  }
  registerCommand(ctx);
}
