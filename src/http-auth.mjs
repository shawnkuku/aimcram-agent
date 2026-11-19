/**
 * 指定网址的直连抓取（可携带登录凭证）。
 *
 * 只在用户显式填写了地址时使用：DeepSeek Fetch 无法带自定义请求头，
 * 所以需要登录的页面改由本地发请求，凭证只存在于本次进程内。
 */

import { AgentError } from './errors.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,'
  + 'application/pdf,text/plain,text/markdown,*/*;q=0.8';
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function cleanHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');
}

/** 把桌面端传来的凭证（对象或 JSON 字符串）校验成可用结构；缺字段返回 null。 */
export function normalizeSourceAuth(raw) {
  if (!raw) return null;
  let value = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return null;
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const type = String(value.type || '').trim().toLowerCase();
  const auth = {
    type,
    hosts: (Array.isArray(value.hosts) ? value.hosts : [])
      .map(cleanHost)
      .filter(Boolean)
  };
  if (type === 'bearer') {
    auth.token = String(value.token || '').trim();
    if (!auth.token) return null;
  } else if (type === 'basic') {
    auth.username = String(value.username || '').trim();
    auth.password = String(value.password ?? '');
    if (!auth.username) return null;
  } else if (type === 'cookie') {
    auth.cookie = String(value.cookie || '').trim();
    if (!auth.cookie) return null;
  } else if (type === 'header') {
    auth.header = String(value.header || '').trim();
    auth.value = String(value.value || '').trim();
    if (!/^[A-Za-z0-9-]+$/.test(auth.header) || !auth.value) return null;
  } else {
    return null;
  }
  return auth;
}

/** 凭证是否允许发送到该地址：填了域名就按域名（含子域）限制。 */
export function authAllowsHost(auth, url) {
  if (!auth) return false;
  if (!auth.hosts.length) return true;
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return auth.hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

function authHeaders(auth) {
  if (auth.type === 'bearer') return { Authorization: `Bearer ${auth.token}` };
  if (auth.type === 'basic') {
    const token = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    return { Authorization: `Basic ${token}` };
  }
  if (auth.type === 'cookie') return { Cookie: auth.cookie };
  if (auth.type === 'header') return { [auth.header]: auth.value };
  return {};
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > maxBytes) {
    throw new AgentError('LA006', `页面超过大小上限（${declared} 字节）`, {
      hint: '换用体积更小的资料页，或只粘贴需要的正文'
    });
  }
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* 忽略取消异常 */ }
      throw new AgentError('LA006', '页面超过大小上限', {
        hint: '换用体积更小的资料页，或只粘贴需要的正文'
      });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * 带上凭证直接 GET 页面，手动跟随少量重定向；跨域跳转时自动丢弃凭证。
 * @param {string} url
 * @param {object} auth normalizeSourceAuth 的返回值
 * @param {{timeoutMs?: number, maxBytes?: number}} [opts]
 */
export async function fetchUrlWithAuth(url, auth, opts = {}) {
  const timeoutMs = Math.max(5_000, Number(opts.timeoutMs) || 20_000);
  const maxBytes = Math.max(1024, Number(opts.maxBytes) || 5 * 1024 * 1024);
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const headers = { 'User-Agent': UA, Accept: ACCEPT, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };
    if (authAllowsHost(auth, current)) Object.assign(headers, authHeaders(auth));
    let res;
    try {
      res = await fetch(current, {
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? '请求超时' : (err?.message || String(err));
      throw new AgentError('LA006', `抓取失败：${reason}`, {
        hint: '检查网络连通性与地址是否可访问；需要登录的页面请填写凭证',
        cause: err
      });
    }
    if (REDIRECTS.has(res.status)) {
      const location = res.headers.get('location');
      if (!location || hop === 5) {
        throw new AgentError('LA006', '重定向次数过多或缺少跳转地址', { hint: '改用最终地址重试' });
      }
      try { await res.body?.cancel(); } catch { /* 忽略 */ }
      current = new URL(location, current).toString();
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AgentError('LA005', `地址需要登录或凭证无效（HTTP ${res.status}）：${current}`, {
        hint: '在创建页展开「地址需要登录凭证」，填写 Token / Cookie 后重试',
        details: { status: res.status, url: current, auth: true }
      });
    }
    if (!res.ok) {
      throw new AgentError('LA006', `抓取失败（HTTP ${res.status}）：${current}`, {
        hint: '确认地址可公开访问，或稍后重试'
      });
    }
    return {
      buffer: await readCapped(res, maxBytes),
      contentType: res.headers.get('content-type') || '',
      finalUrl: current,
      status: res.status
    };
  }
  throw new AgentError('LA006', '重定向次数过多', { hint: '改用最终地址重试' });
}
