/**
 * 合规抓取器
 *
 * 硬性约束（对应需求「合规与功能细节要求」）：
 *   1. 只允许 http / https，默认拒绝 localhost、内网、链路本地地址（防 SSRF 与抓取非公开资源）；
 *   2. 每次抓取前读取并遵守目标站点 robots.txt（含 Crawl-delay），5xx 视为暂时禁止；
 *   3. 同主机串行 + 最小请求间隔，UA 带用途与联系方式；
 *   4. 超时、响应体上限、重定向上限、Content-Type 白名单；
 *   5. 所有拒绝都记录原因，抓取报告可追溯。
 */

import robotsParser from 'robots-parser';
import { AgentError } from '../errors.mjs';
import { isPrivateHost, sleep } from '../util.mjs';

const HTML_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain'];

function originOf(url) {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;
}

function charsetOf(contentType) {
  const m = /charset=([^;]+)/i.exec(contentType || '');
  return m ? m[1].trim().replace(/^"|"$/g, '').toLowerCase() : 'utf-8';
}

function decodeBody(buffer, contentType) {
  const charset = charsetOf(contentType);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

export class Crawler {
  constructor(config) {
    this.config = config;
    this.robotsCache = new Map();
    this.hostChains = new Map();
    this.lastHit = new Map();
    this.stats = {
      requests: 0,
      robotsBlocked: 0,
      privateBlocked: 0,
      failures: 0,
      bytes: 0,
      hosts: new Set()
    };
    this.log = [];
  }

  headers(extra = {}) {
    return {
      'User-Agent': this.config.userAgent,
      Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extra
    };
  }

  assertPublic(url, { allowPrivate = this.config.allowPrivateHosts } = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new AgentError('LA012', `URL 非法：${url}`);
    }
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new AgentError('LA005', `只允许 http/https：${url}`);
    }
    if (parsed.username || parsed.password) {
      throw new AgentError('LA005', '禁止在 URL 中携带账号密码');
    }
    if (!allowPrivate && isPrivateHost(parsed.hostname)) {
      this.stats.privateBlocked++;
      throw new AgentError('LA005', `拒绝抓取非公开地址：${parsed.hostname}`, {
        hint: '仅允许公网 http(s) 资源；本地调试可设置 LA_ALLOW_PRIVATE_HOSTS=1'
      });
    }
    return parsed;
  }

  /** robots.txt：404 视为无限制，5xx / 网络失败视为暂时禁止。 */
  async robotsFor(url) {
    const origin = originOf(url);
    if (this.robotsCache.has(origin)) return this.robotsCache.get(origin);
    const robotsUrl = `${origin}/robots.txt`;
    let entry;
    try {
      this.stats.requests++;
      const res = await fetch(robotsUrl, {
        headers: this.headers({ Accept: 'text/plain,*/*;q=0.1' }),
        signal: AbortSignal.timeout(Math.min(10_000, this.config.crawlTimeoutMs)),
        redirect: 'follow'
      });
      if (res.status === 404 || res.status === 410) {
        entry = { robots: null, status: res.status, origin, note: '无 robots.txt，按允许处理' };
      } else if (res.status >= 500) {
        entry = { robots: null, status: res.status, origin, denyAll: true, note: 'robots.txt 服务端错误，保守禁止' };
      } else if (!res.ok) {
        entry = { robots: null, status: res.status, origin, denyAll: true, note: `robots.txt 返回 ${res.status}，保守禁止` };
      } else {
        const body = await res.text();
        entry = { robots: robotsParser(robotsUrl, body), status: res.status, origin, body, note: '已读取 robots.txt' };
      }
    } catch (err) {
      entry = { robots: null, status: 0, origin, denyAll: true, note: `robots.txt 读取失败：${err.message}` };
    }
    this.robotsCache.set(origin, entry);
    return entry;
  }

  async checkRobots(url) {
    const entry = await this.robotsFor(url);
    if (entry.denyAll) return { allowed: false, reason: entry.note, crawlDelay: 0 };
    if (!entry.robots) return { allowed: true, reason: entry.note, crawlDelay: 0 };
    const allowed = entry.robots.isAllowed(url, this.config.userAgent);
    const crawlDelay = entry.robots.getCrawlDelay(this.config.userAgent) || 0;
    return {
      allowed: allowed !== false,
      reason: allowed !== false ? 'robots 允许' : 'robots 禁止',
      crawlDelay: Number(crawlDelay) || 0
    };
  }

  /** 同主机串行 + 最小间隔（取配置值与 Crawl-delay 的较大者）。 */
  async throttle(url, crawlDelay = 0) {
    const host = new URL(url).host;
    const delay = Math.max(this.config.rateLimitMs, Number(crawlDelay) * 1000);
    const prev = this.hostChains.get(host) || Promise.resolve();
    const next = prev.then(async () => {
      const last = this.lastHit.get(host) || 0;
      const wait = last + delay - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastHit.set(host, Date.now());
    });
    this.hostChains.set(host, next.catch(() => {}));
    await next;
  }

  async readCapped(res, maxBytes) {
    if (!res.body) return Buffer.alloc(0);
    const chunks = [];
    let total = 0;
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new AgentError('LA006', `响应体超过 ${Math.round(maxBytes / 1024)}KB 上限`);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  }

  /**
   * 抓取单页。
   * @param {string} url
   * @param {{checkRobots?: boolean, maxBytes?: number, allowPrivate?: boolean, maxRedirects?: number}} [opts]
   */
  async fetchPage(url, opts = {}) {
    const {
      checkRobots = true,
      maxBytes = this.config.maxBytes,
      maxRedirects = 5
    } = opts;
    let current = this.assertPublic(url, opts).toString();

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (checkRobots) {
        const verdict = await this.checkRobots(current);
        if (!verdict.allowed) {
          this.stats.robotsBlocked++;
          this.log.push({ url: current, action: 'blocked', reason: verdict.reason });
          throw new AgentError('LA005', `robots 协议禁止抓取：${current}`, { details: verdict.reason });
        }
        await this.throttle(current, verdict.crawlDelay);
      }

      let res;
      try {
        this.stats.requests++;
        this.stats.hosts.add(new URL(current).host);
        res = await fetch(current, {
          headers: this.headers(),
          redirect: 'manual',
          signal: AbortSignal.timeout(this.config.crawlTimeoutMs)
        });
      } catch (err) {
        this.stats.failures++;
        throw new AgentError('LA006', `网页请求失败：${err.message}`, {
          hint: '检查网络或稍后重试',
          cause: err
        });
      }

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new AgentError('LA006', `重定向缺少 Location：${current}`);
        const next = this.assertPublic(new URL(location, current).toString(), opts);
        current = next.toString();
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      const mainType = contentType.split(';')[0].trim().toLowerCase();
      if (!res.ok) {
        throw new AgentError('LA006', `HTTP ${res.status}：${current}`, {
          details: { status: res.status, contentType }
        });
      }
      if (mainType && !HTML_TYPES.includes(mainType) && !mainType.endsWith('+xml')) {
        throw new AgentError('LA005', `不抓取非文本资源（${mainType}）：${current}`);
      }

      const buffer = await this.readCapped(res, maxBytes);
      this.stats.bytes += buffer.length;
      const html = decodeBody(buffer, contentType);
      this.log.push({ url: current, action: 'fetched', status: res.status, bytes: buffer.length, contentType });
      return {
        url,
        finalUrl: current,
        status: res.status,
        contentType,
        html,
        bytes: buffer.length,
        headers: Object.fromEntries(res.headers.entries())
      };
    }
    throw new AgentError('LA006', `重定向次数超过 ${maxRedirects}：${url}`);
  }

  /** 供搜索服务使用，不做正文 Content-Type 限制。 */
  async fetchText(url, { accept = 'application/json,text/html,text/plain;q=0.9', allowPrivate = false } = {}) {
    // 检索接口地址由用户显式配置（本地 SearXNG 常见为 127.0.0.1），只对这一条路径放行内网，
    // 正文抓取仍严格走 assertPublic，避免 SSRF 面扩大。
    this.assertPublic(url, { allowPrivate: this.config.allowPrivateHosts || allowPrivate });
    const res = await fetch(url, {
      headers: this.headers({ Accept: accept }),
      signal: AbortSignal.timeout(this.config.crawlTimeoutMs),
      redirect: 'follow'
    });
    this.stats.requests++;
    if (!res.ok) throw new AgentError('LA006', `HTTP ${res.status}：${url}`);
    const buffer = await this.readCapped(res, this.config.maxBytes);
    this.stats.bytes += buffer.length;
    return decodeBody(buffer, res.headers.get('content-type') || 'text/plain; charset=utf-8');
  }
}
