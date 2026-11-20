#!/usr/bin/env node
/**
 * kshare md/json → AimCram data.js 转换器
 *
 * 用法：
 *   node tools/to-datajs.mjs <题库.md|题库.json> [-o data.js]
 *        [--no-inline] [--allow-missing] [--pretty] [--strict]
 *
 * 说明：
 *   - 传入 .md 时先调用 kshare.mjs 做校验，校验失败直接退出；
 *   - 转换单选、多选、判断题（多选答案按字母连写成 "ABD"，判断题转成 A=正确 / B=错误），其余题型统计后跳过；
 *   - Markdown 会转成 App 需要的 HTML，图片默认内联为 data URI，保证离线可用；
 *   - 题目 id 由内容哈希派生成 9 位数字，稳定且满足 App 的数值 id 假设。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp'
};
const LETTERS = ['A', 'B', 'C', 'D'];
const TYPE_LABEL = {
  single: '单选', multiple: '多选', judge: '判断',
  case: '案例', qa: '问答', essay: '论文'
};

const opts = {
  input: '', out: '', inline: true, allowMissing: false,
  pretty: false, strict: false
};

function usage(code) {
  const text = [
    'kshare → data.js 转换器',
    '',
    '  node tools/to-datajs.mjs <题库.md|题库.json> [-o data.js]',
    '       [--no-inline] [--allow-missing] [--pretty] [--strict]',
    '',
    '  -o, --out <file>   输出路径，默认 <输入名>.data.js',
    '      --no-inline    图片保留 md 中的相对路径（需自行拷进 App）',
    '      --allow-missing 图片缺失时保留原路径并警告，不中断',
    '      --pretty       输出带缩进的 JSON',
    '      --strict       校验阶段把警告也视为失败（仅 md 输入）'
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
    else if (a === '--no-inline') opts.inline = false;
    else if (a === '--allow-missing') opts.allowMissing = true;
    else if (a === '--pretty') opts.pretty = true;
    else if (a === '--strict') opts.strict = true;
    else if (a.startsWith('-')) { process.stderr.write('未知参数：' + a + '\n'); usage(2); }
    else if (!opts.input) opts.input = a;
    else { process.stderr.write('多余参数：' + a + '\n'); usage(2); }
  }
  if (!opts.input) usage(2);
})();

/* ---------------- 载入题库：md 走校验，json 直接读 ---------------- */
function loadBank(file) {
  if (path.extname(file).toLowerCase() === '.json') {
    const bank = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!bank || bank.schema !== 'kshare/v1' || !Array.isArray(bank.chapters)) {
      throw new Error('不是 kshare/v1 的入库 JSON：' + file);
    }
    return { bank, dir: path.dirname(path.resolve(file)), temp: null };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kshare-'));
  const tmpJson = path.join(tmpDir, 'bank.json');
  const args = [path.join(path.dirname(fileURLToPath(import.meta.url)), 'kshare.mjs'), file, '--out', tmpJson, '--quiet'];
  if (opts.strict) args.push('--strict');
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (run.stderr) process.stderr.write(run.stderr);
  if (run.status !== 0) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    throw new Error('校验未通过，已停止转换（退出码 ' + run.status + '）');
  }
  const bank = JSON.parse(fs.readFileSync(tmpJson, 'utf8'));
  return { bank, dir: path.dirname(path.resolve(file)), temp: tmpDir };
}

/* ---------------- Markdown → HTML（够用即可，不引三方库） ---------------- */
const escText = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = s => escText(s).replace(/"/g, '&quot;');

function inline(text, ctx) {
  const slots = [];
  const stash = html => {
    slots.push(html);
    return '\u0000' + (slots.length - 1) + '\u0000';
  };

  let s = String(text == null ? '' : text);

  /* 图片先抽出来，避免后续转义破坏标签 */
  s = s.replace(/!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g, (m, alt, src) => {
    const url = resolveImage(src, ctx);
    return stash('<img src="' + escAttr(url) + '" alt="' + escAttr(alt) + '" loading="lazy">');
  });

  /* 放行少量安全的内联 HTML */
  s = s.replace(/<\/?(sub|sup|b|i|u|br)\s*\/?>/gi, m => stash(m));

  s = escText(s);

  /* 行内代码优先占位，避免里面的 * 被当成强调 */
  s = s.replace(/`([^`]+)`/g, (m, code) => stash('<code>' + code + '</code>'));

  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  /* 链接对离线 App 意义不大，降级为“文本（URL）” */
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1（$2）');

  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => slots[+i]);
}

function mdToHtml(md, ctx) {
  if (!md || !String(md).trim()) return '';
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null;

  const flushPara = () => {
    if (!para.length) return;
    out.push('<p>' + inline(para.join(' '), ctx) + '</p>');
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push('<' + list.type + '>' +
      list.items.map(item => '<li>' + inline(item, ctx) + '</li>').join('') +
      '</' + list.type + '>');
    list = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) { flushPara(); flushList(); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(ul[1]);
      continue;
    }
    if (ol) {
      flushPara();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(ol[1]);
      continue;
    }
    if (list) {
      list.items[list.items.length - 1] += ' ' + line.trim();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('');
}

/* ---------------- 图片 ---------------- */
function resolveImage(src, ctx) {
  if (/^data:/i.test(src)) return src;
  if (/^https?:/i.test(src)) {
    ctx.warnings.push('外链图片无法离线显示：' + src);
    return src;
  }
  if (!opts.inline) {
    ctx.warnings.push('保留相对图片路径，需手动拷入 App：' + src);
    return src;
  }
  const clean = decodeURIComponent(src.split('?')[0]);
  const abs = path.resolve(ctx.dir, clean);
  if (ctx.imageCache.has(abs)) return ctx.imageCache.get(abs);
  if (!fs.existsSync(abs)) {
    const msg = '图片不存在：' + src;
    if (opts.allowMissing) {
      ctx.warnings.push(msg + '（已保留原路径）');
      ctx.imageCache.set(abs, src);
      return src;
    }
    throw new Error(msg + '（可用 --allow-missing 跳过）');
  }
  const buf = fs.readFileSync(abs);
  const mime = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  const uri = 'data:' + mime + ';base64,' + buf.toString('base64');
  ctx.imageCache.set(abs, uri);
  ctx.images++;
  return uri;
}

/* ---------------- 转换 ---------------- */
/* 选择题答案 → 去重升序字母串：单选 "B"，多选 "ABD" */
function choiceAnswer(list) {
  const raw = Array.isArray(list) ? list : String(list == null ? '' : list).split(/[\s,，、]+/);
  return Array.from(new Set(raw.map(a => String(a).trim().toUpperCase()).filter(a => LETTERS.indexOf(a) >= 0))).sort().join('');
}

function convert(bank, ctx) {
  const chapters = [];
  const questions = [];
  const usedIds = new Set();
  const skipped = { multiple: 0, judge: 0, case: 0, qa: 0, essay: 0, other: 0 };
  const badChoice = [];

  const makeId = seed => {
    const hex = crypto.createHash('sha1').update(seed).digest('hex');
    let n = 100000000 + (parseInt(hex.slice(0, 8), 16) % 800000000);
    while (usedIds.has(n)) n = n >= 899999999 ? 100000000 : n + 1;
    usedIds.add(n);
    return n;
  };

  bank.chapters.forEach(ch => {
    const sections = [];
    const ci = chapters.length;

    ch.sections.forEach(sec => {
      const picked = [];
      sec.questions.forEach(q => {
        let norm = null;
        if (q.type === 'single' || q.type === 'multiple') {
          const options = (Array.isArray(q.options) ? q.options : []).map(String);
          const answer = choiceAnswer(q.answer);
          if (options.length >= 2 && options.length <= LETTERS.length && answer
            && answer.charCodeAt(answer.length - 1) - 65 < options.length
            && (q.type === 'single'
              ? options.length === LETTERS.length && answer.length === 1
              : answer.length >= 2)) {
            norm = { options, answer };
          }
        } else if (q.type === 'judge') {
          const a = String(Array.isArray(q.answer) ? q.answer[0] : q.answer == null ? '' : q.answer).trim();
          const yes = /^(正确|对|是|true|t|√|y|yes|a)$/i.test(a);
          const no = /^(错误|错|否|false|f|×|n|no|b)$/i.test(a);
          if (yes || no) norm = { options: ['正确', '错误'], answer: yes ? 'A' : 'B' };
        } else {
          skipped[TYPE_LABEL[q.type] ? q.type : 'other']++;
          return;
        }
        if (!norm) {
          skipped[q.type in skipped ? q.type : 'other']++;
          badChoice.push((q.stem || '').slice(0, 24));
          return;
        }
        picked.push({ q, norm });
      });
      if (!picked.length) return;

      const si = sections.length;
      sections.push({ name: sec.name, count: picked.length });

      picked.forEach(({ q, norm }) => {
        const stem = mdToHtml(q.stem, ctx);
        const options = norm.options.map(t => mdToHtml(t, ctx));
        const analysis = mdToHtml(q.analysis, ctx);
        questions.push([
          makeId(q.id + '|' + q.stem),
          ci,
          si,
          stem,
          '',
          options,
          norm.answer,
          analysis,
          TYPE_LABEL[q.type]
        ]);
      });
    });

    if (sections.length) chapters.push({ name: ch.name, sections });
  });

  return { chapters, questions, skipped, badChoice };
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
  const ctx = { dir, warnings: [], imageCache: new Map(), images: 0 };

  let result;
  try {
    result = convert(bank, ctx);
  } catch (e) {
    if (temp) fs.rmSync(temp, { recursive: true, force: true });
    process.stderr.write((e && e.message ? e.message : e) + '\n');
    process.exit(1);
  }
  if (temp) fs.rmSync(temp, { recursive: true, force: true });

  const { chapters, questions, skipped, badChoice } = result;
  if (!questions.length) {
    process.stderr.write('没有可转换的选择题或判断题。\n');
    process.exit(1);
  }

  const meta = {
    version: bank.meta.version || '1.0.0',
    builtAt: new Date().toISOString().slice(0, 10),
    total: questions.length,
    type: '单选 + 多选 + 判断',
    note: '由 kshare 模板转换，含单选、多选、判断。',
    slug: bank.meta.slug || '',
    title: bank.meta.title || '',
    subject: bank.meta.subject || '',
    category: bank.meta.category || '',
    description: bank.meta.description || '',
    author: bank.meta.author || '',
    rights: bank.meta.rights || '',
    license: bank.meta.license || '',
    source: bank.meta.sourceFile || path.basename(file)
  };

  const payload = { chapters, questions, meta };
  const header = '/* ' + (meta.title || '题库') + ' · 数据文件（转换生成）\n' +
    ' * 来源：' + (meta.slug || meta.source) + ' v' + meta.version +
    ' | 授权：' + (meta.license || '未声明') + ' | 版权状态：' + (meta.rights || '未声明') + '\n' +
    ' * 结构：questions = [id, 章索引, 节索引, 题干, 材料, 选项数组, 答案, 解析, 题型]\n' +
    ' */\n';
  const body = 'window.BANK=' + JSON.stringify(payload, null, opts.pretty ? 2 : 0) + ';\n';

  const outPath = opts.out || path.join(process.cwd(), path.basename(file, path.extname(file)) + '.data.js');
  fs.writeFileSync(outPath, header + body);

  const byType = Object.keys(skipped).filter(k => skipped[k]).map(k => TYPE_LABEL[k] + ' ' + skipped[k]).join('、');
  process.stdout.write(
    '转换完成：' + path.basename(file) + ' → ' + outPath + '\n' +
    '  章节：' + chapters.length + ' 章 / ' + chapters.reduce((n, c) => n + c.sections.length, 0) + ' 节\n' +
    '  题目：' + questions.length + ' 道（单选/多选/判断）' + (byType ? '（跳过：' + byType + '）' : '') + '\n' +
    '  图片：' + ctx.images + ' 张已内联\n' +
    '  文件：' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB\n'
  );
  if (badChoice.length) {
    process.stderr.write('[WARN] ' + badChoice.length + ' 道选择题选项或答案不合格，已跳过：\n');
    badChoice.slice(0, 10).forEach(s => process.stderr.write('  - ' + s + '…\n'));
  }
  if (ctx.warnings.length) {
    const uniq = Array.from(new Set(ctx.warnings));
    process.stderr.write('[WARN] ' + uniq.length + ' 条提示：\n');
    uniq.slice(0, 10).forEach(w => process.stderr.write('  - ' + w + '\n'));
  }
}

main();
