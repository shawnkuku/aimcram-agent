/**
 * 交互式学习库建设协议（NDJSON）辅助工具。
 *
 * 与 runPipeline({ outlineHook | interact }) 配套，把「采集 → 大纲确认 → 逐章生成 → 组包」
 * 拆成可暂停的分段；除大纲确认外，还支持在生成过程中根据实际情况主动向用户提问。
 * 上层（CLI / DSH 工具 / Rust 桥）通过 NDJSON 双向通信：
 *
 *   上行（agent → 上层）：
 *     {"type":"outline","preview":{...},"suggest":{depth,reason,...}}   # 大纲就绪 + 内容等级建议
 *     {"type":"question","qid":"insufficient","kind":"insufficient",...} # 有效内容不足，请用户决策
 *     {"type":"question","qid":"chapter-0","kind":"chapter",...}         # 某章生成完毕，请用户决定是否继续
 *   下行（上层 → agent）：
 *     {"type":"confirm","accepted":true,"outline":{...},"depth":"detail"} # 确认大纲（可携带微调 + 采纳的等级）
 *     {"type":"confirm","accepted":false}                                 # 取消
 *     {"type":"answer","qid":"insufficient","choice":"continue"|"abort"}  # 回答「继续用现有资料 / 取消」
 *     {"type":"answer","qid":"chapter-N","choice":"ok"|"abort"|"ok-all"}  # 回答「继续 / 中止 / 全部继续不再询问」
 *
 * 上层无需理解 kshare 内部结构，只接触「章 / 节 / 知识点数」这一层预览。
 */

/** 三档内容等级：每节题量与最多小节数（与 App「内容设置」一致）。 */
export const DEPTH_LEVELS = {
  simple: { perSection: 2, maxSections: 12, label: '简单' },
  detail: { perSection: 6, maxSections: 24, label: '详细' },
  deep: { perSection: 10, maxSections: 36, label: '超级详细' }
};

/**
 * 依据有效内容量给出内容等级建议。资料越少越不建议出太多题，
 * 否则模型只能靠灌水或兜底题凑数；资料充足时才建议更高的题量。
 */
export function suggestDepth(totalChars) {
  const n = Number(totalChars) || 0;
  if (n < 2000) {
    return { depth: 'simple', ...DEPTH_LEVELS.simple, reason: `有效内容仅 ${n} 字，建议用「简单」档（每节 2 题）避免灌水。` };
  }
  if (n < 8000) {
    return { depth: 'detail', ...DEPTH_LEVELS.detail, reason: `有效内容 ${n} 字，建议用「详细」档（每节 6 题）。` };
  }
  return { depth: 'deep', ...DEPTH_LEVELS.deep, reason: `有效内容充足（${n} 字），可用「超级详细」档（每节 10 题）。` };
}

/** 把大纲压成可供上层展示 / 编辑的预览层。id 用于上层增删改后回传时对齐原结构。 */
export function outlinePreview(outline) {
  return {
    title: outline.title || '',
    subject: outline.subject || '',
    category: outline.category || '',
    description: outline.description || '',
    chapters: (outline.chapters || []).map((ch, ci) => ({
      id: `ch${ci}`,
      name: ch.name,
      summary: ch.summary || '',
      sections: (ch.sections || []).map((sec, si) => ({
        id: `ch${ci}s${si}`,
        name: sec.name,
        summary: sec.summary || '',
        points: (sec.points || []).length
      }))
    })),
    plates: (outline.plates || []).map((p) => ({ id: p.id, name: p.name, points: (p.points || []).length }))
  };
}

/**
 * 把上层确认时带回的微调合并回大纲。
 *
 * 预览层把「知识点」压成了数量、把「知识板块」压成了 {id,name}，因此不能整棵替换，
 * 否则会丢掉 sections[].points / plates[].points / plates[].lead 等内部结构，导致后续
 * 出题与图解渲染失败。这里按 id（没有 id 时退回索引）对齐、只接收名称 / 摘要等用户可编辑字段，
 * 其余字段一律沿用原大纲；上层新增的章 / 节用空知识点占位，交给出题阶段按名称补内容。
 */
export function applyOutlineEdits(outline, edits) {
  if (!edits || typeof edits !== 'object') return outline;
  const result = { ...outline };
  const origChapters = Array.isArray(result.chapters) ? result.chapters : [];
  const chById = new Map(origChapters.map((ch, i) => [`ch${i}`, ch]));
  const secById = new Map();
  const secByIndex = new Map();
  origChapters.forEach((ch, ci) => {
    (Array.isArray(ch.sections) ? ch.sections : []).forEach((sec, si) => {
      secById.set(`ch${ci}s${si}`, sec);
      secByIndex.set(`${ci}-${si}`, sec);
    });
  });

  if (typeof edits.title === 'string' && edits.title.trim()) result.title = edits.title.trim();
  if (typeof edits.subject === 'string' && edits.subject.trim()) result.subject = edits.subject.trim();
  if (typeof edits.category === 'string' && edits.category.trim()) result.category = edits.category.trim();
  if (typeof edits.description === 'string') result.description = edits.description;

  // 章节：按 id 对齐（新增章节没有 id），仅接收名称 / 摘要；points / seeds 等内部结构保留原值。
  const renamed = new Map();
  if (Array.isArray(edits.chapters) && edits.chapters.length) {
    const next = [];
    edits.chapters.forEach((editCh, i) => {
      if (!editCh || typeof editCh !== 'object') return;
      const orig = (editCh.id && chById.get(editCh.id)) || origChapters[i];
      const base = orig && typeof orig === 'object' ? orig : {};
      const ch = { ...base };
      const name = typeof editCh.name === 'string' ? editCh.name.trim() : '';
      ch.name = name || base.name || `主题${next.length + 1}`;
      if (base.name && ch.name && base.name !== ch.name) renamed.set(base.name, ch.name);
      if (typeof editCh.summary === 'string') ch.summary = editCh.summary;
      if (!ch.summary) ch.summary = ch.name;

      if (Array.isArray(editCh.sections)) {
        const origSecs = Array.isArray(base.sections) ? base.sections : [];
        ch.sections = editCh.sections
          .filter((es) => es && typeof es === 'object')
          .map((es, j) => {
            const origSec = (es.id && secById.get(es.id)) || secByIndex.get(`${i}-${j}`) || origSecs[j];
            const secName = (typeof es.name === 'string' ? es.name.trim() : '')
              || (origSec && origSec.name) || `小节 ${j + 1}`;
            if (origSec) {
              const sec = { ...origSec, name: secName };
              if (typeof es.summary === 'string' && es.summary.trim()) sec.summary = es.summary.trim();
              return sec;
            }
            // 用户新增的小节：没有原知识点，用名称占位，出题/渲染阶段仍然可用
            const summary = (typeof es.summary === 'string' && es.summary.trim()) || secName;
            return { name: secName, summary, points: [], questions: [] };
          });
      }
      if (!Array.isArray(ch.sections) || !ch.sections.length) return; // 空章节直接丢弃
      next.push(ch);
    });
    if (next.length) result.chapters = next;
  }

  // 板块：按 id / 索引对齐，仅接收名称 / 颜色；points / lead / exam / chapters 保留原值。
  if (Array.isArray(edits.plates) && edits.plates.length) {
    const byId = new Map(result.plates.map((p) => [p.id, p]));
    result.plates = edits.plates.map((editP, i) => {
      const orig = (editP && editP.id && byId.get(editP.id)) || result.plates[i];
      if (!orig) return editP;
      if (typeof editP !== 'object') return orig;
      const p = { ...orig };
      if (typeof editP.name === 'string' && editP.name.trim()) p.name = editP.name.trim();
      if (typeof editP.color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(editP.color)) {
        p.color = editP.color;
      }
      return p;
    });
  }

  // 章名被用户改过时，同步板块的「关联章节」，避免知识图谱与案例分类指向旧名称。
  if (renamed.size) {
    result.plates = (result.plates || []).map((p) => ({
      ...p,
      chapters: (p.chapters || []).map((name) => renamed.get(name) || name)
    }));
  }

  return result;
}

/**
 * 依据一个「读写通道」构造 outlineHook。
 *
 * @param {{write: (obj:object)=>void, awaitMessage: (type:string)=>Promise<object|null>}} io
 * @returns {(outline:object)=>Promise<object|null>}
 */
export function createOutlineHook(io) {
  return async function confirmOutline(outline) {
    io.write({ type: 'outline', preview: outlinePreview(outline) });
    const msg = await io.awaitMessage('confirm');
    if (!msg || msg.accepted === false) return null;
    return applyOutlineEdits(outline, msg.outline || msg.edits);
  };
}

/**
 * 依据一个「读写通道」构造完整交互钩子集（大纲 + 资料不足 + 逐章）。
 *
 * confirmOutline 既向前兼容（返回大纲对象），也支持带等级采纳：
 * 当上层回传 depth 时返回 { outline, questionsPerSection }，pipeline 据此
 * 在逐章出题阶段覆盖每节题量。askInsufficient / confirmChapter 走通用
 * question/answer 协议。
 *
 * @param {{write: (obj:object)=>void, awaitMessage: (type:string)=>Promise<object|null>}} io
 * @returns {{
 *   confirmOutline: (outline:object, suggest:object)=>Promise<object|null>,
 *   askInsufficient: (info:object)=>Promise<'continue'|'abort'>,
 *   confirmChapter: (info:object)=>Promise<'ok'|'abort'|'ok-all'>
 * }}
 */
export function createInteractHooks(io) {
  async function confirmOutline(outline, suggest) {
    io.write({ type: 'outline', preview: outlinePreview(outline), suggest: suggest || null });
    const msg = await io.awaitMessage('confirm');
    if (!msg || msg.accepted === false) return null;
    const merged = applyOutlineEdits(outline, msg.outline || msg.edits);
    /* 用户在大纲确认后才补充的要求（案例数、出题侧重）随确认消息带回，供后续出题阶段使用 */
    const note = typeof msg.note === 'string' ? msg.note.trim() : '';
    /* 用户在前端「生成方案」里设置的题量与案例数：精确总量，不是每节题量 */
    const counts = {};
    const qc = Math.round(Number(msg.questionCount));
    if (Number.isFinite(qc) && qc > 0) counts.questionCount = qc;
    const cc = Math.round(Number(msg.caseCount));
    if (Number.isFinite(cc) && cc > 0) counts.caseCount = Math.min(200, cc);
    const wrap = (pack) => {
      if (note) pack.note = note;
      Object.assign(pack, counts);
      return pack;
    };
    /* 上层按用户填写的题量算出每节题量时优先采纳，避免只能用三档预设 */
    const per = Math.round(Number(msg.perSection));
    if (Number.isFinite(per) && per > 0) {
      return wrap({ outline: merged, questionsPerSection: Math.max(1, per) });
    }
    if (msg.depth && DEPTH_LEVELS[msg.depth]) {
      return wrap({ outline: merged, questionsPerSection: DEPTH_LEVELS[msg.depth].perSection });
    }
    if (note || Object.keys(counts).length) return wrap({ outline: merged });
    return merged;
  }

  async function askInsufficient(info) {
    io.write({
      type: 'question',
      qid: 'insufficient',
      kind: 'insufficient',
      prompt: '没有足够的有效内容，可能无法生成完整的学习库',
      hint: info.hint || '',
      options: ['continue', 'abort'],
      data: info
    });
    const msg = await io.awaitMessage('answer');
    if (!msg || msg.qid !== 'insufficient') return 'abort'; // 未回话 / 关闭输入：保守中止
    return msg.choice === 'continue' ? 'continue' : 'abort';
  }

  async function confirmChapter(info) {
    io.write({
      type: 'question',
      qid: info.qid,
      kind: 'chapter',
      prompt: info.prompt || '',
      options: ['ok', 'abort', 'ok-all'],
      data: info.data
    });
    const msg = await io.awaitMessage('answer');
    if (!msg || msg.qid !== info.qid) return 'abort';
    const choice = msg.choice;
    return choice === 'ok' || choice === 'ok-all' || choice === 'continue' ? choice : 'abort';
  }

  return { confirmOutline, askInsufficient, confirmChapter };
}