/**
 * 学习库合集（kshare-collection/v1）
 *
 * 多学科分别生成时，每次都会产出 `<slug>-<version>/` 目录与同名 ZIP；分发和传输
 * 时希望只有**一个**文件，因此合集把若干合法的 kshare-pack/v1 包收进同一个 ZIP：
 *
 *   aimcram-driving-1.0.0/
 *   ├── collection.json          # 合集清单：每个包的 slug / 版本 / 指纹
 *   ├── jiakao-subject1-1.0.0/   # 原样保留的 kshare-pack/v1
 *   └── jiakao-subject4-1.0.0/
 *
 * 合集只做「打包与校验」，不改写任何单个学习库的内容，因此解包后每个子包仍可
 * 单独 verify / 导入。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip, writeZip } from './zip.mjs';
import { verifyPack } from './pack.mjs';
import { AgentError } from './errors.mjs';
import { ensureDir, isoNow } from './util.mjs';

export const COLLECTION_FORMAT = 'kshare-collection/v1';

const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

function listPackEntries(target) {
  if (!fs.existsSync(target)) {
    throw new AgentError('LA004', `学习库包不存在：${target}`);
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    const root = path.basename(target);
    const entries = [];
    const walk = (dir, base = '') => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${item.name}` : item.name;
        const abs = path.join(dir, item.name);
        if (item.isDirectory()) walk(abs, rel);
        else if (item.isFile()) entries.push({ path: `${root}/${rel}`, data: fs.readFileSync(abs) });
      }
    };
    walk(target);
    return entries;
  }
  return [...readZip(fs.readFileSync(target)).entries()].map(([p, data]) => ({ path: p, data }));
}

function stripRoot(entryPath) {
  const i = entryPath.indexOf('/');
  return i < 0 ? '' : entryPath.slice(i + 1);
}

/**
 * 把多个学习库包打成一个 ZIP。
 *
 * @param {{targets: string[], outFile?: string, outDir?: string, name?: string, version?: string, title?: string, force?: boolean}} params
 * @returns {{zip: string, rootName: string, collection: object}}
 */
export function buildCollection({
  targets,
  outFile,
  outDir,
  name = 'aimcram-collection',
  version = '1.0.0',
  title = '',
  force = false
} = {}) {
  if (!Array.isArray(targets) || !targets.length) {
    throw new AgentError('LA012', 'bundle 至少需要一个学习库包（目录或 ZIP）');
  }
  if (!NAME_RE.test(name)) {
    throw new AgentError('LA012', `合集名 ${JSON.stringify(name)} 只能包含小写字母、数字、点、下划线与连字符`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new AgentError('LA012', `合集版本 ${JSON.stringify(version)} 必须是 x.y.z`);
  }

  const rootName = `${name}-${version}`;
  const packs = [];
  const entries = [];
  const seen = new Set();

  for (const target of targets) {
    const report = verifyPack(target, { strict: true });
    if (!report.ok) {
      throw new AgentError('LA010', `学习库包未通过严格校验：${target}`, {
        details: { errors: report.errors.slice(0, 8), warnings: report.warnings.slice(0, 8) }
      });
    }
    const manifest = report.manifest;
    const dirName = `${manifest.slug}-${manifest.version}`;
    if (seen.has(dirName)) {
      throw new AgentError('LA012', `合集内出现重复学习库：${dirName}`);
    }
    seen.add(dirName);

    for (const entry of listPackEntries(target)) {
      const rel = stripRoot(entry.path);
      if (!rel) continue;
      entries.push({ path: `${rootName}/${dirName}/${rel}`, data: entry.data });
    }

    packs.push({
      slug: manifest.slug,
      version: manifest.version,
      title: manifest.title,
      subject: manifest.subject,
      path: dirName,
      counts: manifest.counts,
      fingerprint: manifest.content?.fingerprint || '',
      bytes: fs.statSync(target).size
    });
  }

  const collection = {
    format: COLLECTION_FORMAT,
    name,
    version,
    title: title || name,
    createdAt: isoNow(),
    generator: 'aimcram-agent',
    counts: {
      packs: packs.length,
      chapters: packs.reduce((n, p) => n + (p.counts?.chapters || 0), 0),
      sections: packs.reduce((n, p) => n + (p.counts?.sections || 0), 0),
      questions: packs.reduce((n, p) => n + (p.counts?.questions || 0), 0),
      resources: packs.reduce((n, p) => n + (p.counts?.resources || 0), 0)
    },
    packs
  };

  const collectionBuf = Buffer.from(JSON.stringify(collection, null, 2) + '\n', 'utf8');
  entries.push({ path: `${rootName}/collection.json`, data: collectionBuf });
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const zipPath = outFile
    ? path.resolve(outFile)
    : path.join(outDir || '.', `${rootName}.zip`);
  if (fs.existsSync(zipPath) && !force) {
    throw new AgentError('LA015', `合集已存在：${zipPath}`, { hint: '提升 --version 或加 --force 覆盖' });
  }
  ensureDir(path.dirname(zipPath));
  fs.writeFileSync(zipPath, writeZip(entries));
  return { zip: zipPath, rootName, collection };
}

/** 判断 ZIP 是否为学习库合集（单个根目录 + 根下 collection.json）。 */
export function isCollection(target) {
  if (!fs.existsSync(target)) return false;
  if (fs.statSync(target).isDirectory()) {
    return fs.existsSync(path.join(target, 'collection.json'));
  }
  try {
    const files = readZip(fs.readFileSync(target));
    const roots = new Set([...files.keys()].map((n) => n.split('/')[0]).filter(Boolean));
    return roots.size === 1 && files.has(`${[...roots][0]}/collection.json`);
  } catch {
    return false;
  }
}

function err(list, code, p, message) {
  list.push({ code, path: p, message });
}

/**
 * 校验合集：外层清单 + 每个子包的 strict 校验。
 *
 * @param {string} target 合集 ZIP 或已解包的合集目录
 * @param {{strict?: boolean, appVersion?: string}} [opts]
 */
export function verifyCollection(target, opts = {}) {
  const errors = [];
  const warnings = [];
  const report = { ok: false, format: COLLECTION_FORMAT, file: target, errors, warnings, packs: [] };

  if (!fs.existsSync(target)) {
    err(errors, 'E100', target, '目标不存在');
    return report;
  }

  let files;
  let rootName;
  if (fs.statSync(target).isDirectory()) {
    rootName = path.basename(target);
    files = new Map();
    const walk = (dir, base = '') => {
      for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = base ? `${base}/${item.name}` : item.name;
        const abs = path.join(dir, item.name);
        if (item.isDirectory()) walk(abs, rel);
        else if (item.isFile()) files.set(`${rootName}/${rel}`, fs.readFileSync(abs));
      }
    };
    walk(target);
  } else {
    try {
      files = readZip(fs.readFileSync(target));
    } catch (e) {
      err(errors, 'E102', target, `无法读取合集：${e.message}`);
      return report;
    }
    const roots = new Set([...files.keys()].map((n) => n.split('/')[0]).filter(Boolean));
    if (roots.size !== 1) {
      err(errors, 'E120', target, `合集内必须只有一个根目录，实际：${[...roots].join(', ')}`);
      return report;
    }
    rootName = [...roots][0];
  }

  const collectionBuf = files.get(`${rootName}/collection.json`);
  if (!collectionBuf) {
    err(errors, 'E120', `${rootName}/collection.json`, '缺少合集清单 collection.json');
    return report;
  }
  let collection;
  try {
    collection = JSON.parse(collectionBuf.toString('utf8'));
  } catch (e) {
    err(errors, 'E120', 'collection.json', `不是合法 JSON：${e.message}`);
    return report;
  }
  report.collection = collection;
  if (collection.format !== COLLECTION_FORMAT) {
    err(errors, 'E120', 'collection.json', `format 必须为 ${COLLECTION_FORMAT}`);
  }
  if (!Array.isArray(collection.packs) || !collection.packs.length) {
    err(errors, 'E121', 'collection.json', 'packs 不能为空');
    return report;
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'la-collection-'));
  try {
    for (const pack of collection.packs) {
      const dirName = String(pack.path || `${pack.slug}-${pack.version}`);
      const prefix = `${rootName}/${dirName}/`;
      const packFiles = [...files.entries()].filter(([name]) => name.startsWith(prefix));
      if (!packFiles.length) {
        err(errors, 'E121', dirName, '合集清单登记了该学习库，但包内没有对应文件');
        continue;
      }
      const dir = path.join(tmpRoot, dirName);
      for (const [name, data] of packFiles) {
        const rel = name.slice(prefix.length);
        if (!rel) continue;
        const dest = path.join(dir, rel);
        ensureDir(path.dirname(dest));
        fs.writeFileSync(dest, data);
      }
      const inner = verifyPack(dir, { strict: opts.strict, appVersion: opts.appVersion });
      for (const e of inner.errors) errors.push({ ...e, path: `${dirName}/${e.path}` });
      for (const w of inner.warnings) warnings.push({ ...w, path: `${dirName}/${w.path}` });
      if (inner.manifest) {
        if (inner.manifest.slug !== pack.slug || inner.manifest.version !== pack.version) {
          err(errors, 'E123', dirName, `清单登记 ${pack.slug} ${pack.version}，实际为 ${inner.manifest.slug} ${inner.manifest.version}`);
        }
        const actual = inner.manifest.content?.fingerprint || '';
        if (pack.fingerprint && actual && pack.fingerprint !== actual) {
          err(errors, 'E123', dirName, '内容指纹与合集清单不一致（包可能被替换或篡改）');
        }
        report.packs.push({
          slug: inner.manifest.slug,
          version: inner.manifest.version,
          title: inner.manifest.title,
          ok: inner.ok,
          counts: inner.manifest.counts
        });
      }
    }
    if (collection.packs.length !== report.packs.length) {
      err(errors, 'E121', 'collection.json', `清单登记 ${collection.packs.length} 个学习库，实际可读 ${report.packs.length} 个`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  report.ok = errors.length === 0 && (!opts.strict || warnings.length === 0);
  return report;
}
