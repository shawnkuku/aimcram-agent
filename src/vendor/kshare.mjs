#!/usr/bin/env node
/**
 * kshare 题库校验 / 入库脚本（schema: kshare/v1）
 *
 * 用法：
 *   node tools/kshare.mjs <题库.md> [选项]
 *
 * 选项：
 *   -o, --out <file>   指定输出 JSON 路径（默认与 md 同名的 .json）
 *       --check        只校验，不写文件
 *       --strict       把警告视为错误（平台侧入库闸门用）
 *       --inline-images 把相对路径图片转成 data URI（供离线 App 直接使用）
 *       --no-assets    不检查图片文件是否存在
 *       --allow-dup    重复题目只告警，不阻断
 *       --index <path> 与已入库资料查重（可重复；文件或目录），命中记为 E051
 *       --minify       输出紧凑 JSON
 *       --quiet        只输出错误与结果摘要
 *
 * 兼容性：
 *   - 接受 kshare/v1 与 kshare/v2；未声明版本按 v1 处理，其它主版本直接报 E003；
 *   - front matter 与题目内以 x- 开头的自定义字段会原样透传到 JSON（meta.ext / ext），
 *     不会触发「字段不使用」告警，方便未来扩展而不改模板。
 *
 * 解析策略：先按行做“定界正则”，再用状态机装配章节/题目/小问，
 * 最后做 schema 校验。纯正则一次性匹配整篇文档在多层结构下不可靠。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SCHEMA = 'kshare/v1';
const SUPPORTED_SCHEMAS = ['kshare/v1', 'kshare/v2'];
const MAX_REPORT = 200;

const TYPES = {
  单选: { key: 'single', options: true, name: '单选题' },
  多选: { key: 'multiple', options: true, name: '多选题' },
  判断: { key: 'judge', options: false, name: '判断题' },
  案例: { key: 'case', options: false, name: '案例题' },
  问答: { key: 'qa', options: false, name: '问答题' },
  论文: { key: 'essay', options: false, name: '论文题' }
};

const TYPE_NAME = {};
Object.keys(TYPES).forEach(k => { TYPE_NAME[TYPES[k].key] = TYPES[k].name; });

const FIELD_ALIAS = {
  题干: 'stem', 材料: 'material', 选项: 'options', 答案: 'answer', 参考答案: 'answer',
  解析: 'analysis', 难度: 'difficulty', 标签: 'tags', 关键词: 'tags', 来源: 'source',
  分值: 'score', 要求: 'requirements', 提纲: 'outline', 范文: 'essay', 备注: 'note',
  题目: 'title', 分类: 'category', 速记: 'ksum', 图解: 'figure'
};

const ALLOWED_FIELDS = {
  single: ['stem', 'options', 'answer', 'analysis', 'difficulty', 'tags', 'source', 'score', 'note'],
  multiple: ['stem', 'options', 'answer', 'analysis', 'difficulty', 'tags', 'source', 'score', 'note'],
  judge: ['stem', 'answer', 'analysis', 'difficulty', 'tags', 'source', 'score', 'note'],
  qa: ['stem', 'answer', 'analysis', 'difficulty', 'tags', 'source', 'score', 'note'],
  case: ['material', 'title', 'analysis', 'difficulty', 'tags', 'source', 'score', 'note', 'category', 'ksum', 'figure'],
  essay: ['title', 'requirements', 'outline', 'essay', 'analysis', 'difficulty', 'tags', 'source', 'note']
};

/* 案例精析的分类：中文／英文都收，统一成 App 的键 */
const CASE_CATEGORY = {
  预测: 'pred', 押题: 'pred', 考点预测: 'pred', '10月预测': 'pred',
  图解填空: 'fill', 填空: 'fill', 图解: 'fill',
  ai: 'ai', AI: 'ai', 人工智能: 'ai', 大模型: 'ai',
  iot: 'iot', IOT: 'iot', 物联网: 'iot', 边缘计算: 'iot'
};

const LABEL_RE = /^\s*(?:[-*+]\s+)?(参考答案|题干|材料|选项|答案|解析|难度|标签|关键词|来源|分值|要求|提纲|范文|备注|题目|分类|速记|图解|x-[A-Za-z0-9_-]+)\s*[：:]\s*(.*)$/;
const OPTION_RE = /^\s*(?:[-*+]\s+)([A-Ha-h])\s*[.、．)]\s*(.+)$/;
const HEAD_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const IMG_RE = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'
};
const BRANDS = ['51CTO', '希赛', '环球网校', '软考通', '学员回忆版', '内部资料', '扫码', '加群', '微信公众号'];
const DIFFICULTY = {
  易: '易', 简单: '易', 低: '易', 1: '易', 2: '易',
  中: '中', 中等: '中', 一般: '中', 3: '中',
  难: '难', 困难: '难', 高: '难', 4: '难', 5: '难'
};

/* ---------------- 命令行 ---------------- */
const opts = {
  input: '', out: '', check: false, strict: false, inline: false,
  noAssets: false, allowDup: false, minify: false, quiet: false, index: []
};

function usage(code) {
  const text = [
    'kshare 题库校验 / 入库',
    '',
    '  node tools/kshare.mjs <题库.md> [-o 输出.json] [--check] [--strict]',
    '                        [--inline-images] [--no-assets] [--allow-dup]',
    '                        [--index 已入库.json|目录] [--minify] [--quiet]',
    '',
    '  schema: ' + SUPPORTED_SCHEMAS.join(' / ')
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
    else if (a === '--check') opts.check = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--inline-images') opts.inline = true;
    else if (a === '--no-assets') opts.noAssets = true;
    else if (a === '--allow-dup') opts.allowDup = true;
    else if (a === '--index') opts.index.push(argv[++i] || '');
    else if (a === '--minify') opts.minify = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a.startsWith('-')) { process.stderr.write('未知参数：' + a + '\n'); usage(2); }
    else if (!opts.input) opts.input = a;
    else { process.stderr.write('多余参数：' + a + '\n'); usage(2); }
  }
  if (!opts.input) usage(2);
})();

/* ---------------- 基础工具 ---------------- */
const unquote = s => {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
};

function parseScalar(raw) {
  let v = String(raw).trim();
  if (!v) return '';
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(/[,，]/).map(x => unquote(x.trim())).filter(Boolean);
  }
  if (!/^["']/.test(v)) v = v.replace(/\s+#.*$/, '');
  return unquote(v);
}

/* 去掉 HTML 注释，保留行号 */
function stripComments(lines) {
  let inComment = false;
  return lines.map(line => {
    let out = line;
    if (inComment) {
      const end = out.indexOf('-->');
      if (end < 0) return '';
      out = ' '.repeat(end + 3) + out.slice(end + 3);
      inComment = false;
    }
    for (;;) {
      const s = out.indexOf('<!--');
      if (s < 0) break;
      const e = out.indexOf('-->', s + 4);
      if (e < 0) {
        out = out.slice(0, s);
        inComment = true;
        break;
      }
      out = out.slice(0, s) + ' '.repeat(e + 3 - s) + out.slice(e + 3);
    }
    return out;
  });
}

/* 去掉块级缩进并裁掉首尾空行 */
function block(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  const arr = lines.slice(a, b);
  let min = Infinity;
  for (const l of arr) {
    if (!l.trim()) continue;
    const n = l.match(/^[ \t]*/)[0].length;
    if (n < min) min = n;
  }
  if (!isFinite(min)) min = 0;
  return arr.map(l => l.slice(Math.min(min, l.length))).join('\n').trim();
}

/* 收集题目/小问里以 x- 开头的扩展字段 */
function collectExt(fields) {
  const ext = {};
  Object.keys(fields || {}).forEach(k => {
    if (/^x-/i.test(k)) ext[k.slice(2)] = block(fields[k].lines);
  });
  return Object.keys(ext).length ? ext : undefined;
}

function normSpace(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

function keyText(s) {
  return normSpace(s)
    .replace(/[（）()【】\[\]「」《》"'“”‘’，,。.、；;：:！!？?]/g, '')
    .toLowerCase();
}

/* 与 finishQuestion 里的去重键保持同一套口径，用于跨库查重 */
function bankQuestionKey(q) {
  return [
    q.type,
    keyText(q.stem || q.title || q.material),
    (q.options || []).map(keyText).join('|'),
    Array.isArray(q.answer) ? q.answer.join('') : keyText(q.answer),
    keyText(q.material),
    (q.subQuestions || []).map(s => keyText(s.stem)).join('|')
  ].join('###');
}

/* 读取已入库资料（.json 或目录）建立查重索引：key -> { lib, id } */
let INDEX = null;
function getIndex() {
  if (INDEX) return INDEX;
  INDEX = new Map();
  const files = [];
  opts.index.filter(Boolean).forEach(p => {
    if (!fs.existsSync(p)) {
      process.stderr.write('[WARN] --index 路径不存在，已忽略：' + p + '\n');
      return;
    }
    if (fs.statSync(p).isDirectory()) {
      fs.readdirSync(p)
        .filter(f => /\.json$/i.test(f))
        .forEach(f => files.push(path.join(p, f)));
    } else {
      files.push(p);
    }
  });
  files.forEach(f => {
    let bank;
    try { bank = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return; }
    if (!bank || !Array.isArray(bank.chapters)) return;
    const lib = (bank.meta && (bank.meta.slug || bank.meta.title)) || path.basename(f);
    bank.chapters.forEach(ch => (ch.sections || []).forEach(sec => (sec.questions || []).forEach(q => {
      const k = bankQuestionKey(q);
      if (!INDEX.has(k)) INDEX.set(k, { lib, id: q.id || '' });
    })));
  });
  return INDEX;
}

function parseTags(raw) {
  if (!raw) return [];
  return String(raw)
    .replace(/^\[|\]$/g, '')
    .split(/[,，、\s]+/)
    .map(t => t.replace(/^#/, '').trim())
    .filter(Boolean);
}

/* 逗号 / 顿号 / 分号 / 竖线 / 换行 分隔的多值字段 */
function splitList(raw) {
  return String(raw == null ? '' : raw)
    .split(/[,，、;；|\n]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function parseScore(raw) {
  if (!raw) return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  return isFinite(n) && n > 0 ? n : NaN;
}

function parseChoiceAnswer(raw) {
  const letters = String(raw || '').toUpperCase().replace(/[^A-H]/g, '').split('');
  return Array.from(new Set(letters)).sort();
}

function parseJudge(raw) {
  const t = String(raw || '').trim().replace(/[\s。.]/g, '').toUpperCase();
  if (['正确', '对', '是', '√', 'TRUE', 'T', 'YES', 'Y'].includes(t)) return '正确';
  if (['错误', '错', '否', '×', 'X', 'FALSE', 'F', 'NO', 'N'].includes(t)) return '错误';
  return '';
}

function normalizeCategory(raw) {
  const t = String(raw || '').trim();
  if (!t) return { key: '', label: '' };
  const key = CASE_CATEGORY[t] || CASE_CATEGORY[t.replace(/[\s_]+/g, '')] || CASE_CATEGORY[t.toLowerCase()] || '';
  return { key, label: key ? '' : t };
}

function parseQuestionHeading(text) {
  const m = text.match(/^(单选|多选|判断|案例|问答|论文)\s*(.*)$/);
  if (!m) return null;
  let rest = m[2].trim();
  let title = rest;
  const num = title.match(/^(?:第\s*)?\d+\s*(?:题)?\s*[｜|·:：\-—]\s*/);
  if (num) title = title.slice(num[0].length);
  else if (/^(?:第\s*)?\d+\s*(?:题)?$/.test(title)) title = '';
  return { type: m[1], title: title.trim() };
}

function parseSubHeading(text) {
  return text
    .replace(/^(?:小问|子问|问题)\s*\d*\s*[｜|·:：\-—]?\s*/, '')
    .trim();
}

/* ---------------- 知识图谱区块 ---------------- */
const KG_TITLE_RE = /^(知识图谱|知识图谱（可选）|学习资料[·・\/\-]?知识图谱)$/;
const KG_PLATE_RE = /^板块\s*[｜|:：]?\s*(.*)$/;
const KG_FIELD_RE = /^\s*(?:[-*+]\s+)?(导语|知识点|高频考点|图解|图解说明|颜色|标识|关联章节|x-[A-Za-z0-9_-]+)\s*[：:]\s*(.*)$/;
const KG_PALETTE = [
  '#4263eb', '#0ca678', '#e8590c', '#9c36b5', '#1098ad', '#d6336c',
  '#f08c00', '#5c940d', '#343a40', '#1c7ed6', '#7048e8', '#0b7285', '#c2255c'
];

/**
 * 抽出「## 知识图谱」区块并把它从行数组里清空，避免干扰题目状态机。
 * 结构：
 *   ## 知识图谱
 *   ### 板块｜名称
 *   - 导语：...
 *   - 知识点：        ← 换行后每行一条 "- xxx"
 *   - 高频考点：
 *   - 图解：images/x.svg
 *   - 图解说明：...
 *   - 颜色：#4263eb
 *   - 标识：os
 */
function extractKnowledge(lines, err, warn) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEAD_RE);
    if (m && m[1].length === 2 && KG_TITLE_RE.test(m[2].trim())) { start = i; break; }
  }
  if (start < 0) return null;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(HEAD_RE);
    if (m && m[1].length <= 2) { end = i; break; }
  }

  const plates = [];
  let cur = null;
  let field = null;
  const seenIds = new Set();

  const setScalar = (name, text) => {
    if (!cur) return;
    if (name === '导语') cur.lead = text;
    else if (name === '图解') cur.diagram = text.split('\n').map(x => x.trim()).filter(Boolean)[0] || '';
    else if (name === '图解说明') cur.diagramNote = text;
    else if (name === '颜色') cur.color = text.trim();
    else if (name === '关联章节') cur.chapters = splitList(text);
    else if (/^x-/i.test(name)) cur.ext[name.slice(2)] = text;
    else if (name === '标识') cur.id = text.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  };

  const pushItem = (name, text) => {
    if (!cur) return;
    if (name === '知识点') cur.points.push(text);
    else cur.exam.push(text);
  };

  const flush = () => {
    if (!cur) return;
    const ref = '知识图谱板块「' + (cur.name || '未命名') + '」';
    if (!cur.name) err(cur.line, 'E060', '知识图谱板块缺少名称，请写成「### 板块｜名称」');
    if (!cur.lead) warn(cur.line, 'W015', ref + '：没有「导语」，建议一句话说明本板块考什么');
    if (!cur.points.length) warn(cur.line, 'W016', ref + '：没有「知识点」');
    if (cur.color && !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(cur.color)) {
      warn(cur.line, 'W019', ref + '：颜色 ' + cur.color + ' 不是 #RGB / #RRGGBB，已改用默认色');
      cur.color = '';
    }
    let id = cur.id || 'p' + plates.length;
    while (seenIds.has(id)) id += '-' + plates.length;
    seenIds.add(id);
    const plate = {
      _line: cur.line,
      id,
      name: cur.name,
      color: cur.color || KG_PALETTE[plates.length % KG_PALETTE.length],
      lead: cur.lead,
      points: cur.points,
      exam: cur.exam,
      diagram: cur.diagram,
      diagramNote: cur.diagramNote
    };
    if (cur.chapters.length) plate.chapters = cur.chapters;
    if (Object.keys(cur.ext).length) plate.ext = cur.ext;
    plates.push(plate);
    cur = null;
    field = null;
  };

  for (let i = start + 1; i < end; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const hm = line.match(HEAD_RE);

    if (hm) {
      if (hm[1].length === 3) {
        flush();
        const text = hm[2].trim();
        const m = text.match(KG_PLATE_RE);
        cur = {
          line: lineNo,
          name: (m ? m[1] : text).trim(),
          id: '', color: '', lead: '', points: [], exam: [], diagram: '', diagramNote: '',
          chapters: [], ext: {}
        };
        field = null;
        continue;
      }
      warn(lineNo, 'W017', '知识图谱块内只支持「### 板块｜名称」，本行已忽略');
      continue;
    }

    if (!cur) {
      if (line.trim()) warn(lineNo, 'W018', '知识图谱块内「### 板块」之前的文本已忽略');
      continue;
    }

    const lm = line.match(KG_FIELD_RE);
    if (lm) {
      const name = lm[1];
      const value = lm[2].trim();
      const isList = name === '知识点' || name === '高频考点';
      field = { name, buf: [], list: isList };
      if (value) {
        if (isList) pushItem(name, value);
        else setScalar(name, value);
      }
      continue;
    }

    if (!line.trim()) continue;

    if (field && field.list) {
      const li = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
      const text = (li ? li[1] : line).trim();
      if (text) pushItem(field.name, text);
      continue;
    }
    if (field) {
      field.buf.push(line.trim());
      setScalar(field.name, field.buf.join('\n'));
      continue;
    }
    warn(lineNo, 'W018', '知识图谱块内无法识别的文本已忽略：' + line.trim().slice(0, 24));
  }
  flush();

  for (let i = start; i < end; i++) lines[i] = '';

  return { plates };
}

/* ---------------- 解析 ---------------- */
function parse(rawText, file) {
  const errors = [];
  const warnings = [];
  const dir = path.dirname(path.resolve(file));
  const assets = new Map();
  const dupMap = new Map();
  const lines = stripComments(rawText.replace(/^\uFEFF/, '').split(/\r?\n/));

  const err = (line, code, msg) => errors.push({ line, code, msg });
  const warn = (line, code, msg) => warnings.push({ line, code, msg });

  /* 元数据（允许文件开头有注释与空行） */
  let lead = 0;
  while (lead < lines.length && !lines[lead].trim()) lead++;
  if (lead >= lines.length || lines[lead].trim() !== '---') {
    err(lead + 1, 'E001', '文件开头必须是以 --- 包裹的元数据块（front matter）');
    return { errors, warnings, bank: null };
  }
  let end = -1;
  for (let i = lead + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end < 0) {
    err(lead + 1, 'E001', '元数据块缺少结束的 ---');
    return { errors, warnings, bank: null };
  }

  const meta = {};
  for (let i = lead + 1; i < end; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([a-zA-Z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) { err(i + 1, 'E001', '元数据行应写成 key: value'); continue; }
    meta[m[1]] = parseScalar(m[2]);
  }

  const REQUIRED = [
    ['schema', '协议版本'], ['slug', '库标识'], ['title', '标题'], ['subject', '科目'],
    ['category', '分类'], ['rights', '版权状态'], ['license', '授权协议'],
    ['version', '版本号'], ['updated', '更新日期']
  ];
  for (const [k, label] of REQUIRED) {
    if (!String(meta[k] == null ? '' : meta[k]).trim()) err(1, 'E002', '元数据缺少「' + k + '」（' + label + '）');
  }
  if (meta.schema && SUPPORTED_SCHEMAS.indexOf(String(meta.schema).trim()) < 0) {
    err(1, 'E003', 'schema 只支持 ' + SUPPORTED_SCHEMAS.join(' / ') + '，当前为 ' + meta.schema);
  }
  if (meta.slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.slug)) {
    err(1, 'E003', 'slug 只能使用小写字母、数字与中划线，例如 sa-architect-2024');
  }
  if (meta.rights && !['original', 'authorized', 'public'].includes(meta.rights)) {
    err(1, 'E003', 'rights 只能是 original / authorized / public');
  }
  const LICENSE_RE = /^(CC0-1\.0|CC-BY(-(SA|NC|NC-SA))?-4\.0|All-Rights-Reserved)$/;
  if (meta.license && !LICENSE_RE.test(meta.license)) {
    err(1, 'E003', 'license 不在允许列表：CC0-1.0 / CC-BY-4.0 / CC-BY-SA-4.0 / CC-BY-NC-4.0 / CC-BY-NC-SA-4.0 / All-Rights-Reserved');
  }
  if (meta.version && !/^\d+\.\d+\.\d+$/.test(meta.version)) err(1, 'E003', 'version 需为 x.y.z');
  if (meta.updated && !/^\d{4}-\d{2}-\d{2}$/.test(meta.updated)) err(1, 'E003', 'updated 需为 YYYY-MM-DD');
  if (meta.year && !/^\d{4}$/.test(String(meta.year))) err(1, 'E003', 'year 需为四位年份');
  if (meta.tags != null && !Array.isArray(meta.tags)) meta.tags = parseTags(meta.tags);
  if (!meta.language) meta.language = 'zh-CN';

  /* 扩展字段：front matter 里以 x- 开头的键原样透传，便于未来加字段而不改模板 */
  const metaExt = {};
  Object.keys(meta).forEach(k => {
    if (!/^x-/i.test(k)) return;
    metaExt[k.slice(2)] = meta[k];
    delete meta[k];
  });

  /* 「## 知识图谱」是可选区块，先抽走再从题目状态机里剔除 */
  const knowledge = extractKnowledge(lines, err, warn);

  /* 结构解析 */
  const chapters = [];
  let chapter = null, section = null, q = null, sub = null;
  let field = null, optMode = false, orphan = false;

  const qLabel = item => {
    if (!item) return '题目';
    const text = item.title || normSpace(item.stem || item.material);
    const brief = text ? '「' + text.slice(0, 16) + (text.length > 16 ? '…' : '') + '」' : '';
    return item.cnType + brief;
  };

  function finishSub(s) {
    const get = n => (s._f[n] ? block(s._f[n].lines) : '');
    const out = {
      _line: s.line,
      heading: s.heading,
      stem: get('stem') || s.heading,
      answer: get('answer'),
      analysis: get('analysis'),
      tags: parseTags(get('tags')),
      scoreRaw: get('score')
    };
    const ext = collectExt(s._f);
    if (ext) out.ext = ext;
    return out;
  }

  function finishQuestion() {
    if (!q) { field = null; sub = null; optMode = false; return; }
    const def = TYPES[q.type];
    const cur = q;
    const get = n => (cur._f[n] ? block(cur._f[n].lines) : '');

    const options = cur._opts.map(o => block(o.lines));
    const item = {
      type: def.key,
      cnType: q.type,
      label: q.heading,
      line: q.line,
      title: (def.key === 'case' || def.key === 'essay') ? (get('title') || q.title || '') : (q.title || ''),
      stem: get('stem'),
      material: get('material'),
      options,
      answerRaw: get('answer'),
      analysis: get('analysis'),
      difficulty: get('difficulty'),
      tagsRaw: get('tags'),
      source: get('source'),
      scoreRaw: get('score'),
      requirements: get('requirements'),
      outline: get('outline'),
      essay: get('essay'),
      note: get('note'),
      categoryRaw: get('category'),
      ksum: get('ksum'),
      figure: get('figure'),
      subs: q._subs.map(finishSub)
    };

    const ref = qLabel(item);

    /* ---- 通用必填 ---- */
    if (def.key === 'case') {
      if (!item.material) err(item.line, 'E020', ref + '：缺少「材料」');
      if (!item.subs.length) err(item.line, 'E020', ref + '：缺少小问，请用 ##### 小问 1 起头');
      if (item.answerRaw) warn(item.line, 'W005', ref + '：案例题顶层「答案」不会入库，请写在各小问里');
    } else if (def.key === 'essay') {
      if (!item.title) err(item.line, 'E020', ref + '：缺少论文题目（标题或「- 题目：」）');
      if (!item.requirements) err(item.line, 'E020', ref + '：缺少「要求」');
      if (!item.outline && !item.essay) err(item.line, 'E020', ref + '：论文题至少需要「提纲」或「范文」之一');
    } else if (!item.stem) {
      err(item.line, 'E020', ref + '：缺少「题干」');
    }

    /* ---- 题型专属 ---- */
    let answer = null;
    if (def.options) {
      if (item.options.length < 2) err(item.line, 'E021', ref + '：至少需要 2 个选项');
      if (item.options.length > 8) err(item.line, 'E021', ref + '：选项最多 8 个（A–H）');
      item.options.forEach((t, i) => {
        if (!t) err(item.line, 'E021', ref + '：选项 ' + (LETTERS[i] || i + 1) + ' 内容为空');
      });
      if (item.options.length && item.options.length !== 4) {
        warn(item.line, 'W002', ref + '：选项数为 ' + item.options.length + '，常见为 4 个');
      }
      const letters = parseChoiceAnswer(item.answerRaw);
      if (!letters.length) {
        err(item.line, 'E030', ref + '：缺少「答案」');
      } else {
        if (def.key === 'single' && letters.length !== 1) {
          err(item.line, 'E030', ref + '：单选题答案必须且只能是一个字母');
        }
        if (def.key === 'multiple' && letters.length < 2) {
          err(item.line, 'E030', ref + '：多选题答案至少两个字母');
        }
        letters.forEach(l => {
          if (LETTERS.indexOf(l) >= item.options.length) {
            err(item.line, 'E030', ref + '：答案 ' + l + ' 超出选项范围');
          }
        });
        answer = letters;
      }
    } else if (def.key === 'judge') {
      const judge = parseJudge(item.answerRaw);
      answer = judge ? [judge] : null;
      if (!judge) err(item.line, 'E031', ref + '：判断题答案应为「正确」或「错误」');
      if (item.options.length) warn(item.line, 'W012', ref + '：判断题不需要「选项」');
    } else if (def.key === 'qa') {
      if (!item.answerRaw) err(item.line, 'E030', ref + '：缺少「参考答案」');
      answer = item.answerRaw || '';
    }

    /* ---- 难度 / 分值 / 标签 ---- */
    let difficulty = '';
    if (item.difficulty) {
      difficulty = DIFFICULTY[item.difficulty] || '';
      if (!difficulty) err(item.line, 'E022', ref + '：难度只能是 易 / 中 / 难');
    }
    let score = null;
    if (item.scoreRaw) {
      score = parseScore(item.scoreRaw);
      if (Number.isNaN(score)) err(item.line, 'E022', ref + '：分值需为正数');
    }

    /* ---- 小问 ---- */
    const subQuestions = [];
    if (def.key === 'case') {
      item.subs.forEach((s, idx) => {
        const sref = ref + ' 小问 ' + (idx + 1);
        if (!s.stem) err(s._line, 'E020', sref + '：缺少题干');
        if (!s.answer) err(s._line, 'E030', sref + '：缺少「参考答案」');
        let sScore = null;
        if (s.scoreRaw) {
          sScore = parseScore(s.scoreRaw);
          if (Number.isNaN(sScore)) err(s._line, 'E022', sref + '：分值需为正数');
        }
        subQuestions.push({
          id: '',
          stem: s.stem,
          answer: s.answer,
          analysis: s.analysis,
          score: sScore,
          tags: s.tags,
          ...(s.ext ? { ext: s.ext } : {})
        });
      });
    }

    /* ---- 组装 ---- */
    const caseCat = def.key === 'case' ? normalizeCategory(item.categoryRaw) : { key: '', label: '' };
    const out = {
      _line: item.line,
      id: '',
      type: def.key,
      title: item.title,
      stem: item.stem,
      material: item.material,
      options: item.options.length ? item.options : undefined,
      answer,
      analysis: item.analysis,
      difficulty,
      tags: parseTags(item.tagsRaw),
      source: item.source,
      score,
      requirements: def.key === 'essay' ? item.requirements : undefined,
      outline: def.key === 'essay' ? item.outline : undefined,
      essay: def.key === 'essay' ? item.essay : undefined,
      subQuestions: def.key === 'case' ? subQuestions : undefined,
      note: item.note,
      category: def.key === 'case' ? caseCat.key : undefined,
      categoryLabel: def.key === 'case' ? caseCat.label : undefined,
      quickNote: def.key === 'case' ? item.ksum : undefined,
      figure: def.key === 'case' ? item.figure : undefined
    };
    const qExt = collectExt(cur._f);
    if (qExt) out.ext = qExt;

    if (!item.analysis && ['single', 'multiple', 'judge'].includes(def.key)) {
      warn(item.line, 'W001', ref + '：没有「解析」，建议补充');
    }
    if (def.key === 'case' && subQuestions.length && !subQuestions.some(s => s.answer)) {
      err(item.line, 'E030', ref + '：所有小问都缺少参考答案');
    }

    /* ---- 品牌 / 来源标记扫描 ---- */
    const scan = [out.stem, out.material, out.analysis, out.title, out.essay, out.outline, out.requirements,
      (out.options || []).join(' '), ...subQuestions.map(s => s.stem + ' ' + s.answer + ' ' + s.analysis)]
      .filter(Boolean).join(' ');
    const hit = BRANDS.filter(b => scan.includes(b));
    if (hit.length) warn(item.line, 'W003', ref + '：包含来源/推广标记「' + hit.join('、') + '」，入库前请清理');

    /* ---- 去重 + ID ---- */
    const key = [
      def.key,
      keyText(out.stem || out.title || out.material),
      (out.options || []).map(keyText).join('|'),
      Array.isArray(out.answer) ? out.answer.join('') : keyText(out.answer),
      keyText(out.material),
      subQuestions.map(s => keyText(s.stem)).join('|')
    ].join('###');

    if (dupMap.has(key)) {
      const first = dupMap.get(key);
      const msg = ref + '：与第 ' + first.line + ' 行的题目完全重复';
      if (opts.allowDup) warn(item.line, 'W007', msg);
      else err(item.line, 'E050', msg);
    } else {
      dupMap.set(key, { line: item.line });
    }

    /* 跨库查重：与 --index 指定的已入库资料比对 */
    if (opts.index.length) {
      const known = getIndex().get(key);
      if (known) {
        const msg = ref + '：与已入库资料「' + known.lib + '」中的题目重复' +
          (known.id ? '（' + known.id + '）' : '');
        if (opts.allowDup) warn(item.line, 'W008', msg);
        else err(item.line, 'E051', msg);
      }
    }

    out.id = 'q_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
    subQuestions.forEach((s, i) => {
      s.id = out.id + '_' + (i + 1);
    });

    section.questions.push(out);
    q = null; sub = null; field = null; optMode = false;
  }

  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const hm = line.match(HEAD_RE);

    if (hm) {
      const level = hm[1].length;
      const text = hm[2].trim();

      if (level === 1) {
        if (!meta.title) meta.title = text;
        continue;
      }
      if (level === 2) {
        finishQuestion();
        chapter = { name: text, line: lineNo, sections: [] };
        chapters.push(chapter);
        section = null;
        orphan = false;
        continue;
      }
      if (level === 3) {
        finishQuestion();
        if (!chapter) { err(lineNo, 'E010', '「### 节」必须放在「## 章」之下'); orphan = true; continue; }
        section = { name: text, line: lineNo, questions: [] };
        chapter.sections.push(section);
        orphan = false;
        continue;
      }
      if (level === 4) {
        finishQuestion();
        if (!chapter || !section) {
          err(lineNo, 'E010', '「#### 题目」必须放在「### 节」之下');
          orphan = true;
          continue;
        }
        const info = parseQuestionHeading(text);
        if (!info) {
          err(lineNo, 'E011', '题目标题必须以题型开头：单选 / 多选 / 判断 / 案例 / 问答 / 论文');
          orphan = true;
          continue;
        }
        q = { type: info.type, title: info.title, heading: text, line: lineNo, _f: {}, _opts: [], _subs: [] };
        sub = null;
        field = null;
        optMode = false;
        orphan = false;
        continue;
      }
      if (level === 5) {
        if (!q || q.type !== '案例') {
          err(lineNo, 'E010', '「##### 小问」只能出现在案例题中');
          continue;
        }
        sub = { heading: parseSubHeading(text), line: lineNo, _f: {} };
        q._subs.push(sub);
        field = null;
        optMode = false;
        continue;
      }
      warn(lineNo, 'W030', '六级及以下标题会被当作普通文本忽略');
      continue;
    }

    if (orphan) continue;

    if (!q) {
      if (line.trim()) warn(lineNo, 'W020', '题目块之外的文本已忽略');
      continue;
    }

    const lm = line.match(LABEL_RE);
    if (lm) {
      const label = lm[1];
      const value = lm[2].trim();
      const name = FIELD_ALIAS[label] || label;
      const target = sub || q;
      optMode = name === 'options';

      if (name === 'title') {
        if (!sub) {
          if (value) {
            q.title = value;
            field = null;
          } else {
            q._f.title = { line: lineNo, lines: [] };
            field = q._f.title;
          }
        } else {
          warn(lineNo, 'W012', '小问内不使用「题目」字段，已忽略');
          field = null;
        }
        continue;
      }
      const allowed = sub
        ? ['stem', 'answer', 'analysis', 'score', 'tags']
        : (ALLOWED_FIELDS[TYPES[q.type].key] || []);
      if (!/^x-/i.test(name) && allowed.indexOf(name) < 0 && !(q.type === '案例' && name === 'answer')) {
        warn(lineNo, 'W012', (sub ? '小问' : TYPES[q.type].name) + '不使用「' + label + '」字段');
      }
      if (name === 'options') {
        if (value) warn(lineNo, 'W013', '「选项」请另起一行书写，每行一个 "- A. 内容"');
        field = null;
        continue;
      }
      target._f[name] = { line: lineNo, lines: value ? [value] : [] };
      field = target._f[name];
      continue;
    }

    const om = line.match(OPTION_RE);
    if (om && optMode && q && TYPES[q.type].options) {
      q._opts.push({ line: lineNo, lines: [om[2]] });
      field = null;
      continue;
    }

    if (!line.trim()) {
      if (field) field.lines.push('');
      continue;
    }

    if (field) {
      field.lines.push(line);
      continue;
    }

    if (optMode && q._opts.length) {
      q._opts[q._opts.length - 1].lines.push(line);
      continue;
    }

    /* 未加字段标签的自由文本：按题型推断 */
    const implicit = q.type === '案例' ? 'material' : 'stem';
    if (!q._f[implicit]) {
      warn(lineNo, 'W011', '题目内容未使用「- 字段：」标注，已按「' + (implicit === 'material' ? '材料' : '题干') + '」处理');
      q._f[implicit] = { line: lineNo, lines: [line] };
      field = q._f[implicit];
    } else {
      field = q._f[implicit];
      field.lines.push(line);
    }
  }

  finishQuestion();

  /* 空章 / 空节 */
  chapters.forEach(ch => {
    if (!ch.sections.length) {
      warn(ch.line, 'W004', '章「' + ch.name + '」下没有小节，已丢弃');
    }
    ch.sections = ch.sections.filter(sec => {
      if (!sec.questions.length) {
        warn(sec.line, 'W004', '节「' + sec.name + '」下没有题目，已丢弃');
        return false;
      }
      return true;
    });
  });
  const keptChapters = chapters.filter(ch => ch.sections.length);
  if (!keptChapters.length && !(knowledge && knowledge.plates.length)) {
    err(1, 'E010', '没有解析到任何题目，请检查 ## 章 / ### 节 / #### 题目 结构');
  }

  /* 图片 */
  const qLineOf = ref => (ref && ref.line) || 1;
  const qRefOf = ref => (ref && ref.label) || '题目';

  /* 校验图片是否存在，可选转成 data URI；返回应写入结果的字符串 */
  const resolveAsset = (src, ref) => {
    if (/^(https?:|data:|\/\/)/i.test(src)) {
      if (/^https?:/i.test(src)) err(qLineOf(ref), 'E040', qRefOf(ref) + '：图片不允许使用外链 ' + src);
      return src;
    }
    if (opts.noAssets) return src;
    const clean = decodeURIComponent(src.split('?')[0]);
    const abs = path.resolve(dir, clean);
    if (!fs.existsSync(abs)) {
      err(qLineOf(ref), 'E040', qRefOf(ref) + '：图片文件不存在 ' + src);
      return src;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length > 300 * 1024) {
      warn(qLineOf(ref), 'W006', qRefOf(ref) + '：图片 ' + src + ' 超过 300KB，建议压缩');
    }
    const rel = path.relative(dir, abs).split(path.sep).join('/');
    if (!assets.has(rel)) {
      assets.set(rel, {
        path: rel,
        bytes: buf.length,
        sha1: crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16),
        mime: MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream'
      });
    }
    if (!opts.inline) return src;
    const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  };

  const scanImages = (obj, ref) => {
    const visit = v => {
      if (typeof v === 'string') return visitText(v, ref);
      if (Array.isArray(v)) return v.map(visit);
      if (v && typeof v === 'object') {
        Object.keys(v).forEach(k => { v[k] = visit(v[k]); });
      }
      return v;
    };
    const visitText = (text, ref2) => text.replace(IMG_RE, (m, src) => {
      const out = resolveAsset(src, ref2);
      return out === src ? m : m.replace(src, () => out);
    });
    visit(obj);
  };

  keptChapters.forEach(ch => ch.sections.forEach(sec => sec.questions.forEach(question => {
    const label = (TYPE_NAME[question.type] || question.type) + '「' +
      normSpace(question.stem || question.title || question.material).slice(0, 18) + '」';
    const ref = { line: question._line || 1, label };
    scanImages(question, ref);
    /* 案例精析的「图解」：允许裸路径或 ![](path) 两种写法 */
    if (question.figure) {
      const raw = String(question.figure).trim();
      const fm = raw.match(/!\[[^\]]*\]\(\s*([^)\s]+)/);
      const src = fm ? fm[1] : raw;
      const out = resolveAsset(src, ref);
      question.figure = out === src ? src : out;
    }
    delete question._line;
  })));

  /* 知识图谱图解 */
  if (knowledge) {
    knowledge.plates.forEach(p => {
      if (p.diagram) {
        p.diagram = resolveAsset(p.diagram.trim(), { line: p._line || 1, label: '知识图谱「' + p.name + '」' });
      }
      delete p._line;
    });
  }

  /* 汇总 */
  const byType = { single: 0, multiple: 0, judge: 0, case: 0, qa: 0, essay: 0 };
  let count = 0;
  keptChapters.forEach(ch => ch.sections.forEach(sec => sec.questions.forEach(question => {
    byType[question.type]++;
    count++;
  })));

  const bank = {
    schema: meta.schema === 'kshare/v2' ? 'kshare/v2' : SCHEMA,
    meta: {
      slug: meta.slug || '',
      title: meta.title || '',
      subject: meta.subject || '',
      category: meta.category || '',
      exam: meta.exam || '',
      year: meta.year ? Number(meta.year) : null,
      author: meta.author || '',
      rights: meta.rights || '',
      license: meta.license || '',
      version: meta.version || '',
      updated: meta.updated || '',
      language: meta.language,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      description: meta.description || '',
      ...(Object.keys(metaExt).length ? { ext: metaExt } : {}),
      sourceFile: path.basename(file),
      builtAt: new Date().toISOString(),
      counts: {
        chapters: keptChapters.length,
        sections: keptChapters.reduce((n, ch) => n + ch.sections.length, 0),
        questions: count,
        byType,
        knowledge: knowledge ? {
          plates: knowledge.plates.length,
          points: knowledge.plates.reduce((n, p) => n + p.points.length, 0),
          exam: knowledge.plates.reduce((n, p) => n + p.exam.length, 0),
          diagrams: knowledge.plates.filter(p => p.diagram).length
        } : null
      },
      assets: Array.from(assets.values())
    },
    chapters: keptChapters.map(ch => ({
      name: ch.name,
      sections: ch.sections.map(sec => ({
        name: sec.name,
        questions: sec.questions
      }))
    })),
    knowledge: knowledge ? { plates: knowledge.plates } : null
  };

  if (opts.strict) {
    warnings.forEach(w => errors.push({ line: w.line, code: w.code, msg: w.msg + '（--strict 视为错误）' }));
  }

  return { errors, warnings, bank };
}

/* ---------------- 主流程 ---------------- */
function main() {
  const file = opts.input;
  if (!fs.existsSync(file)) {
    process.stderr.write('找不到文件：' + file + '\n');
    process.exit(2);
  }
  const raw = fs.readFileSync(file, 'utf8');
  let result;
  try {
    result = parse(raw, file);
  } catch (e) {
    process.stderr.write('解析器内部错误：' + (e && e.stack ? e.stack : e) + '\n');
    process.exit(2);
  }

  const { errors, warnings, bank } = result;
  errors.sort((a, b) => a.line - b.line);
  warnings.sort((a, b) => a.line - b.line);

  const show = list => list.slice(0, MAX_REPORT).forEach(x => {
    const tag = x.code.startsWith('W') ? 'WARN ' : 'ERROR';
    process.stderr.write('[' + tag + '] L' + x.line + ' ' + x.code + ' ' + x.msg + '\n');
  });
  show(errors);
  if (errors.length > MAX_REPORT) process.stderr.write('……另有 ' + (errors.length - MAX_REPORT) + ' 条错误未显示\n');
  show(warnings);
  if (warnings.length > MAX_REPORT) process.stderr.write('……另有 ' + (warnings.length - MAX_REPORT) + ' 条警告未显示\n');

  if (errors.length) {
    process.stderr.write('\n校验失败：' + errors.length + ' 个错误，' + warnings.length + ' 个警告，未生成入库文件。\n');
    process.exit(1);
  }

  if (opts.check) {
    process.stdout.write('校验通过：' + path.basename(file) + '（未写出文件）\n');
    return;
  }

  const outPath = opts.out || path.join(path.dirname(path.resolve(file)), path.basename(file, path.extname(file)) + '.json');
  const text = JSON.stringify(bank, null, opts.minify ? 0 : 2) + '\n';
  fs.writeFileSync(outPath, text);

  if (!opts.quiet) {
    const c = bank.meta.counts;
    const by = c.byType;
    const kg = c.knowledge;
    process.stdout.write(
      '校验通过：' + path.basename(file) + '\n' +
      '  章节：' + c.chapters + ' 章 / ' + c.sections + ' 节\n' +
      '  题量：' + c.questions + ' 题（单选 ' + by.single + '、多选 ' + by.multiple + '、判断 ' + by.judge +
      '、案例 ' + by.case + '、问答 ' + by.qa + '、论文 ' + by.essay + '）\n' +
      (kg ? '  知识图谱：' + kg.plates + ' 板块 / ' + kg.points + ' 知识点 / ' + kg.exam + ' 考点 / ' + kg.diagrams + ' 图解\n' : '') +
      '  图片：' + bank.meta.assets.length + ' 个' + (opts.inline ? '（已内联为 data URI）' : '（保留相对路径）') + '\n' +
      '  警告：' + warnings.length + ' 条\n' +
      '  输出：' + outPath + '（' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB）\n'
    );
  }
}

main();
