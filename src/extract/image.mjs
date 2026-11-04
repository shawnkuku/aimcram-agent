/**
 * 图片 OCR
 *
 * 首选 macOS Vision（VNRecognizeTextRequest，准确模式，中英双语），
 * 首次运行把 src/extract/vision-ocr.swift 编译到系统临时目录并复用；
 * 没有 swiftc 时退回 tesseract（若已安装），两者都没有则给出明确安装指引。
 *
 * 输出附带逐行置信度，方便上层如实报告 OCR 质量，而不是承诺一个固定准确率。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentError } from '../errors.mjs';
import { textStats, safeBaseName, sha1Hex, ensureDir } from '../util.mjs';
import { VERSION } from '../config.mjs';

const SWIFT_SRC = fileURLToPath(new URL('./vision-ocr.swift', import.meta.url));
const DEFAULT_CACHE = process.env.LA_OCR_CACHE_DIR || path.join(os.tmpdir(), 'aimcram-agent');

function hasCommand(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0 && String(r.stdout || '').trim().length > 0;
}

export function ocrCapability() {
  const swiftc = process.platform === 'darwin' && hasCommand('swiftc');
  return {
    platform: process.platform,
    swiftc,
    vision: swiftc,
    tesseract: hasCommand('tesseract'),
    available: swiftc || hasCommand('tesseract')
  };
}

function ensureVisionBinary(cacheDir) {
  ensureDir(cacheDir);
  if (!fs.existsSync(SWIFT_SRC)) {
    throw new AgentError('LA014', '缺少 vision-ocr.swift，无法启用 Vision OCR');
  }
  const source = fs.readFileSync(SWIFT_SRC);
  const binary = path.join(cacheDir, `vision-ocr-${sha1Hex(source).slice(0, 10)}`);
  if (fs.existsSync(binary)) return binary;

  const result = spawnSync('swiftc', ['-O', SWIFT_SRC, '-o', binary], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024
  });
  if (result.status !== 0 || !fs.existsSync(binary)) {
    throw new AgentError('LA003', 'Vision OCR 编译失败', {
      hint: '确认已安装 Xcode Command Line Tools（xcode-select --install），或安装 tesseract 作为替代',
      details: (result.stderr || '').slice(0, 2000)
    });
  }
  return binary;
}

function groupLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let current = null;
  for (const item of sorted) {
    const text = String(item.text || '').trim();
    if (!text) continue;
    if (current && Math.abs(current.y - item.y) <= 0.012) {
      current.parts.push({ text, x: item.x, confidence: item.confidence });
      current.confidence = Math.min(current.confidence, item.confidence ?? 1);
    } else {
      current = { y: item.y, parts: [{ text, x: item.x, confidence: item.confidence }], confidence: item.confidence ?? 1 };
      lines.push(current);
    }
  }
  return lines.map((line) => {
    const ordered = line.parts.sort((a, b) => a.x - b.x).map((p) => p.text).join(' ');
    return { text: ordered, confidence: line.confidence };
  });
}

function runVision(binary, imagePath, langs) {
  const result = spawnSync(binary, [imagePath, langs], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new AgentError('LA003', `Vision OCR 执行失败（退出码 ${result.status}）`, {
      details: (result.stderr || '').slice(0, 2000)
    });
  }
  let items;
  try {
    items = JSON.parse(result.stdout || '[]');
  } catch (err) {
    throw new AgentError('LA003', 'Vision OCR 输出不是合法 JSON', { cause: err });
  }
  const lines = groupLines(items);
  const confidences = lines.map((l) => l.confidence).filter((n) => Number.isFinite(n));
  const meanConfidence = confidences.length
    ? confidences.reduce((a, b) => a + b, 0) / confidences.length
    : 0;
  return {
    engine: 'vision',
    lines: lines.length,
    meanConfidence: Number(meanConfidence.toFixed(3)),
    lowConfidenceLines: lines.filter((l) => l.confidence < 0.3).length,
    text: lines.map((l) => l.text).join('\n')
  };
}

function runTesseract(imagePath) {
  const langs = process.env.LA_OCR_LANGS || 'chi_sim+eng';
  const result = spawnSync('tesseract', [imagePath, 'stdout', '-l', langs, '--psm', '6'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new AgentError('LA003', `tesseract OCR 失败（退出码 ${result.status}）`, {
      details: (result.stderr || '').slice(0, 2000)
    });
  }
  return {
    engine: 'tesseract',
    lines: String(result.stdout || '').split('\n').filter(Boolean).length,
    meanConfidence: null,
    lowConfidenceLines: 0,
    text: String(result.stdout || '').trim()
  };
}

/**
 * @param {Buffer} buffer 图片字节
 * @param {{file?: string, title?: string, cacheDir?: string}} [opts]
 */
export function extractImage(buffer, opts = {}) {
  const { file = '', title = '', cacheDir = DEFAULT_CACHE } = opts;
  const ext = (path.extname(file) || '.png').toLowerCase();
  const temp = path.join(ensureDir(cacheDir), `ocr-${sha1Hex(buffer).slice(0, 12)}${ext}`);
  const cap = ocrCapability();
  const langs = process.env.LA_OCR_LANGS || 'zh-Hans,en-US';

  let ocr;
  try {
    fs.writeFileSync(temp, buffer);
    if (cap.vision) {
      const binary = ensureVisionBinary(cacheDir);
      ocr = runVision(binary, temp, langs);
    } else if (cap.tesseract) {
      ocr = runTesseract(temp);
    } else {
      throw new AgentError('LA003', '当前环境没有可用的 OCR 引擎', {
        hint: 'macOS 执行 xcode-select --install 启用 Vision OCR，或安装 tesseract（brew install tesseract tesseract-lang）'
      });
    }
  } finally {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {
      /* 临时文件清理失败不影响结果 */
    }
  }

  const text = ocr.text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const stats = textStats(text);
  const warnings = [];
  if (!text) warnings.push('图片未识别出文字（可能是纯图形或分辨率过低）');
  if (ocr.engine === 'vision' && ocr.meanConfidence != null && ocr.meanConfidence < 0.5) {
    warnings.push(`OCR 平均置信度 ${ocr.meanConfidence}，建议换更高分辨率原图`);
  }
  if (ocr.lowConfidenceLines > 0) {
    warnings.push(`${ocr.lowConfidenceLines} 行文字置信度偏低，建议人工复核`);
  }
  if (!cap.vision) warnings.push('未启用 Vision OCR，当前使用 tesseract，置信度不可量化');

  return {
    title: title || safeBaseName(file).replace(/\.[^.]+$/, ''),
    text,
    stats,
    ocr: {
      engine: ocr.engine,
      engineVersion: ocr.engine === 'vision' ? `vision/${VERSION}` : 'tesseract',
      languages: ocr.engine === 'vision' ? langs.split(',') : [process.env.LA_OCR_LANGS || 'chi_sim+eng'],
      lines: ocr.lines,
      meanConfidence: ocr.meanConfidence
    },
    warnings,
    assets: [{ name: path.basename(file) || 'input.png', mime: guessImageMime(ext), data: buffer }]
  };
}

export function guessImageMime(ext) {
  const map = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
  };
  return map[String(ext).toLowerCase()] || 'image/png';
}
