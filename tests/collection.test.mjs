import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildPack } from '../src/pack.mjs';
import { buildCollection, verifyCollection, isCollection } from '../src/collection.mjs';
import { readZip, writeZip } from '../src/zip.mjs';
import { makeTempDir } from './helpers.mjs';

function sampleLibrary(slug) {
  return {
    schema: 'kshare/v1',
    meta: {
      slug,
      title: `${slug} 测试`,
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
                id: `q_${slug}_1`,
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
              }
            ]
          }
        ]
      }
    ],
    knowledge: { plates: [] }
  };
}

function makePack(root, slug) {
  const workDir = path.join(root, `work-${slug}`);
  fs.mkdirSync(path.join(workDir, 'images'), { recursive: true });
  return buildPack({
    workDir,
    meta: {
      slug,
      version: '1.0.0',
      title: `${slug} 测试`,
      subject: '测试',
      category: '通识',
      updated: '2026-10-28',
      author: 'AimCram Learning Agent',
      tags: ['测试'],
      description: '合集测试用学习库。',
      generator: 'aimcram-agent/mock',
      generatorVersion: '1.0.0'
    },
    libraryJson: sampleLibrary(slug),
    outDir: path.join(root, 'packs'),
    sourceMd: `# ${slug}\n`
  });
}

test('学习库合集：打包、校验、篡改检测', async (t) => {
  const root = makeTempDir('la-collection-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const a = makePack(root, 'pack-a');
  const b = makePack(root, 'pack-b');

  await t.test('目录输入打成单个 ZIP，根目录只有一个', () => {
    const built = buildCollection({
      targets: [a.root, b.root],
      outDir: path.join(root, 'dist'),
      name: 'demo',
      version: '1.0.0',
      title: '演示合集'
    });
    assert.equal(built.rootName, 'demo-1.0.0');
    assert.ok(fs.existsSync(built.zip));
    assert.equal(built.collection.counts.packs, 2);
    assert.deepEqual(built.collection.packs.map((p) => p.path), ['pack-a-1.0.0', 'pack-b-1.0.0']);
    assert.equal(isCollection(built.zip), true);
  });

  await t.test('合集 strict 校验通过，并逐个校验子包', () => {
    const zip = path.join(root, 'dist/demo-1.0.0.zip');
    const report = verifyCollection(zip, { strict: true });
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);
    assert.equal(report.ok, true);
    assert.equal(report.packs.length, 2);
  });

  await t.test('ZIP 输入同样可合并', () => {
    const built = buildCollection({
      targets: [a.zip, b.zip],
      outFile: path.join(root, 'dist/from-zip.zip'),
      name: 'fromzip'
    });
    assert.equal(verifyCollection(built.zip, { strict: true }).ok, true);
  });

  await t.test('重复学习库与同名合集都被拒绝', () => {
    assert.throws(
      () => buildCollection({ targets: [a.root, a.root], outDir: path.join(root, 'dist2') }),
      (err) => err.code === 'LA012'
    );
    assert.throws(
      () => buildCollection({ targets: [a.root], outDir: path.join(root, 'dist') , name: 'demo' }),
      (err) => err.code === 'LA015'
    );
  });

  await t.test('子包内容被篡改时合集校验失败', () => {
    const built = buildCollection({
      targets: [a.root, b.root],
      outFile: path.join(root, 'tampered.zip'),
      name: 'tamper'
    });
    const files = readZip(fs.readFileSync(built.zip));
    const key = 'tamper-1.0.0/pack-a-1.0.0/content/library.json';
    const lib = JSON.parse(files.get(key).toString('utf8'));
    lib.chapters[0].name = '被篡改的章名';
    files.set(key, Buffer.from(JSON.stringify(lib, null, 2) + '\n'));
    const file = path.join(root, 'tampered-bad.zip');
    fs.writeFileSync(file, writeZip(files));
    const report = verifyCollection(file, {});
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((e) => e.code === 'E122' || e.code === 'E123'));
  });
});
