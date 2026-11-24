import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as plugin from '../dsh-plugin/index.mjs';
import { makeTempDir } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SAMPLE = path.join(ROOT, 'samples/architecture-notes.md');

function mount(services = {}) {
  const tools = new Map();
  plugin.apply({
    tools: {
      register(definition) {
        assert.ok(definition.output && typeof definition.output.render === 'function', '工具必须声明 output');
        tools.set(definition.name, definition);
      }
    },
    get: (name) => services[name]
  });
  return tools;
}

test('DSH 插件契约：导出 name / inject / apply 并注册五个工具', () => {
  assert.equal(plugin.name, 'aimcram-agent');
  assert.deepEqual(plugin.inject, ['tools']);
  const tools = mount();
  assert.deepEqual([...tools.keys()].sort(), [
    'aimcram_import', 'study_library_bundle', 'study_library_doctor',
    'study_library_generate', 'study_library_verify'
  ]);
  for (const def of tools.values()) {
    assert.ok(def.description.length > 10);
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.execute, 'function');
  }
});

test('DSH 命令：注册 /aimcram 并在空输入时提示用法', async () => {
  const commands = [];
  plugin.apply({
    tools: { register() {} },
    commands: { register(definition) { commands.push(definition); } },
    get: () => undefined
  });
  const cmd = commands.find((item) => item.name === 'aimcram');
  assert.ok(cmd, '应注册 /aimcram 命令');
  assert.deepEqual(cmd.input, { hint: '<主题>' });
  const empty = await cmd.handler({ rawInput: '   ' });
  assert.equal(empty.kind, 'error');
  assert.match(empty.text, /用法/);
});

test('DSH 插件：没有 commands 服务（无头）时仍能正常激活', () => {
  const ctx = {
    tools: { register() {} },
    get: () => undefined,
    inject() {}
  };
  Object.defineProperty(ctx, 'commands', {
    get() {
      throw new Error('cannot get property "commands" without inject');
    }
  });
  assert.doesNotThrow(() => plugin.apply(ctx));
});

test('DSH 工具：generate → verify → doctor', async (t) => {
  const dir = makeTempDir('la-dsh-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = mount();

  const gen = await tools.get('study_library_generate').execute({
    topic: '系统架构设计',
    sources: [SAMPLE],
    mock: true,
    outDir: dir,
    slug: 'dsh-test',
    version: '1.0.0'
  }, { signal: { aborted: false } });
  assert.equal(gen.ok, true);
  assert.equal(gen.mode, 'sources');
  assert.equal(gen.verification.ok, true);
  assert.ok(gen.stats.questions >= 1);
  assert.ok(fs.existsSync(gen.paths.zip));
  assert.ok(Array.isArray(gen.progress) && gen.progress.length > 0);
  assert.equal(gen.progress.at(-1).percent, 100);

  const rendered = tools.get('study_library_generate').output.render({}, gen);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /dsh-test/);

  const verified = await tools.get('study_library_verify').execute({ path: gen.paths.zip, strict: true });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.errors, []);
  assert.equal(verified.manifest.slug, 'dsh-test');

  const bundled = await tools.get('study_library_bundle').execute({
    paths: [gen.paths.zip],
    outFile: path.join(dir, 'all-in-one.zip'),
    name: 'dsh-all',
    title: 'DSH 合集'
  });
  assert.equal(bundled.ok, true);
  assert.equal(bundled.packs.length, 1);
  const collectionReport = await tools.get('study_library_verify').execute({ path: bundled.zip, strict: true });
  assert.equal(collectionReport.ok, true);
  assert.equal(collectionReport.packs.length, 1);

  const doctor = await tools.get('study_library_doctor').execute();
  assert.equal(doctor.version, VERSION);
  assert.equal(doctor.deps['pdfjs-dist'], true);
  assert.equal(doctor.crawl.provider, 'deepseek');

  await assert.rejects(
    () => tools.get('study_library_generate').execute({ mode: 'sources', mock: true }),
    (err) => /LA001/.test(err.message)
  );
});

test('DSH 插件：优先复用 Harness 自身模型（无需 DEEPSEEK_API_KEY）', async () => {
  const tools = mount({
    llm: {
      async *stream() {
        yield { type: 'text-delta', index: 0, text: '{}' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' })
    }
  });

  const doctor = await tools.get('study_library_doctor').execute();
  assert.equal(doctor.llm.viaHarness, true);
  assert.equal(doctor.llm.model, 'deepseek-chat');
  assert.equal(doctor.llm.modelSource, 'default');
});

test('模型选择：会话里选中的模型优先于 profile 默认值', () => {
  const defaults = { currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-flash' }) };
  const agent = {
    options: { provider: 'deepseek', model: 'deepseek-reasoner' },
    session: {
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' } })
    }
  };

  // 会话请求头 > Agent 创建配置 > profile 默认值
  assert.deepEqual(plugin.resolveModelSelection(agent, defaults), {
    provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high', source: 'session'
  });
  assert.deepEqual(plugin.resolveModelSelection({ options: agent.options }, defaults), {
    provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: undefined, source: 'agent'
  });
  assert.deepEqual(plugin.resolveModelSelection(undefined, defaults), {
    provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: undefined, source: 'default'
  });
  assert.equal(plugin.resolveModelSelection(undefined, undefined), null);
});


test('DSH 工具：相对路径按会话工作目录解析', async (t) => {
  const ws = makeTempDir('la-workspace-');
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ws, 'notes.md'), fs.readFileSync(SAMPLE, 'utf8'), 'utf8');

  const tools = mount({ workingDirectory: { get: () => ws } });
  const exec = { agent: { session: {} }, signal: { aborted: false } };

  const gen = await tools.get('study_library_generate').execute({
    topic: '系统架构设计',
    sources: ['notes.md'],
    mock: true,
    outDir: 'out',
    slug: 'rel-test',
    version: '1.0.0'
  }, exec);

  assert.equal(gen.ok, true);
  assert.equal(gen.paths.zip, path.join(ws, 'out/rel-test-1.0.0.zip'));
  assert.ok(fs.existsSync(gen.paths.zip));

  const verified = await tools.get('study_library_verify').execute(
    { path: 'out/rel-test-1.0.0.zip', strict: true },
    exec
  );
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.errors, []);
});

test('DSH 插件：声明 permissions 能力清单并探测内置服务', () => {
  assert.ok(Array.isArray(plugin.permissions) && plugin.permissions.length > 0);
  for (const p of plugin.permissions) {
    assert.ok(typeof p.capability === 'string' && p.capability);
    assert.ok(typeof p.service === 'string' && p.service);
    assert.ok(typeof p.description === 'string' && p.description);
  }
  const services = plugin.permissions.map((p) => p.service);
  assert.ok(services.includes('llm'), '应声明复用 Harness 模型');
  assert.ok(services.includes('approval'), '应声明一次性授权');

  const tools = mount({ llm: {}, workingDirectory: {}, approval: { request: async () => 'allowed-once' } });
  return tools.get('study_library_doctor').execute().then((doctor) => {
    assert.equal(doctor.harness.llm, true);
    assert.equal(doctor.harness.workingDirectory, true);
    assert.equal(doctor.harness.approval, true);
    assert.equal(doctor.harness.agents, false);
    assert.equal(doctor.harness.userQuestions, false);
  });
});

test('DSH 工具：生成需要一次性授权，拒绝则报 LA017', async (t) => {
  const dir = makeTempDir('la-dsh-auth-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const denied = mount({ approval: { request: async () => 'rejected' } });
  const seen = [];
  await assert.rejects(
    () => denied.get('study_library_generate').execute({
      topic: '系统架构设计', sources: [SAMPLE], mock: true, outDir: dir, slug: 'auth-denied'
    }, { agent: { id: 'a' }, callId: 'c1', signal: { aborted: false } }),
    (err) => {
      seen.push(err.code);
      return /LA017/.test(err.message);
    }
  );
  assert.ok(seen.includes('LA017'));

  const allowed = mount({ approval: { request: async (req) => { seen.push(req.toolName); return 'allowed-once'; } } });
  const gen = await allowed.get('study_library_generate').execute({
    topic: '系统架构设计', sources: [SAMPLE], mock: true, outDir: dir, slug: 'auth-allowed', version: '1.0.0'
  }, { agent: { id: 'a' }, callId: 'c2', signal: { aborted: false } });
  assert.equal(gen.ok, true);
  assert.ok(seen.includes('study_library_generate'), '审批请求应携带工具名');
});

test('无 approval 服务时放行（无头 / CLI 回退）', async (t) => {
  const dir = makeTempDir('la-dsh-noauth-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = mount(); // 不提供 approval
  const gen = await tools.get('study_library_generate').execute({
    topic: '系统架构设计', sources: [SAMPLE], mock: true, outDir: dir, slug: 'noauth', version: '1.0.0'
  }, { signal: { aborted: false } });
  assert.equal(gen.ok, true);
});
