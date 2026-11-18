import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { normalizeRecord, parseTextQuestions, importLibrary } from '../src/import.mjs';
import { extractFile } from '../src/extract/index.mjs';

test('JSONL 直采：判断题答案归一为正确/错误', () => {
  const q = normalizeRecord({
    type: '判断',
    question: '夜间通过急弯应交替使用远近光灯。',
    options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
    answer: 'A',
    explanation: '夜间通过急弯需交替使用远近光灯示意。'
  });
  assert.equal(q.type, 'judge');
  assert.deepEqual(q.answer, ['正确']);
  assert.equal(q.difficulty, '中');
});

test('JSONL 直采：单选与多选保留字母答案', () => {
  const single = normalizeRecord({
    type: '单选',
    question: '红灯亮时表示什么？',
    options: [
      { key: 'A', text: '可以通行' },
      { key: 'B', text: '禁止通行' },
      { key: 'C', text: '减速通行' },
      { key: 'D', text: '加速通行' }
    ],
    answer: 'B'
  });
  assert.equal(single.type, 'single');
  assert.deepEqual(single.answer, ['B']);
  assert.equal(single.options.length, 4);
  const multiple = normalizeRecord({
    type: '多选',
    question: '下列哪些属于禁止标线？',
    options: [
      { key: 'A', text: '黄色实线' },
      { key: 'B', text: '白色虚线' },
      { key: 'C', text: '导流线' },
      { key: 'D', text: '停止线' }
    ],
    answer: 'ACD'
  });
  assert.equal(multiple.type, 'multiple');
  assert.deepEqual(multiple.answer, ['A', 'C', 'D']);
});

test('JSONL 直采：难度、标签、配图与章节识别', () => {
  const q = normalizeRecord({
    type: '单选题',
    question: '如图所示，该标志表示什么？',
    options: [{ key: 'A', text: '注意行人' }, { key: 'B', text: '人行横道' }],
    answer: 'B',
    difficulty: 5,
    tags: ['cat05'],
    chapter_name: '道路通行规定',
    has_image: true,
    image_source_url: 'https://example.com/a.jpg'
  });
  assert.equal(q.difficulty, '难');
  assert.deepEqual(q.tags, ['cat05']);
  assert.equal(q.chapter, '道路通行规定');
  assert.equal(q.hasImage, true);
});

test('JSONL 直采：无法识别的记录返回 null', () => {
  assert.equal(normalizeRecord({ type: '填空', question: '____' }), null);
  assert.equal(normalizeRecord({ type: '单选', question: '', answer: 'A' }), null);
  assert.equal(normalizeRecord(null), null);
});

test('文本直采：解析数字题干、选项、答案、解析与章节', () => {
  const text = [
    '# 第一章 道路通行',
    '1. 红灯亮时表示什么？',
    'A. 可以通行',
    'B. 禁止通行',
    '答案：B',
    '解析：红灯表示禁止通行。',
    '2. 黄灯亮时已越过停止线可以继续通行。',
    '答案：正确',
    '解析：已越过停止线可继续通行。'
  ].join('\n');
  const list = parseTextQuestions(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].type, 'single');
  assert.deepEqual(list[0].options.map((o) => o.key), ['A', 'B']);
  assert.equal(list[0].answer, 'B');
  assert.equal(list[0].chapter_name, '道路通行');
  assert.equal(list[1].type, 'judge');
  assert.equal(list[1].answer, '正确');
});

test('直采补题：题量不足时由 agent 补齐', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimcram-import-'));
  const src = path.join(dir, 'bank.jsonl');
  fs.writeFileSync(src, [
    JSON.stringify({
      type: '判断', question: '夜间会车应使用近光灯。', chapter_name: '第一章',
      options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answer: 'A', explanation: '会车使用近光灯。'
    }),
    JSON.stringify({
      type: '判断', question: '雨天行车应降低车速。', chapter_name: '第一章',
      options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answer: 'A', explanation: '雨天路滑需降速。'
    })
  ].join('\n'));
  const llm = {
    async chatJSON() {
      return {
        sections: [{
          chapter: '第一章',
          section: '单选题',
          questions: [{
            type: 'single',
            stem: '雾天行车应开启什么灯？',
            options: ['远光灯', '雾灯和近光灯', '仅示廓灯', '关闭所有灯'],
            answer: 'B',
            analysis: '雾天能见度低，应开启雾灯和近光灯。',
            difficulty: '中',
            tags: ['灯光']
          }]
        }]
      };
    }
  };
  const out = await importLibrary({
    topic: '测试题库',
    sources: [{ path: src, title: 'bank.jsonl', text: fs.readFileSync(src, 'utf8') }],
    workDir: path.join(dir, 'work'),
    meta: { title: '测试题库', subject: '测试题库', category: '职业资格', description: '' },
    questionsPerSection: 3,
    llm
  });
  assert.equal(out.stats.questions, 3);
  assert.equal(out.stats.quality.importedQuestions, 2);
  assert.equal(out.stats.quality.topUpAdded, 1);
  assert.ok(fs.existsSync(out.jsonPath));
});

test('混合科目题库按主题科目过滤', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimcram-import-subject-'));
  const src = path.join(dir, 'mixed.jsonl');
  const base = {
    type: '判断', options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }],
    chapter_name: '基础', explanation: '解析。'
  };
  fs.writeFileSync(src, [
    JSON.stringify({ ...base, id: 's1a', subject: 1, question: '科目一：红灯亮时可以通行。', answer: 'B' }),
    JSON.stringify({ ...base, id: 's1b', subject: 1, question: '科目一：夜间会车使用近光灯。', answer: 'A' }),
    JSON.stringify({ ...base, id: 's4a', subject: 4, question: '科目四：雨天可以加速通过积水路段。', answer: 'B' })
  ].join('\n'));
  const out = await importLibrary({
    topic: '驾考科目一',
    sources: [{ path: src, title: 'mixed.jsonl', text: fs.readFileSync(src, 'utf8') }],
    workDir: path.join(dir, 'work'),
    meta: { title: '驾考科目一', subject: '驾考科目一', category: '职业资格', description: '' }
  });
  assert.equal(out.stats.questions, 2);
  assert.equal(out.stats.quality.sourceRecords, 3);
  assert.equal(out.stats.quality.subjectFiltered, 1);
  assert.ok(!JSON.stringify(out.libraryJson).includes('科目四'));
});

test('规则解析不到题目时用 AI 解析', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimcram-import-ai-'));
  const src = path.join(dir, 'notes.pdf');
  const text = '以下是我们整理的培训资料，排版比较乱。\n红灯亮时禁止车辆通行，这是最基本的信号规则。\n黄灯亮时已越过停止线的车辆可以继续通行。';
  const llm = {
    async chatJSON({ system }) {
      if (String(system || '').includes('题库解析器')) {
        return {
          questions: [
            {
              type: 'judge', question: '红灯亮时禁止车辆通行。', answer: '正确',
              explanation: '红灯表示禁止通行。', chapter: '信号灯'
            },
            {
              type: 'judge', question: '黄灯亮时已越过停止线的车辆可以继续通行。', answer: '正确',
              explanation: '黄灯亮时已越线可继续通过。', chapter: '信号灯'
            }
          ]
        };
      }
      return {};
    }
  };
  const out = await importLibrary({
    topic: '交通信号',
    sources: [{ path: src, title: 'notes.pdf', text }],
    workDir: path.join(dir, 'work'),
    meta: { title: '交通信号', subject: '交通信号', category: '职业资格', description: '' },
    llm
  });
  assert.equal(out.stats.questions, 2);
  assert.equal(out.stats.quality.aiExtracted, 2);
  assert.equal(out.stats.quality.aiChunks, 1);
});

test('xlsx 资料能抽出文本', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimcram-import-xlsx-'));
  const xlsx = path.join(dir, 'bank.xlsx');
  fs.mkdirSync(path.join(dir, 'xl/worksheets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'xl/worksheets/sheet1.xml'), `<?xml version="1.0"?>
<worksheet><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>1. 红灯亮时可以通行。</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>答案：错误</t></is></c></row>
</sheetData></worksheet>`);
  const zip = spawnSync('zip', ['-q', '-r', xlsx, 'xl'], { cwd: dir });
  if (zip.status !== 0) return; // 环境没有 zip 命令时跳过
  const source = await extractFile(xlsx);
  assert.match(source.text, /红灯亮时可以通行/);
  assert.match(source.text, /答案：错误/);
});

test('直采后补生成知识图谱与案例精析', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aimcram-import-enrich-'));
  const src = path.join(dir, 'bank.jsonl');
  fs.writeFileSync(src, [
    JSON.stringify({
      type: '判断', question: '夜间会车应使用近光灯。', chapter_name: '第一章 基础',
      options: [{ key: 'A', text: '正确' }, { key: 'B', text: '错误' }], answer: 'A', explanation: '会车使用近光灯。'
    }),
    JSON.stringify({
      type: '单选', question: '红灯亮时表示什么？', chapter_name: '第一章 基础',
      options: [{ key: 'A', text: '可以通行' }, { key: 'B', text: '禁止通行' }], answer: 'B', explanation: '红灯禁止通行。'
    })
  ].join('\n'));
  const llm = {
    async chatJSON({ task }) {
      if (task === 'cases') {
        return {
          cases: [{
            chapter: '第一章 基础',
            title: '路口信号灯通行案例',
            background: '路口信号灯出现故障，需要依据信号规则判断通行顺序。',
            scenario: '红灯期间一辆车越过停止线，驾驶人主张已提前减速。',
            analysis: '先确认信号状态，再判断是否越线，最后给出通行结论。',
            conclusion: '红灯期间越过停止线属于闯红灯，应停车等待。',
            questions: [{ stem: '该驾驶人是否违法？', answer: '违法，红灯期间不得越过停止线。' }]
          }]
        };
      }
      if (task === 'plates') {
        return {
          plates: [{
            name: '信号与通行规则',
            lead: '交通信号、标线与通行顺序的核心判断依据。',
            chapters: ['第一章 基础'],
            points: ['红灯停、绿灯行', '越线即视为闯红灯']
          }]
        };
      }
      return { sections: [] };
    }
  };
  const out = await importLibrary({
    topic: '直采增强',
    sources: [{ path: src, title: 'bank.jsonl', text: fs.readFileSync(src, 'utf8') }],
    workDir: path.join(dir, 'work'),
    meta: { title: '直采增强', subject: '直采增强', category: '职业资格', description: '' },
    caseCount: 1,
    llm
  });
  assert.equal(out.stats.cases, 1);
  assert.ok(out.stats.plates >= 1);
  assert.ok(out.outline.plates.length >= 1);
  const lib = JSON.parse(fs.readFileSync(out.jsonPath, 'utf8'));
  assert.equal(lib.meta.counts.byType.case, 1);
  assert.ok(lib.knowledge && lib.knowledge.plates.length >= 1);
  assert.ok(fs.existsSync(path.join(path.dirname(out.mdPath), 'images', 'plate-01.svg')));
});
