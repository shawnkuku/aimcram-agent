//! JSONL / JSON 题库直采：把已有的结构化题目原样导入为学习库，不经过 LLM 改写。
//! 支持字段：question、options、answer、explanation、type、chapter_name、difficulty、
//! tags、has_image、image_source_url / image。图片会下载到 workDir/images 并写进题干。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentError } from './errors.mjs';
import { renderLibraryMarkdown, renderPlateSvg, sourceDigest, generateCases, generateKnowledgeGraph, buildExamFocus, backfillCaseCategories, attachFigures } from './generate.mjs';
import { ensureDir } from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KSHARE = path.resolve(HERE, 'vendor/kshare.mjs');

const TYPE_MAP = {
  判断: 'judge',
  判断题: 'judge',
  单选: 'single',
  单选题: 'single',
  多选: 'multiple',
  多选题: 'multiple',
  judge: 'judge',
  single: 'single',
  multiple: 'multiple'
};

const TYPE_SECTION = { judge: '判断题', single: '单选题', multiple: '多选题' };

function sha1(text) {
  return createHash('sha1').update(String(text)).digest('hex');
}

function clampText(value, max) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function optionList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((o) => {
    if (typeof o === 'string') return { key: '', text: o.trim() };
    return {
      key: String(o?.key || '').trim().toUpperCase(),
      text: String(o?.text ?? o?.label ?? o?.value ?? '').trim()
    };
  }).filter((o) => o.text);
}

function normalizeJudge(answer, options) {
  const text = String(answer ?? '').trim();
  const hit = options.find((o) => o.key === text.toUpperCase());
  const candidate = hit ? hit.text : text;
  if (/^(正确|对|是|√|T|TRUE|Y|YES)$/i.test(candidate)) return '正确';
  if (/^(错误|错|否|×|X|F|FALSE|N|NO)$/i.test(candidate)) return '错误';
  if (text.toUpperCase() === 'A') return '正确';
  if (text.toUpperCase() === 'B') return '错误';
  return '';
}

function normalizeChoice(answer, options) {
  const letters = String(Array.isArray(answer) ? answer.join('') : answer ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .split('');
  const valid = [];
  for (const letter of letters) {
    const byKey = options.findIndex((o) => o.key === letter);
    const index = byKey >= 0 ? byKey : letter.charCodeAt(0) - 65;
    if (index >= 0 && index < options.length) {
      const target = options[index].key || String.fromCharCode(65 + index);
      if (!valid.includes(target)) valid.push(target);
    }
  }
  return valid;
}

function difficultyOf(value) {
  if (typeof value === 'string' && ['易', '中', '难'].includes(value.trim())) return value.trim();
  const n = Number(value);
  if (!Number.isFinite(n)) return '中';
  if (n <= 2) return '易';
  if (n >= 4) return '难';
  return '中';
}

/** 解析一行 JSON 为统一题目；无法识别则返回 null。 */
export function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = TYPE_MAP[String(raw.type || '').trim()];
  if (!type) return null;
  const stem = clampText(raw.question ?? raw.stem, 400);
  if (!stem) return null;
  const options = optionList(raw.options);
  const answerRaw = raw.answer ?? raw.answers;
  let answer = [];
  if (type === 'judge') {
    const judge = normalizeJudge(answerRaw, options);
    if (!judge) return null;
    answer = [judge];
  } else {
    answer = normalizeChoice(answerRaw, options);
    if (!answer.length) return null;
    if (type === 'single' && answer.length > 1) answer = answer.slice(0, 1);
    if (type === 'multiple' && answer.length < 1) return null;
    if (options.length < 2) return null;
  }
  const analysis = clampText(raw.explanation ?? raw.analysis, 600)
    || (type === 'judge'
      ? `本题说法${answer[0]}，注意与法条原文保持一致。`
      : `正确选项为 ${answer.join('')}，请结合知识点逐项判断。`);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((t) => clampText(t, 20)).filter(Boolean).slice(0, 4)
    : [];
  const chapter = clampText(raw.chapter_name ?? raw.chapter ?? '', 40) || '未分类';
  return {
    id: String(raw.id || '').trim(),
    subject: subjectNo(raw.subject ?? raw.subject_id ?? raw.subject_name),
    type,
    stem,
    options: options.map((o) => o.text),
    answer,
    analysis,
    difficulty: difficultyOf(raw.difficulty),
    tags,
    chapter,
    imageUrl: String(raw.image_source_url || raw.image_url || (/^https?:\/\//i.test(raw.image || '') ? raw.image : '')).trim(),
    imagePath: String((!raw.image_source_url && !raw.image_url && !/^https?:\/\//i.test(raw.image || '')) ? (raw.image || '') : '').trim(),
    hasImage: raw.has_image === true || Boolean(raw.image_source_url || raw.image)
  };
}

/** 从「科目一 / 科目1 / 1」里抽取科目号，用于过滤混在一起的题库。 */
export function subjectNo(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  const m = s.match(/科目\s*([一二三四1234])/i) || s.match(/^([1-4])$/);
  if (!m) return '';
  return { 一: '1', 二: '2', 三: '3', 四: '4' }[m[1]] || m[1];
}

/* 与 kshare 去重口径一致：题型 + 题干 + 选项 + 答案（忽略图片、空白与标点差异） */
function questionKey(q) {
  const norm = (s) => String(s ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/[（）()【】\[\]「」《》"'“”‘’，,。.、；;：:！!？?]/g, '');
  const answer = Array.isArray(q.answer) ? q.answer.join('') : q.answer;
  return [q.type, norm(q.stem), (q.options || []).map(norm).join('|'), answer].join('###');
}

const TEXT_QUESTION_START = /^(\d{1,4})\s*[.、．)）]\s*(.+)$/;
const TEXT_OPTION = /^([A-Da-d])\s*[.、．)）:：]\s*(.+)$/;
const TEXT_ANSWER = /^(答案|正确答案|参考答案)\s*[：:]\s*(.+)$/;
const TEXT_ANALYSIS = /^(解析|答案解析|分析)\s*[：:]\s*(.*)$/;
const TEXT_HEADING = /^(#{1,4})\s+(.+)$/;
const TEXT_CN_HEADING = /^第[一二三四五六七八九十百零\d]+[章节部分]\s*[：:]?\s*(.*)$/;

function stripHeading(text) {
  return String(text || '')
    .replace(/^第[一二三四五六七八九十百零\d]+[章节部分]\s*[：:]?\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从 Markdown / 纯文本里解析已有题目（数字序号题干 + A-D 选项 + 答案/解析）。
 * 同时收集题干中的图片引用，供后续复制或下载。
 */
export function parseTextQuestions(text) {
  const out = [];
  let chapter = '';
  let block = null;
  const flush = () => {
    if (!block) return;
    let stem = block.stem.trim();
    const images = [];
    stem = stem.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, (m, src) => {
      images.push(src);
      return ' ';
    }).replace(/\s+/g, ' ').trim();
    if (stem.length >= 5 && block.answer) {
      let type = 'judge';
      if (block.options.length >= 2) {
        const letters = String(block.answer).toUpperCase().replace(/[^A-Z]/g, '');
        type = letters.length > 1 ? 'multiple' : 'single';
      }
      out.push({
        type,
        question: stem,
        options: block.options,
        answer: block.answer,
        explanation: block.analysis.trim(),
        chapter_name: block.chapter,
        image: images[0] || '',
        has_image: images.length > 0
      });
    }
    block = null;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = TEXT_HEADING.exec(line) || TEXT_CN_HEADING.exec(line);
    if (heading) {
      flush();
      const title = stripHeading(heading[2] ?? heading[1]);
      if (title) chapter = clampText(title, 40);
      continue;
    }
    const start = TEXT_QUESTION_START.exec(line);
    if (start && !TEXT_OPTION.test(line)) {
      flush();
      block = { stem: line.replace(TEXT_QUESTION_START, '$2'), chapter, options: [], answer: '', analysis: '', image: '' };
      continue;
    }
    if (!block) continue;
    const opt = TEXT_OPTION.exec(line);
    if (opt) {
      block.options.push({ key: opt[1].toUpperCase(), text: opt[2] });
      continue;
    }
    const ans = TEXT_ANSWER.exec(line);
    if (ans) {
      block.answer = ans[2].trim();
      continue;
    }
    const exp = TEXT_ANALYSIS.exec(line);
    if (exp) {
      block.analysis = exp[2] || '';
      continue;
    }
    if (block.answer) {
      block.analysis = block.analysis ? `${block.analysis}\n${line}` : line;
    } else if (block.options.length) {
      const last = block.options[block.options.length - 1];
      last.text += ` ${line}`;
    } else {
      block.stem += ` ${line}`;
    }
  }
  flush();
  return out;
}

const AI_EXTRACT_SYSTEM = `你是题库解析器。用户会给你一段资料（可能来自 PDF / Word / Excel / 网页，排版混乱），请抽取其中所有可作答的题目。

只输出 JSON：
{
  "questions": [
    {
      "type": "single|multiple|judge",
      "question": "完整题干（保留原意，不加序号）",
      "options": [{ "key": "A", "text": "选项原文" }],
      "answer": "单选写 B；多选写 AB；判断写 正确/错误",
      "explanation": "解析或判断依据；资料没有就写简要依据",
      "chapter": "所属章节名；没有就写 未分类",
      "difficulty": "易|中|难"
    }
  ]
}

硬性要求：
1. 判断题可省略 options，answer 用「正确」或「错误」；
2. 单选/多选必须给出全部选项，答案要与选项一一对应；
3. 不改写题干与选项，不合并、不编造题目；
4. 忽略页码、页眉页脚、机构广告、二维码、加群等非题目内容。`;

/** 把长文本切成模型可消化的片段，控制单次素材的 token 成本。 */
function splitForAI(text, size = 6000, maxChunks = 12) {
  const chunks = [];
  let buf = '';
  for (const line of String(text || '').split('\n')) {
    if (buf && buf.length + line.length + 1 > size) {
      chunks.push(buf);
      buf = '';
      if (chunks.length >= maxChunks) break;
    }
    buf += (buf ? '\n' : '') + line;
  }
  if (buf.trim() && chunks.length < maxChunks) chunks.push(buf);
  return chunks.filter((chunk) => chunk.trim());
}

/**
 * 规则解析失败或明显不完整时，用模型把资料转成标准题目。
 * 返回的是原始记录，后续仍走 normalizeRecord / 去重 / 科目过滤。
 */
async function aiExtractQuestions({ llm, text, reporter }) {
  const chunks = splitForAI(text);
  const questions = [];
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    reporter?.stage('import', 45, `AI 解析资料 ${i + 1}/${chunks.length} 段`);
    try {
      const raw = await llm.chatJSON({
        system: AI_EXTRACT_SYSTEM,
        user: `资料片段（第 ${i + 1}/${chunks.length} 段）：\n"""\n${chunks[i]}\n"""\n请抽取其中全部可作答的题目。`,
        maxTokens: 6000,
        temperature: 0.1
      });
      const list = Array.isArray(raw?.questions) ? raw.questions : Array.isArray(raw) ? raw : [];
      questions.push(...list);
    } catch {
      failed += 1;
    }
  }
  return { questions, chunks: chunks.length, failed };
}

/** 读取一个来源里的全部题目记录：JSONL / JSON 数组，或从正文解析。 */
function readRecords(source) {
  const isJson = /\.(jsonl?|ndjson)$/i.test(source?.path || '');
  let text = String(source?.text || '');
  if (isJson && source?.path && fs.existsSync(source.path)) {
    text = fs.readFileSync(source.path, 'utf8');
  }
  text = text.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  if (isJson && text.startsWith('[')) {
    try {
      const list = JSON.parse(text);
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }
  if (isJson) {
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        out.push(JSON.parse(s));
      } catch {
        /* 跳过损坏行 */
      }
    }
    return out;
  }
  /* 非 JSON：按「数字题干 + 选项 + 答案/解析」结构解析正文 */
  return parseTextQuestions(text);
}

function imageFileName(url, fallbackSeed) {
  let ext = '.jpg';
  try {
    const p = new URL(url).pathname;
    const m = /\.(jpe?g|png|webp|gif|bmp)$/i.exec(p);
    if (m) ext = '.' + m[1].toLowerCase().replace('jpeg', 'jpg');
  } catch {
    /* 非 URL，走默认扩展名 */
  }
  return `src-${sha1(url || fallbackSeed).slice(0, 12)}${ext}`;
}

async function fetchImage(url, dest, timeout = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('空文件');
  if (buf.length > 6 * 1024 * 1024) throw new Error('超过 6MB');
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function mapLimit(items, limit, fn) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

const TOPUP_SYSTEM = `你是命题专家，负责为已有题库补充新题，使其达到目标题量。
只输出合法 JSON，不要解释、不要代码围栏。JSON 结构：
{
  "sections": [
    {
      "chapter": "章名称（与输入一致）",
      "section": "判断题|单选题|多选题",
      "questions": [
        { "type": "single", "stem": "题干", "options": ["A原文","B原文","C原文","D原文"], "answer": "B", "analysis": "解析", "difficulty": "易|中|难", "tags": ["知识点"] },
        { "type": "multiple", "stem": "题干", "options": ["A原文","B原文","C原文","D原文"], "answer": ["A","C"], "analysis": "解析", "difficulty": "中", "tags": ["知识点"] },
        { "type": "judge", "stem": "一句可判定真假的具体陈述", "answer": ["正确"], "analysis": "解析", "difficulty": "易", "tags": ["知识点"] }
      ]
    }
  ]
}
硬性要求：
1. 只补 count 道题，不得多给；必须与已有题干明显不同，禁止换汤不换药。
2. 题型混合：判断、单选、多选都要有；单选/多选固定 4 个选项，多选答案 2–4 个字母，判断 answer 为 ["正确"] 或 ["错误"]。
3. 内容必须来自给定资料片段与章名，不编造资料外事实；解析要说明依据。
4. 不要出现机构名、二维码、加群等推广信息。`;

function sourceExcerpt(text, chapter, max = 1800) {
  const lines = String(text || '').split('\n');
  const hits = lines.filter((line) => line.includes(chapter)).join('\n').trim();
  const picked = hits || lines.slice(0, 60).join('\n');
  return picked.length > max ? picked.slice(0, max) : picked;
}

function chapterQuestions(chapter) {
  return chapter.sections.flatMap((sec) => sec.questions);
}

/**
 * 题目不足时用模型按章补题；没有模型或调用失败则保留缺口并在报告中标注。
 */
async function topUpQuestions({ chapters, need, llm, sourceText, reporter }) {
  const existingCounts = chapters.map((ch) => chapterQuestions(ch).length);
  const totalExisting = existingCounts.reduce((a, b) => a + b, 0);
  const shares = chapters.map((ch, i) => {
    const base = totalExisting > 0 ? existingCounts[i] / totalExisting : 1 / chapters.length;
    return Math.floor(need * base);
  });
  let assigned = shares.reduce((a, b) => a + b, 0);
  for (let i = 0; assigned < need; i = (i + 1) % chapters.length) {
    shares[i] += 1;
    assigned += 1;
  }

  let added = 0;
  let failedBatches = 0;
  for (let i = 0; i < chapters.length; i++) {
    const chapter = chapters[i];
    let remaining = shares[i];
    if (!remaining) continue;
    while (remaining > 0) {
      const want = Math.min(10, remaining);
      const existing = chapterQuestions(chapter).map((q) => q.stem).slice(0, 25);
      reporter?.stage('import', 61, `补题：${chapter.name}（还需 ${remaining} 道）`);
      let raw = null;
      try {
        raw = await llm.chatJSON({
          system: TOPUP_SYSTEM,
          user: {
            chapter: chapter.name,
            count: want,
            existing,
            material: sourceExcerpt(sourceText, chapter.name)
          },
          maxTokens: 4000,
          temperature: 0.4
        });
      } catch {
        failedBatches += 1;
        break;
      }
      const sections = Array.isArray(raw?.sections) ? raw.sections : [];
      let got = 0;
      for (const entry of sections) {
        for (const item of Array.isArray(entry?.questions) ? entry.questions : []) {
          if (got >= want) break;
          const q = normalizeRecord({ ...item, chapter_name: chapter.name });
          if (!q) continue;
          if (chapterQuestions(chapter).some((old) => old.stem.slice(0, 30) === q.stem.slice(0, 30))) continue;
          const sectionName = TYPE_SECTION[q.type] || '练习题';
          let section = chapter.sections.find((sec) => sec.name === sectionName);
          if (!section) {
            section = { name: sectionName, questions: [] };
            chapter.sections.push(section);
          }
          section.questions.push({
            type: q.type,
            stem: q.stem,
            options: q.options,
            answer: q.answer,
            analysis: q.analysis,
            difficulty: q.difficulty,
            tags: q.tags
          });
          got += 1;
        }
      }
      added += got;
      remaining -= got;
      if (!got) {
        failedBatches += 1;
        break;
      }
      if (!sections.length) break;
    }
  }
  if (added) reporter?.stage('import', 62, `模型补题完成：新增 ${added} 道`);
  return { added, failedBatches };
}

/**
 * 题库直采：解析 JSONL/JSON，下载配图，渲染 Markdown 并交给 kshare 严格校验。
 * 返回结构与 generateStudyLibrary 保持一致，便于 pipeline 复用组包逻辑。
 */
export async function importLibrary({
  topic,
  sources,
  workDir,
  meta,
  reporter,
  questionCount = 0,
  questionsPerSection = 0,
  caseCount = 0,
  llm = null,
  config = {}
}) {
  reporter?.stage('import', 46, '解析资料中的已有题目');
  const records = [];
  let aiExtracted = 0;
  let aiChunks = 0;
  let aiFailedChunks = 0;
  for (const source of sources) {
    let rows = readRecords(source);
    const structured = /\.(jsonl?|ndjson)$/i.test(source.path || '');
    const text = String(source.text || '');
    /* 规则优先：结构化题库直接映射；文本类资料规则识别不出来或明显漏题时，交给模型兜底 */
    const likelyMessy = !structured && text.trim()
      && (rows.length === 0 || (text.length > 20000 && rows.length * 5000 < text.length));
    if (likelyMessy) {
      if (llm && typeof llm.chatJSON === 'function') {
        const ai = await aiExtractQuestions({ llm, text, reporter });
        aiExtracted += ai.questions.length;
        aiChunks += ai.chunks;
        aiFailedChunks += ai.failed;
        rows = rows.concat(ai.questions);
      } else {
        reporter?.stage('import', 45, '资料格式不规则；配置模型 Key 后可自动 AI 解析');
      }
    }
    for (const raw of rows) {
      const q = normalizeRecord(raw);
      if (q) records.push({ ...q, sourceTitle: source.title, sourcePath: source.path || '' });
    }
  }
  if (!records.length) {
    throw new AgentError('LA013', '没有从资料中解析到可用题目', {
      hint: 'JSONL 需包含 type/question/answer 字段；PDF/Word/Excel/Markdown 需要能识别出题目结构，格式较乱时请配置模型 Key 让 AI 解析，或改用智能生成。'
    });
  }
  /* 混合题库过滤：题目自带 subject（如 1/4）时，只保留与主题科目一致的题 */
  const wantedSubject = subjectNo(meta?.subject) || subjectNo(topic);
  let subjectFiltered = 0;
  let scoped = records;
  if (wantedSubject) {
    const withSubject = records.filter((q) => q.subject).length;
    /* 多数记录带科目信息才启用，避免只有零星字段时误删 */
    if (withSubject >= records.length * 0.5) {
      scoped = records.filter((q) => !q.subject || q.subject === wantedSubject);
      subjectFiltered = records.length - scoped.length;
      if (subjectFiltered) {
        reporter?.stage('import', 46, `按科目 ${wantedSubject} 过滤：保留 ${scoped.length} 题，剔除 ${subjectFiltered} 题`);
      }
    } else {
      reporter?.stage('import', 46, '资料未标注科目，跳过科目过滤');
    }
  }
  if (!scoped.length) {
    throw new AgentError('LA013', `资料中的题目都不属于科目 ${wantedSubject}`, {
      hint: '换用包含该科目题目的资料，或把主题改成与资料一致的科目。'
    });
  }
  /* 源题库常含重复题：先按同一口径去重，避免 kshare E050 直接失败 */
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const q of scoped) {
    const key = questionKey(q);
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    unique.push(q);
  }
  const limited = Number(questionCount) > 0 ? unique.slice(0, Number(questionCount)) : unique;

  /* 图片下载：按 URL 去重，失败时保留无图题目 */
  const imagesDir = path.join(workDir, 'images');
  ensureDir(imagesDir);
  const imageTasks = [];
  const urlToFile = new Map();
  for (const q of limited) {
    if (!q.hasImage) continue;
    const url = q.imageUrl;
    if (url && /^https?:\/\//i.test(url)) {
      if (!urlToFile.has(url)) urlToFile.set(url, imageFileName(url, q.id || q.stem));
    } else if (q.imagePath) {
      const local = path.isAbsolute(q.imagePath)
        ? q.imagePath
        : path.resolve(path.dirname(q.sourcePath || workDir), q.imagePath);
      if (fs.existsSync(local)) {
        const file = imageFileName(local, q.id || q.stem);
        if (!urlToFile.has(local)) urlToFile.set(local, file);
        try {
          fs.copyFileSync(local, path.join(imagesDir, file));
        } catch {
          urlToFile.delete(local);
        }
      }
    }
  }
  for (const [url] of urlToFile) {
    if (!/^https?:\/\//i.test(url)) continue;
    imageTasks.push(url);
  }
  let downloaded = 0;
  let failed = 0;
  reporter?.stage('import', 50, `下载原题配图 ${imageTasks.length} 张`);
  await mapLimit(imageTasks, 6, async (url) => {
    const file = urlToFile.get(url);
    try {
      await fetchImage(url, path.join(imagesDir, file));
      downloaded += 1;
    } catch {
      failed += 1;
      urlToFile.delete(url);
    }
  });
  reporter?.stage('import', 60, `配图完成：成功 ${downloaded} 张，失败 ${failed} 张`);

  for (const q of limited) {
    const key = q.imageUrl || (q.imagePath
      ? path.resolve(path.dirname(q.sourcePath || workDir), q.imagePath)
      : '');
    const file = key ? urlToFile.get(key) : '';
    if (file) q.stem = `${q.stem} ![](images/${file})`;
  }

  /* 章 → 题型小节，保持来源顺序；未分类排最后 */
  const chapterMap = new Map();
  for (const q of limited) {
    if (!chapterMap.has(q.chapter)) chapterMap.set(q.chapter, { name: q.chapter, sections: new Map() });
    const chapter = chapterMap.get(q.chapter);
    const sectionName = TYPE_SECTION[q.type] || '练习题';
    if (!chapter.sections.has(sectionName)) chapter.sections.set(sectionName, { name: sectionName, questions: [] });
    chapter.sections.get(sectionName).questions.push({
      type: q.type,
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      analysis: q.analysis,
      difficulty: q.difficulty,
      tags: q.tags
    });
  }
  const chapters = [...chapterMap.values()]
    .sort((a, b) => (a.name === '未分类' ? 1 : b.name === '未分类' ? -1 : 0))
    .map((ch) => ({
      name: ch.name,
      sections: [...ch.sections.values()].filter((s) => s.questions.length)
    }));

  const sectionCount = chapters.reduce((n, ch) => n + ch.sections.length, 0);
  const target = Number(questionCount) > 0
    ? Number(questionCount)
    : (Number(questionsPerSection) > 0 ? Number(questionsPerSection) * sectionCount : 0);
  const missing = Math.max(0, target - limited.length);
  let topUp = { added: 0, failedBatches: 0 };
  if (missing > 0) {
    if (llm && typeof llm.chatJSON === 'function') {
      const sourceText = sources.map((s) => String(s.text || '')).join('\n');
      topUp = await topUpQuestions({ chapters, need: missing, llm, sourceText, reporter });
    } else {
      reporter?.stage('import', 61, `题目不足 ${missing} 道：未配置模型，跳过补题`);
    }
  }
  const totalQuestions = chapters.reduce((n, ch) => n + chapterQuestions(ch).length, 0);

  const outline = {
    title: meta?.title || topic || '题库直采',
    subject: meta?.subject || topic || '题库',
    category: meta?.category || '职业资格',
    description: `由 ${sources.map((s) => s.title).join('、')} 直采导入，保留原题题干、选项、答案与解析${topUp.added ? `，并由 agent 补充 ${topUp.added} 道` : ''}。`,
    chapters,
    plates: []
  };

  reporter?.stage('import', 62, '根据题库补知识图谱与案例精析');
  /* 直采不重写题目，但可以基于已入库的题库让模型归纳案例与知识图谱 */
  const quality = { platesGenerated: false, caseBatchesFailed: 0, casesTarget: 0, casesGenerated: 0 };
  const canLLM = Boolean(llm && typeof llm.chatJSON === 'function');
  if (canLLM) {
    const digest = sourceDigest(sources, Math.min(Number(config?.maxSourceChars) || 40_000, 40_000));
    if (Number(caseCount) > 0) {
      reporter?.stage('cases', 63, `生成案例精析（目标 ${caseCount} 个）`);
      await generateCases({ llm, outline, digest, count: Number(caseCount), reporter, quality });
    }
    reporter?.stage('knowledge', 65, '根据题库生成知识图谱');
    outline.plates = await generateKnowledgeGraph({
      llm, outline, digest, reporter, quality, examFocus: buildExamFocus(outline)
    });
    backfillCaseCategories(outline);
  } else if (Number(caseCount) > 0) {
    reporter?.stage('import', 63, '未配置模型，跳过案例精析与知识图谱');
  }

  const caseTotal = chapters.reduce((n, ch) => n + (ch.cases || []).length, 0);
  outline.plates.forEach((plate, idx) => {
    plate.diagram = `images/plate-${String(idx + 1).padStart(2, '0')}.svg`;
    plate.diagramNote = `${plate.name} 的知识关联示意`;
  });
  const figureImages = attachFigures(outline, imagesDir);

  reporter?.stage('import', 68, '渲染 Markdown');
  const packMeta = {
    version: '1.0.0',
    updated: new Date().toISOString().slice(0, 10),
    language: 'zh-CN',
    ...meta,
    title: outline.title,
    subject: outline.subject,
    category: outline.category,
    description: outline.description
  };
  const render = renderLibraryMarkdown({ meta: packMeta, outline });
  const mdPath = path.join(workDir, 'library.md');
  fs.writeFileSync(mdPath, render.md, 'utf8');
  outline.plates.forEach((plate, idx) => {
    const file = `plate-${String(idx + 1).padStart(2, '0')}.svg`;
    fs.writeFileSync(path.join(imagesDir, file), renderPlateSvg(plate, idx), 'utf8');
  });

  reporter?.stage('import', 72, '执行 kshare 校验');
  /*
   * 直采是原题导入，源数据里常见 3 选项题、超过 300KB 的动图、来源词等 W 级告警，
   * 这些不应阻断入库；这里只把 E 级（结构错误 / 重复题）当作失败。
   */
  const jsonPath = path.join(workDir, 'library.json');
  const result = spawnSync(process.execPath, [KSHARE, mdPath, '-o', jsonPath], {
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024
  });
  const log = `${result.stderr || ''}\n${result.stdout || ''}`;
  const errorCount = (log.match(/\[ERROR\]/g) || []).length;
  const warnCount = (log.match(/\[WARN \]/g) || []).length;
  if (result.status !== 0 || errorCount) {
    throw new AgentError('LA009', '直采题库未通过 kshare 校验', {
      hint: '查看 details.stderr 中的 E0xx 与行号',
      details: { stdout: result.stdout?.slice(-4000), stderr: result.stderr?.slice(-4000) }
    });
  }
  const libraryJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const byType = {};
  for (const ch of chapters) {
    for (const q of chapterQuestions(ch)) byType[q.type] = (byType[q.type] || 0) + 1;
  }
  const stats = {
    chapters: chapters.length,
    sections: sectionCount,
    questions: totalQuestions,
    cases: caseTotal,
    plates: outline.plates.length,
    points: outline.plates.reduce((n, p) => n + (p.points || []).length, 0),
    diagrams: outline.plates.length,
    figureImages: downloaded + figureImages.length,
    sourceChars: sources.reduce((n, s) => n + String(s.text || '').length, 0),
    byType,
    quality: {
      imported: true,
      planChapters: chapters.length,
      actualChapters: chapters.length,
      sourceRecords: records.length,
      aiExtracted,
      aiChunks,
      aiFailedChunks,
      subjectFiltered,
      duplicatesRemoved: duplicates,
      warnings: warnCount,
      importedQuestions: limited.length,
      topUpAdded: topUp.added,
      topUpFailedBatches: topUp.failedBatches,
      targetQuestions: target,
      images: downloaded,
      imageFailed: failed,
      platesGenerated: quality.platesGenerated,
      casesTarget: quality.casesTarget,
      casesGenerated: quality.casesGenerated,
      caseBatchesFailed: quality.caseBatchesFailed
    }
  };
  return { outline, libraryJson, md: render.md, mdPath, jsonPath, stats };
}
