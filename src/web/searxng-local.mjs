/**
 * 本地 SearXNG 守护：探活 → 按需拉起 searxng/run.sh → 等待就绪。
 *
 * 只有「本机地址且端口拒绝连接」才会尝试启动：
 * - 端口上已有服务（哪怕不是 SearXNG）一律不动，避免劫持别人的进程；
 * - 远端 / 自建实例（非 loopback）永不启动；
 * - LA_SEARXNG_AUTOSTART=0 可整体关闭。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_SH = path.resolve(HERE, '../../searxng/run.sh');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loopbackPort(baseUrl) {
  try {
    const u = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname)) return null;
    return u.port || '8888';
  } catch {
    return null;
  }
}

async function reachable(baseUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.text().catch(() => '');
    return true;
  } catch {
    return false;
  }
}

// 同进程内只启动一次：并发调用共享同一个启动 Promise
let starting = null;

/**
 * @param {string} baseUrl 例如 http://127.0.0.1:8888
 * @param {{timeoutMs?: number, onNote?: (message: string) => void, autoStart?: boolean}} [opts]
 * @returns {Promise<{state: 'running'|'started'|'external'|'skipped'|'failed', url: string, reason?: string}>}
 */
export async function ensureLocalSearxng(baseUrl, opts = {}) {
  const url = String(baseUrl || '').replace(/\/$/, '');
  const port = loopbackPort(url);
  if (!port) return { state: 'external', url };
  if (await reachable(url)) return { state: 'running', url };
  if (opts.autoStart === false) return { state: 'skipped', url, reason: '已关闭自动启动' };
  if (!fs.existsSync(RUN_SH)) return { state: 'failed', url, reason: `缺少 ${RUN_SH}` };

  if (starting) {
    const state = await starting;
    return { state: state === 'started' ? 'started' : 'failed', url };
  }

  const timeoutMs = opts.timeoutMs ?? 120_000;
  opts.onNote?.(`本地 SearXNG 未响应，正在启动 ${url}（首次启动可能需要安装依赖）`);

  starting = (async () => {
    const child = spawn('/bin/bash', [RUN_SH], {
      cwd: path.dirname(RUN_SH),
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, SEARXNG_PORT: port }
    });
    child.unref();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      if (await reachable(url)) return 'started';
    }
    return 'failed';
  })();

  const state = await starting;
  starting = null;
  if (state === 'started') {
    opts.onNote?.(`本地 SearXNG 已就绪：${url}`);
    return { state: 'started', url };
  }
  return { state: 'failed', url, reason: `启动超时（${Math.round(timeoutMs / 1000)}s）` };
}
