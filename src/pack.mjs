/**
 * 学习库包（kshare-pack/v1）组包、校验、解包
 *
 * 严格对齐 services/STUDY-LIBRARY-SPEC.md：
 * - 目录：<slug>-<version>/manifest.json + content/library.json + resources/images/… (+ source/)
 * - fingerprint = sha256(canonicalJson({chapters, knowledge}))
 * - 资源引用统一 resources/ 前缀，只做前缀映射，不改文件名与字节
 * - 校验码：E100–E143 / W100–W141，内容层保留 kshare 的 E0xx / W0xx
 */

import fs from 'node:fs';
import path from 'node:path';
import { AgentError } from './errors.mjs';
import {
  canonicalJson, sha256Hex, writeJson, today, isoNow, ensureDir, truncate
} from './util.mjs';
import { readZip, writeZip } from './zip.mjs';

const PACK_FORMAT = 'kshare-pack/v1';
const MIME_BY_EXT = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml'
};
const MIME_ALLOWED = new Set(Object.values(MIME_BY_EXT));
const TOP_ALLOWED = new Set(['manifest.json', 'content', 'resources', 'source']);
const MANIFEST_REQUIRED = [
  'format', 'slug', 'version', 'title', 'subject', 'category', 'rights', 'license',
  'updated', 'language', 'schema', 'counts', 'content', 'resources', 'provenance', 'compatibility'
];
const META_KEYS = ['slug', 'title', 'subject', 'category', 'rights', 'license', 'version', 'updated', 'language'];
const RESOURCE_EXTS = new Set(Object.keys(MIME_BY_EXT));

/* ------------------------------- 组包 ------------------------------- */

export function computeCounts(library) {
  const byType = { single: 0, multiple: 0, judge: 0, case: 0, qa: 0, essay: 0 };
  let chapters = 0;
  let sections = 0;
  let questions = 0;
  for (const ch of library.chapters || []) {
    chapters++;
    for (const sec of ch.sections || []) {
      sections++;
      for (const q of sec.questions || []) {
        questions++;
        if (q.type in byType) byType[q.type]++;
      }
    }
  }
  const plates = library.knowledge?.plates || [];
  const knowledge = plates.length
    ? {
        plates: plates.length,
        points: plates.reduce((n, p) => n + (p.points?.length || 0), 0),
        exam: plates.reduce((n, p) => n + (p.exam?.length || 0), 0),
        diagrams: plates.filter((p) => p.diagram).length
      }
    : null;
  return { chapters, sections, questions, byType, knowledge };
}

export function contentFingerprint(library) {
  return sha256Hex(canonicalJson({ chapters: library.chapters, knowledge: library.knowledge }));
}

function mapResourcePaths(value) {
  if (typeof value === 'string') {
    return value.startsWith('images/') ? `resources/${value}` : value;
  }
  if (Array.isArray(value)) return value.map(mapResourcePaths);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = mapResourcePaths(v);
    return out;
  }
  return value;
}

function collectImageFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectImageFiles(abs));
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

/**
 * @param {{workDir: string, meta: object, libraryJson: object, outDir?: string, sourceMd?: string, force?: boolean}} params
 */
export function buildPack({ workDir, meta, libraryJson, outDir, sourceMd, force = false }) {
  const library = mapResourcePaths(libraryJson);
  const slug = meta.slug;
  const version = meta.version;
  const rootName = `${slug}-${version}`;
  const targetRoot = path.join(outDir || path.dirname(workDir), rootName);

  const contentJson = JSON.stringify(library, null, 2) + '\n';
  const contentBuf = Buffer.from(contentJson, 'utf8');
  const fingerprint = contentFingerprint(library);
  const counts = computeCounts(library);
  const contentSha = sha256Hex(contentBuf);

  if (fs.existsSync(path.join(targetRoot, 'manifest.json')) && !force) {
    try {
      const existing = JSON.parse(fs.readFileSync(path.join(targetRoot, 'manifest.json'), 'utf8'));
      if (existing?.content?.fingerprint && existing.content.fingerprint !== fingerprint) {
        throw new AgentError('LA015', `已存在同 slug+version 但内容不同的学习库：${rootName}`, {
          hint: '提升 --version（如 1.0.1）或加 --force 覆盖'
        });
      }
    } catch (err) {
      if (err instanceof AgentError) throw err;
      /* 旧目录损坏时允许重建 */
    }
  }

  // 资源：只登记内容里实际存在且被引用的图片
  const imageDir = path.join(workDir, 'images');
  const resources = [];
  const resourceEntries = new Map();
  for (const abs of collectImageFiles(imageDir)) {
    const rel = path.relative(imageDir, abs).split(path.sep).join('/');
    const ext = path.extname(rel).slice(1).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) continue;
    const buf = fs.readFileSync(abs);
    const packPath = `resources/images/${rel}`;
    resources.push({ path: packPath, bytes: buf.length, sha256: sha256Hex(buf), mime });
    resourceEntries.set(packPath, buf);
  }
  resources.sort((a, b) => a.path.localeCompare(b.path));

  const manifest = {
    format: PACK_FORMAT,
    slug,
    version,
    title: meta.title || library.meta?.title || slug,
    subject: meta.subject || library.meta?.subject || slug,
    category: meta.category || library.meta?.category || '通识',
    rights: meta.rights || library.meta?.rights || 'original',
    license: meta.license || library.meta?.license || 'CC-BY-NC-4.0',
    updated: meta.updated || today(),
    language: meta.language || 'zh-CN',
    schema: 'kshare/v1',
    compatibility: { minAppVersion: meta.minAppVersion || '1.0.0' },
    counts: { ...counts, resources: resources.length },
    content: {
      path: 'content/library.json',
      bytes: contentBuf.length,
      sha256: contentSha,
      fingerprint
    },
    resources,
    provenance: {
      type: 'agent',
      generator: meta.generator || 'aimcram-agent',
      generatorVersion: meta.generatorVersion || '1.0.0',
      createdAt: meta.createdAt || isoNow(),
      ...(meta.sourceRef ? { sourceRef: meta.sourceRef } : {})
    }
  };
  if (meta.exam) manifest.exam = meta.exam;
  if (meta.year) manifest.year = Number(meta.year);
  if (meta.author) manifest.author = meta.author;
  if (meta.tags?.length) manifest.tags = meta.tags;
  if (meta.description) manifest.description = meta.description;
  for (const [k, v] of Object.entries(meta.extras || {})) {
    if (k.startsWith('x-')) manifest[k] = v;
  }

  // 落盘（先写临时目录再替换，避免半成品）
  const tmp = `${targetRoot}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  ensureDir(path.join(tmp, 'content'));
  ensureDir(path.join(tmp, 'resources/images'));
  fs.writeFileSync(path.join(tmp, 'content/library.json'), contentBuf);
  for (const [rel, buf] of resourceEntries) {
    const dest = path.join(tmp, rel);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, buf);
  }
  if (sourceMd) {
    ensureDir(path.join(tmp, 'source'));
    fs.writeFileSync(path.join(tmp, 'source/library.md'), sourceMd, 'utf8');
  }
  writeJson(path.join(tmp, 'manifest.json'), manifest);

  fs.rmSync(targetRoot, { recursive: true, force: true });
  fs.renameSync(tmp, targetRoot);

  // ZIP：根目录 = <slug>-<version>/
  const entries = [
    { path: `${rootName}/manifest.json`, data: fs.readFileSync(path.join(targetRoot, 'manifest.json')) },
    { path: `${rootName}/content/library.json`, data: contentBuf },
    ...[...resourceEntries.entries()].map(([rel, data]) => ({ path: `${rootName}/${rel}`, data }))
  ];
  if (sourceMd) entries.push({ path: `${rootName}/source/library.md`, data: Buffer.from(sourceMd, 'utf8') });
  const zipBuf = writeZip(entries);
  const zipPath = path.join(outDir || path.dirname(workDir), `${rootName}.zip`);
  fs.writeFileSync(zipPath, zipBuf);

  return { root: targetRoot, zip: zipPath, manifest, library, counts, fingerprint };
}

/* ------------------------------- 校验 ------------------------------- */

function err(list, code, p, message, extra = {}) {
  list.push({ code, path: p, message, ...extra });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function loadPack(target) {
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const files = new Map();
    const rootName = path.basename(target);
    const walk = (dir, base = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${entry.name}` : entry.name;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs, rel);
        else if (entry.isFile()) files.set(`${rootName}/${rel}`, fs.readFileSync(abs));
        else if (entry.isSymbolicLink()) files.set(`${rootName}/${rel}`, null);
      }
    };
    walk(target);
    return { files, rootName, file: target, kind: 'dir' };
  }
  const files = readZip(fs.readFileSync(target));
  const names = [...files.keys()];
  const roots = new Set(names.map((n) => n.split('/')[0]).filter(Boolean));
  return { files, rootName: roots.size === 1 ? [...roots][0] : '', file: target, kind: 'zip', roots: [...roots] };
}

function normalizePackFile(files, rootName, relPath) {
  return files.get(`${rootName}/${relPath}`) ?? files.get(relPath) ?? null;
}

function validateResources(library) {
  const refs = new Set();
  const add = (value) => {
    if (typeof value !== 'string') return;
    if (/^(images|resources)\//.test(value)) refs.add(value.replace(/^images\//, 'resources/images/'));
    for (const m of value.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) add(m[1]);
    for (const m of value.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1]);
  };
  for (const plate of library.knowledge?.plates || []) add(plate.diagram);
  for (const ch of library.chapters || []) {
    for (const sec of ch.sections || []) {
      for (const q of sec.questions || []) {
        add(q.figure);
        add(q.stem);
        add(q.analysis);
        add(q.material);
      }
    }
  }
  return refs;
}

/**
 * @param {string} target 目录或 ZIP
 * @param {{strict?: boolean, appVersion?: string}} [opts]
 */
export function verifyPack(target, opts = {}) {
  const errors = [];
  const warnings = [];
  const report = { ok: false, format: PACK_FORMAT, file: target, errors, warnings };

  if (!fs.existsSync(target)) {
    err(errors, 'E100', target, '目标不存在');
    return report;
  }

  let pack;
  try {
    pack = loadPack(target);
  } catch (e) {
    err(errors, 'E102', target, `无法读取包：${e.message}`);
    return report;
  }
  const { files, rootName } = pack;

  if (pack.kind === 'zip' && pack.roots && pack.roots.length > 1) {
    err(errors, 'E100', target, `包内存在多个根目录：${pack.roots.join(', ')}`);
    return report;
  }

  // 顶层条目
  const topLevel = new Set();
  for (const name of files.keys()) {
    const parts = name.split('/');
    if (parts.length < 2) {
      err(errors, 'E103', name, '顶层出现文件，学习库包必须只有一个根目录');
      continue;
    }
    if (parts[0] === '__MACOSX' || parts[0] === '.DS_Store') {
      err(errors, 'E103', name, '包含系统垃圾文件');
      continue;
    }
    if (rootName && parts[0] !== rootName) {
      err(errors, 'E100', name, `包内存在多个根目录：${parts[0]}`);
    }
    topLevel.add(parts[1]);
    if (/(^|\/)(data\.js|kb\.js|data-subjects\.js|metrics\.json|ACCEPTANCE\.md)$/.test(name)) {
      err(errors, 'E103', name, '包含构建产物或报告，不应入包');
    }
  }
  for (const name of topLevel) {
    if (!TOP_ALLOWED.has(name)) err(errors, 'E103', name, `顶层条目 ${name} 不在允许清单内`);
  }

  const manifestBuf = normalizePackFile(files, rootName, 'manifest.json');
  if (!manifestBuf) {
    err(errors, 'E100', 'manifest.json', '缺少 manifest.json');
    return report;
  }
  let manifest;
  try {
    const text = manifestBuf.toString('utf8');
    if (text.includes('\u0000')) throw new Error('包含 NUL 字节');
    manifest = JSON.parse(text);
  } catch (e) {
    err(errors, 'E102', 'manifest.json', `不是合法 JSON：${e.message}`);
    return report;
  }
  report.manifest = manifest;

  // E110 / E111
  for (const key of MANIFEST_REQUIRED) {
    if (manifest[key] === undefined || manifest[key] === null) {
      err(errors, 'E110', 'manifest.json', `缺少必填字段 ${key}`);
    }
  }
  const check = (ok, field, message) => {
    if (!ok) err(errors, 'E111', 'manifest.json', message || `字段 ${field} 格式非法`);
  };
  check(manifest.format === PACK_FORMAT, 'format');
  check(typeof manifest.slug === 'string' && /^[a-z0-9][a-z0-9-]{1,62}$/.test(manifest.slug), 'slug');
  check(typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version), 'version');
  check(typeof manifest.title === 'string' && manifest.title.length >= 1 && manifest.title.length <= 80, 'title');
  check(typeof manifest.subject === 'string' && manifest.subject.length >= 1, 'subject');
  check(typeof manifest.category === 'string' && manifest.category.length >= 1, 'category');
  check(['original', 'authorized', 'public'].includes(manifest.rights), 'rights');
  check(['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0', 'All-Rights-Reserved'].includes(manifest.license), 'license');
  check(typeof manifest.updated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(manifest.updated), 'updated');
  check(typeof manifest.language === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(manifest.language), 'language');
  check(['kshare/v1', 'kshare/v2'].includes(manifest.schema), 'schema');
  check(isPlainObject(manifest.provenance) && ['agent', 'user', 'platform'].includes(manifest.provenance?.type), 'provenance.type');
  check(isPlainObject(manifest.compatibility) && /^\d+\.\d+\.\d+$/.test(manifest.compatibility?.minAppVersion || ''), 'compatibility.minAppVersion');

  if (manifest.slug && manifest.version && rootName !== `${manifest.slug}-${manifest.version}`) {
    err(errors, 'E101', rootName, `根目录名应等于 ${manifest.slug}-${manifest.version}`);
  }

  // content 文件
  const contentPath = manifest.content?.path;
  if (contentPath !== 'content/library.json') {
    err(errors, 'E120', 'manifest.json', 'content.path 必须为 content/library.json');
  }
  const contentBuf = normalizePackFile(files, rootName, 'content/library.json');
  if (!contentBuf) {
    err(errors, 'E120', 'content/library.json', '内容文件不存在');
    return report;
  }
  const sha = sha256Hex(contentBuf);
  if (manifest.content?.sha256 !== sha) {
    err(errors, 'E122', 'content/library.json', `sha256 不一致（实际 ${sha.slice(0, 12)}…）`);
  }
  if (manifest.content?.bytes !== contentBuf.length) {
    err(errors, 'E122', 'content/library.json', `bytes 不一致（实际 ${contentBuf.length}）`);
  }
  let library;
  try {
    library = JSON.parse(contentBuf.toString('utf8'));
  } catch (e) {
    err(errors, 'E123', 'content/library.json', `不是合法 JSON：${e.message}`);
    return report;
  }
  report.content = library;

  if (!['kshare/v1', 'kshare/v2'].includes(library.schema)) {
    err(errors, 'E121', 'content/library.json', `schema 不受支持：${library.schema}`);
  }
  if (manifest.schema !== library.schema) {
    err(errors, 'E112', 'manifest.json', 'schema 与 content.schema 不一致');
  }

  // E112 交叉一致性
  for (const key of META_KEYS) {
    if (library.meta?.[key] !== undefined && manifest[key] !== undefined && String(library.meta[key]) !== String(manifest[key])) {
      err(errors, 'E112', 'manifest.json', `${key} 与 content/meta.${key} 不一致`);
    }
  }

  // E113 counts
  const counts = computeCounts(library);
  const declared = manifest.counts || {};
  const compare = (field, actual) => {
    if (declared[field] !== actual) {
      err(errors, 'E113', 'manifest.json', `counts.${field}=${declared[field]}，实际 ${actual}`);
    }
  };
  compare('chapters', counts.chapters);
  compare('sections', counts.sections);
  compare('questions', counts.questions);
  compare('resources', Array.isArray(manifest.resources) ? manifest.resources.length : -1);
  for (const t of Object.keys(counts.byType)) {
    if (declared.byType?.[t] !== counts.byType[t]) {
      err(errors, 'E113', 'manifest.json', `counts.byType.${t}=${declared.byType?.[t]}，实际 ${counts.byType[t]}`);
    }
  }
  const kn = counts.knowledge;
  if (kn) {
    for (const f of ['plates', 'points', 'exam', 'diagrams']) {
      if (declared.knowledge?.[f] !== kn[f]) {
        err(errors, 'E113', 'manifest.json', `counts.knowledge.${f}=${declared.knowledge?.[f]}，实际 ${kn[f]}`);
      }
    }
  } else if (declared.knowledge !== null && declared.knowledge !== undefined) {
    err(errors, 'E113', 'manifest.json', '无知识图谱时 counts.knowledge 应为 null');
  }

  // E124 fingerprint
  const fp = contentFingerprint(library);
  if (manifest.content?.fingerprint !== fp) {
    err(errors, 'E124', 'content/library.json', `fingerprint 不一致（实际 ${fp.slice(0, 12)}…）`);
  }

  // 内容基本校验（E123）
  const seenIds = new Set();
  for (const ch of library.chapters || []) {
    for (const sec of ch.sections || []) {
      for (const q of sec.questions || []) {
        if (!q.id) err(errors, 'E123', 'content/library.json', `题目缺少 id：${truncate(q.stem, 30)}`, { innerCode: 'E020' });
        if (q.id && seenIds.has(q.id)) err(errors, 'E123', 'content/library.json', `题目 id 重复：${q.id}`, { innerCode: 'E050' });
        if (q.id) seenIds.add(q.id);
        if (!q.stem && !q.material) err(errors, 'E123', 'content/library.json', `题目缺少题干（${q.id || '?'}）`, { innerCode: 'E020' });
        if (['single', 'multiple'].includes(q.type)) {
          if (!Array.isArray(q.options) || q.options.length < 2) {
            err(errors, 'E123', 'content/library.json', `选择题选项不足（${q.id}）`, { innerCode: 'E021' });
          }
          if (!Array.isArray(q.answer) || !q.answer.length) {
            err(errors, 'E123', 'content/library.json', `选择题缺少答案（${q.id}）`, { innerCode: 'E030' });
          }
        }
        if (q.type === 'judge' && !(Array.isArray(q.answer) && q.answer.length === 1 && ['正确', '错误'].includes(q.answer[0]))) {
          err(errors, 'E123', 'content/library.json', `判断题答案必须为单元素数组 ["正确"]/["错误"]（${q.id}）`, { innerCode: 'E031' });
        }
      }
    }
  }

  // 资源校验
  const resources = Array.isArray(manifest.resources) ? manifest.resources : [];
  const registered = new Map();
  for (const item of resources) {
    const p = item.path;
    registered.set(p, item);
    if (typeof p !== 'string' || !p.startsWith('resources/') || p.includes('..') || p.includes('\\') || /^[a-z]+:/i.test(p)) {
      err(errors, 'E132', p, '资源路径非法（必须相对 resources/，禁止 ..、反斜杠、URL、data:）');
      continue;
    }
    const ext = path.extname(p).slice(1).toLowerCase();
    if (!RESOURCE_EXTS.has(ext)) err(errors, 'E133', p, `扩展名不在白名单：${ext}`);
    if (MIME_BY_EXT[ext] && item.mime !== MIME_BY_EXT[ext]) {
      err(errors, 'E133', p, `MIME 与扩展名不符：${item.mime} vs ${ext}`);
    }
    if (!MIME_ALLOWED.has(item.mime)) err(errors, 'E133', p, `MIME 不在白名单：${item.mime}`);
    if (!/^resources\/[a-z0-9][a-z0-9._/-]*$/.test(p)) err(errors, 'E132', p, '资源文件名必须为 ASCII 小写');
    const buf = normalizePackFile(files, rootName, p);
    if (!buf) {
      err(errors, 'E130', p, '资源在包内不存在');
      continue;
    }
    if (buf.length !== item.bytes) err(errors, 'E134', p, `bytes 不一致（实际 ${buf.length}）`);
    if (sha256Hex(buf) !== item.sha256) err(errors, 'E134', p, 'sha256 校验失败');
    if (buf.length > 300 * 1024) err(warnings, 'W131', p, `${Math.round(buf.length / 1024)}KB，建议压缩到 300KB 以内`);
    if (ext === 'svg') {
      const svg = buf.toString('utf8');
      if (/<script\b|on\w+\s*=|foreignObject|(?:href|xlink:href)\s*=\s*["'](?:https?:|\/\/)/i.test(svg)) {
        err(errors, 'E135', p, 'SVG 含脚本、事件属性、foreignObject 或外链');
      }
    }
  }

  // 引用 → 清单 / 清单 → 引用
  const refs = validateResources(library);
  for (const ref of refs) {
    if (!registered.has(ref)) err(errors, 'E130', ref, '内容引用了未登记的资源');
    else if (!normalizePackFile(files, rootName, ref)) err(errors, 'E130', ref, '内容引用的资源文件不存在');
  }
  for (const p of registered.keys()) {
    if (!refs.has(p)) err(warnings, 'W130', p, '资源已登记但未被任何内容引用');
  }

  // 其它窗口项
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_REQUIRED.includes(key) && !['exam', 'year', 'author', 'tags', 'description', 'publisher', 'signature', 'publishedAt'].includes(key) && !key.startsWith('x-')) {
      err(warnings, 'W100', 'manifest.json', `未知字段 ${key}，已忽略`);
    }
  }
  for (const key of ['author', 'tags', 'description']) {
    if (manifest[key] === undefined) err(warnings, 'W101', 'manifest.json', `建议补充 ${key}`);
  }
  if (manifest.provenance?.type === 'agent' && (!manifest.provenance.generator || !manifest.provenance.generatorVersion)) {
    err(errors, 'E110', 'manifest.json', 'agent 来源必须提供 generator 与 generatorVersion');
  }
  if (manifest.provenance?.type === 'user' && (!manifest.provenance.exportedAt || !manifest.provenance.appVersion)) {
    err(errors, 'E110', 'manifest.json', 'user 来源必须提供 exportedAt 与 appVersion');
  }
  if (manifest.provenance?.type === 'platform' && (!manifest.provenance.publisher || !manifest.provenance.publishedAt)) {
    err(errors, 'E110', 'manifest.json', 'platform 来源必须提供 publisher 与 publishedAt');
  }
  if (opts.appVersion && manifest.compatibility?.minAppVersion) {
    const cmp = String(manifest.compatibility.minAppVersion).split('.').map(Number);
    const cur = String(opts.appVersion).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((cmp[i] || 0) > (cur[i] || 0)) {
        err(errors, 'E142', 'manifest.json', `minAppVersion ${manifest.compatibility.minAppVersion} 高于当前 App ${opts.appVersion}`);
        break;
      }
    }
  }

  report.ok = errors.length === 0 && (!opts.strict || warnings.length === 0);
  return report;
}

/* ------------------------------- 解包 ------------------------------- */

export function unpackPack(zipPath, outDir) {
  const files = readZip(fs.readFileSync(zipPath));
  const roots = new Set([...files.keys()].map((n) => n.split('/')[0]));
  if (roots.size !== 1) throw new AgentError('LA010', `ZIP 内应只有一个根目录，实际：${[...roots].join(', ')}`);
  const root = [...roots][0];
  const rootDir = path.join(outDir, root);
  ensureDir(rootDir);
  for (const [name, buf] of files) {
    if (name.includes('..')) throw new AgentError('LA010', `ZIP 条目路径非法：${name}`);
    const rel = name.split('/').slice(1).join('/');
    if (!rel) continue;
    const dest = path.join(rootDir, rel);
    ensureDir(path.dirname(dest));
    fs.writeFileSync(dest, buf);
  }
  return { root: rootDir, rootName: root, files: files.size };
}
