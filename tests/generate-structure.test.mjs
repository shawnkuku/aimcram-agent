import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runPipeline } from '../src/pipeline.mjs';
import { verifyPack } from '../src/pack.mjs';
import { planStructure, applyOutlineMeta, isShellQuestion, planSectionTargets } from '../src/generate.mjs';
import { AgentError } from '../src/errors.mjs';
import { HarnessLLM } from '../src/llm-harness.mjs';
import { makeTempDir } from './helpers.mjs';

const TEXT = '机动车驾驶证申领和使用规定明确了申请条件、考试科目与记分规则。'.repeat(200);

function chapter(name, sections) {
  return {
    name,
    summary: `${name}的概述`,
    sections: sections.map((s) => ({
      name: s,
      summary: `${s}的摘要`,
      points: [`**${s}**：${s}的核心要点（关联：后续小节）`]
    }))
  };
}

const ONE_CHAPTER = [chapter('总则与申请条件', ['基础概念', '申请条件'])];
const THREE_CHAPTERS = [
  chapter('总则与申请条件', ['基础概念', '申请条件']),
  chapter('考试与记分', ['科目一考试', '记分周期']),
  chapter('证件管理', ['换证与补证', '注销情形'])
];

/** 伪模型：首次只给 1 章，补足时给 3 章；出题时混入一道空壳题。 */
function fakeLLM() {
  let outlineCalls = 0;
  let questionCalls = 0;
  return {
    name: 'fake-llm',
    stats: {},
    get outlineCalls() { return outlineCalls; },
    async chatJSON(req) {
      if (req.task === 'outline') {
        outlineCalls++;
        return {
          title: '模型自己起的标题',
          subject: '模型自己起的科目',
          category: '职业资格',
          description: '覆盖驾驶证申领、考试与记分规则。',
          chapters: outlineCalls === 1 ? ONE_CHAPTER : THREE_CHAPTERS,
          plates: []
        };
      }
      if (req.task === 'plates') return { plates: [] };
      questionCalls++;
      const sections = [];
      let index = 0;
      for (const ch of req.payload.chapters) {
        for (const sec of ch.sections) {
          const plain = String(sec.name).replace(/^\d+(\.\d+)*\s*/, '');
          index++;
          const questions = [
            {
              type: 'single',
              stem: `${plain} 的核心规则是什么（第 ${index} 题）`,
              options: ['记 6 分', '记 3 分', '记 12 分', '不记分'],
              answer: 'C',
              analysis: `依据本节「${plain}」的知识点，该情形应记 12 分，其余选项对应其他违法情形。`,
              difficulty: '中',
              tags: [plain]
            },
            {
              type: 'judge',
              stem: `判断：${plain} 的适用条件有明确边界。`,
              answer: '正确',
              analysis: `本节「${plain}」给出了明确的适用范围，超出边界的情形不适用该条款。`,
              difficulty: '易',
              tags: [plain]
            }
          ];
          if (questionCalls === 1 && index === 1) {
            questions.unshift({
              type: 'judge',
              stem: `判断：「驾驶证申领」这一表述属于本节「${plain}」的内容。`,
              answer: '正确',
              analysis: '该表述直接来自本节知识点。'
            });
          }
          sections.push({ chapter: ch.name, section: plain, questions });
        }
      }
      return { sections };
    }
  };
}

test('planStructure：8 KB 量级资料不再压成 1 章', () => {
  const plan = planStructure([{ text: TEXT }], { maxSections: 12 });
  assert.ok(plan.chars > 5000, `chars=${plan.chars}`);
  assert.ok(plan.chapters >= 3 && plan.chapters <= 6);
});

test('applyOutlineMeta：显式参数覆盖模型输出', () => {
  const outline = applyOutlineMeta({ title: '模型标题', subject: '模型科目', category: '通识' }, {
    title: '科目一',
    subject: '机动车驾驶证'
  });
  assert.equal(outline.title, '科目一');
  assert.equal(outline.subject, '机动车驾驶证');
  assert.equal(outline.category, '通识');
});

test('isShellQuestion：识别空壳题与复述式解析', () => {
  assert.equal(isShellQuestion({
    stem: '判断：「驾驶证申领」这一表述属于本节「基础概念」的内容。',
    analysis: '该表述直接来自本节知识点。'
  }), true);
  assert.equal(isShellQuestion({
    stem: '判断：驾驶证有效期满前 90 日内可以申请换证。',
    analysis: '判断：驾驶证有效期满前 90 日内可以申请换证。'
  }), true);
  assert.equal(isShellQuestion({
    stem: '判断：驾驶证有效期满前 90 日内可以申请换证。',
    analysis: '依据规定，换证窗口为有效期满前 90 日内，因此命题成立。'
  }), false);
});

test('生成链路：大纲补足 + 元数据同源 + 空壳题剔除', async (t) => {
  const dir = makeTempDir('la-struct-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const llm = fakeLLM();

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    llm,
    outDir: dir,
    meta: { slug: 'driving-test', version: '1.0.0', title: '科目一', subject: '机动车驾驶证' },
    config: { outDir: dir }
  });

  assert.equal(llm.outlineCalls, 2, '首版只有 1 章，应触发一次补足');

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  const pack = verifyPack(result.paths.zip, { strict: true });
  assert.equal(pack.ok, true, JSON.stringify(pack.errors));
  assert.equal(pack.manifest.title, '科目一');
  assert.equal(pack.manifest.subject, '机动车驾驶证');
  assert.equal(pack.manifest.counts.chapters, 3);

  const library = JSON.parse(fs.readFileSync(path.join(result.paths.dir, 'content/library.json'), 'utf8'));
  assert.equal(library.meta.title, pack.manifest.title);
  assert.equal(library.meta.subject, pack.manifest.subject);

  const stems = [];
  for (const ch of library.chapters) {
    for (const sec of ch.sections) {
      assert.ok(sec.questions.length >= 1, `${sec.name} 无题目`);
      for (const q of sec.questions) stems.push(q.stem);
    }
  }
  assert.ok(stems.length > 0);
  assert.ok(!stems.some((s) => s.includes('这一表述属于本节')), '空壳题未被剔除');

  const quality = result.stats.quality;
  assert.equal(quality.planChapters >= 3, true);
  assert.equal(quality.outlineRetried, true);
  assert.equal(quality.outlineStaged, false);
  assert.equal(quality.shellDropped, 1);
  assert.equal(quality.actualChapters, 3);
});

test('生成链路：两次大纲都不达标时走分步生成', async (t) => {
  const dir = makeTempDir('la-staged-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const calls = { outline: 0, titles: 0, chapter: 0 };
  let questionIndex = 0;
  const llm = {
    name: 'staged-llm',
    stats: {},
    async chatJSON(req) {
      if (req.task === 'outline') {
        calls.outline++;
        // 两次都只给 1 章，强制进入分步路径
        return {
          title: '模型标题',
          subject: '模型科目',
          category: '职业资格',
          description: '覆盖驾驶证申领与记分。',
          chapters: ONE_CHAPTER,
          plates: []
        };
      }
      if (req.task === 'outline-titles') {
        calls.titles++;
        return { chapters: ['总则与申请条件', '考试与记分', '证件管理'] };
      }
      if (req.task === 'outline-chapter') {
        calls.chapter++;
        const name = req.user.chapter;
        return {
          summary: `${name}的概述`,
          sections: [
            { name: `${name}要点一`, summary: '摘要一', points: [`**${name}要点一**：核心内容（关联：要点二）`] },
            { name: `${name}要点二`, summary: '摘要二', points: [`**${name}要点二**：核心内容（关联：要点一）`] }
          ]
        };
      }
      const sections = [];
      for (const ch of req.payload.chapters) {
        for (const sec of ch.sections) {
          const plain = String(sec.name).replace(/^\d+(\.\d+)*\s*/, '');
          questionIndex++;
          sections.push({
            chapter: ch.name,
            section: plain,
            questions: [
              {
                type: 'single',
                stem: `${plain} 的规定是什么（第 ${questionIndex} 题）`,
                options: ['记 6 分', '记 3 分', '记 12 分', '不记分'],
                answer: 'C',
                analysis: `本节「${plain}」明确该情形记 12 分，其余选项对应其他违法情形。`,
                difficulty: '中',
                tags: [plain]
              },
              {
                type: 'judge',
                stem: `判断：${plain} 的适用情形有明确界定。`,
                answer: '正确',
                analysis: `本节「${plain}」给出了适用范围，超出界定则不适用该条款。`,
                difficulty: '易',
                tags: [plain]
              }
            ]
          });
        }
      }
      return { sections };
    }
  };

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    llm,
    outDir: dir,
    meta: { slug: 'driving-staged', version: '1.0.0', title: '科目一', subject: '机动车驾驶证' },
    config: { outDir: dir }
  });

  assert.equal(calls.outline, 2);
  assert.equal(calls.titles, 1);
  assert.equal(calls.chapter, 3);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.chapters, 3);
  assert.equal(result.stats.quality.outlineStaged, true);
  assert.equal(result.pack.manifest.title, '科目一');
  assert.equal(result.pack.manifest.counts.chapters, 3);
});

/** 通用出题响应：按 payload 的章节结构给每节 2 道题。 */
function questionReply(req) {
  const sections = [];
  let index = 0;
  for (const ch of req.payload.chapters) {
    for (const sec of ch.sections) {
      const plain = String(sec.name).replace(/^\d+(\.\d+)*\s*/, '');
      index++;
      sections.push({
        chapter: ch.name,
        section: plain,
        questions: [
          {
            type: 'single',
            stem: `${plain} 的规定是什么（第 ${index} 题）`,
            options: ['记 6 分', '记 3 分', '记 12 分', '不记分'],
            answer: 'C',
            analysis: `本节「${plain}」明确该情形记 12 分，其余选项对应其他违法情形。`,
            difficulty: '中',
            tags: [plain]
          },
          {
            type: 'judge',
            stem: `判断：${plain} 的适用情形有明确界定。`,
            answer: '正确',
            analysis: `本节「${plain}」给出了适用范围，超出界定则不适用该条款。`,
            difficulty: '易',
            tags: [plain]
          }
        ]
      });
    }
  }
  return { sections };
}

test('生成链路：一次大纲失败时自动退到分步大纲', async (t) => {
  const dir = makeTempDir('la-outline-fallback-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let outlineCalls = 0;
  const llm = {
    name: 'outline-fail-llm',
    stats: {},
    async chatJSON(req) {
      if (req.task === 'outline') {
        outlineCalls++;
        throw new AgentError('LA008', 'Harness 模型返回空内容（finish=max-tokens）');
      }
      if (req.task === 'outline-titles') {
        return { chapters: ['总则与申请条件', '考试与记分', '证件管理'] };
      }
      if (req.task === 'outline-chapter') {
        const name = req.user.chapter;
        return {
          summary: `${name}的概述`,
          sections: [
            { name: `${name}要点一`, summary: '摘要一', points: [`**${name}要点一**：核心内容（关联：要点二）`] },
            { name: `${name}要点二`, summary: '摘要二', points: [`**${name}要点二**：核心内容（关联：要点一）`] }
          ]
        };
      }
      return questionReply(req);
    }
  };

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    llm,
    outDir: dir,
    meta: { slug: 'driving-outline-fallback', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.equal(outlineCalls, 1, '一次大纲失败后不应原地重试');
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.chapters, 3);
  assert.equal(result.stats.quality.outlineFallback, true);
  assert.equal(result.stats.quality.outlineStaged, true);
});

test('生成链路：出题批次失败仍用兜底题完成组包', async (t) => {
  const dir = makeTempDir('la-question-fallback-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let questionCalls = 0;
  const llm = {
    name: 'question-fail-llm',
    stats: {},
    async chatJSON(req) {
      if (req.task === 'outline') {
        return {
          title: '模型标题',
          subject: '模型科目',
          category: '职业资格',
          description: '覆盖驾驶证申领与记分。',
          chapters: THREE_CHAPTERS,
          plates: []
        };
      }
      if (req.task === 'questions') {
        questionCalls++;
        throw new AgentError('LA008', '出题输出被截断');
      }
      throw new Error(`unexpected task: ${req.task}`);
    }
  };

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    llm,
    outDir: dir,
    meta: { slug: 'driving-question-fallback', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.ok(questionCalls >= 1);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.quality.questionBatchesFailed >= 1, true);
  assert.equal(result.stats.quality.sectionsFilled, 6, '每节都应由兜底题补齐');
  assert.equal(result.stats.questions, 6);
  assert.equal(result.pack.manifest.counts.questions, 6);
});

test('生成链路：知识图谱默认详细，题量与案例数严格匹配用户配置', async (t) => {
  const dir = makeTempDir('la-counts-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    mock: true,
    outDir: dir,
    questionCount: 7,
    caseCount: 5,
    meta: { slug: 'driving-counts', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.questions, result.stats.quality.questionTarget, '题量统计应与目标一致');
  assert.equal(result.stats.questions, 7, '选择题总数必须严格等于配置值');
  assert.equal(result.stats.cases, 5, '案例总数必须严格等于配置值');

  const library = JSON.parse(fs.readFileSync(path.join(result.paths.dir, 'content/library.json'), 'utf8'));

  // 知识图谱：板块齐全、每个板块层级（二级）与关联清晰、高频考点充足
  assert.ok(library.knowledge && library.knowledge.plates.length >= 2, '知识图谱板块过少');
  for (const plate of library.knowledge.plates) {
    assert.ok(plate.name, '板块缺少名称');
    assert.ok(plate.points.length >= 8, `${plate.name} 知识点不足 8 条`);
    for (const point of plate.points) {
      assert.ok(/（二级[：:]/.test(point), `${plate.name} 的知识点缺少二级层级：${point}`);
      assert.ok(/关联[：:]/.test(point), `${plate.name} 的知识点缺少关联关系：${point}`);
    }
    assert.ok(plate.exam.length >= 4, `${plate.name} 高频考点不足 4 条`);
  }

  // 案例精析：数量精确，且背景 / 场景 / 分析过程 / 结论总结齐备
  const cases = [];
  for (const ch of library.chapters) {
    for (const sec of ch.sections) {
      for (const q of sec.questions) if (q.type === 'case') cases.push(q);
    }
  }
  assert.equal(cases.length, 5);
  for (const c of cases) {
    assert.ok(c.material.includes('【背景】'), `${c.title} 缺少背景`);
    assert.ok(c.material.includes('【场景】'), `${c.title} 缺少场景`);
    assert.ok(c.analysis.includes('【分析过程】'), `${c.title} 缺少分析过程`);
    assert.ok(c.analysis.includes('【结论总结】'), `${c.title} 缺少结论总结`);
    assert.ok((c.subQuestions || []).length >= 2, `${c.title} 小问不足 2 个`);
  }
});

test('生成链路：沿用用户确认的目录，不按默认上限裁剪章节', async (t) => {
  const dir = makeTempDir('la-preset-outline-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  /* 10 章 × 7 节：超过 normalizeOutline 的「8 章 / 6 节」上限，验证不被裁剪 */
  const chapters = Array.from({ length: 10 }, (_, i) => ({
    name: `自定义章 ${i + 1}`,
    summary: `第 ${i + 1} 章说明`,
    sections: Array.from({ length: 7 }, (_, j) => ({
      name: `小节 ${i + 1}.${j + 1}`,
      summary: `第 ${i + 1} 章第 ${j + 1} 节说明`
    }))
  }));

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    mock: true,
    outDir: dir,
    questionCount: 140,
    caseCount: 2,
    presetOutline: { title: '机动车驾驶证', chapters },
    meta: { slug: 'driving-preset', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  const library = JSON.parse(fs.readFileSync(path.join(result.paths.dir, 'content/library.json'), 'utf8'));
  assert.equal(library.chapters.length, 10, '章节数应与用户目录一致');
  assert.equal(library.chapters[0].name, '自定义章 1', '章名应原样保留');
  assert.equal(library.chapters[0].sections.length, 7, '小节数应与用户目录一致');
  assert.equal(result.stats.questions, 140);
  assert.equal(result.stats.cases, 2);
});

test('生成链路：题量小于小节数时也不会产出空小节导致校验失败', async (t) => {
  const dir = makeTempDir('la-small-count-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    mock: true,
    outDir: dir,
    questionCount: 1,
    caseCount: 1,
    meta: { slug: 'driving-small-count', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
  assert.equal(result.stats.questions, 1);
  assert.equal(result.stats.cases, 1);
  assert.equal(result.pack.manifest.counts.questions, 2, '1 道选择题 + 1 个案例');
});


test('生成链路：首次 reasoning 耗尽预算后自动重试并完成长资料生成', async (t) => {
  const dir = makeTempDir('la-harness-retry-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  let outlineStreams = 0;
  const outline = {
    title: '模型标题',
    subject: '模型科目',
    category: '职业资格',
    description: '覆盖驾驶证申领与记分。',
    chapters: THREE_CHAPTERS,
    plates: []
  };
  const service = {
    async *stream(options) {
      const system = String(options.system || '');
      if (system.includes('课程设计专家')) {
        outlineStreams++;
        if (outlineStreams === 1) {
          // 复现线上失败：reasoning 吃满预算，一个 text-delta 都没有。
          yield { type: 'reasoning-delta', index: 0, text: '先通读资料并规划章节结构……' };
          yield { type: 'finish', reason: { kind: 'max-tokens' } };
          return;
        }
        yield { type: 'text-delta', index: 0, text: JSON.stringify(outline) };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      // 出题阶段返回空小节，交给兜底题补齐，验证整条链路不会中断。
      yield { type: 'text-delta', index: 0, text: '{"sections":[]}' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  };
  const model = new HarnessLLM({ llm: service, provider: 'deepseek', model: 'deepseek-flash' });

  const result = await runPipeline({
    topic: '机动车驾驶证',
    inputs: [`text:${TEXT}`],
    mode: 'sources',
    llm: model,
    outDir: dir,
    meta: { slug: 'driving-harness-retry', version: '1.0.0' },
    config: { outDir: dir }
  });

  assert.equal(outlineStreams, 2, '首次空输出后应自动重试一次');
  assert.equal(model.stats.calls >= 2, true);
  assert.equal(model.stats.retries >= 1, true);
  assert.equal(result.stats.quality.outlineFallback, false, '重试成功时不应走分步大纲');
  assert.equal(result.stats.chapters, 3);
  assert.equal(result.stats.quality.sectionsFilled, 6);
  assert.equal(result.verification.ok, true, JSON.stringify(result.verification.errors));
});

test('题量按章/节考试权重分配，而不是按章节平均', () => {
  const outline = {
    chapters: [
      { name: '高频章', weight: 5, sections: [{ name: '核心节', weight: 3 }, { name: '次要节', weight: 3 }] },
      { name: '低频章', weight: 1, sections: [{ name: '边缘节', weight: 3 }] }
    ]
  };
  const targets = planSectionTargets(outline, 3, 30);
  const values = [...targets.values()];
  assert.equal(values.reduce((a, b) => a + b, 0), 30, '总题量必须精确等于 30');
  assert.ok(values[0] > values[2], '高频章每节题量应多于低频章');

  // 未给总题量时，同样按权重缩放，不退回平均
  const scaled = [...planSectionTargets(outline, 3).values()];
  assert.ok(scaled[0] > scaled[2], '每节题量模式下高频章也应更多');
});
