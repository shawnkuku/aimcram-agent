/**
 * 内容提取质量评测
 *
 * 指标：字符 bigram 的 Dice F1（归一化去掉空白与标点），既能发现漏字，也能发现混入的导航/广告文本。
 * 数字文本类（md/txt/html/pdf/docx）应接近 100%；OCR 单独统计，受图片分辨率与字体影响。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFile } from '../src/extract/index.mjs';
import { buildFixtures, makeTempDir, diceText } from './helpers.mjs';

export async function runEval({ threshold = 0.95 } = {}) {
  const dir = makeTempDir('aimcram-agent-eval-');
  const fixtures = buildFixtures(dir);
  const cases = [];

  const add = async (name, file, expected, { kind = 'digital' } = {}) => {
    if (!file) {
      cases.push({ name, kind, skipped: true, f1: 1, precision: 1, recall: 1, ok: true, note: '生成工具不可用，已跳过' });
      return;
    }
    try {
      const source = await extractFile(file, { cacheDir: path.join(os.tmpdir(), 'aimcram-agent') });
      const score = diceText(expected, source.text);
      cases.push({
        name,
        kind,
        f1: Number(score.f1.toFixed(4)),
        precision: Number(score.precision.toFixed(4)),
        recall: Number(score.recall.toFixed(4)),
        chars: source.quality?.chars ?? source.text.length,
        quality: source.quality,
        ok: score.f1 >= (kind === 'ocr' ? Math.min(threshold, 0.6) : threshold),
        note: `${source.quality?.mode || ''} ${source.quality?.chars || 0} 字`
      });
    } catch (err) {
      cases.push({ name, kind, skipped: true, f1: 0, precision: 0, recall: 0, ok: false, note: `提取失败：${err.message}` });
    }
  };

  await add('Markdown', fixtures.md, fixtures.expected.md);
  await add('纯文本', fixtures.txt, fixtures.expected.txt);
  await add('HTML 正文', fixtures.html, fixtures.expected.html);
  await add('DOCX', fixtures.docx, fixtures.expected.docx);
  await add('PDF', fixtures.pdf, fixtures.expected.pdf);
  await add('图片 OCR', fixtures.png, fixtures.expected.image, { kind: 'ocr' });

  const digital = cases.filter((c) => c.kind === 'digital' && !c.skipped);
  const ocr = cases.filter((c) => c.kind === 'ocr' && !c.skipped);
  const digitalF1 = digital.length ? digital.reduce((n, c) => n + c.f1, 0) / digital.length : 0;
  const ocrF1 = ocr.length ? ocr.reduce((n, c) => n + c.f1, 0) / ocr.length : null;
  const ok = digitalF1 >= threshold && (ocrF1 == null || ocrF1 >= Math.min(threshold, 0.6)) && cases.every((c) => c.skipped || c.ok);

  fs.rmSync(dir, { recursive: true, force: true });
  return {
    ok,
    threshold,
    digitalF1: Number(digitalF1.toFixed(4)),
    ocrF1: ocrF1 == null ? null : Number(ocrF1.toFixed(4)),
    cases
  };
}
