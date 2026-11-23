import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { detectApp, importUrl, openUrl } from '../src/app.mjs';

test('detectApp：macOS 命中 /Applications/AimCram.app', () => {
  const app = detectApp({
    platform: 'darwin',
    home: '/Users/demo',
    env: {},
    exists: (p) => p === '/Applications/AimCram.app'
  });
  assert.deepEqual(app, { installed: true, path: '/Applications/AimCram.app' });
});

test('detectApp：Windows 依次检查常见安装目录', () => {
  const app = detectApp({
    platform: 'win32',
    home: 'C:\\Users\\demo',
    env: { LOCALAPPDATA: 'C:\\Users\\demo\\AppData\\Local' },
    exists: (p) => p.endsWith('AimCram.exe')
  });
  assert.equal(app.installed, true);
  assert.ok(app.path.endsWith('AimCram.exe'));
});

test('detectApp：未安装时返回 installed=false', () => {
  const app = detectApp({ platform: 'darwin', home: '/Users/demo', env: {}, exists: () => false });
  assert.deepEqual(app, { installed: false });
});

test('importUrl：中文和空格必须编码', () => {
  const url = importUrl('/tmp/学习 库/pack');
  assert.equal(url, 'aimcram://import?path=' + encodeURIComponent('/tmp/学习 库/pack'));
  assert.ok(!url.includes(' '));
});

test('openUrl：macOS 用 open，Windows 用 cmd start', async () => {
  const calls = [];
  const fakeSpawn = (command, args) => {
    calls.push([command, args]);
    const child = new EventEmitter();
    child.unref = () => {};
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  await openUrl('aimcram://import?path=%2Ftmp%2Fpack', { platform: 'darwin', spawnImpl: fakeSpawn });
  await openUrl('aimcram://import?path=%2Ftmp%2Fpack', { platform: 'win32', spawnImpl: fakeSpawn });
  assert.deepEqual(calls[0], ['open', ['aimcram://import?path=%2Ftmp%2Fpack']]);
  assert.deepEqual(calls[1], ['cmd', ['/c', 'start', '', 'aimcram://import?path=%2Ftmp%2Fpack']]);
});
