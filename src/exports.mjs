/**
 * 产物出口：App 运行数据（data.js / kb.js）与独立 Markdown 导出。
 *
 * 复用 services/tools 下已经过验证的转换器，避免出现第二套字段映射。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentError } from './errors.mjs';
import { ensureDir } from './util.mjs';

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../tools');

function runTool(script, args, label) {
  const r = spawnSync(process.execPath, [path.join(TOOLS, script), ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (r.status !== 0) {
    throw new AgentError('LA009', `${label} 失败`, {
      details: { stdout: r.stdout?.slice(-2000), stderr: r.stderr?.slice(-2000) }
    });
  }
  return r;
}

/**
 * @param {{libraryJsonPath: string, appDir: string}} params
 */
export function emitAppData({ libraryJsonPath, appDir }) {
  if (!fs.existsSync(libraryJsonPath)) {
    throw new AgentError('LA009', `找不到内容文件：${libraryJsonPath}`);
  }
  ensureDir(appDir);
  const dataJs = path.join(appDir, 'data.js');
  const kbJs = path.join(appDir, 'kb.js');
  const d = runTool('to-datajs.mjs', [libraryJsonPath, '-o', dataJs], 'data.js 转换');
  const k = runTool('to-kbjs.mjs', [libraryJsonPath, '-o', kbJs], 'kb.js 转换');
  return {
    dataJs,
    kbJs,
    dataBytes: fs.statSync(dataJs).size,
    kbBytes: fs.statSync(kbJs).size,
    stdout: { data: d.stdout?.trim(), kb: k.stdout?.trim() }
  };
}

/** 学习库包内容 → 独立 md（复用 to-md.mjs）。 */
export function exportMarkdown({ libraryJsonPath, outPath }) {
  const r = runTool('to-md.mjs', [libraryJsonPath, '-o', outPath], 'Markdown 导出');
  return { outPath, stdout: r.stdout?.trim() };
}
