/**
 * 主题检索（DeepSeek 官方 Search API）
 *
 * 依次用前两个查询模板调 tools.search，合并结果后按 URL 去重（去 #fragment）、
 * 过滤非 http(s) 链接、截断到 limit。搜索失败直接抛错，不做静默回退；
 * 返回结果只是候选，正文仍逐页走 DeepSeekTools.fetchPage。
 */

import { AgentError } from '../errors.mjs';
import { uniqueBy } from '../util.mjs';

const SEARCH_QUERIES = [
  (topic) => `${topic} 核心概念 原理`,
  (topic) => `${topic} 教程 基础知识`,
  (topic) => `${topic} 高频考点 总结`
];

/**
 * @param {string} topic
 * @param {import('./deepseek-tools.mjs').DeepSeekTools} tools
 * @param {{limit?: number, queries?: string[]}} [opts]
 */
export async function searchTopic(topic, tools, opts = {}) {
  const limit = opts.limit || 10;
  const queries = (opts.queries?.length ? opts.queries : SEARCH_QUERIES.map((f) => f(topic))).slice(0, 2);
  const attempts = [];
  const collected = [];

  for (const query of queries) {
    const results = await tools.search(query, { count: limit });
    collected.push(...results.map((r) => ({ ...r, provider: 'deepseek', query })));
    attempts.push({ provider: 'deepseek', query, ok: true, count: results.length });
  }

  const valid = collected
    .filter((r) => /^https?:\/\//i.test(r.url || ''))
    .map((r) => ({ ...r, url: r.url.split('#')[0] }));
  const results = uniqueBy(valid, (r) => r.url).slice(0, limit);
  if (!results.length) {
    throw new AgentError('LA006', 'DeepSeek 搜索未返回结果', {
      hint: '检查 DEEPSEEK_API_KEY 是否有效、账户余额是否充足，或改用本地文件 / URL 输入源',
      details: attempts
    });
  }
  return { provider: 'deepseek', results, attempts };
}

export { SEARCH_QUERIES };
