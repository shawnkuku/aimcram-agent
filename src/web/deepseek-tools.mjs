/**
 * DeepSeek 官方 Search / Fetch 工具 API 客户端
 *
 * - 搜索：POST {BASE}/v1/tools/search，Body：query（1~128 字符）、count（1~50）、need_content=false；
 *   正文不随搜索结果返回，逐页走 Fetch。
 * - 抓取：POST {BASE}/v1/tools/fetch，Body：{url}；返回 {title, content}，content 为 Markdown 正文。
 * - 鉴权：Authorization: Bearer {apiKey}；BASE 取 config.baseUrl（已以 /v1 结尾时不再重复拼接）。
 * - 错误：401 Key 无效（LA007）；402 余额不足；403 目标站点安全策略拒绝（LA005，仅 fetch）；
 *   404 未能获取可用网页内容（LA006，仅 fetch）；408/429/5xx 指数退避重试；其余 4xx 直接失败。
 *   失败直接抛错，不做任何静默回退。
 */

import { AgentError } from '../errors.mjs';
import { sleep } from '../util.mjs';

/** baseUrl 已以 /v1 结尾时不再拼第二次。 */
export function toolsUrl(baseUrl, path) {
  const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const prefix = /\/v1$/i.test(base) ? base : `${base}/v1`;
  return `${prefix}/tools/${String(path).replace(/^\/+/, '')}`;
}

const KIND_LABEL = { search: '搜索', fetch: '抓取' };

export class DeepSeekTools {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    if (!config?.apiKey) {
      throw new AgentError('LA007', '未配置 DeepSeek API Key，无法使用联网搜索与网页抓取', {
        hint: 'export DEEPSEEK_API_KEY=... 后重试；离线场景可加 --mock 并改用本地文件输入'
      });
    }
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.stats = { searchCalls: 0, fetchCalls: 0, retries: 0, bytes: 0 };
  }

  get #timeoutMs() {
    return this.config.crawlTimeoutMs || 20_000;
  }

  get #retries() {
    return this.config.llmRetries || 3;
  }

  async #post(path, body, kind) {
    const url = toolsUrl(this.config.baseUrl, path);
    const label = KIND_LABEL[kind] || kind;
    let lastError = null;

    for (let attempt = 1; attempt <= this.#retries; attempt++) {
      let res;
      let text = '';
      try {
        if (kind === 'search') this.stats.searchCalls++;
        else this.stats.fetchCalls++;
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#timeoutMs)
        });
        text = await res.text();
        this.stats.bytes += Buffer.byteLength(text, 'utf8');
      } catch (err) {
        // 网络错误 / 超时：可重试
        lastError = new AgentError('LA006', `DeepSeek ${label}请求失败：${err.message}`, {
          hint: '检查网络连通性或稍后重试',
          retryable: true,
          cause: err
        });
        if (attempt === this.#retries) break;
        this.stats.retries++;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
        continue;
      }

      if (res.ok) {
        try {
          return JSON.parse(text);
        } catch {
          throw new AgentError('LA006', `DeepSeek ${label}接口未返回 JSON`, { details: text.slice(0, 500) });
        }
      }

      const detail = text.slice(0, 500);
      if (res.status === 401) {
        throw new AgentError('LA007', 'DeepSeek API Key 无效或已失效', {
          hint: '检查 DEEPSEEK_API_KEY 是否正确',
          details: detail
        });
      }
      if (res.status === 402) {
        throw new AgentError('LA006', 'DeepSeek 账户余额不足', {
          hint: '请先到 DeepSeek 开放平台充值后重试',
          details: detail
        });
      }
      if (kind === 'fetch' && res.status === 403) {
        throw new AgentError('LA005', `目标站点安全策略拒绝抓取：${body.url}`, { details: detail });
      }
      if (kind === 'fetch' && res.status === 404) {
        throw new AgentError('LA006', `未能获取可用网页内容：${body.url}`, { details: detail });
      }
      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        lastError = new AgentError('LA006', `DeepSeek ${label}接口 HTTP ${res.status}`, {
          retryable: true,
          details: detail
        });
        if (attempt === this.#retries) break;
        this.stats.retries++;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
        continue;
      }
      throw new AgentError('LA006', `DeepSeek ${label}请求失败：HTTP ${res.status}`, { details: detail });
    }

    throw lastError;
  }

  /**
   * 联网搜索。无结果时返回空数组（不算错误）。
   * @param {string} query 1~128 字符
   * @returns {Promise<Array<{title: string, url: string, snippet: string}>>}
   */
  async search(query, { count = 10 } = {}) {
    const q = String(query || '').trim();
    if (!q || q.length > 128) {
      throw new AgentError('LA012', `搜索词长度需在 1~128 字符之间（当前 ${q.length}）`);
    }
    const data = await this.#post('search', {
      query: q,
      count: Math.max(1, Math.min(50, count)),
      need_content: false
    }, 'search');
    return (data.results || []).map((r) => ({
      title: String(r.title || '').trim(),
      url: String(r.url || '').trim(),
      snippet: String(r.snippet || r.summary || '').replace(/\s+/g, ' ').trim()
    }));
  }

  /**
   * 抓取单页，返回 Markdown 正文。
   * @param {string} url
   * @returns {Promise<{url: string, finalUrl: string, title: string, markdown: string, bytes: number}>}
   */
  async fetchPage(url) {
    const data = await this.#post('fetch', { url: String(url) }, 'fetch');
    const markdown = String(data.content || '');
    return {
      url,
      finalUrl: url,
      title: String(data.title || '').trim(),
      markdown,
      bytes: Buffer.byteLength(markdown, 'utf8')
    };
  }
}
