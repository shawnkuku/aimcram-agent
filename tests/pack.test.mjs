import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildPack, verifyPack, unpackPack, computeCounts, contentFingerprint
} from '../src/pack.mjs';
import { makeTempDir } from './helpers.mjs';

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#4263eb"/></svg>';

function sampleLibrary() {
  return {
    schema: 'kshare/v1',
    meta: {
      slug: 'pack-test',
      title: '打包测试',
      version: '1.0.0',
      updated: '2026-10-28',
      counts: {},
      assets: [],
      sourceFile: 'library.md',
      builtAt: '2026-10-28T00:00:00Z'
    },
    chapters: [
      {
        name: '第一章 总论',
        sections: [
          {
            name: '1.1 基础概念',
            questions: [
              {
                id: 'q_pack_test_1',
                type: 'single',
                stem: '以下哪一项属于架构风格？',
                options: ['分层', '编译', '加密', '索引'],
                answer: ['A'],
                analysis: '分层是一种常见的架构风格。',
                difficulty: '易',
                tags: ['架构'],
                source: '',
                score: null,
                title: '',
                material: '',
                note: ''
              },
              {
                id: 'q_pack_test_2',
                type: 'judge',
                stem: '事件驱动架构可以降低生产者与消费者的耦合。',
                options: [],
                answer: ['正确'],
                analysis: '通过事件总线解耦。',
                difficulty: '易',
                tags: ['架构'],
                source: '',
                score: null,
                title: '',
                material: '',
                note: ''
              }
            ]
          }
        ]
      }
    ],
    knowledge: {
      plates: [
        {
          id: 'basic',
          name: '基础板块',
          color: '#4263eb',
          lead: '架构风格与质量属性。',
          points: ['分层', '事件驱动'],
          exam: ['架构风格辨析'],
          diagram: 'images/plate-01.svg',
          diagramNote: '知识点关联示意'
        }
      ]
    }
  };
}

function makeWorkDir(root) {
  const workDir = path.join(root, 'work');
  fs.mkdirSync(path.join(workDir, 'images'), { recursive: true });
  fs.writeFileSync(path.join(workDir, 'images/plate-01.svg'), SVG, 'utf8');
  return workDir;
}

function packMeta(overrides = {}) {
  return {
    slug: 'pack-test',
    version: '1.0.0',
    title: '打包测试',
    subject: '软件架构',
    category: '职业资格',
    updated: '2026-10-28',
    author: 'AimCram Learning Agent',
    tags: ['架构'],
    description: '覆盖架构风格与质量属性。',
    generator: 'aimcram-agent/mock',
    generatorVersion: '1.0.0',
    minAppVersion: '1.0.0',
    ...overrides
  };
}

test('学习库包：组包、校验、解包', async (t) => {
  const root = makeTempDir('la-pack-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workDir = makeWorkDir(root);
  const outDir = path.join(root, 'out');

  const built = buildPack({
    workDir,
    meta: packMeta(),
    libraryJson: sampleLibrary(),
    outDir,
    sourceMd: '# 打包测试\n'
  });

  await t.test('目录结构符合 <slug>-<version>/ 约定', () => {
    assert.equal(path.basename(built.root), 'pack-test-1.0.0');
    assert.ok(fs.existsSync(path.join(built.root, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(built.root, 'content/library.json')));
    assert.ok(fs.existsSync(path.join(built.root, 'resources/images/plate-01.svg')));
    assert.ok(fs.existsSync(path.join(built.root, 'source/library.md')));
    assert.equal(path.basename(built.zip), 'pack-test-1.0.0.zip');
  });

  await t.test('manifest 计数与指纹正确', () => {
    assert.equal(built.manifest.format, 'kshare-pack/v1');
    assert.deepEqual(built.manifest.counts, {
      chapters: 1,
      sections: 1,
      questions: 2,
      byType: { single: 1, multiple: 0, judge: 1, case: 0, qa: 0, essay: 0 },
      knowledge: { plates: 1, points: 2, exam: 1, diagrams: 1 },
      resources: 1
    });
    assert.equal(built.manifest.resources[0].path, 'resources/images/plate-01.svg');
    assert.equal(built.manifest.resources[0].mime, 'image/svg+xml');
    assert.equal(built.fingerprint, contentFingerprint(built.library));
  });

  await t.test('目录包与 ZIP 包都能通过 strict 校验', () => {
    const dirReport = verifyPack(built.root, { strict: true, appVersion: '1.0.0' });
    assert.deepEqual(dirReport.errors, []);
    assert.deepEqual(dirReport.warnings, []);
    assert.equal(dirReport.ok, true);

    const zipReport = verifyPack(built.zip, { strict: true, appVersion: '1.0.0' });
    assert.deepEqual(zipReport.errors, []);
    assert.deepEqual(zipReport.warnings, []);
    assert.equal(zipReport.ok, true);
  });

  await t.test('解包后仍可校验，内容往返一致', () => {
    const target = path.join(root, 'unpacked');
    const result = unpackPack(built.zip, target);
    assert.ok(result.files >= 4);
    assert.equal(result.root, path.join(target, 'pack-test-1.0.0'));
    const report = verifyPack(result.root, { strict: true });
    assert.equal(report.ok, true);
    const original = JSON.parse(fs.readFileSync(path.join(built.root, 'content/library.json'), 'utf8'));
    const restored = JSON.parse(fs.readFileSync(path.join(result.root, 'content/library.json'), 'utf8'));
    assert.deepEqual(restored, original);
  });

  await t.test('内容被篡改时报 E122', () => {
    const tampered = unpackPack(built.zip, path.join(root, 'tampered')).root;
    const file = path.join(tampered, 'content/library.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8') + ' ', 'utf8');
    const report = verifyPack(tampered, {});
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === 'E122'));
  });

  await t.test('包内出现构建产物时报 E103', () => {
    const dirty = unpackPack(built.zip, path.join(root, 'dirty')).root;
    fs.writeFileSync(path.join(dirty, 'data.js'), 'export default {};\n', 'utf8');
    const report = verifyPack(dirty, {});
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === 'E103'));
  });

  await t.test('同 slug+version 内容变化时报 LA015', () => {
    const changed = sampleLibrary();
    changed.chapters[0].name = '第一章 变更后的总论';
    assert.throws(
      () => buildPack({ workDir, meta: packMeta(), libraryJson: changed, outDir, sourceMd: '# x\n' }),
      (err) => err.code === 'LA015'
    );
  });

  await t.test('computeCounts 对空知识图谱返回 null', () => {
    const lib = sampleLibrary();
    lib.knowledge = { plates: [] };
    const counts = computeCounts(lib);
    assert.equal(counts.knowledge, null);
    assert.equal(counts.questions, 2);
  });
});
