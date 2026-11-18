/**
 * .xlsx 文本抽取：xlsx 本质是 zip + XML，这里只用系统 unzip 读取工作表，
 * 把每行拼成制表符分隔的文本，交给后续的题目解析（规则或 AI）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { AgentError } from '../errors.mjs';

const MAX_BUFFER = 64 * 1024 * 1024;

function unzip(file, args) {
  const r = spawnSync('unzip', [...args, file], { maxBuffer: MAX_BUFFER });
  if (r.status !== 0) return '';
  return r.stdout.toString('utf8');
}

function listEntries(file) {
  return unzip(file, ['-Z1']).split('\n').map((s) => s.trim()).filter(Boolean);
}

function xmlText(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');
}

function readEntry(file, entry) {
  if (!entry) return '';
  const r = spawnSync('unzip', ['-p', file, entry], { maxBuffer: MAX_BUFFER });
  return r.status === 0 ? r.stdout.toString('utf8') : '';
}

function parseSharedStrings(xml) {
  return (xml.match(/<si[\s>][\s\S]*?<\/si>/g) || []).map((si) => (
    [...si.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlText(m[1])).join('')
  ));
}

function columnIndex(ref) {
  const letters = (String(ref).match(/^([A-Z]+)/i) || [])[1] || '';
  let index = 0;
  for (const ch of letters.toUpperCase()) index = index * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(0, index - 1);
}

function parseSheet(xml, shared) {
  const lines = [];
  for (const row of xml.match(/<row[\s>][\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const m of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = m[1];
      const body = m[2];
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || '';
      const ref = (attrs.match(/r="([A-Z]+\d+)"/) || [])[1] || '';
      let value = '';
      if (type === 's') {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = shared[Number(v)] ?? '';
      } else if (type === 'inlineStr') {
        value = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => xmlText(x[1])).join('');
      } else {
        const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = v ? xmlText(v) : '';
      }
      if (value !== '') cells[columnIndex(ref)] = value;
    }
    const line = cells.map((v) => v || '').join('\t').replace(/\t+$/, '');
    if (line.trim()) lines.push(line);
  }
  return lines;
}

export async function extractXlsx(buffer, { file, title } = {}) {
  let abs = file;
  let tmp = '';
  if (!abs || !fs.existsSync(abs)) {
    tmp = path.join(os.tmpdir(), `aimcram-xlsx-${Date.now()}.xlsx`);
    fs.writeFileSync(tmp, buffer);
    abs = tmp;
  }
  try {
    const entries = listEntries(abs);
    const sheets = entries
      .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry))
      .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));
    if (!sheets.length) {
      throw new AgentError('LA002', 'Excel 文件里没有可读取的工作表', {
        hint: '确认文件为 .xlsx；旧版 .xls 请先另存为 .xlsx'
      });
    }
    const shared = parseSharedStrings(readEntry(abs, 'xl/sharedStrings.xml'));
    const lines = [];
    for (const sheet of sheets) lines.push(...parseSheet(readEntry(abs, sheet), shared));
    const text = lines.join('\n');
    if (!text.trim()) {
      throw new AgentError('LA002', 'Excel 没有抽取到文本内容', {
        hint: '表格可能是纯图片或空表，请先转成可复制的文本'
      });
    }
    return {
      title: title || path.basename(abs, path.extname(abs)),
      text,
      rows: lines.length,
      sheets: sheets.length
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { force: true });
  }
}
