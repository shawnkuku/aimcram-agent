import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/pipeline.mjs';
import { createReporter } from '../src/log.mjs';
import { outlinePreview, applyOutlineEdits, createOutlineHook, suggestDepth, createInteractHooks, DEPTH_LEVELS } from '../src/interactive.mjs';
import { makeTempDir, FIXTURE_TEXT } from './helpers.mjs';

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
  return { crawlTimeoutMs: 5000, maxPages: 3, maxDepth: 0, minContentChars: 150, ...overrides };
}

test('outlinePreview：压成轻量预览层，不泄漏内部结构', () => {
  const outline = {
    title: '网络体系结构',
    subject: '计算机网络',
    category: '通识 / 自主学习',
    description: '描述',
    chapters: [{
      name: '第一章 分层模型',
      summary: '摘要A',
      sections: [
        { name: '1.1 七层', summary: 's', points: ['p1', 'p2'] },
        { name: '1.2 接口', summary: 's2', points: ['p3'] }
      ]
    }],
    plates: [{ id: 'plate1', name: '板块A', points: ['x', 'y', 'z'] }]
  };
  const preview = outlinePreview(outline);
  assert.equal(preview.title, '网络体系结构');
  assert.equal(preview.chapters[0].sections[0].points, 2);
  assert.equal(preview.plates[0].points, 3);
  // 预览层不携带真 points 数组（避免上层误改内部结构）
  assert.ok(!Array.isArray(preview.chapters[0].sections[0].points));
});

test('applyOutlineEdits：只改名称/摘要，保留 points 等内部结构', () => {
  const outline = {
    title: '旧标题',
    chapters: [{
      name: '第一章 A',
      summary: '摘要A',
      sections: [
        { name: '1.1 a', summary: 's', points: ['p1', 'p2'], questions: [] },
        { name: '1.2 b', summary: 's2', points: ['p3'], questions: [] }
      ]
    }],
    plates: [{ id: 'plate1', name: '板块A', color: '#4263eb', lead: '导语', points: ['x'], exam: ['e'], chapters: ['第一章 A'] }]
  };
  const edits = {
    title: '新标题',
    chapters: [{
      name: '第一章 改中文',
      summary: '新摘要',
      sections: [{ name: '1.1 改名', points: 2 }, { name: '1.2 b', points: 1 }]
    }],
    plates: [{ id: 'plate1', name: '板块改名' }]
  };
  const merged = applyOutlineEdits(outline, edits);
  assert.equal(merged.title, '新标题');
  assert.equal(merged.chapters[0].name, '第一章 改中文');
  assert.equal(merged.chapters[0].summary, '新摘要');
  assert.equal(merged.chapters[0].sections[0].name, '1.1 改名');
  // 内部结构保留：points 仍是数组、summary 未被预览里的数字覆盖
  assert.deepEqual(merged.chapters[0].sections[0].points, ['p1', 'p2']);
  assert.equal(merged.chapters[0].sections[1].summary, 's2');
  assert.deepEqual(merged.plates[0].points, ['x']);
  assert.equal(merged.plates[0].name, '板块改名');
});

test('applyOutlineEdits：按 id 合并用户增删改后的章节树', () => {
  const outline = {
    title: '科目',
    chapters: [
      {
        name: '第一章 A',
        summary: 's',
        sections: [
          { name: '1.1 a', summary: 'sa', points: ['p1'], questions: [] },
          { name: '1.2 b', summary: 'sb', points: ['p2'], questions: [] }
        ]
      },
      {
        name: '第二章 C',
        summary: 's2',
        sections: [{ name: '2.1 c', summary: 'sc', points: ['p3'], questions: [] }]
      }
    ],
    plates: []
  };
  // 删掉第二章、改第一节名、给第一章加一节、再补一章新的
  const edits = {
    chapters: [
      {
        id: 'ch0',
        name: '第一章 A',
        sections: [{ id: 'ch0s0', name: '1.1 改名' }, { id: 'ch0s1', name: '1.2 b' }, { name: '1.3 新节' }]
      },
      { name: '第三章 新章', sections: [{ name: '3.1 新节' }] }
    ]
  };
  const merged = applyOutlineEdits(outline, edits);

  assert.equal(merged.chapters.length, 2);
  assert.equal(merged.chapters[0].sections.length, 3);
  assert.equal(merged.chapters[0].sections[0].name, '1.1 改名');
  // 原知识点结构保留，改名不影响 points
  assert.deepEqual(merged.chapters[0].sections[0].points, ['p1']);
  assert.deepEqual(merged.chapters[0].sections[1].points, ['p2']);
  // 用户新增的小节有可用占位结构，不会在出题阶段报错
  assert.equal(merged.chapters[0].sections[2].name, '1.3 新节');
  assert.deepEqual(merged.chapters[0].sections[2].points, []);
  assert.deepEqual(merged.chapters[0].sections[2].questions, []);
  assert.equal(merged.chapters[1].name, '第三章 新章');
  // 被删掉的第二章不再出现在结果里
  assert.ok(!merged.chapters.some((c) => c.name.includes('第二章')));
});

test('createOutlineHook：写出大纲并等待确认，确认并入微调', async () => {
  const written = [];
  const outline = {
    title: '主题',
    chapters: [{ name: '第一章 A', summary: 's', sections: [{ name: '1.1 a', points: ['p'] }] }],
    plates: [{ id: 'p1', name: '板', points: ['x'] }]
  };
  let resolveConfirm;
  const hook = createOutlineHook({
    write: (obj) => written.push(obj),
    awaitMessage: async (type) => {
      assert.equal(type, 'confirm');
      return new Promise((r) => { resolveConfirm = r; });
    }
  });
  const pending = hook(outline);
  assert.equal(written.length, 1);
  assert.equal(written[0].type, 'outline');
  assert.equal(written[0].preview.chapters.length, 1);
  resolveConfirm({ type: 'confirm', accepted: true, outline: { title: '改后主题' } });
  const confirmed = await pending;
  assert.equal(confirmed.title, '改后主题');
});

test('createOutlineHook：accepted=false 返回 null（取消）', async () => {
  const hook = createOutlineHook({
    write: () => {},
    awaitMessage: async () => ({ type: 'confirm', accepted: false })
  });
  const out = await hook({ title: 'x', chapters: [], plates: [] });
  assert.equal(out, null);
});

test('交互式流程：确认大纲（含改名）后逐章生成', async (t) => {
  const root = makeTempDir('la-interact-ok-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const md = writeNotes(root);
  const outDir = path.join(root, 'out');
  const marker = '【已确认章节】';
  let hookCalls = 0;

  const result = await runPipeline({
    topic: '网络体系结构',
    inputs: [md],
    mode: 'sources',
    mock: true,
    config: baseConfig(),
    reporter: createReporter({ quiet: true }),
    outDir,
    meta: { slug: 'interact-ok', version: '1.0.0' },
    outlineHook: async (outline) => {
      hookCalls++;
      assert.ok(outline.chapters.length >= 1);
      assert.ok(Array.isArray(outline.chapters[0].sections[0].points));
      const edits = outlinePreview(outline);
      edits.chapters[0].name = `${marker}${edits.chapters[0].name}`;
      return applyOutlineEdits(outline, edits);
    }
  });

  assert.equal(hookCalls, 1, 'outlineHook 只应调用一次');
  assert.equal(result.verification.ok, true);
  assert.ok(result.stats.questions >= 1, '确认后应生成题目');
  const mdContent = fs.readFileSync(result.paths.md, 'utf8');
  assert.ok(mdContent.includes(marker), '改后的章节名应出现在产物 markdown 中');
});

test('交互式流程：用户取消抛 LA016', async (t) => {
  const root = makeTempDir('la-interact-cancel-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const md = writeNotes(root);

  await assert.rejects(
    () => runPipeline({
      topic: '网络体系结构',
      inputs: [md],
      mode: 'sources',
      mock: true,
      config: baseConfig(),
      reporter: createReporter({ quiet: true }),
      outDir: path.join(root, 'out'),
      meta: { slug: 'interact-cancel', version: '1.0.0' },
      outlineHook: async () => null
    }),
    (err) => err.code === 'LA016'
  );
});

/* ------------------------------ 通用交互（Phase 2） ------------------------------ */

test('suggestDepth：按有效内容量给出等级建议', () => {
  assert.equal(suggestDepth(300).depth, 'simple');
  assert.equal(suggestDepth(5000).depth, 'detail');
  assert.equal(suggestDepth(12000).depth, 'deep');
  assert.equal(suggestDepth(0).depth, 'simple');
});

test('createInteractHooks.confirmOutline：写出大纲+建议，采纳 depth 时返回包装', async () => {
  const written = [];
  const outline = {
    title: '主题',
    chapters: [{ name: '第一章 A', summary: 's', sections: [{ name: '1.1 a', points: ['p'] }] }],
    plates: []
  };
  const suggest = { depth: 'simple', perSection: 2, reason: '内容不足' };
  let resolveConfirm;
  const hooks = createInteractHooks({
    write: (obj) => written.push(obj),
    awaitMessage: async () => new Promise((r) => { resolveConfirm = r; })
  });
  const pending = hooks.confirmOutline(outline, suggest);
  assert.equal(written[0].type, 'outline');
  assert.equal(written[0].suggest.depth, 'simple');
  assert.ok(written[0].preview.chapters.length === 1);
  resolveConfirm({ type: 'confirm', accepted: true, outline: { title: '改后' }, depth: 'deep' });
  const out = await pending;
  assert.equal(out.outline.title, '改后');
  assert.equal(out.questionsPerSection, DEPTH_LEVELS.deep.perSection);
});

test('createInteractHooks.confirmOutline：未采纳 depth 时仍返回纯大纲（向后兼容）', async () => {
  const outline = { title: '主题', chapters: [], plates: [] };
  const hooks = createInteractHooks({
    write: () => {},
    awaitMessage: async () => ({ type: 'confirm', accepted: true, outline: { title: '改后' } })
  });
  const out = await hooks.confirmOutline(outline, null);
  assert.equal(typeof out, 'object');
  assert.equal(out.outline, undefined, '未采纳等级时应返回大纲本身');
  assert.equal(out.title, '改后');
});

test('createInteractHooks.askInsufficient：继续 / 中止 / 未回话', async () => {
  const mk = (answer) => createInteractHooks({
    write: (obj) => { if (obj.type === 'question') assert.equal(obj.qid, 'insufficient'); },
    awaitMessage: async () => answer
  });
  assert.equal(await mk({ qid: 'insufficient', choice: 'continue' }).askInsufficient({}), 'continue');
  assert.equal(await mk({ qid: 'insufficient', choice: 'abort' }).askInsufficient({}), 'abort');
  assert.equal(await mk(null).askInsufficient({}), 'abort');
});

test('createInteractHooks.confirmChapter：choice 映射', async () => {
  const mk = (choice) => createInteractHooks({
    write: () => {},
    awaitMessage: async () => choice ? { qid: 'chapter-0', choice } : null
  });
  const info = { qid: 'chapter-0', prompt: '继续？', data: { index: 0 } };
  assert.equal(await mk('ok').confirmChapter(info), 'ok');
  assert.equal(await mk('ok-all').confirmChapter(info), 'ok-all');
  assert.equal(await mk('abort').confirmChapter(info), 'abort');
  assert.equal(await mk(null).confirmChapter(info), 'abort');
});

/* 固定 3 章、每节 12 题的伪模型，用于验证逐章确认与等级采纳。 */
function interactLLM() {
  return {
    name: 'interact-llm',
    stats: {},
    async chatJSON(req) {
      if (req.task === 'outline') {
        return {
          title: '交互测试库',
          subject: '测试科目',
          category: '通识',
          description: '覆盖三章。',
          chapters: ['甲', '乙', '丙'].map((n) => ({
            name: `${n}章`,
            summary: `${n}概述`,
            sections: [{ name: `${n}节`, summary: `${n}摘要`, points: [`**${n}点**：${n}要点（关联：后续）`] }]
          })),
          plates: []
        };
      }
      const list = [];
      for (const ch of req.payload.chapters) {
        for (const sec of ch.sections) {
          const n = String(sec.name).replace(/^\d+(\.\d+)*\s*/, '');
          const qs = [];
          for (let k = 0; k < 12; k++) {
            qs.push({
              type: 'single',
              stem: `${n} 题${k}`,
              options: ['答案A', '答案B', '答案C', '答案D'],
              answer: 'A',
              analysis: `${n} 第 ${k} 题的解析，依据对应知识点判定。`,
              difficulty: '易',
              tags: [n]
            });
          }
          list.push({ chapter: ch.name, section: sec.name, questions: qs });
        }
      }
      return { sections: list };
    }
  };
}

test('集成：资料不足时询问，continue 继续、abort 抛 LA011', async (t) => {
  const short = '系统架构设计需要权衡可用性、性能、安全性与可维护性。'.repeat(8);

  // 用户选择继续：即使内容少于门槛也继续生成
  const root1 = makeTempDir('la-insuf-ok-');
  t.after(() => fs.rmSync(root1, { recursive: true, force: true }));
  let asked = 0;
  const ok = await runPipeline({
    topic: '系统架构设计',
    inputs: [`text:${short}`],
    mode: 'sources',
    mock: true,
    config: baseConfig({ minContentChars: 600 }),
    reporter: createReporter({ quiet: true }),
    outDir: path.join(root1, 'out'),
    meta: { slug: 'insuf-ok', version: '1.0.0' },
    interact: {
      askInsufficient: async (info) => { asked++; assert.ok(info.totalChars < info.minContentChars); return 'continue'; }
    }
  });
  assert.equal(asked, 1);
  assert.equal(ok.verification.ok, true);

  // 用户选择中止：抛 LA011
  const root2 = makeTempDir('la-insuf-abort-');
  t.after(() => fs.rmSync(root2, { recursive: true, force: true }));
  await assert.rejects(
    () => runPipeline({
      topic: '系统架构设计',
      inputs: [`text:${short}`],
      mode: 'sources',
      mock: true,
      config: baseConfig({ minContentChars: 600 }),
      reporter: createReporter({ quiet: true }),
      outDir: path.join(root2, 'out'),
      meta: { slug: 'insuf-abort', version: '1.0.0' },
      interact: { askInsufficient: async () => 'abort' }
    }),
    (err) => err.code === 'LA011'
  );
});

test('集成：逐章确认被按章调用，ok-all 之后不再询问', async (t) => {
  const root = makeTempDir('la-chapter-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const confirmCalls = [];
  const result = await runPipeline({
    topic: '交互测试',
    inputs: [`text:${FIXTURE_TEXT}`],
    mode: 'sources',
    llm: interactLLM(),
    outDir: path.join(root, 'out'),
    meta: { slug: 'chapter-confirm', version: '1.0.0' },
    config: baseConfig({ outDir: path.join(root, 'out') }),
    interact: {
      confirmChapter: async (info) => {
        confirmCalls.push(info);
        // 第 2 章之后选择「全部继续不再询问」
        return info.data.index === 1 ? 'ok-all' : 'ok';
      }
    }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.chapters, 3);
  assert.equal(confirmCalls.length, 2, 'ok-all 之后第 3 章不应再询问');
  assert.equal(confirmCalls[0].qid, 'chapter-0');
  assert.equal(confirmCalls[1].qid, 'chapter-1');
  assert.ok(confirmCalls[0].data.questions >= 1);
});

test('集成：逐章中止抛 LA018', async (t) => {
  const root = makeTempDir('la-chapter-abort-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(
    () => runPipeline({
      topic: '交互测试',
      inputs: [`text:${FIXTURE_TEXT}`],
      mode: 'sources',
      llm: interactLLM(),
      outDir: path.join(root, 'out'),
      meta: { slug: 'chapter-abort', version: '1.0.0' },
      config: baseConfig({ outDir: path.join(root, 'out') }),
      interact: { confirmChapter: async () => 'abort' }
    }),
    (err) => err.code === 'LA018'
  );
});

test('集成：采纳大纲等级改变每节题量', async (t) => {
  const root = makeTempDir('la-depth-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runPipeline({
    topic: '交互测试',
    inputs: [`text:${FIXTURE_TEXT}`],
    mode: 'sources',
    llm: interactLLM(),
    outDir: path.join(root, 'out'),
    meta: { slug: 'depth-adopt', version: '1.0.0' },
    config: baseConfig({ outDir: path.join(root, 'out') }),
    interact: {
      confirmOutline: async (outline) => ({ outline, questionsPerSection: DEPTH_LEVELS.deep.perSection })
    }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  // 3 章 × 1 节，deep 档每节 10 题；未指定总题量时题量只作下限，多出的题保留，至少 33 题。
  assert.ok(result.stats.questions >= 33, `实际生成 ${result.stats.questions} 题`);
});

test('集成：确认消息携带的题量与案例数被精确执行', async (t) => {
  const root = makeTempDir('la-counts-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runPipeline({
    topic: '交互测试',
    inputs: [`text:${FIXTURE_TEXT}`],
    mode: 'sources',
    llm: interactLLM(),
    outDir: path.join(root, 'out'),
    meta: { slug: 'counts-adopt', version: '1.0.0' },
    config: baseConfig({ outDir: path.join(root, 'out') }),
    interact: {
      confirmOutline: async (outline) => ({
        outline,
        questionsPerSection: 6,
        questionCount: 5,
        caseCount: 2
      })
    }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.questions, 5, '选择题总数必须严格等于配置值');
  assert.equal(result.stats.cases, 2, '案例总数必须严格等于配置值');

  const library = JSON.parse(fs.readFileSync(path.join(result.paths.dir, 'content/library.json'), 'utf8'));
  const cases = [];
  for (const ch of library.chapters) {
    for (const sec of ch.sections) {
      for (const q of sec.questions) if (q.type === 'case') cases.push(q);
    }
  }
  assert.equal(cases.length, 2);
  for (const c of cases) {
    assert.ok(c.material.includes('【背景】'));
    assert.ok(c.analysis.includes('【分析过程】'));
    assert.ok(c.analysis.includes('【结论总结】'));
  }
});