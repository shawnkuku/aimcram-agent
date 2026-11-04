import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { extractFile, detectType } from '../src/extract/index.mjs';
import { buildFixtures, makeTempDir, FIXTURE_TEXT } from './helpers.mjs';

const cacheDir = path.join(os.tmpdir(), 'aimcram-agent');

test('多格式提取：md / html / docx / pdf / 图片 OCR', async (t) => {
  const dir = makeTempDir('la-extract-');
  const fx = buildFixtures(dir);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  await t.test('Markdown 标题与正文', async () => {
    const src = await extractFile(fx.md, { cacheDir });
    assert.equal(src.type, 'markdown');
    assert.equal(src.title, '网络体系结构');
    assert.match(src.text, /TCP 提供面向连接的可靠传输/);
    assert.equal(src.quality.mode, 'lossless');
    assert.equal(src.quality.confidence, 1);
  });

  await t.test('HTML 正文提取会剥离导航、广告与页脚', async () => {
    const src = await extractFile(fx.html, { cacheDir });
    assert.match(src.text, /OSI 参考模型把网络通信划分为七层/);
    assert.match(src.text, /UDP 不保证可靠交付/);
    assert.doesNotMatch(src.text, /扫码加群|首页|版权所有|广告位/);
    assert.equal(src.quality.mode, 'heuristic');
  });

  await t.test('DOCX 段落与文本', async () => {
    const src = await extractFile(fx.docx, { cacheDir });
    assert.equal(src.type, 'docx');
    assert.match(src.text, /SNMP 用于采集设备状态与告警/);
    assert.equal(src.quality.mode, 'lossless');
    assert.ok(src.meta.bytes > 0);
  });

  await t.test('PDF 文本层（可用时）', async (t2) => {
    if (!fx.pdf) {
      t2.skip('cupsfilter 不可用');
      return;
    }
    const src = await extractFile(fx.pdf, { cacheDir });
    assert.equal(src.type, 'pdf');
    assert.match(src.text, /每一层只与相邻层交互/);
    assert.doesNotMatch(src.text, /⽹/, 'NFKC 应把康熙部首归一化为汉字');
    assert.equal(src.meta.pageCount, 1);
  });

  await t.test('图片 OCR（可用时）', async (t2) => {
    if (!fx.png) {
      t2.skip('Chromium 截图不可用');
      return;
    }
    const src = await extractFile(fx.png, { cacheDir });
    assert.equal(src.type, 'image');
    assert.equal(src.quality.mode, 'ocr');
    assert.ok(src.text.length > 0, 'OCR 应识别出文字');
    assert.match(src.text.replace(/\s/g, ''), /网络|OSI|TCP/);
    assert.ok(src.meta.ocr.engine === 'vision' || src.meta.ocr.engine === 'tesseract');
  });

  await t.test('类型识别与旧版 .doc 报错', async () => {
    assert.equal(detectType('a.md', Buffer.from('# x')), 'markdown');
    assert.equal(detectType('a.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04])), 'docx');
    assert.equal(detectType('a.pdf', Buffer.from('%PDF-1.7')), 'pdf');
    assert.equal(detectType('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'image');
    assert.throws(
      () => detectType('a.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0])),
      (err) => err.code === 'LA002'
    );
    const fake = path.join(dir, 'legacy.doc');
    fs.writeFileSync(fake, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]));
    await assert.rejects(() => extractFile(fake), (err) => err.code === 'LA002');
  });

  await t.test('缺失文件给出 LA004', async () => {
    await assert.rejects(() => extractFile(path.join(dir, 'nope.md')), (err) => err.code === 'LA004');
  });
});

test('夹具文本本身包含关键知识点', () => {
  assert.match(FIXTURE_TEXT, /OSI 参考模型/);
  assert.ok(FIXTURE_TEXT.length > 200);
});
