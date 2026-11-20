/**
 * 学习库生成：大纲 → 知识点/关联 → 题目 → kshare Markdown → 官方校验 → 生成 JSON
 *
 * 关键取舍：不自己发明内容格式，而是渲染成 services/README.md 定义的 kshare Markdown，
 * 再交给 src/vendor/kshare.mjs（--strict）产出 content/library.json。
 * 这样题目 id、字段裁剪、错误码与现有 App 完全一致，天然满足「可直接导入」。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AgentError } from './errors.mjs';
import {
  truncate, keywords, splitSentences, slugify, textStats, ensureDir, writeJson, sha1Hex, mapLimit
} from './util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KSHARE = path.resolve(HERE, 'vendor/kshare.mjs');
const OUTLINE_SYSTEM = `你是资深课程设计专家，负责把零散资料整理成可直接学习的知识体系。
只输出合法 JSON，不要解释、不要 Markdown 代码围栏。JSON 结构：
{
  "title": "库标题（≤40字）",
  "subject": "科目",
  "category": "分类，如 职业资格 / 校内课程 / 通识",
  "description": "一句话说明覆盖范围与不包含的内容",
  "chapters": [
    {
      "name": "章的短名称（不要带“第N章”前缀）",
      "summary": "本章 60–120 字概述：知识主线、考查重点",
      "weight": 3,
      "sections": [
        {
          "name": "节名称（不要带编号）",
          "summary": "本节 60–120 字摘要：讲什么、怎么考",
          "weight": 3,
          "points": ["**知识点名**：定义/结论 + 判断依据或易错点（关联：另一个知识点）", "..."]
        }
      ]
    }
  ]
}
硬性要求：
1. 章数必须等于 structure.chapters，每章 4–6 节，每节 4–6 个知识点；每个知识点都要写成「**名称**：定义/结论 + 判断依据或易错点」，并用“（关联：…）”标注与其他知识点的关系。
2. 章节要具体、可出题：章名落到知识模块（如「传输层协议」「网络安全防护」），不要用「基础」「概述」「综合」这类空泛命名；每节聚焦一个可以独立命题的知识点，避免同一考点在多个小节重复。
3. 内容必须来自给定资料，不编造资料中没有的事实；资料不足时合并小节而不是扩写。
4. points 的每条 40–120 字，不要换行；同一节要覆盖概念定义、流程步骤、对比辨析、易错点、应用场景中适用的部分，不要只写一句结论。
5. 不允许把全部内容压进 1 章；章是按主题划分的一级结构，必须相互独立。
6. 每章与每节都必须给出 weight（1–5 的整数）：按该章/节在真实考试中的出题频率与知识重要程度打分，5 = 每年必考的核心，1 = 很少出现的边缘内容；不得所有章都填同一个值，权重会直接决定题量与案例的分配比例。`;

const OUTLINE_TITLES_SYSTEM = `你是课程设计专家。只输出合法 JSON，不要解释、不要代码围栏。
JSON 结构：{ "chapters": ["章名1", "章名2", "章名3"] }
硬性要求：
1. 章名数量必须等于 chapters，按学习顺序排列；
2. 章名 4–12 字，不带“第N章”前缀，不含“概述/其他”这类凑数章；
3. 各章主题相互独立且覆盖资料主线，不得把全部内容归入 1 章。`;

const OUTLINE_EXPAND_SYSTEM = `你是课程设计专家，负责把一个章名展开成可学习的小节。只输出合法 JSON，不要解释、不要代码围栏。
JSON 结构：
{
  "summary": "本章一句话概述",
  "sections": [
    { "name": "节名称（不带编号）", "summary": "60–120 字摘要", "points": ["**知识点名**：定义/结论 + 判断依据（关联：另一个知识点）"] }
  ]
}
硬性要求：
1. 4–6 个小节，每节 4–6 个知识点，每条知识点 40–120 字；
2. 小节名要具体到可独立出题的知识点，不要写「概述」「综合练习」这类空泛名称；
3. 内容必须来自给定资料，不编造；资料不足时减少小节，不要扩写；
4. 知识点用“（关联：…）”标注与其他要点的关系，并尽量写清定义、流程、对比与易错点。`;

const QUESTION_SYSTEM = `你是命题专家，基于给定章节知识点出题。
只输出合法 JSON，不要解释、不要代码围栏。JSON 结构：
{
  "sections": [
    {
      "chapter": "章名称",
      "section": "节名称",
      "questions": [
        { "type": "single", "stem": "题干", "options": ["选项A原文","选项B原文","选项C原文","选项D原文"],
          "answer": "B", "analysis": "解析", "difficulty": "易|中|难", "tags": ["知识点"] },
        { "type": "multiple", "stem": "多选题干（要求选出全部正确项）",
          "options": ["选项A原文","选项B原文","选项C原文","选项D原文"],
          "answer": ["A","C"], "analysis": "解析", "difficulty": "易|中|难", "tags": ["知识点"] },
        { "type": "judge", "stem": "一句可判定真假的具体陈述", "answer": ["正确"],
          "analysis": "解析", "difficulty": "易|中|难", "tags": ["知识点"] },
        { "type": "single", "stem": "需要看图作答的题干", "options": ["A原文","B原文","C原文","D原文"],
          "answer": "A", "analysis": "解析", "difficulty": "中", "tags": ["知识点"],
          "figure": { "kind": "flow", "title": "≤20字", "items": ["步骤一", "步骤二", "步骤三"] } }
      ]
    }
  ]
}
硬性要求：
1. 单选必须有且仅有 4 个选项，answer 是单个字母；多选同样 4 个选项，answer 是 2–4 个字母的数组；判断题的 answer 必须是单元素数组 ["正确"] 或 ["错误"]，题干直接写陈述本身，不要加「判断：」之类的前缀。
2. 三种题型都要出现：每个小节至少各出 1 道单选、1 道多选、1 道判断，剩余名额按知识点难易分配；多选题的错误选项必须具有迷惑性。
3. 题目与解析必须能在给定知识点中找到依据，不要出现“以上都对”“略”。
4. 每个小节必须实际出满 countPerSection 道题，题目之间不得重复或换汤不换药。
5. 禁止空壳题：题干不能是“这一表述属于本节内容”“以下说法正确的是”这类没有具体概念的句子；判断题的命题必须给出可判定真假的具体陈述。
6. 解析必须说明为什么正确/错误，不得原样复述题干或知识点原文。
7. 不要包含任何机构名、网校名、二维码、加群等推广信息。
8. 配图：只有确实依赖图才能理解的内容（流程、层级结构、拓扑、数据流、对比、表格数据）才加 figure，并让题干明确指向图；figure 必须是结构化数据，不要输出 SVG、图片链接或 base64：
   - 流程/结构：{ "kind": "flow|layers", "title": "≤20字", "items": ["节点1","节点2","节点3"] }
   - 表格/对比：{ "kind": "table", "title": "≤20字", "columns": ["项目","方案A","方案B"], "rows": [["指标","值1","值2"]] }
   不依赖图的题目不要给 figure；带 figure 的题目不超过本小节题量的 30%。
9. 解析要写足：先给结论，再说明判断依据、易错点以及与其它选项的差异，每条不少于 60 字；同一小节的题目要尽量覆盖不同知识点，不要反复考同一个概念。`;

const PLATES_SYSTEM = `你是知识图谱设计专家，负责把课程大纲整理成层级完整、关联清晰的知识图谱。
只输出合法 JSON，不要解释、不要代码围栏。JSON 结构：
{
  "plates": [
    {
      "name": "知识板块名（4–16 字，落到知识模块，不要写「基础」「概述」）",
      "lead": "导语：说明本板块考什么、与其他板块是什么关系（60–140 字）",
      "points": [
        "**一级概念**：定义/结论（60–120 字）。（二级：子概念A、子概念B）。（关联：同板块的另一个概念或跨板块概念）",
        "..."
      ],
      "exam": ["具体考法或易错点，例如「TCP 三次握手中 SYN 与 ACK 的标志位组合」"],
      "chapters": ["覆盖的章名称，必须来自给定 chapters"]
    }
  ]
}
硬性要求：
1. plates 数量必须等于 plateTarget，板块之间主题互不重叠，合起来覆盖全部章节。
2. 每个板块 8–10 条 points：至少 2 条一级概念，每条都要先给定义/结论，再给解释或判断依据；
   每条 points 必须用「（二级：…）」列下属子概念，并用「（关联：…）」标注与另一条知识点的关系（同板块或跨板块均可）。
3. exam 每板块 4–6 条，必须是可直接命题的具体考点或易错点，不要只写「高频考点」四个字。
4. chapters 必须填写本板块覆盖的章名称，取自给定 chapters，不得编造章名。
5. 内容来自给定大纲与资料，不编造资料中没有的事实；每条 points 不超过 220 字，不换行，不含营销信息。
6. examFocus 给出了各章的权重、已出题量、高频标签与案例，请据此排定优先级：高频考点多的章/板块排在前面，exam 中优先列这些高频考点；权重高但题目少的章要补足考点，权重低的章不要占据过多板块篇幅。`;

const CASE_SYSTEM = `你是案例教学专家，负责为课程编写可直接用于案例精析的实操案例。
只输出合法 JSON，不要解释、不要代码围栏。JSON 结构：
{
  "cases": [
    {
      "title": "案例标题（≤30 字，点明业务/系统/制度场景）",
      "chapter": "所属章名称，必须来自给定 chapters",
      "category": "所属知识板块名；不确定时留空字符串",
      "background": "背景：交代业务、系统或制度背景，以及为什么会产生这个案例（80–160 字）",
      "scenario": "场景：给出具体数据、约束、冲突或异常现象，足以支撑分析（100–200 字）",
      "analysis": "分析过程：分 2–4 点逐步推理，说明判断依据、取舍与可能风险（180–320 字）",
      "conclusion": "结论总结：给出明确结论与可落地的对策/检查清单（80–160 字）",
      "quickNote": "速记：一句话答题骨架，用 → 串联关键步骤",
      "difficulty": "易|中|难",
      "tags": ["知识点1", "知识点2"],
      "figure": { "kind": "flow", "title": "≤20字", "items": ["环节一", "环节二", "环节三"] },
      "questions": [
        { "stem": "结合材料，提出的具体问题", "answer": "分步作答，写清依据与结论", "analysis": "补充说明评分点或易错点" }
      ]
    }
  ]
}
硬性要求：
1. cases 数量必须等于 caseCount，不要多给也不要少给；多条案例之间场景与考点不得重复。
2. 每条的 background、scenario、analysis、conclusion 必须齐备且写实，禁止只写一两句话或使用「略」「见解析」。
3. questions 给 2–3 个小问，每个小问的 answer 必须分步推理，不能只给结论。
4. category 可留空；知识图谱会在案例之后生成，届时按所在章自动归类，不要编造板块名。
5. chapter 必须取自给定 chapters 中的章名称；一批跨多章时要按章分别对应，不能把所有案例都写在同一章。
6. 内容必须来自给定大纲与资料，不编造资料外的事实；不要出现机构名、二维码、加群等推广信息。
7. 案例涉及流程、结构、拓扑或数据对比时，必须用 figure 给出图示化数据（结构化 JSON，不要 SVG 或图片链接）：流程/结构用 { "kind": "flow|layers", "title": "...", "items": [...] }，对比用 { "kind": "table", "title": "...", "columns": [...], "rows": [[...]] }；纯文字论述型案例可省略 figure。`;

/* 入库校验（W003）会拒绝带来源 / 推广词的文本；生成内容里这类词多为正常表述，
   统一换成中性说法，避免整份产物在最后一步校验失败 */
const BRAND_REPLACE = {
  '微信公众号': '公众号',
  '学员回忆版': '真题回顾',
  '内部资料': '培训资料',
  '扫码': '扫描二维码',
  '加群': '加入学习群',
  '51CTO': '',
  '希赛': '',
  '环球网校': '',
  '软考通': ''
};

function scrubBrands(value) {
  let text = String(value ?? '');
  for (const [from, to] of Object.entries(BRAND_REPLACE)) {
    if (text.includes(from)) text = text.split(from).join(to);
  }
  return text;
}

function cleanText(value, max = 600) {
  let s = String(value ?? '').replace(/\u0000/g, '').replace(/\r/g, '');
  s = scrubBrands(s);
  s = s.replace(/\s+/g, ' ').trim();
  return truncate(s, max);
}

/**
 * 模型调用可能持续几十秒到几分钟：等待期间定期补一条进度，
 * 让 App / CLI 能看出「仍在等模型」而不是误判成卡死。
 */
async function withHeartbeat(reporter, stage, percent, message, fn) {
  if (!reporter) return fn();
  let secs = 0;
  const timer = setInterval(() => {
    secs += 15;
    reporter.stage(stage, percent, `${message} · 等待模型响应 ${secs}s`);
  }, 15_000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

function oneLine(value, max = 120) {
  return cleanText(value, max).replace(/[|\n]/g, ' ');
}

function normalizePoint(raw, sectionName) {
  const text = cleanText(typeof raw === 'string' ? raw : raw?.text, 240);
  if (!text) return '';
  let point = text;
  if (!/^\*\*[^*]+\*\*[：:]/.test(point)) {
    const kw = keywords(point, 1)[0]?.word || sectionName;
    point = `**${kw}**：${point}`;
  }
  if (!/关联[：:]/.test(point)) point += '（关联：本节后续要点）';
  return point.replace(/\s+/g, ' ').trim();
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnNumber(n) {
  if (n <= 10) return CN_NUM[n];
  if (n < 20) return `十${CN_NUM[n - 10]}`;
  return String(n);
}

/** 考试权重：模型可能给数字或字符串，缺省按 3（中等频次）处理。 */
export function examWeight(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 3;
}

export function normalizeOutline(raw, { topic, config }) {
  const title = oneLine(raw?.title || topic, 60) || topic;
  const chaptersRaw = Array.isArray(raw?.chapters) ? raw.chapters : [];
  const chapters = [];
  for (const ch of chaptersRaw) {
    if (!ch || typeof ch !== 'object') continue;
    const sections = [];
    for (const sec of Array.isArray(ch.sections) ? ch.sections : []) {
      if (!sec || typeof sec !== 'object') continue;
      const name = oneLine(sec.name, 50);
      if (!name) continue;
      const points = (Array.isArray(sec.points) ? sec.points : [])
        .map((p) => normalizePoint(p, name))
        .filter(Boolean)
        .slice(0, 6);
      sections.push({
        name,
        summary: oneLine(sec.summary, 160) || (points[0] ? truncate(points[0], 120) : `${name} 的要点。`),
        points: points.length ? points : [`**${name}**：${oneLine(sec.summary, 100) || '本节核心概念。'}（关联：综合应用）`],
        weight: examWeight(sec.weight),
        questions: []
      });
      if (sections.length >= 8) break;
    }
    if (!sections.length) continue;
    chapters.push({
      name: oneLine(ch.name, 40) || `主题${chapters.length + 1}`,
      summary: oneLine(ch.summary, 160) || sections[0].summary,
      weight: examWeight(ch.weight),
      sections
    });
    if (chapters.length >= 10) break;
  }

  if (!chapters.length) {
    throw new AgentError('LA011', '大纲为空：模型没有给出可用章节', {
      hint: '检查输入源是否过短，或降低 --questions-per-section 后重试'
    });
  }

  // 章节 / 小节统一编号
  chapters.forEach((ch, ci) => {
    ch.name = /^第[一二三四五六七八九十百\d]+章/.test(ch.name) ? ch.name : `第${cnNumber(ci + 1)}章 ${ch.name}`;
    ch.sections.forEach((sec, si) => {
      sec.name = /^\d+(\.\d+)*\s/.test(sec.name) ? sec.name : `${ci + 1}.${si + 1} ${sec.name}`;
    });
  });

  // 知识图谱在选择题与案例精析之后单独生成，这里不再提前产出板块。
  return {
    title,
    subject: oneLine(raw?.subject || topic, 40) || topic,
    category: oneLine(raw?.category, 30) || '通识 / 自主学习',
    description: oneLine(raw?.description, 200) || `围绕「${topic}」自动整理的学习库。`,
    chapters,
    plates: []
  };
}

/**
 * 采用用户在 App 里确认过的目录：保留原有章 / 节顺序与数量，只补齐内部字段，
 * 不再套用「最多 8 章 6 节 / 自动编号」这类默认裁剪，避免改过的目录被改写。
 */
export function normalizePresetOutline(raw, { topic }) {
  const chapters = [];
  for (const ch of Array.isArray(raw?.chapters) ? raw.chapters : []) {
    if (!ch || typeof ch !== 'object') continue;
    const name = oneLine(ch.name || ch.title, 60);
    if (!name) continue;
    const sections = [];
    for (const sec of Array.isArray(ch.sections) ? ch.sections : []) {
      if (!sec || typeof sec !== 'object') continue;
      const secName = oneLine(sec.name || sec.title, 60);
      if (!secName) continue;
      const points = (Array.isArray(sec.points) ? sec.points : [])
        .map((p) => normalizePoint(p, secName))
        .filter(Boolean)
        .slice(0, 8);
      const summary = oneLine(sec.summary, 160) || `${secName} 的核心知识。`;
      sections.push({
        name: secName,
        summary,
        points: points.length ? points : [`**${secName}**：${summary}（关联：综合应用）`],
        weight: examWeight(sec.weight),
        questions: []
      });
    }
    if (!sections.length) continue;
    chapters.push({
      name,
      summary: oneLine(ch.summary, 160) || sections[0].summary,
      weight: examWeight(ch.weight),
      sections
    });
  }
  if (!chapters.length) {
    throw new AgentError('LA011', '目录为空：请至少保留一章并填好小节名称', {
      hint: '回到目录步骤补全章节与小节后再生成'
    });
  }
  return {
    title: oneLine(raw?.title || topic, 60) || topic,
    subject: oneLine(raw?.subject || topic, 40) || topic,
    category: oneLine(raw?.category, 30) || '通识 / 自主学习',
    description: oneLine(raw?.description, 200) || `围绕「${topic}」整理的学习库。`,
    chapters,
    plates: []
  };
}

/* 知识图谱板块配色：与 App / kshare 默认色板保持一致 */
const PLATE_COLORS = [
  '#4263eb', '#0ca678', '#e8590c', '#9c36b5', '#1098ad', '#d6336c',
  '#f08c00', '#5c940d', '#1c7ed6', '#7048e8'
];

const shortTitle = (name) => String(name || '').replace(/^第[一二三四五六七八九十百\d]+章\s*/, '').replace(/^\d+(\.\d+)*\s*/, '').trim();

/** 把模型输出的板块列表归一化：去噪、限量、补色、对齐章名。 */
export function normalizePlates(rawPlates, { chapterNames = [], max = 10 } = {}) {
  const list = [];
  const used = new Set();
  for (const [idx, p] of (Array.isArray(rawPlates) ? rawPlates : []).entries()) {
    if (!p || typeof p !== 'object') continue;
    const name = oneLine(p.name, 40);
    if (!name) continue;
    let id = slugify(p.id || name, `plate${idx + 1}`).slice(0, 24) || `plate${idx + 1}`;
    while (used.has(id)) id = `${id}-${idx + 1}`.slice(0, 24);
    used.add(id);
    const color = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(String(p.color || ''))
      ? p.color
      : PLATE_COLORS[list.length % PLATE_COLORS.length];
    const points = (Array.isArray(p.points) ? p.points : [])
      .map((x) => cleanText(typeof x === 'string' ? x : x?.text, 320))
      .filter(Boolean)
      .slice(0, 12);
    const exam = (Array.isArray(p.exam) ? p.exam : [])
      .map((x) => cleanText(x, 100))
      .filter(Boolean)
      .slice(0, 6);
    const chaptersRef = (Array.isArray(p.chapters) ? p.chapters : [])
      .map((x) => oneLine(x, 60))
      .filter((x) => !chapterNames.length || chapterNames.some((c) => c.includes(x) || x.includes(c)));
    list.push({
      id,
      name,
      color,
      lead: oneLine(p.lead, 200) || `${name} 的核心概念、层级关系与高频考点。`,
      points: points.length ? points : [`**${name}**：${oneLine(p.lead, 120) || '核心概念与判断依据。'}`],
      exam,
      chapters: chaptersRef.length ? chaptersRef : chapterNames.slice(0, 2)
    });
    if (list.length >= max) break;
  }
  return list;
}

/**
 * 没有独立知识图谱生成结果时的兜底：每个章一个板块，
 * 汇总本章全部小节的知识点（至少补到 8 条），并给每条补上关联与二级结构。
 */
export function buildOutlinePlates(chapters, { max = 10 } = {}) {
  return (chapters || []).slice(0, max).map((ch, idx) => {
    const points = [];
    const add = (text) => {
      const point = cleanText(text, 300);
      if (point && !points.includes(point)) points.push(point);
    };
    ch.sections.forEach((sec, si) => {
      const next = ch.sections[si + 1] || (chapters || [])[idx + 1]?.sections[0];
      const relation = next ? shortTitle(next.name) : '综合应用';
      const secName = shortTitle(sec.name) || sec.name;
      (sec.points || []).forEach((p) => {
        let point = cleanText(p, 300);
        if (!/关联[：:]/.test(point)) point += `（关联：${relation}）`;
        if (!/二级[：:]/.test(point)) point += `（二级：${secName} 的判定条件与常见误区）`;
        add(point);
      });
      if (points.length < 8) add(`**${secName}**：${sec.summary || '本节核心结论与适用边界。'}（关联：${relation}）`);
    });
    for (const sec of ch.sections) {
      if (points.length >= 8) break;
      add(`**${shortTitle(sec.name)}**：${sec.summary || '本节要点。'}（关联：本章其他小节）（二级：定义、适用条件、常见误区）`);
    }
    const exam = (ch.sections || []).map((sec) => {
      const concept = String((sec.points || [])[0] || sec.name).replace(/^\*\*([^*]+)\*\*.*$/, '$1').replace(/^[^：:]{1,24}[：:]/, '');
      return `${shortTitle(sec.name)}：${cleanText(concept, 40) || '核心概念'}的适用条件与易错辨析`;
    }).slice(0, 6);
    return {
      id: slugify(shortTitle(ch.name), `plate${idx + 1}`).slice(0, 24) || `plate${idx + 1}`,
      name: shortTitle(ch.name).slice(0, 40) || `板块${idx + 1}`,
      color: PLATE_COLORS[idx % PLATE_COLORS.length],
      lead: `${ch.summary || ch.name}。本板块覆盖 ${ch.sections.length} 个知识节点，重点梳理概念定义、层级关系与命题角度。`,
      points: points.slice(0, 10),
      exam,
      chapters: [ch.name]
    };
  });
}

/** 模型只给少量板块时，把未被覆盖的章补成兜底板块，保证知识图谱覆盖全部章。 */
function coverChapters(plates, chapters, max = 10) {
  const covered = new Set();
  const chapterNames = chapters.map((c) => c.name);
  plates.forEach((p) => {
    (p.chapters || []).forEach((name) => {
      const hit = chapterNames.find((c) => c === name || c.includes(name) || name.includes(c));
      if (hit) covered.add(hit);
    });
  });
  const missing = chapters.filter((ch) => !covered.has(ch.name));
  if (!missing.length) return plates;
  const extra = buildOutlinePlates(missing, { max: Math.max(0, max - plates.length) });
  return plates.concat(extra).slice(0, max);
}

/**
 * 结构目标：按小节预算反推章数（每章 4–6 节），再按资料体量微调。
 * 至少 3 章，最多 10 章；不再把整库压成 1–2 章，也不再因为没提供资料就只出 2 章。
 */
export function planStructure(sources, config = {}) {
  const chars = sources.reduce((n, s) => n + textStats(s.text).meaningful, 0);
  const maxSections = config.maxSections || 12;
  const byBudget = Math.ceil(maxSections / 5);
  const byChars = Math.ceil(chars / 3000);
  const chapters = Math.min(10, Math.max(3, byBudget, Math.max(2, byChars)));
  return { chars, chapters, sectionsPerChapter: [4, 6] };
}

/**
 * 显式传入的 title / subject / category 覆盖模型输出。
 * 必须在渲染 md 之前调用——manifest 与 content/meta 同源，否则 strict 校验报 E112。
 */
export function applyOutlineMeta(outline, meta = {}) {
  if (meta.title) outline.title = oneLine(meta.title, 60) || outline.title;
  if (meta.subject) outline.subject = oneLine(meta.subject, 40) || outline.subject;
  if (meta.category) outline.category = oneLine(meta.category, 30) || outline.category;
  if (meta.description) outline.description = oneLine(meta.description, 200) || outline.description;
  return outline;
}

const SHELL_PATTERNS = [
  /这一表述属于本节/,
  /属于本节「.*」的内容/,
  /^判断[：:]\s*「?.{0,4}」?\s*$/,
  /^(以下|下列)(说法|表述)(中)?(哪项|哪一项)?(正确|错误)/,
  /以上(都|均|全)(对|正确|错)/
];

/** 空壳题：题干没有具体概念，或解析只是复述题干/知识点原文。 */
export function isShellQuestion(q) {
  const stem = String(q?.stem || '').trim();
  const analysis = String(q?.analysis || '').trim();
  if (!stem || !analysis) return true;
  if (SHELL_PATTERNS.some((re) => re.test(stem))) return true;
  const norm = (s) => s.replace(/[\s，。、；：:,.;!？?「」“”"'（）()]/g, '');
  if (norm(analysis) === norm(stem)) return true;
  if (norm(analysis).length < 12) return true;
  return false;
}

/**
 * 分步大纲（兜底策略）：先只要章名，再逐章展开小节。
 * 只在大纲两次都达不到目标章数时启用——弱模型对“列 N 个章名”的遵循度远高于一次输出整棵树。
 */
async function stagedOutline({ llm, topic, digest, plan, reporter }) {
  const titlesRaw = await llm.chatJSON({
    task: 'outline-titles',
    system: OUTLINE_TITLES_SYSTEM,
    user: {
      instruction: `只输出 ${plan.chapters} 个章名，按学习顺序排列，只输出 JSON。`,
      topic,
      chapters: plan.chapters,
      sources: digest
    },
    maxTokens: 800
  });
  const titles = (Array.isArray(titlesRaw?.chapters) ? titlesRaw.chapters : [])
    .map((c) => oneLine(typeof c === 'string' ? c : c?.name, 40))
    .filter(Boolean)
    .slice(0, 10);
  if (titles.length < 2) return null;

  const chapters = [];
  for (const [i, title] of titles.entries()) {
    reporter?.stage('outline', 48, `展开 ${i + 1}/${titles.length} 章：${title}`);
    try {
      const raw = await llm.chatJSON({
        task: 'outline-chapter',
        system: OUTLINE_EXPAND_SYSTEM,
        user: {
          instruction: '为该章展开 4–6 个小节与知识点，只输出 JSON。',
          topic,
          chapter: title,
          sources: digest.slice(0, 3)
        },
        maxTokens: 3200
      });
      chapters.push({ name: title, summary: raw?.summary, sections: raw?.sections });
    } catch (err) {
      reporter?.warn(`第 ${i + 1} 章展开失败：${err.message}`);
    }
  }
  return chapters.length >= 2 ? chapters : null;
}

function padOptions(options, stem) {
  const list = [...options];
  const fillers = [
    '该说法只适用于与本节无关的场景',
    '所有情况下都不需要验证前提条件',
    '与本节讨论的主题没有直接关系',
    '仅适用于历史版本，当前已不再使用'
  ];
  let i = 0;
  while (list.length < 4 && i < fillers.length) {
    const filler = fillers[i++];
    if (!list.includes(filler)) list.push(filler);
  }
  while (list.length < 4) list.push(`与本知识点无关的干扰项 ${list.length + 1}`);
  const uniq = [];
  for (const opt of list) {
    const o = cleanText(opt, 80).replace(/^[A-H][.、:：)]\s*/, '');
    if (o && !uniq.includes(o)) uniq.push(o);
  }
  while (uniq.length < 4) uniq.push(`干扰项 ${sha1Hex(stem + uniq.length).slice(0, 4)}`);
  return uniq.slice(0, 4);
}

function normalizeQuestion(raw, sectionName) {
  if (!raw || typeof raw !== 'object') return null;
  const typeRaw = String(raw.type || '').toLowerCase();
  const type = /多选|multiple/.test(typeRaw) ? 'multiple'
    : /判断|judge|true/.test(typeRaw) ? 'judge'
      : 'single';
  const stem = oneLine(raw.stem, 300);
  if (!stem) return null;
  const analysis = cleanText(raw.analysis || raw.explanation, 500) || `本题考察「${sectionName}」的核心表述，请结合本节知识点理解。`;
  const difficulty = /难/.test(raw.difficulty) ? '难' : /易|简单/.test(raw.difficulty) ? '易' : '中';
  const tags = (Array.isArray(raw.tags) ? raw.tags : [sectionName])
    .map((t) => oneLine(t, 20)).filter(Boolean).slice(0, 4);
  if (!tags.length) tags.push(sectionName.slice(0, 20));
  const figure = parseFigure(raw.figure);

  if (type === 'judge') {
    const a = String(Array.isArray(raw.answer) ? raw.answer[0] : raw.answer || '');
    const answer = /^(正确|对|是|true|t|√|y|yes)$/i.test(a) ? '正确'
      : /^(错误|错|否|false|f|×|n|no)$/i.test(a) ? '错误' : '正确';
    const claim = stem.replace(/^判断\s*[：:]\s*/, '') || stem;
    return { type, stem: claim, options: [], answer: [answer], analysis, difficulty, tags, figure };
  }

  const options = padOptions(Array.isArray(raw.options) ? raw.options : [], stem);
  let answer = '';
  const rawAnswer = Array.isArray(raw.answer) ? raw.answer.join('') : String(raw.answer || '');
  const letters = rawAnswer.toUpperCase().replace(/[^A-D]/g, '').split('');
  if (type === 'single') {
    answer = letters[0] || 'A';
    if (!/^[A-D]$/.test(answer)) answer = 'A';
  } else {
    const uniq = [...new Set(letters)].sort();
    answer = uniq.length >= 2 ? uniq.join(',') : 'A,B';
  }
  return { type, stem, options, answer, analysis, difficulty, tags, figure };
}

/**
 * 兜底题：只用知识点本身的陈述做判断题，不用「这一表述属于本节内容」这类空壳。
 * 属于最后一档保底（模型补题仍失败时才会出现），因此保留原文陈述以便人工校对。
 */
function fallbackQuestion(sec) {
  const short = sec.name.replace(/^\d+(\.\d+)*\s*/, '');
  const point = String(sec.points[0] || sec.summary || '').replace(/\*\*/g, '');
  const claim = truncate(point.split('（关联')[0].replace(/^[^：:]{1,20}[：:]/, ''), 80) || short;
  return {
    type: 'judge',
    stem: claim,
    options: [],
    answer: ['正确'],
    analysis: `该表述对应本节「${short}」的知识点：${claim}。判断题干是否与教材/资料原文一致即可判定。`,
    difficulty: '易',
    tags: [short.slice(0, 20)]
  };
}

export function normalizeQuestions(raw, outline, { questionsPerSection = 2, stats, fillFallback = true } = {}) {
  const index = new Map();
  for (const ch of outline.chapters) {
    for (const sec of ch.sections) index.set(`${ch.name}||${sec.name}`, sec);
  }
  const list = Array.isArray(raw?.sections) ? raw.sections : [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const sec = index.get(`${entry.chapter}||${entry.section}`)
      || [...index.values()].find((s) => s.name === entry.section || s.name.endsWith(entry.section));
    if (!sec) continue;
    for (const q of Array.isArray(entry.questions) ? entry.questions : []) {
      const normalized = normalizeQuestion(q, sec.name.replace(/^\d+(\.\d+)*\s*/, ''));
      if (!normalized) continue;
      if (isShellQuestion(normalized)) {
        if (stats) stats.shellDropped++;
        continue;
      }
      sec.questions.push(normalized);
    }
  }

  // 兜底只在最后一次调用时执行：确保「补题」先跑，避免兜底题挤掉模型题
  if (fillFallback) {
    for (const ch of outline.chapters) {
      for (const sec of ch.sections) {
        if (!sec.questions.length) {
          sec.questions.push(fallbackQuestion(sec));
          if (stats) stats.sectionsFilled++;
        }
        sec.questions = sec.questions.slice(0, Math.max(1, questionsPerSection + 1));
      }
    }
  }

  // 去重：题干 + 选项 + 答案
  const seen = new Set();
  for (const ch of outline.chapters) {
    for (const sec of ch.sections) {
      sec.questions = sec.questions.filter((q) => {
        const key = `${q.type}|${q.stem}|${q.options.join('|')}|${q.answer}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
  }
  return outline;
}

/**
 * 兜底题组：模型没给够时按知识点生成互不重复的题目，
 * 尽可能保持「单选 / 判断」两种题型并可判定对错。
 */
function fallbackQuestions(sec, need) {
  const short = sec.name.replace(/^\d+(\.\d+)*\s*/, '');
  const items = (sec.points || []).map((p) => {
    const text = String(p).replace(/\*\*/g, '').replace(/（关联[^）]*）/g, '').replace(/（二级[^）]*）/g, '').trim();
    const concept = text.replace(/[：:].*$/, '').slice(0, 30) || short;
    return { concept, text: text.replace(/^[^：:]{1,30}[：:]\s*/, '') || text };
  }).filter((x) => x.text);
  if (!items.length) {
    items.push({ concept: short, text: sec.summary || `${short} 的核心要求。` });
  }
  const templates = [
    (c) => `关于「${c}」，下列说法正确的是？`,
    (c) => `在「${short}」中，「${c}」的判断依据是什么？`,
    (c) => `以下关于「${c}」的表述，正确的是？`,
    (c, d) => `「${c}」与「${d}」的关系，下列理解正确的是？`,
    (c) => `「${c}」在「${short}」中的适用边界是什么？`,
    (c) => `结合「${short}」，「${c}」的常见误区是？`
  ];
  const out = [];
  for (let k = 0; k < need; k++) {
    const item = items[k % items.length];
    const round = Math.floor(k / items.length);
    const next = items[(k + 1) % items.length];
    const tpl = templates[round % templates.length];
    const suffix = round >= templates.length ? `（辨析 ${round + 1}）` : '';
    const options = [item.text];
    items.forEach((x) => { if (x !== item && options.length < 3 && !options.includes(x.text)) options.push(x.text); });
    padOptions(options, item.concept).forEach((o) => { if (options.length < 4 && !options.includes(o)) options.push(o); });
    while (options.length < 4) options.push(`与「${item.concept}」无关的干扰项 ${options.length + 1}`);
    const correct = options[0];
    const shift = k % 4;
    const rotated = options.map((_, i) => options[(i + shift) % 4]);
    out.push({
      type: 'single',
      stem: tpl(item.concept, next.concept) + suffix,
      options: rotated.slice(0, 4).map((o) => cleanText(o, 80)),
      answer: 'ABCD'[rotated.indexOf(correct)],
      analysis: `依据本节「${short}」：${item.text}。其余选项与该知识点的定义或适用条件不符。`,
      difficulty: '易',
      tags: [item.concept.slice(0, 20)]
    });
  }
  return out;
}

/**
 * 严格对齐按考试权重分摊后的题量：按每节目标裁剪，缺额用兜底题补齐。
 * 目标来自 planSectionTargets，未显式填写总量时同样生效。
 */
export function finalizeQuestionCounts(outline, targetByKey, quality, { exact = true } = {}) {
  const seen = new Set();
  let filled = 0;
  for (const ch of outline.chapters) {
    for (const sec of ch.sections) {
      const target = Math.max(0, targetByKey.get(`${ch.name}||${sec.name}`) || 0);
      if (target > 0 && !sec.questions.length && quality) quality.sectionsFilled += 1;
      // 未指定总题量时不裁剪：模型按内容多出的题全部保留，题量只作为下限参考。
      const cap = exact ? target : Infinity;
      const kept = [];
      for (const q of sec.questions) {
        const key = `${q.type}|${q.stem}|${q.options.join('|')}|${Array.isArray(q.answer) ? q.answer.join('') : q.answer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        kept.push(q);
        if (kept.length >= cap) break;
      }
      if (kept.length < target) {
        // 未指定总量时保持旧行为：只给完全空白的小节补 1 道兜底题，不强行凑满目标
        const need = exact ? target - kept.length : (kept.length ? 0 : 1);
        if (need > 0) {
          const extra = fallbackQuestions(sec, need);
          filled += extra.length;
          kept.push(...extra);
        }
      }
      sec.questions = kept.slice(0, cap);
    }
  }
  if (quality) quality.fallbackQuestions = filled;
  return outline;
}

export function sourceDigest(sources, maxChars) {
  const perSource = Math.max(2000, Math.floor(maxChars / Math.max(1, sources.length)));
  return sources.map((s) => ({
    title: s.title,
    url: s.url || s.path || '',
    type: s.type,
    text: truncate(String(s.text || '').replace(/\n{3,}/g, '\n\n'), perSource)
  }));
}

/**
 * 按考试权重精确分配总数：先取整数部分，再按余数从大到小补 1，保证 sum === total。
 * 权重来自大纲里模型给出的 1–5 分（出题频率 + 知识重要程度）。
 */
export function distributeByWeight(total, weights) {
  const n = Math.max(0, Math.floor(Number(total) || 0));
  const ws = (Array.isArray(weights) ? weights : []).map((w) => examWeight(w));
  const len = ws.length;
  if (!len) return [];
  const sum = ws.reduce((a, b) => a + b, 0) || 1;
  const out = ws.map((w) => Math.floor((n * w) / sum));
  let used = out.reduce((a, b) => a + b, 0);
  const order = ws
    .map((w, i) => ({ i, rem: (n * w) % sum }))
    .sort((a, b) => b.rem - a.rem || a.i - b.i);
  let k = 0;
  while (used < n) {
    out[order[k % len].i] += 1;
    used += 1;
    k += 1;
  }
  return out;
}

/** 知识图谱生成用的章节骨架：只给结构，不重复塞大段资料。 */
function knowledgeSkeleton(outline) {
  return outline.chapters.map((ch) => ({
    name: ch.name,
    summary: ch.summary,
    sections: ch.sections.map((sec) => ({
      name: sec.name,
      summary: sec.summary,
      points: (sec.points || []).slice(0, 4)
    }))
  }));
}

/** 板块覆盖不足时，用本章小节知识点把每个板块补到至少 8 条要点。 */
function enrichPlates(plates, chapters) {
  const byName = new Map(chapters.map((c) => [c.name, c]));
  return plates.map((plate) => {
    const refs = (plate.chapters || []).map((name) => {
      const exact = byName.get(name);
      if (exact) return exact;
      const hit = chapters.find((c) => c.name.includes(name) || name.includes(c.name));
      return hit || null;
    }).filter(Boolean);
    const related = refs.length ? refs : chapters.slice(0, 1);
    const points = [...plate.points];
    const exam = [...plate.exam];
    for (const ch of related) {
      for (const [si, sec] of ch.sections.entries()) {
        if (points.length >= 8) break;
        const next = ch.sections[si + 1] || ch.sections[0];
        for (const p of sec.points || []) {
          let text = cleanText(p, 300);
          if (!text) continue;
          if (!/关联[：:]/.test(text)) text += `（关联：${shortTitle(next.name)}）`;
          if (!/二级[：:]/.test(text)) text += `（二级：定义、适用条件、常见误区）`;
          if (!points.includes(text)) points.push(text);
          if (points.length >= 8) break;
        }
        if (points.length < 8) {
          const text = cleanText(
            `**${shortTitle(sec.name)}**：${sec.summary || '本节要点。'}（关联：${shortTitle(next.name)}）（二级：定义、适用条件、常见误区）`,
            300
          );
          if (text && !points.includes(text)) points.push(text);
        }
      }
      if (exam.length < 4) {
        ch.sections.forEach((sec) => {
          if (exam.length < 6) exam.push(`${shortTitle(sec.name)}：核心概念的适用条件与易错辨析`);
        });
      }
    }
    return { ...plate, points: points.slice(0, 10), exam: exam.slice(0, 6) };
  });
}

/**
 * 独立生成详细知识图谱：层级（一级概念 + 二级子概念）与关联（（关联：…））都写进 points，
 * 避免把知识图谱挤在大纲那一次 JSON 里导致板块少、要点浅。
 */
export async function generateKnowledgeGraph({ llm, outline, digest, reporter, quality, examFocus = [] }) {
  const target = Math.max(6, Math.min(10, outline.chapters.length * 2));
  const chapters = knowledgeSkeleton(outline);
  const focus = Array.isArray(examFocus) ? examFocus : [];
  try {
    reporter?.stage('knowledge', 60, `生成知识图谱（目标 ${target} 个板块）`);
    const raw = await withHeartbeat(reporter, 'knowledge', 60, `生成知识图谱（${target} 个板块）`, () => llm.chatJSON({
      task: 'plates',
      system: PLATES_SYSTEM,
      user: {
        instruction: `为以下大纲生成 ${target} 个知识板块，只输出 JSON；板块要覆盖全部章节。`,
        plateTarget: target,
        chapters,
        examFocus: focus,
        sources: digest.slice(0, 6)
      },
      payload: { plateTarget: target, chapters, examFocus: focus, sources: digest.slice(0, 6) },
      maxTokens: 8000
    }));
    let plates = normalizePlates(raw?.plates || raw, {
      chapterNames: outline.chapters.map((c) => c.name),
      max: 10
    });
    if (plates.length) {
      plates = enrichPlates(coverChapters(plates, outline.chapters, 10), outline.chapters);
      if (quality) quality.platesGenerated = true;
      return plates;
    }
    reporter?.warn('知识图谱模型输出为空，改用大纲内容生成');
  } catch (err) {
    reporter?.warn(`知识图谱生成失败，改用大纲内容生成：${err.message}`);
  }

  const base = enrichPlates(normalizePlates(outline.plates, {
    chapterNames: outline.chapters.map((c) => c.name),
    max: 10
  }), outline.chapters);
  const plates = coverChapters(base, outline.chapters, 10);
  if (quality) quality.platesGenerated = false;
  return plates.length ? plates : buildOutlinePlates(outline.chapters, { max: 10 });
}

export function buildExamFocus(outline) {
  return outline.chapters.map((ch) => {
    const freq = new Map();
    let questions = 0;
    for (const sec of ch.sections || []) {
      for (const q of sec.questions || []) {
        questions += 1;
        for (const tag of q.tags || []) freq.set(tag, (freq.get(tag) || 0) + 1);
      }
    }
    for (const c of ch.cases || []) {
      for (const tag of c.tags || []) freq.set(tag, (freq.get(tag) || 0) + 1);
    }
    return {
      name: ch.name,
      weight: examWeight(ch.weight),
      questions,
      hotTags: [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag),
      cases: (ch.cases || []).slice(0, 4).map((c) => c.title)
    };
  });
}

export function backfillCaseCategories(outline) {
  const plateNames = (outline.plates || []).map((p) => p.name);
  const pairs = [];
  for (const plate of outline.plates || []) {
    for (const name of plate.chapters || []) pairs.push([name, plate.name]);
  }
  for (const ch of outline.chapters) {
    const hit = pairs.find(([name]) => name === ch.name || name.includes(ch.name) || ch.name.includes(name));
    if (!hit) continue;
    for (const c of ch.cases || []) {
      if (!plateNames.includes(c.category)) c.category = hit[1];
    }
  }
}

/** 把章/节摊平成列表，供分批出题使用。 */
function sectionEntries(outline) {
  const entries = [];
  for (const ch of outline.chapters) {
    for (const sec of ch.sections) entries.push({ ch, sec });
  }
  return entries;
}

/**
 * 综合章权重与节权重：章越重要、节越核心，题量越多；
 * 避免「章权重不同但节权重都填 3」时又退回平均分配。
 */
function effectiveSectionWeight(ch, sec) {
  return Math.min(5, Math.max(1, examWeight(ch && ch.weight) + examWeight(sec && sec.weight) - 3));
}

/**
 * 每节题量：给了总题量就按节权重精确分摊；
 * 没给则以 questionsPerSection 为基准，按 weight/平均权重 缩放（每节 1–20）。
 */
export function planSectionTargets(outline, questionsPerSection = 3, questionCount = 0) {
  const entries = sectionEntries(outline);
  const map = new Map();
  if (!entries.length) return map;
  const key = (ch, sec) => `${ch.name}||${sec.name}`;
  const weights = entries.map(({ ch, sec }) => effectiveSectionWeight(ch, sec));
  let counts;
  if (Number(questionCount) > 0) {
    counts = distributeByWeight(questionCount, weights);
  } else {
    const avg = weights.reduce((a, b) => a + b, 0) / weights.length || 3;
    const base = Math.max(1, Number(questionsPerSection) || 1);
    counts = weights.map((w) => Math.max(1, Math.round((base * w) / avg)));
  }
  entries.forEach(({ ch, sec }, i) => map.set(key(ch, sec), counts[i]));
  return map;
}

/** 把单章的小节摊平成列表，供「逐章出题 + 逐章确认」使用。 */
function chapterSectionEntries(chapter) {
  const entries = [];
  for (const sec of chapter.sections) entries.push({ ch: chapter, sec });
  return entries;
}

function chunkEntries(entries, size) {
  const out = [];
  for (let i = 0; i < entries.length; i += size) out.push(entries.slice(i, i + size));
  return out;
}

/** 按原章节结构组装一次出题的 payload；targetOf 给出每个小节要出满的题量。 */
function batchPayload(entries, topic, countPerSection, targetOf) {
  const byChapter = new Map();
  for (const { ch, sec } of entries) {
    if (!byChapter.has(ch.name)) byChapter.set(ch.name, { name: ch.name, sections: [] });
    const count = targetOf ? targetOf(ch, sec) : countPerSection;
    byChapter.get(ch.name).sections.push({ name: sec.name, summary: sec.summary, points: sec.points, count });
  }
  return { topic, countPerSection, chapters: [...byChapter.values()] };
}

/** 每批最多多少个小节：控制单次输出 token，避免 JSON 被截断。 */
function sectionsPerQuestionBatch(questionsPerSection) {
  return Math.max(1, Math.min(8, Math.floor(12 / Math.max(1, questionsPerSection)) || 1));
}

function cleanBlock(value, max = 1200) {
  const text = scrubBrands(String(value ?? ''))
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return truncate(text, max);
}

const ensureTag = (tag, text) => (String(text || '').startsWith(`【${tag}】`) ? String(text) : `【${tag}】${text}`);

function matchPlateName(raw, plateNames = []) {
  const text = oneLine(raw, 60);
  if (!text) return '';
  return plateNames.find((name) => name === text)
    || plateNames.find((name) => name.includes(text) || text.includes(name))
    || '';
}

/** 案例统一结构：材料（背景 + 场景）、解析（分析过程 + 结论总结）、小问。 */
export function normalizeCase(raw, { chapterName = '', plateNames = [], defaultCategory = '' } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title || raw.name, 50) || `${shortTitle(chapterName) || '综合'}案例分析`;

  const rawQuestions = Array.isArray(raw.questions)
    ? raw.questions
    : Array.isArray(raw.subQuestions) ? raw.subQuestions : [];
  const questions = [];
  for (const q of rawQuestions) {
    if (!q || typeof q !== 'object') continue;
    const stem = oneLine(q.stem || q.question || q.title, 240);
    const answer = cleanBlock(q.answer || q.reference || q.referenceAnswer, 900);
    if (!stem || !answer) continue;
    questions.push({ stem, answer, analysis: cleanBlock(q.analysis, 600) });
    if (questions.length >= 4) break;
  }
  if (!questions.length) return null;

  const background = cleanBlock(raw.background || raw.material, 900);
  const scenario = cleanBlock(raw.scenario || raw.situation || raw.detail, 1000);
  if (!background && !scenario) return null;

  const process = cleanBlock(raw.analysis || raw.process, 1600)
    || questions.map((q, i) => `${i + 1}. ${q.answer}`).join('\n');
  const conclusion = cleanBlock(raw.conclusion || raw.summary, 800)
    || '综合上述分析，先确认前提与约束，再按判断依据给出可执行结论。';
  const material = scenario
    ? `${ensureTag('背景', background || chapterName)}\n${ensureTag('场景', scenario)}`
    : ensureTag('背景', background);
  const analysisText = `${process.startsWith('【分析过程】') ? process : ensureTag('分析过程', process)}\n${ensureTag('结论总结', conclusion)}`;

  return {
    title,
    category: matchPlateName(raw.category, plateNames) || defaultCategory,
    material,
    analysis: analysisText,
    quickNote: oneLine(raw.quickNote || raw.note || '', 160),
    difficulty: ['易', '中', '难'].includes(raw.difficulty) ? raw.difficulty : '中',
    tags: (Array.isArray(raw.tags) ? raw.tags : String(raw.tags || '').split(/[,，、]/))
      .map((t) => oneLine(t, 30)).filter(Boolean).slice(0, 4),
    questions,
    figure: parseFigure(raw.figure)
  };
}

/** 案例兜底：从章节知识点拼出含背景 / 场景 / 分析过程 / 结论总结的完整案例。 */
function fallbackCases(ch, need, { plateName = '' } = {}) {
  const sections = ch.sections.length
    ? ch.sections
    : [{ name: ch.name, summary: ch.summary, points: [] }];
  const out = [];
  for (let i = 0; i < need; i++) {
    const sec = sections[i % sections.length];
    const short = shortTitle(sec.name) || shortTitle(ch.name) || '本节';
    const points = (sec.points || []).map((p) => String(p)
      .replace(/^\*\*([^*]+)\*\*[：:]\s*/, '$1：')
      .replace(/（关联[^）]*）/g, '')
      .replace(/（二级[^）]*）/g, '')
      .trim()).filter(Boolean);
    const concept = (points[0] || short).replace(/[：:].*$/, '').slice(0, 30);
    const detail = points.join('；') || sec.summary || ch.summary || `${short} 的核心要求`;
    out.push({
      title: `${short}案例${i + 1}`,
      category: plateName,
      material:
        `【背景】${ch.summary || ch.name}。本案例围绕「${short}」展开，需要在给定约束下判断「${concept}」的适用条件。`
        + `\n【场景】资料给出了「${short}」的原则与要点，但实际执行中出现边界情形：条件相互冲突，需要依据「${concept}」逐项核对后给出结论。`,
      analysis:
        `【分析过程】\n1. 先确认前提：${points[0] || detail}\n2. 再比对约束：${points[1] || detail}\n3. 最后核对结论是否满足「${short}」的要求。`
        + `\n【结论总结】应按「${concept}」的定义先判断适用边界，再用材料中的事实逐条验证，最后给出可执行的结论。`,
      quickNote: `识别场景 → 确认${concept} → 比对约束 → 给出结论`,
      difficulty: '中',
      tags: [concept].filter(Boolean),
      questions: [
        {
          stem: `结合材料，说明「${short}」中「${concept}」的适用条件与判断依据。`,
          answer: `${points.join('；') || detail}。据此可确定本案例的结论。`,
          analysis: '按定义、适用条件、材料比对三步作答。'
        },
        {
          stem: '如果材料中的约束发生变化，结论应如何调整？',
          answer: `先检查变化是否触及「${concept}」的适用边界；若仍满足前提则维持原结论，否则按新的约束重新判断并说明依据。`,
          analysis: '考察边界条件与结论的对应关系。'
        }
      ]
    });
  }
  return out;
}

/** 案例按章权重分配：高频章节多分案例，且严格求和等于用户填写的案例数。 */
export function planCaseCounts(outline, count) {
  const chapters = outline.chapters || [];
  const counts = distributeByWeight(count, chapters.map((ch) => ch.weight));
  return chapters.map((ch, i) => ({ ch, count: counts[i] }));
}

/**
 * 生成案例精析：按用户填写的案例数精确分配，先批量请求，缺额再补一次，
 * 最后从章节知识点生成兜底案例，保证条目数与配置完全一致。
 */
export async function generateCases({ llm, outline, digest, count, reporter, quality }) {
  const plan = planCaseCounts(outline, count).filter((x) => x.count > 0);
  if (!plan.length) return 0;
  const plateNames = (outline.plates || []).map((p) => p.name);
  const plateForChapter = (ch) => {
    const hit = (outline.plates || []).find((p) => (p.chapters || []).some((name) => name === ch.name));
    return hit ? hit.name : '';
  };

  const collect = async (entries, label) => {
    const want = entries.reduce((n, e) => n + e.count, 0);
    if (!want) return [];
    const payload = {
      topic: outline.title,
      caseCount: want,
      plates: plateNames,
      chapters: entries.map(({ ch, count: n, offset: o = 0 }) => ({
        name: ch.name,
        summary: ch.summary,
        count: n,
        alreadyGenerated: o,
        sections: ch.sections.map((sec) => ({ name: sec.name, summary: sec.summary, points: sec.points }))
      })),
      sources: digest.slice(0, 3)
    };
    reporter?.stage('cases', 71, `生成案例：${label}（${want} 个）`);
    try {
      const raw = await withHeartbeat(reporter, 'cases', 71, `生成案例：${label}（${want} 个）`, () => llm.chatJSON({
        task: 'cases',
        system: CASE_SYSTEM,
        user: { instruction: `为以下章节写 ${want} 个案例，只输出 JSON。`, ...payload },
        payload,
        maxTokens: Math.min(8000, Math.max(4000, want * 1800))
      }));
      const list = Array.isArray(raw?.cases) ? raw.cases : Array.isArray(raw) ? raw : [];
      const slots = [];
      entries.forEach(({ ch, count: n }) => { for (let i = 0; i < n; i++) slots.push(ch.name); });
      const out = [];
      list.forEach((item, idx) => {
        const matched = entries.find((e) => item && item.chapter
          && (e.ch.name.includes(item.chapter) || item.chapter.includes(shortTitle(e.ch.name))));
        const chapterName = matched ? matched.ch.name : slots[Math.min(idx, slots.length - 1)];
        const ch = outline.chapters.find((c) => c.name === chapterName);
        const normalized = normalizeCase(item, {
          chapterName,
          plateNames,
          defaultCategory: ch ? plateForChapter(ch) : ''
        });
        if (normalized) out.push({ ...normalized, chapter: chapterName });
      });
      return out;
    } catch (err) {
      if (quality) quality.caseBatchesFailed = (quality.caseBatchesFailed || 0) + 1;
      reporter?.warn(`案例生成失败（${label}）：${err.message}`);
      return [];
    }
  };

  /* 单批最多 4 个案例、3 章：案例正文长，批次过大会让 JSON 被截断。 */
  const CASE_BATCH_MAX = 4;
  const CASE_BATCH_CHAPTERS = 3;
  const batches = [];
  let batch = [];
  let batchCount = 0;
  const offsets = new Map();
  for (const entry of plan) {
    let rest = entry.count;
    while (rest > 0) {
      const room = CASE_BATCH_MAX - batchCount;
      if (room <= 0) {
        batches.push(batch);
        batch = [];
        batchCount = 0;
        continue;
      }
      const last = batch[batch.length - 1];
      if (last && last.ch === entry.ch) {
        const take = Math.min(rest, room);
        last.count += take;
        batchCount += take;
        rest -= take;
        continue;
      }
      if (batch.length >= CASE_BATCH_CHAPTERS) {
        batches.push(batch);
        batch = [];
        batchCount = 0;
        continue;
      }
      const take = Math.min(rest, room);
      const offset = offsets.get(entry.ch.name) || 0;
      batch.push({ ch: entry.ch, count: take, offset });
      offsets.set(entry.ch.name, offset + take);
      batchCount += take;
      rest -= take;
    }
  }
  if (batch.length) batches.push(batch);

  /* 案例批次互不依赖：并发请求，结果按批次顺序合并，墙钟时间约为串行的 1/N */
  const concurrency = Math.max(1, Number(llm?.config?.llmConcurrency) || 1);
  const chunks = await mapLimit(batches, concurrency, (entries, i) =>
    collect(entries, `第 ${i + 1}/${batches.length} 批`));
  const collected = [];
  chunks.forEach((list) => collected.push(...list));

  const have = () => {
    const map = new Map();
    collected.forEach((c) => map.set(c.chapter, (map.get(c.chapter) || 0) + 1));
    return map;
  };
  const missing = () => {
    const got = have();
    return plan
      .map(({ ch, count: n }) => {
        const done = got.get(ch.name) || 0;
        return { ch, count: Math.max(0, n - done), offset: done };
      })
      .filter((x) => x.count > 0);
  };
  const gap = missing();
  if (gap.length) {
    collected.push(...await collect(gap, '缺额补生成'));
  }

  const byChapter = new Map();
  collected.forEach((c) => {
    if (!byChapter.has(c.chapter)) byChapter.set(c.chapter, []);
    byChapter.get(c.chapter).push(c);
  });

  let filled = 0;
  const planned = new Set(plan.map((e) => e.ch.name));
  outline.chapters.forEach((ch) => {
    if (!planned.has(ch.name)) { ch.cases = []; return; }
    const target = plan.find((e) => e.ch.name === ch.name).count;
    let list = (byChapter.get(ch.name) || []).slice(0, target);
    if (list.length < target) {
      const extra = fallbackCases(ch, target - list.length, { plateName: plateForChapter(ch) });
      filled += extra.length;
      list = list.concat(extra);
    }
    ch.cases = list.slice(0, target);
  });

  const total = outline.chapters.reduce((n, ch) => n + (ch.cases || []).length, 0);
  if (quality) {
    quality.casesTarget = count;
    quality.casesGenerated = collected.length;
    quality.casesFilled = filled;
  }
  return total;
}

/**
 * 只生成大纲（供交互式流程在「出题」前拿给用户确认 / 微调）。
 * 返回 normalize 后的 outline 与质量标记，generateStudyLibrary 可直接复用，
 * 从而把「采集 → 大纲确认 → 逐章生成」拆成可暂停的两段。
 */
export async function generateOutlineRaw({ topic, sources, llm, config, reporter, meta }) {
  const digest = sourceDigest(sources, config.maxSourceChars);
  const plan = planStructure(sources, config);
  const quality = {
    planChapters: plan.chapters,
    outlineRetried: false,
    outlineStaged: false,
    outlineFallback: false,
    questionBatchesFailed: 0,
    shellDropped: 0,
    sectionsFilled: 0,
    platesGenerated: false
  };
  reporter?.stage('outline', 40, `生成大纲（${sources.length} 个输入源，目标 ${plan.chapters} 章）`);

  let outline = null;
  let outlineRaw = null;
  let outlineError = null;
  try {
    outlineRaw = await llm.chatJSON({
      task: 'outline',
      system: OUTLINE_SYSTEM,
      user: {
        instruction: '根据以下资料整理学习库大纲，只输出 JSON。',
        topic,
        structure: { chapters: plan.chapters, sectionsPerChapter: '4-6', maxSections: config.maxSections },
        maxSections: config.maxSections,
        sources: digest
      },
      payload: { topic, sources: digest, maxSections: config.maxSections },
      maxTokens: 8000
    });
    outline = applyOutlineMeta(normalizeOutline(outlineRaw, { topic, config }), meta);
  } catch (err) {
    outlineError = err;
    // 空大纲（LA011）与模型空输出（LA008）都值得退到分步大纲；鉴权等硬错误直接抛。
    if (!err.retryable && err.code !== 'LA011') throw err;
    reporter?.warn(`一次生成大纲失败（${err.code || 'LA008'}），改用分步大纲：${err.message}`);
    quality.outlineFallback = true;
  }

  // 模型把整库压成 1–2 章时补一次：显式给出目标章数与上一版结构
  if (outline && outline.chapters.length < plan.chapters) {
    quality.outlineRetried = true;
    reporter?.stage('outline', 46, `大纲仅 ${outline.chapters.length} 章，补足到 ${plan.chapters} 章`);
    try {
      const retryRaw = await llm.chatJSON({
        task: 'outline',
        system: OUTLINE_SYSTEM,
        user: {
          instruction:
            `上一版只有 ${outline.chapters.length} 章，不满足 structure.chapters=${plan.chapters}。`
            + '请重新输出完整大纲，章数必须达到要求，且各章主题相互独立。',
          topic,
          structure: { chapters: plan.chapters, sectionsPerChapter: '4-6', maxSections: config.maxSections },
          previous: outline.chapters.map((ch) => ({
            name: ch.name.replace(/^第.+?章\s*/, ''),
            sections: ch.sections.map((sec) => sec.name.replace(/^\d+(\.\d+)*\s*/, ''))
          })),
          sources: digest
        },
        maxTokens: 8000
      });
      const retried = applyOutlineMeta(normalizeOutline(retryRaw, { topic, config }), meta);
      if (retried.chapters.length > outline.chapters.length) outline = retried;
    } catch (err) {
      reporter?.warn(`大纲补足失败，沿用首版：${err.message}`);
    }
  }

  // 一次调用失败，或两次都达不到目标章数时，改为分步生成：先章名，再逐章展开。
  if (!outline || outline.chapters.length < plan.chapters) {
    try {
      const staged = await stagedOutline({ llm, topic, digest, plan, reporter });
      if (staged) {
        const base = outlineRaw ? { ...outlineRaw, chapters: staged } : { title: topic, chapters: staged };
        const rebuilt = applyOutlineMeta(normalizeOutline(base, { topic, config }), meta);
        if (!outline || rebuilt.chapters.length > outline.chapters.length) {
          outline = rebuilt;
          quality.outlineStaged = true;
        }
      }
    } catch (err) {
      reporter?.warn(`分步大纲失败，沿用上一版：${err.message}`);
    }
  }

  if (!outline) {
    if (outlineError) throw outlineError;
    throw new AgentError('LA011', '大纲为空：模型没有给出可用章节', {
      hint: '换用能力更强的模型，或减少单次输入的资料量后重试'
    });
  }

  // 知识图谱放到选择题与案例精析之后生成（见 generateStudyLibrary），这里只产出目录。
  return { outline, quality, digest, plan };
}

export async function generateStudyLibrary({
  topic, sources, llm, config, reporter, meta, outline, outlineQuality,
  questionsPerSectionOverride, questionCount = 0, caseCount = 0, chapterHook
}) {
  const qps = questionsPerSectionOverride || config.questionsPerSection;
  let quality;
  if (outline) {
    // 交互式流程已生成并确认大纲，这里跳过重复出大纲，直接进入出题。
    quality = {
      planChapters: outline.chapters.length,
      outlineRetried: false,
      outlineStaged: false,
      outlineFallback: false,
      questionBatchesFailed: 0,
      shellDropped: 0,
      sectionsFilled: 0,
      ...(outlineQuality || {})
    };
  } else {
    const pre = await generateOutlineRaw({ topic, sources, llm, config, reporter, meta });
    outline = pre.outline;
    quality = pre.quality;
  }

  const digest = sourceDigest(sources, Math.min(config.maxSourceChars, 40_000));

  // 案例精析：用户填写了案例数才生成；知识图谱还没生成，category 先留空。
  if (caseCount > 0) {
    await generateCases({ llm, outline, digest, count: caseCount, reporter, quality });
  }

  // 题量按考试权重分摊：高频章/节多出题，低频章/节少出题，不再按章节平均分配。
  const targetByKey = planSectionTargets(outline, qps, questionCount);
  const targetOf = (ch, sec) => targetByKey.get(`${ch.name}||${sec.name}`) || 0;
  const maxTarget = Math.max(1, ...targetByKey.values());
  const budgetOf = (entries) => Math.min(8000, Math.max(
    2000,
    entries.reduce((n, { ch, sec }) => n + targetOf(ch, sec), 0) * 260 + 1200
  ));

  // 按章分批出题：每章内部再按 perBatch 分片，控制单次输出 token；章与章之间不混批。
  const perBatch = sectionsPerQuestionBatch(maxTarget);
  let stopAskingChapters = false;

  for (const [ci, ch] of outline.chapters.entries()) {
    const chEntries = chapterSectionEntries(ch).filter(({ sec }) => targetOf(ch, sec) > 0);
    const chBatches = chunkEntries(chEntries, perBatch);
    const chConcurrency = Math.max(1, Number(config.llmConcurrency) || 1);
    /* 同一章的各批互不依赖：并发请求，拿到结果后再按批次顺序写回（normalizeQuestions 会跨小节去重） */
    const raws = await mapLimit(chBatches, chConcurrency, async (entries, j) => {
      const pct = 58 + Math.round(((ci + (j + 1) / Math.max(1, chBatches.length)) / Math.max(1, outline.chapters.length)) * 12);
      const label = `生成题目：第 ${ci + 1}/${outline.chapters.length} 章 · 第 ${j + 1}/${chBatches.length} 批`;
      reporter?.stage('questions', pct, label);
      const payload = batchPayload(entries, topic, qps, targetOf);
      try {
        return await withHeartbeat(reporter, 'questions', pct, label, () => llm.chatJSON({
          task: 'questions',
          system: QUESTION_SYSTEM,
          user: { instruction: '为以下章节出题，只输出 JSON；每个小节按 count 精确出题，不要多也不要少。', ...payload },
          payload,
          maxTokens: budgetOf(entries)
        }));
      } catch (err) {
        quality.questionBatchesFailed++;
        reporter?.warn(`第 ${ci + 1}/${outline.chapters.length} 章第 ${j + 1}/${chBatches.length} 批出题失败，稍后补题：${err.message}`);
        return null;
      }
    });
    raws.forEach((qRaw) => {
      if (!qRaw) return;
      normalizeQuestions(qRaw, outline, {
        questionsPerSection: maxTarget,
        stats: quality,
        fillFallback: false
      });
    });

    // 逐章确认：每生成完一章，让上层决定继续 / 中止 / 之后不再询问。
    if (chapterHook && !stopAskingChapters) {
      const qi = ch.sections.reduce((n, s) => n + s.questions.length, 0);
      const choice = await chapterHook({
        qid: `chapter-${ci}`,
        prompt: `第 ${ci + 1}/${outline.chapters.length} 章「${ch.name}」已生成 ${qi} 题，是否继续？`,
        data: { index: ci, total: outline.chapters.length, name: ch.name, questions: qi }
      });
      if (choice === 'abort') {
        throw new AgentError('LA018', '用户中止了逐章生成');
      }
      if (choice === 'ok-all') stopAskingChapters = true;
    }
  }

  // 题量不足的小节再补一次；仍不足才走兜底题
  const weak = [];
  for (const ch of outline.chapters) {
    for (const sec of ch.sections) {
      if (sec.questions.length < targetOf(ch, sec)) weak.push({ ch, sec });
    }
  }
  if (weak.length) {
    reporter?.stage('questions', 70, `${weak.length} 个小节题量不足，补题`);
    const missingOf = (ch, sec) => Math.max(0, targetOf(ch, sec) - sec.questions.length);
    const weakBatches = chunkEntries(weak, perBatch);
    const weakRaws = await mapLimit(weakBatches, Math.max(1, Number(config.llmConcurrency) || 1), async (entries, i) => {
      const payload = batchPayload(entries, topic, qps, missingOf);
      try {
        return await withHeartbeat(reporter, 'questions', 70, `补题第 ${i + 1}/${weakBatches.length} 批`, () => llm.chatJSON({
          task: 'questions',
          system: QUESTION_SYSTEM,
          user: { instruction: '以下小节题量不足，请为每个小节按 count 补齐到目标题量，不要重复也不要用空壳题。', ...payload },
          payload,
          maxTokens: Math.min(8000, Math.max(2000, entries.reduce((n, { ch, sec }) => n + missingOf(ch, sec), 0) * 260 + 1200))
        }));
      } catch (err) {
        quality.questionBatchesFailed++;
        reporter?.warn(`补题第 ${i + 1}/${weakBatches.length} 批失败：${err.message}`);
        return null;
      }
    });
    weakRaws.forEach((qRaw) => {
      if (!qRaw) return;
      normalizeQuestions(qRaw, outline, {
        questionsPerSection: maxTarget,
        stats: quality,
        fillFallback: false
      });
    });
  }
  finalizeQuestionCounts(outline, targetByKey, quality, { exact: questionCount > 0 });
  if (questionCount > 0) quality.questionTarget = questionCount;

  // 选择题与案例精析都完成后，最后一步才生成知识图谱。
  outline.plates = await generateKnowledgeGraph({
    llm, outline, digest, reporter, quality, examFocus: buildExamFocus(outline)
  });
  backfillCaseCategories(outline);
  reporter?.stage(
    'knowledge',
    70,
    `已生成 ${outline.chapters.length} 章 / ${outline.plates.length} 个知识板块 / ${outline.plates.reduce((n, p) => n + p.points.length, 0)} 个知识节点`
  );

  reporter?.stage('render', 74, '渲染 kshare Markdown');
  outline.plates.forEach((plate, idx) => {
    plate.diagram = `images/plate-${String(idx + 1).padStart(2, '0')}.svg`;
    plate.diagramNote = `${plate.name} 的知识关联示意`;
  });
  ensureDir(meta.workDir);
  const imagesDir = path.join(meta.workDir, 'images');
  ensureDir(imagesDir);
  // 配图：把题目/案例里的结构化 figure 渲染成 SVG，题目图拼进题干。
  const figureImages = attachFigures(outline, imagesDir);
  const render = renderLibraryMarkdown({ meta, outline });
  const mdPath = path.join(meta.workDir, 'library.md');
  /* 最后一道保险：整份 Markdown 再过一遍，确保任何字段都没有来源 / 推广标记 */
  fs.writeFileSync(mdPath, scrubBrands(render.md), 'utf8');

  // 图解 SVG
  const diagrams = [];
  outline.plates.forEach((plate, idx) => {
    const file = `plate-${String(idx + 1).padStart(2, '0')}.svg`;
    fs.writeFileSync(path.join(imagesDir, file), renderPlateSvg(plate, idx), 'utf8');
    diagrams.push({ plate: plate.id, file: `images/${file}` });
  });

  reporter?.stage('render', 76, '执行 kshare 严格校验');
  const jsonPath = path.join(meta.workDir, 'library.json');
  const result = spawnSync(process.execPath, [KSHARE, mdPath, '-o', jsonPath, '--strict'], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new AgentError('LA009', '生成内容未通过 kshare 严格校验', {
      hint: '查看 details.stderr 中的 E0xx / W0xx 与行号',
      details: { stdout: result.stdout?.slice(-4000), stderr: result.stderr?.slice(-4000) }
    });
  }

  const libraryJson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const stats = {
    chapters: outline.chapters.length,
    sections: outline.chapters.reduce((n, c) => n + c.sections.length, 0),
    questions: outline.chapters.reduce((n, c) => n + c.sections.reduce((m, s) => m + s.questions.length, 0), 0),
    cases: outline.chapters.reduce((n, c) => n + (c.cases || []).length, 0),
    plates: outline.plates.length,
    points: outline.plates.reduce((n, p) => n + p.points.length, 0),
    diagrams: diagrams.length,
    figureImages: figureImages.length,
    sourceChars: sources.reduce((n, s) => n + textStats(s.text).meaningful, 0),
    quality: { ...quality, actualChapters: outline.chapters.length }
  };

  return {
    outline,
    libraryJson,
    md: render.md,
    mdPath,
    jsonPath,
    diagrams,
    stats,
    kshare: { stdout: result.stdout, stderr: result.stderr }
  };
}

/* ------------------------------ Markdown 渲染 ------------------------------ */

function yamlValue(value) {
  const s = String(value ?? '').replace(/\r?\n/g, ' ').trim();
  return /^[\[\]{}&*#?|\-<>=!%@`]/.test(s) || s.includes(': ') ? JSON.stringify(s) : s;
}

export function renderLibraryMarkdown({ meta, outline }) {
  const lines = [];
  lines.push('---');
  lines.push('schema: kshare/v1');
  lines.push(`slug: ${meta.slug}`);
  lines.push(`title: ${yamlValue(outline.title)}`);
  lines.push(`subject: ${yamlValue(outline.subject)}`);
  lines.push(`category: ${yamlValue(outline.category)}`);
  lines.push('rights: original');
  lines.push(`license: ${meta.license || 'CC-BY-NC-4.0'}`);
  lines.push(`version: ${meta.version}`);
  lines.push(`updated: ${meta.updated}`);
  if (meta.exam) lines.push(`exam: ${yamlValue(meta.exam)}`);
  if (meta.year) lines.push(`year: ${meta.year}`);
  lines.push(`author: ${yamlValue(meta.author || 'AimCram Learning Agent')}`);
  lines.push('language: zh-CN');
  if (meta.tags?.length) lines.push(`tags: [${meta.tags.map((t) => yamlValue(t)).join(', ')}]`);
  lines.push(`description: ${yamlValue(outline.description)}`);
  lines.push(`x-generator: ${meta.generator}`);
  lines.push(`x-generator-version: ${meta.generatorVersion}`);
  lines.push(`x-generation-mode: ${meta.mode}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${outline.title}`);
  lines.push('');
  /* 直采模式没有知识图谱，跳过整个区块，避免空标题触发 kshare 警告 */
  if (outline.plates.length) {
  lines.push('## 知识图谱');
  lines.push('');
  for (const plate of outline.plates) {
    lines.push(`### 板块｜${plate.name}`);
    lines.push(`- 标识：${plate.id}`);
    lines.push(`- 颜色：${plate.color}`);
    lines.push(`- 导语：${plate.lead}`);
    lines.push('- 知识点：');
    plate.points.forEach((p) => lines.push(`  - ${p}`));
    if (plate.exam.length) {
      lines.push('- 高频考点：');
      plate.exam.forEach((e) => lines.push(`  - ${e}`));
    }
    const diagram = plate.diagram;
    if (diagram) {
      lines.push(`- 图解：${diagram}`);
      lines.push(`- 图解说明：${plate.diagramNote || `${plate.name} 的知识关联示意`}`);
    }
    lines.push(`- 关联章节：${plate.chapters.join(', ')}`);
    lines.push('');
  }
  }

  const typeLabel = { single: '单选', multiple: '多选', judge: '判断' };
  for (const ch of outline.chapters) {
    const chCases = ch.cases || [];
    // 题量很小时，部分小节分配不到题目：不渲染空小节，否则 kshare 会以 W004 丢弃它。
    // 若整章只剩案例，保留首节作为案例挂载点，避免案例无处安放。
    const visible = ch.sections.filter((sec) => sec.questions.length > 0);
    if (!visible.length && chCases.length && ch.sections.length) visible.push(ch.sections[0]);
    if (!visible.length) continue;
    lines.push(`## ${ch.name}`);
    lines.push('');
    for (const sec of visible) {
      lines.push(`### ${sec.name}`);
      lines.push('');
      sec.questions.forEach((q, qi) => {
        lines.push(`#### ${typeLabel[q.type] || '单选'} ${qi + 1}`);
        lines.push(`- 题干：${q.stem}`);
        if (q.type !== 'judge') {
          lines.push('- 选项：');
          q.options.forEach((opt, oi) => lines.push(`  - ${'ABCD'[oi]}. ${opt}`));
        }
        lines.push(`- 答案：${Array.isArray(q.answer) ? q.answer.join('') : q.answer}`);
        lines.push(`- 解析：${q.analysis}`);
        lines.push(`- 难度：${q.difficulty}`);
        if (q.tags?.length) lines.push(`- 标签：[${q.tags.join(', ')}]`);
        lines.push('');
      });
    }

    // 案例精析挂在章下：每个案例都带背景/场景/分析过程/结论总结，外加 2–3 个小问。
    chCases.forEach((c, ci) => {
      lines.push(`#### 案例 ${ci + 1}｜${c.title}`);
      lines.push('- 材料：');
      String(c.material || '').split('\n').forEach((l) => lines.push(`  ${l}`));
      if (c.category) lines.push(`- 分类：${c.category}`);
      if (c.figurePath) lines.push(`- 图解：${c.figurePath}`);
      if (c.quickNote) lines.push(`- 速记：${c.quickNote}`);
      lines.push('- 解析：');
      String(c.analysis || '').split('\n').forEach((l) => lines.push(`  ${l}`));
      lines.push(`- 难度：${c.difficulty || '中'}`);
      if (c.tags?.length) lines.push(`- 标签：[${c.tags.join(', ')}]`);
      (c.questions || []).forEach((q, qi) => {
        lines.push(`##### 小问 ${qi + 1}`);
        lines.push(`- 题干：${q.stem}`);
        lines.push('- 参考答案：');
        String(q.answer || '').split('\n').forEach((l) => lines.push(`  ${l}`));
        if (q.analysis) lines.push(`- 解析：${q.analysis}`);
      });
      lines.push('');
    });
  }
  return { md: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n' };
}

/* ---------------- 题目 / 案例配图 ---------------- */

const FIGURE_FONT = "'PingFang SC', 'Microsoft YaHei', sans-serif";

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function figureList(value, max, cell) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => oneLine(typeof item === 'string' ? item : item?.text, cell))
    .filter(Boolean)
    .slice(0, max);
}

/**
 * 解析模型给出的结构化 figure；只在题目/案例确实依赖图示时使用。
 * 支持 flow / layers（步骤、层级）与 table（对比表）三种低风险图形。
 */
export function parseFigure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kindRaw = String(raw.kind || '').toLowerCase();
  const kind = /table|表/.test(kindRaw) ? 'table'
    : /layer|层/.test(kindRaw) ? 'layers' : 'flow';
  const title = oneLine(raw.title, 24);
  const items = figureList(raw.items, 6, 60);
  const columns = figureList(raw.columns, 4, 16);
  const rows = (Array.isArray(raw.rows) ? raw.rows : [])
    .map((row) => (Array.isArray(row) ? row : [row])
      .map((cell) => oneLine(cell, 28))
      .slice(0, Math.max(1, columns.length)))
    .filter((row) => row.length)
    .slice(0, 8);
  if (kind === 'table') {
    if (columns.length < 2 || !rows.length) return null;
  } else if (items.length < 2) {
    return null;
  }
  return { kind, title, items, columns, rows };
}

/** 把结构化 figure 渲染成确定性 SVG（无脚本、无外链、无 foreignObject）。 */
export function renderFigureSvg(figure) {
  const W = 760;
  const PAD = 34;
  const ACCENT = '#4263eb';
  const INK = '#1f2933';
  const title = escapeXml(figure.title || (figure.kind === 'table' ? '对比表' : '流程示意'));
  if (figure.kind === 'table') {
    const cols = Math.max(2, figure.columns.length);
    const rows = figure.rows;
    const colW = (W - PAD * 2) / cols;
    const headerH = 40;
    const rowH = 38;
    const top = 64;
    const H = top + headerH + rows.length * rowH + 20;
    const cellChars = Math.max(3, Math.floor((colW - 18) / 12));
    const head = figure.columns.slice(0, cols).map((col, i) => (
      `<text x="${(PAD + i * colW + 10).toFixed(1)}" y="${top + 26}" font-size="13" font-weight="600" fill="#ffffff" font-family="${FIGURE_FONT}">${escapeXml(truncate(col, cellChars))}</text>`
    )).join('');
    const body = rows.map((row, ri) => {
      const y = top + headerH + ri * rowH;
      const fill = ri % 2 === 0 ? '#ffffff' : '#f1f3f5';
      const cells = Array.from({ length: cols }, (_, ci) => {
        const text = escapeXml(truncate(row[ci] || '', cellChars));
        return `<text x="${(PAD + ci * colW + 10).toFixed(1)}" y="${y + 24}" font-size="13" fill="${INK}" font-family="${FIGURE_FONT}">${text}</text>`;
      }).join('');
      return `<rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${rowH}" fill="${fill}"/>${cells}`;
    }).join('\n  ');
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
  <rect width="${W}" height="${H}" fill="#f7f8fa"/>
  <text x="${PAD}" y="44" font-size="16" font-weight="600" fill="${INK}" font-family="${FIGURE_FONT}">${title}</text>
  <rect x="${PAD}" y="${top}" width="${W - PAD * 2}" height="${headerH}" rx="6" fill="${ACCENT}"/>
  ${head}
  ${body}
  <rect x="${PAD}" y="${top}" width="${W - PAD * 2}" height="${headerH + rows.length * rowH}" rx="6" fill="none" stroke="#dee2e6"/>
</svg>
`;
  }
  const stacked = figure.kind === 'layers';
  const boxH = 48;
  const gap = 26;
  const top = 72;
  const H = top + figure.items.length * (boxH + gap) + 18;
  const boxes = figure.items.map((item, i) => {
    const y = top + i * (boxH + gap);
    const inset = stacked ? i * 26 : 0;
    const x = PAD + inset;
    const w = W - PAD * 2 - inset * 2;
    const maxChars = Math.max(4, Math.floor((w - 36) / 14));
    const label = escapeXml(truncate(item, maxChars));
    const fill = stacked && i % 2 === 1 ? '#ffffff' : '#fdfdff';
    const cx = PAD + 30 + inset;
    const line = i > 0
      ? `<line x1="${cx}" y1="${top + (i - 1) * (boxH + gap) + boxH}" x2="${cx}" y2="${y}" stroke="${ACCENT}" stroke-width="2" stroke-dasharray="4 3"/>`
      : '';
    return `${line}
  <rect x="${x}" y="${y}" width="${w}" height="${boxH}" rx="10" fill="${fill}" stroke="${ACCENT}" stroke-width="1.5"/>
  <circle cx="${cx}" cy="${y + boxH / 2}" r="13" fill="${ACCENT}"/>
  <text x="${cx}" y="${y + boxH / 2 + 5}" font-size="13" fill="#ffffff" text-anchor="middle" font-family="${FIGURE_FONT}">${i + 1}</text>
  <text x="${PAD + 54 + inset}" y="${y + boxH / 2 + 5}" font-size="14" fill="${INK}" font-family="${FIGURE_FONT}">${label}</text>`;
  }).join('\n  ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
  <rect width="${W}" height="${H}" fill="#f7f8fa"/>
  <text x="${PAD}" y="44" font-size="16" font-weight="600" fill="${INK}" font-family="${FIGURE_FONT}">${title}</text>
  ${boxes}
</svg>
`;
}

/**
 * 把题目/案例里的 figure 落盘为 images/*.svg：
 * 题目图拼进题干（Markdown 图片，随 kshare 内联），案例图写入「图解」字段。
 */
export function attachFigures(outline, imagesDir) {
  const files = [];
  outline.chapters.forEach((ch, ci) => {
    ch.sections.forEach((sec, si) => {
      sec.questions.forEach((q, qi) => {
        if (!q.figure) return;
        const file = `q-${String(ci + 1).padStart(2, '0')}-${String(si + 1).padStart(2, '0')}-${String(qi + 1).padStart(2, '0')}.svg`;
        fs.writeFileSync(path.join(imagesDir, file), renderFigureSvg(q.figure), 'utf8');
        q.stem = `${q.stem} ![](images/${file})`;
        delete q.figure;
        files.push(`images/${file}`);
      });
    });
    (ch.cases || []).forEach((c, ki) => {
      if (!c.figure) return;
      const file = `case-${String(ci + 1).padStart(2, '0')}-${ki + 1}.svg`;
      fs.writeFileSync(path.join(imagesDir, file), renderFigureSvg(c.figure), 'utf8');
      c.figurePath = `images/${file}`;
      delete c.figure;
      files.push(c.figurePath);
    });
  });
  return files;
}

/** 生成简洁的知识关联 SVG 图解（无脚本、无外链）。 */
export function renderPlateSvg(plate, index = 0) {
  const colors = ['#4263eb', '#0ca678', '#f76707', '#7048e8', '#1098ad', '#e8590c'];
  const color = plate.color || colors[index % colors.length];
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const title = esc(truncate(plate.name, 18));
  const points = (plate.points || []).slice(0, 3).map((p) => esc(truncate(p.replace(/\*\*/g, '').split('（关联')[0], 22)));
  const W = 720;
  const H = 320;
  const boxes = points.map((text, i) => {
    const y = 90 + i * 66;
    return `
    <g>
      <rect x="56" y="${y}" width="608" height="48" rx="10" fill="#ffffff" stroke="${color}" stroke-width="1.5"/>
      <circle cx="82" cy="${y + 24}" r="11" fill="${color}" opacity="0.14"/>
      <text x="82" y="${y + 29}" font-size="13" text-anchor="middle" fill="${color}">${i + 1}</text>
      <text x="102" y="${y + 29}" font-size="14" fill="#212529">${text}</text>
    </g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
  <rect width="${W}" height="${H}" fill="#f8f9fa"/>
  <text x="56" y="50" font-size="22" font-weight="600" fill="#212529">${title}</text>
  <text x="56" y="74" font-size="13" fill="#868e96">知识关联示意 · 自动生成</text>
  <line x1="82" y1="104" x2="82" y2="${90 + Math.max(0, points.length - 1) * 66 + 24}" stroke="${color}" stroke-width="2" stroke-dasharray="4 4"/>
  ${boxes}
</svg>
`;
}
