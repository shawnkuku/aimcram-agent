/**
 * 离线确定性生成器（MockLLM）
 *
 * 用途：
 *   1. 没有 DEEPSEEK_API_KEY 时仍能跑通「解析 → 生成 → 组包 → 校验」全链路；
 *   2. 测试用例可重复、零网络；
 *   3. 作为 live 模式失败时的兜底（需显式 --mock）。
 *
 * 它不做「假装是 LLM」的事：按标题层级切分原始资料，从各节自己的段落中抽取句子，
 * 组织成章节 / 知识点 / 题目；产物在 manifest.provenance.generator 中明确标记为 mock。
 */

import crypto from 'node:crypto';
import { splitSentences, keywords, truncate, slugify } from './util.mjs';

function hashInt(text) {
  return parseInt(crypto.createHash('sha1').update(String(text)).digest('hex').slice(0, 8), 16);
}

function pick(array, seed) {
  if (!array.length) return null;
  return array[hashInt(seed) % array.length];
}

function shortName(name) {
  return String(name || '').replace(/^\d+(\.\d+)*\s*/, '').trim();
}

function headingOf(line) {
  const m = line.match(/^(#{1,4})\s+(.+)$/);
  if (m) return { level: m[1].length, title: m[2].replace(/[*_`]/g, '').trim() };
  const cn = line.match(/^第([一二三四五六七八九十百]+)([章节])\s*(.*)$/);
  if (cn) return { level: cn[2] === '章' ? 2 : 3, title: (cn[3] || line).replace(/[*_`]/g, '').trim() };
  return null;
}

/** 按标题切块：每块保留自己的正文，避免所有小节共用同一批高分句。 */
function parseBlocks(sources) {
  const blocks = [];
  let current = { level: 0, title: '', lines: [] };
  for (const src of sources) {
    for (const line of String(src.text || '').split('\n')) {
      const h = headingOf(line.trim());
      if (h) {
        if (current.lines.join('').trim() || current.title) blocks.push(current);
        current = { level: h.level, title: h.title, lines: [], source: src.title };
      } else {
        current.lines.push(line);
      }
    }
    if (current.lines.join('').trim() || current.title) {
      blocks.push(current);
      current = { level: 0, title: '', lines: [] };
    }
  }
  return blocks;
}

function scoreSentence(sentence, terms) {
  const len = sentence.length;
  let score = 0;
  if (len >= 16 && len <= 90) score += 3;
  else if (len <= 140) score += 1;
  score += terms.filter((t) => sentence.includes(t)).length * 2;
  if (/[：:，,、]/.test(sentence)) score += 1;
  if (/例如|包括|分为|首先|其次|因此|关键是|核心是|优势|劣势/.test(sentence)) score += 2;
  return score;
}

function termOf(sentence, fallback) {
  const bold = sentence.match(/^\*\*(.+?)\*\*/);
  if (bold) return bold[1];
  const subject = sentence.match(/^(.{2,12}?)(?:把|将|通过|依赖|采用|使用)/);
  if (subject) return subject[1];
  const modal = sentence.match(/^(.{2,10}?)(?:应|需|可以|必须|能够)/);
  if (modal) return modal[1];
  const lead = sentence.match(/^(.{2,12}?)(?:是|包括|分为|用于|指|指出|表明|强调)/);
  if (lead) return lead[1];
  const colon = sentence.match(/^([^：:]{2,12})[：:]/);
  if (colon) return colon[1].replace(/\*/g, '');
  const kw = keywords(sentence, 2).filter((k) => k.word.length >= 2 && k.word.length <= 8)[0];
  return kw?.word || String(fallback || '要点').slice(0, 8);
}

function summarize(sentence, max = 72) {
  return truncate(String(sentence).replace(/\s+/g, ' '), max).replace(/[。；;]$/, '');
}

function sentencePool(text, terms) {
  return splitSentences(text)
    .filter((s) => !/^(图|表|资料来源|来源|责任编辑)/.test(s))
    .map((s) => ({ text: s, score: scoreSentence(s, terms) }))
    .sort((a, b) => b.score - a.score);
}

function chooseBlocks(blocks) {
  const usable = blocks.filter((b) => b.title && b.title.length <= 40 && b.lines.join('').trim().length >= 40);
  if (!usable.length) return [];
  for (const level of [2, 3, 4, 1]) {
    const atLevel = usable.filter((b) => b.level === level);
    if (atLevel.length >= 2) return atLevel;
  }
  return usable;
}

function buildSections(blocks, topic, maxSections) {
  const terms = keywords(topic, 6).map((k) => k.word);
  const usable = chooseBlocks(blocks);
  const sections = [];

  if (usable.length >= 2) {
    for (const block of usable.slice(0, maxSections)) {
      const pool = sentencePool(block.lines.join('\n'), terms);
      sections.push({
        name: block.title,
        summary: pool[0] ? summarize(pool[0].text) : `${block.title} 的要点。`,
        seeds: pool,
        ownText: block.lines.join('\n')
      });
    }
  }

  if (sections.length < 2) {
    const all = sentencePool(blocks.map((b) => b.lines.join('\n')).join('\n'), terms);
    const names = ['基础概念', '核心原理', '关键方法', '实践与考点'];
    const count = Math.min(names.length, Math.max(2, Math.ceil(maxSections / 2)));
    for (let i = 0; i < count; i++) {
      sections.push({
        name: `${topic} · ${names[i]}`,
        summary: '',
        seeds: [],
        ownText: ''
      });
    }
    all.forEach((s, i) => sections[i % sections.length].seeds.push(s));
  }

  // 每节至少 2 条材料：先从全量池里补，且全局不复用
  const used = new Set();
  for (const sec of sections) {
    sec.seeds = sec.seeds.filter((s) => {
      if (used.has(s.text)) return false;
      used.add(s.text);
      return true;
    });
  }
  const globalPool = sentencePool(blocks.map((b) => b.lines.join('\n')).join('\n'), terms);
  for (const sec of sections) {
    for (const cand of globalPool) {
      if (sec.seeds.length >= 2) break;
      if (used.has(cand.text)) continue;
      sec.seeds.push(cand);
      used.add(cand.text);
    }
    sec.seeds = sec.seeds.slice(0, 4);
    if (!sec.summary) sec.summary = sec.seeds[0] ? summarize(sec.seeds[0].text) : `${sec.name} 的要点梳理。`;
  }
  return sections;
}

function chunkChapters(sections) {
  const chapters = [];
  const size = sections.length <= 4 ? 2 : 3;
  for (let i = 0; i < sections.length; i += size) {
    const group = sections.slice(i, i + size);
    chapters.push({
      name: group[0].name.replace(/^.*?[·:：]\s*/, ''),
      summary: group.map((s) => s.summary).join(' ').slice(0, 120),
      sections: group
    });
  }
  return chapters;
}

function makeQuestions(section, allSections, count) {
  const questions = [];
  const seeds = section.seeds || [];
  const others = allSections
    .filter((s) => s.name !== section.name)
    .flatMap((s) => (s.seeds || []).map((x) => ({ ...x, from: s.name })));
  const label = shortName(section.name);

  for (let i = 0; i < Math.min(count, seeds.length); i++) {
    const seed = seeds[i];
    if (i % 2 === 0) {
      const correct = summarize(seed.text, 58);
      const distractors = [];
      for (const cand of others) {
        const d = summarize(cand.text, 58);
        if (d && d !== correct && !distractors.includes(d)) distractors.push(d);
        if (distractors.length >= 3) break;
      }
      while (distractors.length < 3) {
        distractors.push(`该说法只适用于与「${label}」无关的场景（干扰项 ${distractors.length + 1}）`);
      }
      const options = [correct, ...distractors.slice(0, 3)];
      const shift = hashInt(seed.text) % 4;
      const rotated = options.map((_, idx) => options[(idx + shift) % 4]);
      const answer = 'ABCD'[rotated.indexOf(correct)];
      questions.push({
        type: 'single',
        stem: `关于「${label}」，下列说法正确的是？`,
        options: rotated.map((o) => o.replace(/^[-*]\s*/, '')),
        answer,
        analysis: `原文依据：${summarize(seed.text, 90)}`,
        difficulty: seed.score >= 6 ? '易' : '中',
        tags: [label, termOf(seed.text, label)].filter(Boolean).slice(0, 2)
      });
    } else {
      const useTrue = hashInt(seed.text + label) % 2 === 0;
      const source = useTrue ? seed : pick(others.filter((x) => x.text !== seed.text), seed.text) || seed;
      questions.push({
        type: 'judge',
        stem: `判断：「${summarize(source.text, 64)}」这一表述${useTrue ? '符合' : '不属于'}「${label}」的内容。`,
        answer: useTrue ? '正确' : '错误',
        analysis: useTrue
          ? `原文在「${label}」中给出了该表述。`
          : `该表述来自「${shortName(source.from || '其他小节')}」，不能归入「${label}」。`,
        difficulty: '中',
        tags: [label]
      });
    }
  }
  return questions;
}

export class MockLLM {
  constructor({ sources = [], topic = '', config = {} } = {}) {
    this.sources = sources;
    this.topic = topic;
    this.config = config;
    this.name = 'mock:deterministic';
    this.stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
  }

  async chatJSON({ task, payload }) {
    this.stats.calls++;
    if (task === 'outline') return this.outline(payload);
    if (task === 'plates') return this.plates(payload);
    if (task === 'questions') return this.questions(payload);
    if (task === 'cases') return this.cases(payload);
    throw new Error(`MockLLM 不支持任务：${task}`);
  }

  outline(payload = {}) {
    const topic = payload.topic || this.topic || '学习主题';
    const sources = payload.sources?.length ? payload.sources : this.sources;
    const maxSections = payload.maxSections || this.config.maxSections || 8;
    const blocks = parseBlocks(sources);
    const sections = buildSections(blocks, topic, maxSections);
    const chapters = chunkChapters(sections);

    const plates = chapters.slice(0, 4).map((ch, idx) => {
      const points = [];
      ch.sections.forEach((sec, sIdx) => {
        const seed = sec.seeds[0];
        if (!seed) return;
        const next = ch.sections[sIdx + 1] || chapters[idx + 1]?.sections[0];
        const relation = next ? `${shortName(sec.name)} → ${shortName(next.name)}` : `${shortName(sec.name)} → 综合应用`;
        const point = `**${termOf(seed.text, sec.name)}**：${summarize(seed.text, 60)}（关联：${relation}）`;
        if (!points.includes(point)) points.push(point);
      });
      const colors = ['#4263eb', '#0ca678', '#f76707', '#7048e8'];
      return {
        id: slugify(ch.name, `plate${idx + 1}`).slice(0, 24) || `plate${idx + 1}`,
        name: shortName(ch.name).slice(0, 20) || `板块${idx + 1}`,
        color: colors[idx % colors.length],
        lead: ch.summary || `${shortName(ch.name)} 的核心概念与关联。`,
        points: points.length ? points : [`**${shortName(ch.name)}**：${ch.summary}`],
        exam: ch.sections.slice(0, 2).map((s) => `${shortName(s.name)} · 高频考点`),
        chapters: [ch.name]
      };
    });

    return {
      title: topic,
      subject: topic,
      category: '通识 / 自主学习',
      description: `围绕「${topic}」自动整理的学习库，含 ${chapters.length} 章、${sections.length} 节，内容来自 ${sources.length} 个输入源。`,
      chapters: chapters.map((ch) => ({
        name: ch.name,
        summary: ch.summary,
        sections: ch.sections.map((sec) => ({
          name: sec.name,
          summary: sec.summary,
          points: sec.seeds.slice(0, 3).map((seed, idx) => {
            const next = sec.seeds[idx + 1];
            const relation = next ? `关联：${termOf(next.text, sec.name)}` : '关联：本节小结';
            return `**${termOf(seed.text, sec.name)}**：${summarize(seed.text, 64)}（${relation}）`;
          })
        }))
      })),
      plates
    };
  }

  /* 知识图谱：每个板块至少 8 条要点，且每条都带「二级」与「关联」，保证离线也有层级。 */
  plates(payload = {}) {
    const chapters = payload.chapters || [];
    const target = Math.max(1, Number(payload.plateTarget) || chapters.length);
    const plates = chapters.slice(0, target).map((ch, ci) => {
      const secs = ch.sections || [];
      const points = [];
      secs.forEach((sec, si) => {
        for (const raw of sec.points || []) {
          let text = String(raw).replace(/\s+/g, ' ').trim();
          if (!text) continue;
          if (!/（二级[：:]/.test(text)) text += `（二级：${shortName(sec.name)}的定义、适用条件、常见误区）`;
          if (!/关联[：:]/.test(text)) {
            const next = secs[si + 1] || secs[0] || { name: ch.name };
            text += `（关联：${shortName(next.name)}）`;
          }
          if (!points.includes(text)) points.push(text);
        }
      });
      for (let i = 0; points.length < 8 && secs.length; i++) {
        const sec = secs[i % secs.length];
        const round = Math.floor(i / secs.length) + 1;
        const text = round === 1
          ? `**${shortName(sec.name)}**：${sec.summary || '本节核心概念与判断依据。'}（二级：定义、判断依据、易错点）（关联：${shortName(ch.name)}整体框架）`
          : `**${shortName(sec.name)}（延伸 ${round}）**：核心概念的适用条件、判断依据与易错辨析（二级：定义、判断依据、易错点）（关联：${shortName(ch.name)}整体框架）`;
        if (!points.includes(text)) points.push(text);
        if (i > 40) break;
      }
      const exam = secs.slice(0, 6).map((sec) => `${shortName(sec.name)}：概念适用条件与易错辨析`);
      while (exam.length < 4) exam.push(`${shortName(ch.name)}：核心规则的判断依据`);
      return {
        name: shortName(ch.name).slice(0, 18) || `板块${ci + 1}`,
        lead: `${ch.summary || shortName(ch.name)}。本板块梳理核心概念、层级关系与高频考点。`,
        points: points.slice(0, 10),
        exam: exam.slice(0, 6),
        chapters: [ch.name]
      };
    });
    return { plates };
  }

  /* 案例精析：按 payload 里每章的 count 生成，背景/场景/分析过程/结论总结齐备。 */
  cases(payload = {}) {
    const chapters = payload.chapters || [];
    const plates = payload.plates || [];
    const out = [];
    for (const [ci, ch] of chapters.entries()) {
      const need = Math.max(0, Number(ch.count) || 0);
      const start = Math.max(0, Number(ch.alreadyGenerated) || 0);
      const withPoints = (ch.sections || []).filter((s) => (s.points || []).length);
      const pool = withPoints.length ? withPoints : [{ name: ch.name, summary: ch.summary, points: [] }];
      for (let i = start; i < start + need; i++) {
        const sec = pool[i % pool.length];
        const short = shortName(sec.name) || shortName(ch.name) || '本节';
        const point = String(sec.points?.[0] || sec.summary || ch.summary || short)
          .replace(/^\*\*([^*]+)\*\*[：:]\s*/, '$1：')
          .replace(/（关联[^）]*）/g, '')
          .replace(/（二级[^）]*）/g, '')
          .trim();
        const concept = point.replace(/[：:].*$/, '').slice(0, 24) || short;
        out.push({
          title: `${short}场景${i + 1}：${concept}的应用`,
          category: plates.length ? plates[(ci + i) % plates.length] : '',
          background: `${ch.summary || ch.name}。本案例围绕「${short}」展开，用于检验在实际业务约束下对「${concept}」的理解。`,
          scenario: `给定场景包含相互冲突的约束：一方面要满足「${short}」的规范要求，另一方面资源与时限受限。需要依据材料判断「${concept}」是否适用，并说明理由。`,
          analysis: `1. 先确认前提：${point || short}。\n2. 再比对约束：核对材料中的边界条件是否满足上述前提。\n3. 评估风险：若前提不成立，需要调整方案并说明替代路径。`,
          conclusion: `结论：以「${concept}」的判断依据为准，逐条核对材料事实后给出可执行方案。检查清单：前提、约束、风险、结论四步齐全。`,
          quickNote: `读场景 → 找${concept} → 核对约束 → 给结论`,
          difficulty: '中',
          tags: [concept, short].filter(Boolean),
          questions: [
            {
              stem: `结合材料，说明「${short}」中「${concept}」的判断依据。`,
              answer: `${point || short}。据此可以确定本案例的结论。`,
              analysis: '按定义、依据、材料事实三步作答。'
            },
            {
              stem: '如果资源约束进一步收紧，你的结论会如何调整？',
              answer: `先检查是否触及「${concept}」的适用边界；若仍满足前提则维持结论，否则按新约束重新判断并说明依据。`,
              analysis: '考察边界条件与结论调整。'
            }
          ]
        });
      }
    }
    return { cases: out };
  }

  questions(payload = {}) {
    const allSections = [];
    for (const ch of payload.chapters || []) {
      for (const sec of ch.sections || []) {
        allSections.push({
          name: sec.name,
          chapter: ch.name,
          seeds: (sec.points || []).map((p) => ({
            text: String(p).replace(/^\*\*[^*]+\*\*：/, '').replace(/（关联：[^）]*）$/, '').replace(/（关联：.*$/, ''),
            score: 6
          }))
        });
      }
    }
    const fallbackCount = payload.countPerSection || this.config.questionsPerSection || 2;
    const out = [];
    for (const ch of payload.chapters || []) {
      for (const sec of ch.sections || []) {
        const seedSection = allSections.find((s) => s.name === sec.name) || {
          name: sec.name,
          seeds: (sec.points || []).map((p) => ({ text: String(p), score: 6 }))
        };
        const count = Math.max(1, Number(sec.count) || fallbackCount);
        const questions = makeQuestions(seedSection, allSections, count);
        if (questions.length) out.push({ chapter: ch.name, section: sec.name, questions });
      }
    }
    return { sections: out };
  }
}
