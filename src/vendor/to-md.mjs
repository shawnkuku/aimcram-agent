#!/usr/bin/env node
/**
 * kshare 入库 JSON → Markdown 导出器（反向转换）
 *
 * 用法：
 *   node tools/to-md.mjs <bank.json> [-o 导出.md] [--assets images] [--no-inline-svg]
 *
 * 说明：
 *   - 输入必须是 kshare.mjs 生成的入库 JSON（schema: kshare/v1 或 v2）；
 *   - 输出是一份可直接再导入的 md：front matter + 知识图谱 + 章 / 节 / 题目；
 *   - JSON 里的 data URI 图片会被写成独立文件（默认 images/ 目录），md 里改为相对路径，
 *     这样 md 可以直接打包分享，别人用 kshare.mjs 校验后再导入即可还原；
 *   - 导出前不做内容猜测：字段按题型原样还原，题目 id 由内容重新推导，
 *     因此「导出 → 再校验」应与原 JSON 的题量、题号完全一致。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp'
};
const TYPE_CN = { single: '单选', multiple: '多选', judge: '判断', case: '案例', qa: '问答', essay: '论文' };
const CAT_CN = { pred: '预测', fill: '图解填空', ai: 'AI', iot: '物联网' };

const opts = { input: '', out: '', assets: 'images' };

function usage(code) {
  const text = [
    'kshare 入库 JSON → Markdown（导出 / 备份 / 分享）',
    '',
    '  node tools/to-md.mjs <bank.json> [-o 导出.md] [--assets images]',
    '',
    '  -o, --out <file>   输出 md 路径，默认 <输入名>.export.md',
    '      --assets <dir> 图片目录（相对 md），默认 images',
    '',
    '  导出后可用 node tools/kshare.mjs 导出.md --check --strict 验证是否可再导入。'
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
    else if (a === '--assets') opts.assets = argv[++i] || 'images';
    else if (a.startsWith('-')) { process.stderr.write('未知参数：' + a + '\n'); usage(2); }
    else if (!opts.input) opts.input = a;
    else { process.stderr.write('多余参数：' + a + '\n'); usage(2); }
  }
  if (!opts.input) usage(2);
})();

/* ---------------- 文本工具 ---------------- */
const txt = s => String(s == null ? '' : s).replace(/\r\n/g, '\n').trim();
const oneLine = s => txt(s).replace(/\s+/g, ' ');

const L = (label, value) => '- ' + label + '：' + oneLine(value);
const BLOCK = (label, text) => '- ' + label + '：\n' + txt(text)
  .split('\n').map(l => '  ' + l).join('\n');
const LIST = (label, items) => '- ' + label + '：\n' +
  items.map(x => '  - ' + oneLine(x)).join('\n');
const TAGLINE = tags => '- 标签：[' + (tags || []).map(oneLine).join(', ') + ']';
const asLines = v => Array.isArray(v)
  ? v.map(txt).filter(Boolean)
  : String(v == null ? '' : v).split('\n').map(x => x.trim()).filter(Boolean);

/* 一行块内容可能被解析器误判成新字段的极端情况（如正文行以「- 答案：」开头）与
   render.mjs 保持同一取舍：不做事后转义，保证导出文本与原文一致。 */
const BRANCH = (label, text) => text ? BLOCK(label, text) : '';

/* ---------------- 图片外置 ---------------- */
/**
 * 导出时把图片统一收进 assets 目录：
 *   - data URI → 解码写文件；
 *   - 相对路径 → 从 bank.json 所在目录拷过来（保证导出目录自包含）；
 *   - http(s) → 原样保留（校验器会提示外链不可离线）。
 */
function makeAssetWriter(mdDir, srcDir) {
  const dir = path.resolve(mdDir, opts.assets);
  const prefix = opts.assets.replace(/\\/g, '/').replace(/\/+$/, '') || 'images';
  const hash = b => crypto.createHash('sha1').update(b).digest('hex').slice(0, 8);
  const byHash = new Map();
  let written = 0;

  function save(name, buf) {
    const h = hash(buf);
    if (byHash.has(h)) return byHash.get(h);   /* 同一张图多处引用只写一次 */
    fs.mkdirSync(dir, { recursive: true });
    let final = name;
    let target = path.join(dir, final);
    if (fs.existsSync(target)) {
      if (fs.readFileSync(target).equals(buf)) {
        byHash.set(h, prefix + '/' + final);
        return prefix + '/' + final;
      }
      const ext = path.extname(name);
      final = path.basename(name, ext) + '-' + h + ext;
      target = path.join(dir, final);
      if (fs.existsSync(target)) {
        byHash.set(h, prefix + '/' + final);
        return prefix + '/' + final;
      }
    }
    fs.writeFileSync(target, buf);
    written++;
    const rel = prefix + '/' + final;
    byHash.set(h, rel);
    return rel;
  }

  function resolveSrc(raw, hint) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (/^https?:/i.test(s)) return s;
    const m = s.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    if (m) {
      const ext = MIME_EXT[String(m[1]).toLowerCase()] || 'bin';
      const buf = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
      return save((hint ? hint + '-' : '') + hash(buf) + '.' + ext, buf);
    }
    const clean = decodeURIComponent(s.split('?')[0]);
    const abs = path.resolve(srcDir, clean);
    if (!fs.existsSync(abs)) return s;   /* 缺失时原样保留，由 kshare 报 E040 */
    return save(path.basename(abs), fs.readFileSync(abs));
  }

  return {
    dir,
    written: () => written,
    src: resolveSrc,
    /* 正文里的 ![](src) 全部改写成导出的相对路径 */
    text(text) {
      if (!text) return text;
      return String(text).replace(
        /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g,
        (mm, alt, src) => '![' + alt + '](' + resolveSrc(src) + ')'
      );
    }
  };
}

const externalizeText = (text, writer) => writer.text(text);

/* 裸路径或 data URI（图解 / 案例图）：统一转成导出目录下的相对路径 */
function externalizeImage(value, writer, hint) {
  const raw = txt(value).replace(/^!\[[^\]]*\]\(\s*([^)\s]+)\s*\)$/, '$1');
  if (!raw) return '';
  return writer.src(raw, hint);
}

/* ---------------- front matter ---------------- */
function frontMatter(bank) {
  const m = bank.meta || {};
  const lines = [
    '---',
    'schema: ' + (bank.schema === 'kshare/v2' ? 'kshare/v2' : 'kshare/v1'),
    'slug: ' + (m.slug || 'exported-library'),
    'title: ' + oneLine(m.title || '学习资料'),
    'subject: ' + oneLine(m.subject || m.title || '未命名科目'),
    'category: ' + oneLine(m.category || '综合'),
    'exam: ' + oneLine(m.exam || ''),
    'year: ' + (m.year || new Date().getFullYear()),
    'author: ' + oneLine(m.author || 'AimCram'),
    'rights: ' + (m.rights || 'original'),
    'license: ' + (m.license || 'CC-BY-NC-4.0'),
    'version: ' + (m.version || '1.0.0'),
    'updated: ' + (m.updated || new Date().toISOString().slice(0, 10)),
    'language: ' + (m.language || 'zh-CN'),
    'tags: [' + (m.tags || []).map(oneLine).join(', ') + ']',
    'description: ' + oneLine(m.description || '由 to-md.mjs 从入库 JSON 导出，可直接分享或备份。')
  ];
  Object.keys(m.ext || {}).forEach(k => {
    const v = m.ext[k];
    lines.push('x-' + k + ': ' + oneLine(typeof v === 'string' ? v : JSON.stringify(v)));
  });
  lines.push('---', '');
  return lines.join('\n');
}

/* ---------------- 知识图谱 ---------------- */
function knowledgeBlock(bank, writer) {
  const plates = (bank.knowledge && bank.knowledge.plates) || [];
  if (!plates.length) return '';
  const out = ['## 知识图谱', ''];
  plates.forEach(p => {
    out.push('### 板块｜' + (p.name || '未命名板块'));
    if (p.id) out.push(L('标识', p.id));
    if (p.color) out.push(L('颜色', p.color));
    if (p.lead) out.push(BRANCH('导语', p.lead));
    if ((p.points || []).length) out.push(LIST('知识点', p.points));
    if ((p.exam || []).length) out.push(LIST('高频考点', p.exam));
    if (p.diagram) {
      const rel = externalizeImage(p.diagram, writer, 'plate');
      if (rel) out.push(L('图解', rel));
    }
    if (p.diagramNote) out.push(BRANCH('图解说明', p.diagramNote));
    if ((p.chapters || []).length) out.push(L('关联章节', p.chapters.join(', ')));
    Object.keys(p.ext || {}).forEach(k => out.push(L('x-' + k, p.ext[k])));
    out.push('');
  });
  return out.join('\n');
}

/* ---------------- 题目 ---------------- */
function answerText(q) {
  if (Array.isArray(q.answer)) {
    if (q.type === 'single') return q.answer[0] || '';
    if (q.type === 'multiple') return q.answer.join(',');
    return q.answer.join('');
  }
  return txt(q.answer);
}

function questionBlock(q, no, writer, caseSeq) {
  const out = [];
  const label = TYPE_CN[q.type] || q.type;
  const withTitle = (q.type === 'case' || q.type === 'essay') && q.title;

  out.push('#### ' + label + ' ' + no + (withTitle ? '｜' + oneLine(q.title) : ''));

  if (q.type === 'case') {
    if (q.title) out.push(BRANCH('题目', q.title));
    if (q.material) out.push(BRANCH('材料', externalizeText(q.material, writer)));
    if (q.score) out.push(L('分值', q.score));
    const cat = q.category ? (CAT_CN[q.category] || q.categoryLabel || q.category) : (q.categoryLabel || '');
    if (cat) out.push(L('分类', cat));
    if (q.difficulty) out.push(L('难度', q.difficulty));
    if (q.quickNote) out.push(BRANCH('速记', q.quickNote));
    if (q.figure) {
      const rel = externalizeImage(q.figure, writer, 'case' + caseSeq);
      if (rel) out.push(L('图解', rel));
    }
    if (q.source) out.push(L('来源', q.source));
    if ((q.tags || []).length) out.push(TAGLINE(q.tags));
    (q.subQuestions || []).forEach((s, i) => {
      out.push('');
      out.push('##### 小问 ' + (i + 1));
      out.push(s.stem ? BRANCH('题干', externalizeText(s.stem, writer)) : '');
      if (s.score) out.push(L('分值', s.score));
      out.push(BRANCH('参考答案', externalizeText(s.answer, writer)));
      if (s.analysis) out.push(BRANCH('解析', externalizeText(s.analysis, writer)));
      if ((s.tags || []).length) out.push(TAGLINE(s.tags));
      Object.keys(s.ext || {}).forEach(k => out.push(L('x-' + k, s.ext[k])));
    });
    return out.filter(Boolean);
  }

  if (q.type === 'essay') {
    if (q.title) out.push(BRANCH('题目', q.title));
    const req = asLines(q.requirements);
    const outline = asLines(q.outline);
    if (req.length) out.push(BRANCH('要求', req.join('\n')));
    if (outline.length) out.push(BRANCH('提纲', outline.join('\n')));
    if (q.essay) out.push(BRANCH('范文', externalizeText(q.essay, writer)));
    if (q.difficulty) out.push(L('难度', q.difficulty));
    if (q.source) out.push(L('来源', q.source));
    if ((q.tags || []).length) out.push(TAGLINE(q.tags));
    Object.keys(q.ext || {}).forEach(k => out.push(L('x-' + k, q.ext[k])));
    return out.filter(Boolean);
  }

  if (q.stem) out.push(BRANCH('题干', externalizeText(q.stem, writer)));
  if (q.material) out.push(BRANCH('材料', externalizeText(q.material, writer)));
  if ((q.options || []).length) {
    out.push('- 选项：');
    q.options.forEach((o, i) => out.push('  - ' + 'ABCDEFGH'[i] + '. ' + oneLine(externalizeText(o, writer))));
  }
  const ans = answerText(q);
  if (ans) out.push(L(q.type === 'qa' ? '参考答案' : '答案', ans));
  if (q.analysis) out.push(BRANCH('解析', externalizeText(q.analysis, writer)));
  if (q.difficulty) out.push(L('难度', q.difficulty));
  if (q.score) out.push(L('分值', q.score));
  if (q.source) out.push(L('来源', q.source));
  if (q.note) out.push(L('备注', q.note));
  if ((q.tags || []).length) out.push(TAGLINE(q.tags));
  Object.keys(q.ext || {}).forEach(k => out.push(L('x-' + k, q.ext[k])));
  return out.filter(Boolean);
}

/* ---------------- 主流程 ---------------- */
function main() {
  const file = opts.input;
  if (!fs.existsSync(file)) {
    process.stderr.write('找不到文件：' + file + '\n');
    process.exit(2);
  }
  let bank;
  try { bank = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    process.stderr.write('JSON 解析失败：' + e.message + '\n');
    process.exit(1);
  }
  if (!bank || !/^kshare\/v[12]$/.test(bank.schema || '') || !Array.isArray(bank.chapters)) {
    process.stderr.write('不是 kshare/v1 或 v2 的入库 JSON：' + file + '\n');
    process.exit(1);
  }

  const outPath = path.resolve(opts.out ||
    path.join(path.dirname(file), path.basename(file, path.extname(file)) + '.export.md'));
  const writer = makeAssetWriter(path.dirname(outPath), path.dirname(path.resolve(file)));

  const title = (bank.meta && bank.meta.title) || '学习资料';
  const body = [frontMatter(bank), '# ' + oneLine(title), ''];
  const kg = knowledgeBlock(bank, writer);
  if (kg) body.push(kg);

  const counts = { single: 0, multiple: 0, judge: 0, case: 0, qa: 0, essay: 0 };
  let caseSeq = 0;
  let sections = 0;

  bank.chapters.forEach(ch => {
    body.push('## ' + oneLine(ch.name || '未命名章'), '');
    (ch.sections || []).forEach(sec => {
      body.push('### ' + oneLine(sec.name || '未命名节'), '');
      sections++;
      (sec.questions || []).forEach(q => {
        counts[q.type] = (counts[q.type] || 0) + 1;
        let no = counts[q.type];
        if (q.type === 'case') { caseSeq++; no = caseSeq; }
        body.push(questionBlock(q, no, writer, caseSeq).join('\n'));
        body.push('');
      });
    });
  });

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body.join('\n').replace(/\n{4,}/g, '\n\n\n').trimEnd() + '\n');

  const total = Object.keys(counts).reduce((n, k) => n + counts[k], 0);
  process.stdout.write(
    '导出完成：' + path.basename(file) + ' → ' + outPath + '\n' +
    '  章节：' + bank.chapters.length + ' 章 / ' + sections + ' 节\n' +
    '  题量：' + total + ' 题（' +
    Object.keys(counts).filter(k => counts[k]).map(k => TYPE_CN[k] + ' ' + counts[k]).join('、') + '）\n' +
    '  图片：' + writer.written() + ' 个 → ' + writer.dir + '\n' +
    '  校验：node tools/kshare.mjs "' + path.basename(outPath) + '" --check --strict\n'
  );
}

try { main(); } catch (e) {
  process.stderr.write((e && e.stack ? e.stack : e) + '\n');
  process.exit(1);
}
