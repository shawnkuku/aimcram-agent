/**
 * AimCram 桌面 App 的检测与唤起。
 *
 * 插件通过 `aimcram://import?path=<包目录>` 让 App 直接导入学习库，
 * 不主动提醒导入；只有用户明确要求时才调用（由工具描述约束）。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** 常见安装位置；AIMCRAM_APP_PATH 可覆盖（测试或自定义安装）。 */
function candidates({ platform, env, home }) {
  if (platform === 'darwin') {
    return [
      env.AIMCRAM_APP_PATH,
      '/Applications/AimCram.app',
      path.join(home, 'Applications', 'AimCram.app')
    ].filter(Boolean);
  }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || '';
    const programFiles = env.ProgramFiles || '';
    return [
      env.AIMCRAM_APP_PATH,
      local && path.join(local, 'Programs', 'AimCram', 'AimCram.exe'),
      local && path.join(local, 'AimCram', 'AimCram.exe'),
      programFiles && path.join(programFiles, 'AimCram', 'AimCram.exe')
    ].filter(Boolean);
  }
  return [env.AIMCRAM_APP_PATH, '/usr/bin/aimcram', '/opt/AimCram/aimcram'].filter(Boolean);
}

/**
 * 检测 AimCram 是否已安装。
 * @returns {{installed: boolean, path?: string}}
 */
export function detectApp({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = fs.existsSync
} = {}) {
  for (const candidate of candidates({ platform, env, home })) {
    if (exists(candidate)) return { installed: true, path: candidate };
  }
  return { installed: false };
}

/** 构造 App 深链；路径整体编码，避免空格、中文和 & 破坏参数。 */
export function importUrl(target) {
  return `aimcram://import?path=${encodeURIComponent(path.resolve(target))}`;
}

/** 调用系统打开器唤起深链；只等 spawn 成功，不等待 App 退出。 */
export function openUrl(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const [command, args] = platform === 'darwin'
    ? ['open', [url]]
    : platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.once('error', reject);
    // open / xdg-open 在找不到协议处理器时会以非 0 退出，用它区分“已唤起”和“没装 App”
    child.once('close', (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(`系统未能打开 aimcram:// 链接（退出码 ${code}）`));
    });
  });
}
