#!/usr/bin/env node
/**
 * kshare md/json → AimCram kb.js 转换器
 * 产出 App「学习」页读取的 window.KB：知识图谱 / 案例精析 / 真题考点
 *
 * 用法：
 *   node tools/to-kbjs.mjs <资料.md|资料.json> [-o kb.js] [--pretty] [--no-inline]
 *
 * 说明：
 *   - 传入 .md 时先调用 kshare.mjs 校验，失败即停止；
 *   - 知识图谱来自 md 里的「## 知识图谱」区块；
 *   - 案例精析取所有「#### 案例 N」，按「- 分类：」分流：
 *       预测 / 图解填空 / AI / 物联网 → 对应专题，其它文本按知识图谱板块名匹配；
 *       不写分类的案例按所在章归到「板块案例」；
 *   - 真题考点全部由题目自动聚合（章题数、题型、标签词频、论文论题），无需手写；
 *   - 图解支持 .svg（原样内联）与 png/jpg 等（转 data URI）；--no-inline 保留相对路径。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'
};
const PALETTE = [
  '#4263eb', '#0ca678', '#e8590c', '#9c36b5', '#1098ad', '#d6336c',
  '#f08c00', '#5c940d', '#343a40', '#1c7ed6', '#7048e8', '#0b7285', '#c2255c'
];
const SPECIAL = { pred: '★ 10月预测', fill: '★ 图解填空', ai: 'AI 基础与辨析', iot: '物联网与边缘计算' };
const TYPE_LABEL = {
  single: '单选', multiple: '多选', judge: '判断',
  case: '案例', qa: '问答', essay: '论文'
};

const opts = { input: '', out: '', pretty: false, inline: true };

function usage(code) {
  const text = [
    'kshare → kb.js 转换器（知识图谱 / 案例精析 / 真题考点）',
    '',
    '  node tools/to-kbjs.mjs <资料.md|资料.json> [-o kb.js] [--pretty] [--no-inline]',
    '',
    '  -o, --out <file>  输出路径，默认 <输入名>.kb.js',
    '      --pretty      输出带缩进的 JSON',
    '      --no-inline   图片保留 md 中的相对路径（需自行拷进 App）'
  ].join('\n');
  (code ? process.stderr : process.stdout).write(text + '\n');
  process.exit(code);
}

(function parseArgs() {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') usage(0);
    else if (a === '-o' || a === '--out') opts.out = argv[++i] || '';
    else if (a === '--pretty') opts.pretty = true;
    else if (a === '--no-inline') opts.inline = false;
    else if (a.startsWith('-')) { process.stderr.write('未知参数：' + a + '\n'); usage(2); }
    else if (!opts.input) opts.input = a;
    else { process.stderr.write('多余参数：' + a + '\n'); usage(2); }
  }
  if (!opts.input) usage(2);
})();

/* ---------------- 载入：md 走校验，json 直接读 ---------------- */
function loadBank(file) {
  if (path.extname(file).toLowerCase() === '.json') {
    const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!bank || !/^kshare\/v[12]$/.test(bank.schema || '') || !Array.isArray(bank.chapters)) {
      throw new Error('不是 kshare/v1 或 v2 的入库 JSON：' + file);
    }
    return { bank, dir: path.dirname(path.resolve(file)), temp: null };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kshare-'));
  const tmpJson = path.join(tmpDir, 'bank.json');
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'kshare.mjs'), file, '--out', tmpJson, '--quiet'];
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('校验未通过，已停止转换（退出码 ' + run.status + '）');
  }
  const bank = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  return { bank, dir: path.dirname(path.resolve(file)), temp: tmpDir };
}

/* ---------------- 图解 ---------------- */
function makeFigureResolver(dir, warnings) {
  const cache = new Map();
  return function resolve(src) {
    const raw = String(src || '').trim();
    if (!raw) return {};
    const m = raw.match(/^data:([^;,]+);base64,([\s\S]*)$/);
    if (m) {
      if (/svg/i.test(m[1])) return { svg: Buffer.from(m[2], 'base64').toString('utf8') };
      return { fig: raw };
    }
    if (/^https?:/i.test(raw)) {
      warnings.push('外链图解无法离线使用：' + raw);
      return {};
    }
    const abs = path.resolve(dir, decodeURIComponent(raw.split('?')[0]));
    if (!fs.existsSync(abs)) {
      warnings.push('图解文件不存在：' + raw);
      return {};
    }
    if (cache.has(abs)) return cache.get(abs);
    const ext = path.extname(abs).toLowerCase();
    let out;
    if (!opts.inline) out = { fig: raw };
    else if (ext === '.svg') out = { svg: fs.readFileSync(abs, 'utf8') };
    else out = { fig: 'data:' + (MIME[ext] || 'application/octet-stream') + ';base64,' + fs.readFileSync(abs).toString('base64') };
    cache.set(abs, out);
    return out;
  };
}

/* ---------------- 转换 ---------------- */
const txt = s => String(s == null ? '' : s).trim();

function caseQuestion(q) {
  const head = q.title ? '【' + txt(q.title) + '】' : '';
  return [head, txt(q.material)].filter(Boolean).join('\n\n');
}

function caseAnswer(q) {
  const subs = (q.subQuestions || []).map((s, i) =>
    '（' + (i + 1) + '）' + txt(s.stem) + '\n' + txt(s.answer)
  ).join('\n\n');
  const ana = txt(q.analysis) ? '\n\n【解析】\n' + txt(q.analysis) : '';
  return subs + ana;
}

function tagCount(list) {
  const map = new Map();
  list.forEach(q => (q.tags || []).forEach(t => map.set(t, (map.get(t) || 0) + 1)));
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function convert(bank, dir) {
  const warnings = [];
  const resolveFigure = makeFigureResolver(dir, warnings);
  const chapters = bank.chapters || [];
  const kgSrc = (bank.knowledge && bank.knowledge.plates) || [];

  /* ---- 板块 ---- */
  const plates = kgSrc.map((p, i) => ({
    id: p.id || 'p' + i,
    name: p.name || '板块 ' + (i + 1),
    color: p.color || PALETTE[i % PALETTE.length]
  }));
  const kg = {};
  kgSrc.forEach((p, i) => {
    const id = p.id || 'p' + i;
    kg[id] = {
      lead: txt(p.lead),
      points: (p.points || []).slice(),
      exam: (p.exam || []).slice(),
      diagram: '',
      diagramNote: txt(p.diagramNote)
    };
    if (p.diagram) {
      const fig = resolveFigure(p.diagram);
      if (fig.svg) kg[id].diagram = fig.svg;
      else if (fig.fig) kg[id].diagram = '<img src="' + fig.fig + '" alt="">';
    }
  });

  /* ---- 题目摊平 ---- */
  const all = [];
  chapters.forEach((ch, ci) => ch.sections.forEach((sec, si) => sec.questions.forEach(q => {
    all.push({ q, ci, si, ch, sec });
  })));

  /* ---- 案例精析 ---- */
  const cases = { pred: [], fill: [], ai: [], iot: [], plate: {} };
  const plateName = {};
  const plateById = new Map(plates.map(p => [p.id, p]));
  const plateByName = new Map(plates.map(p => [p.name, p]));
  /* 板块声明的「关联章节」：案例没写分类时，先按所在章精确归类 */
  const plateByChapter = new Map();
  kgSrc.forEach((p, i) => {
    const id = p.id || 'p' + i;
    (p.chapters || []).forEach(ch => { if (ch && !plateByChapter.has(ch)) plateByChapter.set(ch, id); });
  });
  const plateCaseCount = new Map();
  const usedPlate = new Set();

  const ensureChapterPlate = (ci, ch) => {
    const id = 'c' + ci;
    if (!plateById.has(id)) {
      const p = { id, name: ch.name, color: PALETTE[plates.length % PALETTE.length] };
      plates.push(p);
      plateById.set(id, p);
      kg[id] = { lead: '本章案例归类（未在知识图谱中单独梳理）。', points: [], exam: [], diagram: '', diagramNote: '' };
    }
    return id;
  };

  all.forEach(({ q, ci, ch, sec }) => {
    if (q.type !== 'case') return;
    const qText = caseQuestion(q);
    const aText = caseAnswer(q);
    const k = txt(q.quickNote);
    const cat = q.category || '';
    const chName = txt(ch.name);
    const secName = txt(sec.name);

    if (cat === 'pred') {
      cases.pred.push({ tag: txt(q.title), hot: 0, q: qText, a: aText, k, ch: chName, sec: secName });
      plateCaseCount.set('pred', (plateCaseCount.get('pred') || 0) + 1);
      return;
    }
    if (cat === 'fill') {
      const fig = resolveFigure(q.figure);
      cases.fill.push({ cat: txt(q.title) || ch.name, q: qText, a: aText, ...fig, k, ch: chName, sec: secName });
      plateCaseCount.set('fill', (plateCaseCount.get('fill') || 0) + 1);
      return;
    }
    if (cat === 'ai' || cat === 'iot') {
      const lvl = q.difficulty === '易' ? '基础' : '进阶';
      cases[cat].push({
        cat: txt(q.title) || ch.name, lvl,
        q: qText, a: aText, k, ch: chName, sec: secName,
        group: lvl === '基础' ? '基础辨析' : '进阶实战'
      });
      plateCaseCount.set(cat, (plateCaseCount.get(cat) || 0) + 1);
      return;
    }

    /* 其它文本按知识图谱板块名/标识匹配，匹配不到按章归类 */
    const label = txt(q.categoryLabel);
    let pid = '';
    if (label) {
      const hit = plateByName.get(label) || plateById.get(label);
      if (hit) pid = hit.id;
      else warnings.push('案例「' + (txt(q.title) || txt(q.material).slice(0, 16)) + '」的分类「' + label + '」在知识图谱里找不到，已按所在章归类');
    }
    if (!pid) pid = plateByChapter.get(ch.name) || '';
    if (!pid) pid = ensureChapterPlate(ci, ch);
    const fig = resolveFigure(q.figure);
    (cases.plate[pid] = cases.plate[pid] || []).push({ q: qText, a: aText, k, ch: chName, sec: secName, ...fig });
    plateCaseCount.set(pid, (plateCaseCount.get(pid) || 0) + 1);
    usedPlate.add(pid);
  });

  /* 没有案例的板块不在「案例精析」里出现 */
  const caseCount = cases.pred.length + cases.fill.length + cases.ai.length + cases.iot.length
    + Object.keys(cases.plate).reduce((n, k) => n + cases.plate[k].length, 0);
  plates.forEach(p => {
    if (!(plateCaseCount.get(p.id) > 0)) p.noCase = 1;
  });

  /* ---- 真题考点（自动聚合） ---- */
  const chapterStats = chapters.map((ch, ci) => {
    const qs = [];
    ch.sections.forEach(sec => sec.questions.forEach(q => qs.push(q)));
    const stat = { name: ch.name, secs: ch.sections.length, total: qs.length, ch: 0, ca: 0, es: 0, plate: plateByChapter.get(ch.name) || ('c' + ci), kps: tagCount(qs).slice(0, 14) };
    qs.forEach(q => {
      if (q.type === 'case') stat.ca++;
      else if (q.type === 'essay') stat.es++;
      else stat.ch++;
    });
    plateName['c' + ci] = ch.name;
    return stat;
  });

  /* 案例考点分布：专题 + 板块 */
  const casePlateCounts = {};
  Object.keys(SPECIAL).forEach(k => {
    if (plateCaseCount.get(k) > 0) {
      casePlateCounts[k] = plateCaseCount.get(k);
      plateName[k] = SPECIAL[k];
    }
  });
  Object.keys(cases.plate).forEach(k => {
    casePlateCounts[k] = cases.plate[k].length;
  });

  const caseQuestions = all.filter(x => x.q.type === 'case').map(x => x.q);
  let caseTop = tagCount(caseQuestions);
  if (!caseTop.length) {
    caseTop = Object.keys(casePlateCounts).map(k => [plateName[k] || k, casePlateCounts[k]]).sort((a, b) => b[1] - a[1]);
  }

  const caseSecArr = [];
  chapters.forEach(ch => ch.sections.forEach(sec => {
    const n = sec.questions.filter(q => q.type === 'case').length;
    if (n) caseSecArr.push([sec.name, n]);
  }));
  caseSecArr.sort((a, b) => b[1] - a[1]);

  const byType = { single: 0, multiple: 0, judge: 0, case: 0, qa: 0, essay: 0 };
  all.forEach(({ q }) => { byType[q.type] = (byType[q.type] || 0) + 1; });

  const essays = all.filter(x => x.q.type === 'essay').map(x => txt(x.q.title) || txt(x.q.requirements).slice(0, 30));

  const rk = {
    overview: {
      total: all.length,
      chapters: chapters.length,
      sections: chapters.reduce((n, ch) => n + ch.sections.length, 0),
      choice: byType.single + byType.multiple + byType.judge,
      case: byType.case,
      essay: byType.essay
    },
    chapters: chapterStats,
    caseTop: caseTop.slice(0, 46),
    casePlate: casePlateCounts,
    caseSecArr: caseSecArr.slice(0, 16),
    essays,
    plateName
  };

  const points = kgSrc.reduce((n, p) => n + (p.points || []).length, 0);
  const exam = kgSrc.reduce((n, p) => n + (p.exam || []).length, 0);

  const meta = {
    title: (bank.meta && bank.meta.title ? bank.meta.title : '学习资料') + ' · 学习资料',
    source: bank.meta && bank.meta.sourceFile ? bank.meta.sourceFile : '',
    builtAt: new Date().toISOString().slice(0, 10),
    counts: {
      plates: plates.length,
      points,
      exam,
      cases: caseCount,
      rkChapters: chapters.length,
      essays: essays.length
    },
    slug: (bank.meta && bank.meta.slug) || '',
    license: (bank.meta && bank.meta.license) || '',
    rights: (bank.meta && bank.meta.rights) || '',
    author: (bank.meta && bank.meta.author) || ''
  };

  return {
    kb: { meta, plates, kg, cases, rk },
    stats: { byType, caseCount, warnings, usedPlate }
  };
}

/* ---------------- 主流程 ---------------- */
function main() {
  const file = opts.input;
  if (!fs.existsSync(file)) {
    process.stderr.write('找不到文件：' + file + '\n');
    process.exit(2);
  }

  let loaded;
  try {
    loaded = loadBank(file);
  } catch (e) {
    process.stderr.write((e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }

  const { bank, dir, temp } = loaded;
  let result;
  try {
    result = convert(bank, dir);
  } catch (e) {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    process.stderr.write((e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });

  const { kb, stats } = result;
  if (!kb.meta.counts.plates && !kb.meta.counts.cases) {
    process.stderr.write('没有可转换的内容：既没有「## 知识图谱」板块，也没有案例题。\n');
    process.exit(1);
  }

  const outPath = opts.out || path.join(path.dirname(path.resolve(file)), path.basename(file, path.extname(file)) + '.kb.js');
  const header = '/* ' + (kb.meta.title || '学习资料') + ' · 学习资料数据（转换生成）\n' +
    ' * 来源：' + (kb.meta.slug || kb.meta.source) + ' | 授权：' + (kb.meta.license || '未声明') +
    ' | 版权状态：' + (kb.meta.rights || '未声明') + '\n' +
    ' * 结构：plates 板块 / kg 知识图谱 / cases 案例精析 / rk 真题考点\n' +
    ' */\n';
  fs.writeFileSync(outPath, header + 'window.KB=' + JSON.stringify(kb, null, opts.pretty ? 2 : 0) + ';\n');

  const c = kb.meta.counts;
  process.stdout.write(
    '转换完成：' + path.basename(file) + ' → ' + outPath + '\n' +
    '  知识图谱：' + c.plates + ' 板块 / ' + c.points + ' 知识点 / ' + c.exam + ' 考点 / ' +
    kbSrcDiagrams(kb) + ' 图解\n' +
    '  案例精析：' + c.cases + ' 道（预测 ' + kb.cases.pred.length + ' · 图解填空 ' + kb.cases.fill.length +
    ' · AI ' + kb.cases.ai.length + ' · 物联网 ' + kb.cases.iot.length +
    ' · 板块 ' + Object.keys(kb.cases.plate).reduce((n, k) => n + kb.cases.plate[k].length, 0) + '）\n' +
    '  真题考点：' + kb.rk.overview.total + ' 题统计 / ' + kb.rk.chapters.length + ' 章 / ' +
    kb.rk.caseTop.length + ' 个考点 / ' + kb.rk.essays.length + ' 个论文论题\n' +
    '  文件：' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB\n'
  );

  if (stats.warnings.length) {
    const uniq = Array.from(new Set(stats.warnings));
    process.stderr.write('[WARN] ' + uniq.length + ' 条提示：\n');
    uniq.slice(0, 10).forEach(w => process.stderr.write('  - ' + w + '\n'));
  }
}

function kbSrcDiagrams(kb) {
  return Object.keys(kb.kg).filter(id => kb.kg[id].diagram).length;
}

main();
