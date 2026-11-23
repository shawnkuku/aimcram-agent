import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeTempDir, CLI } from './helpers.mjs';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

function run(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    ...opts
  });
}

const ROOT = path.dirname(CLI);
const SAMPLE = path.join(ROOT, 'samples/architecture-notes.md');

test('CLI：generate → verify → unpack', async (t) => {
  const dir = makeTempDir('la-cli-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const gen = run([
    'generate', '--topic', '系统架构设计', '--source', SAMPLE,
    '--mock', '--out', dir, '--slug', 'cli-test', '--version', '1.0.0', '--quiet'
  ]);
  assert.equal(gen.status, 0, gen.stderr);
  const zip = path.join(dir, 'cli-test-1.0.0.zip');
  assert.ok(fs.existsSync(zip));

  const verify = run(['verify', zip, '--strict', '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  const report = JSON.parse(verify.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.manifest.slug, 'cli-test');

  const unpackDir = path.join(dir, 'unpacked');
  const unpack = run(['unpack', zip, '-o', unpackDir]);
  assert.equal(unpack.status, 0, unpack.stderr);
  assert.ok(fs.existsSync(path.join(unpackDir, 'cli-test-1.0.0/manifest.json')));
});

test('CLI：bundle 把多个包合成一个 ZIP，verify 自动识别合集', async (t) => {
  const dir = makeTempDir('la-cli-bundle-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  for (const slug of ['cli-a', 'cli-b']) {
    const gen = run([
      'generate', '--topic', `主题 ${slug}`, '--source', SAMPLE,
      '--mock', '--out', dir, '--slug', slug, '--version', '1.0.0', '--quiet'
    ]);
    assert.equal(gen.status, 0, gen.stderr);
  }

  const bundle = run([
    'bundle',
    path.join(dir, 'cli-a-1.0.0.zip'),
    path.join(dir, 'cli-b-1.0.0.zip'),
    '--name', 'cli-all', '--version', '2.0.0', '--title', 'CLI 合集',
    '-o', path.join(dir, 'cli-all-2.0.0.zip')
  ]);
  assert.equal(bundle.status, 0, bundle.stderr);
  assert.match(bundle.stdout, /学习库合集已生成/);
  assert.ok(fs.existsSync(path.join(dir, 'cli-all-2.0.0.zip')));

  const verify = run(['verify', path.join(dir, 'cli-all-2.0.0.zip'), '--strict', '--json']);
  assert.equal(verify.status, 0, verify.stderr);
  const report = JSON.parse(verify.stdout);
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.collection.name, 'cli-all');
  assert.deepEqual(report.packs.map((p) => p.slug).sort(), ['cli-a', 'cli-b']);
});

test('CLI：--json-progress 输出 NDJSON 事件与结果', async (t) => {
  const dir = makeTempDir('la-cli-json-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gen = run([
    'generate', '--topic', '系统架构设计', '--source', SAMPLE,
    '--mock', '--out', dir, '--slug', 'cli-json', '--json-progress'
  ]);
  assert.equal(gen.status, 0, gen.stderr);
  const lines = gen.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.type === 'progress' && e.stage === 'outline'));
  const result = lines.at(-1);
  assert.equal(result.type, 'result');
  assert.equal(result.ok, true);
  assert.equal(result.slug, 'cli-json');
  assert.ok(result.paths.zip);
});

test('CLI：参数错误与缺失来源给出非零退出码', () => {
  const missing = run(['generate', '--topic', 'x', '--mode', 'sources', '--mock', '--quiet']);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /LA001/);

  const badTarget = run(['verify', path.join(makeTempDir('la-cli-miss-'), 'nope.zip')]);
  assert.notEqual(badTarget.status, 0);
});

test('CLI：doctor 自检可执行', () => {
  const doctor = run(['doctor', '--json']);
  const info = JSON.parse(doctor.stdout);
  assert.equal(info.version, VERSION);
  assert.equal(info.kshare, true);
  assert.ok(info.deps['pdfjs-dist']);
});
