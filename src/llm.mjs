/**
 * LLM 接入层（DeepSeek OpenAI 兼容接口）
 *
 * - JSON 模式 + 温度 0.2 + 上限 token；
 * - 429 / 5xx / 超时按指数退避重试，其余 4xx 直接失败；
 * - 返回内容先做代码围栏剥离，再 JSON.parse；解析失败追加一次「只输出 JSON」修复请求；
 * - 所有调用统计写入 stats，最终进入生成报告。
 */

import { AgentError } from './errors.mjs';
import { sleep } from './util.mjs';

export function stripFence(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  return s;
}

export class DeepSeekLLM {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.name = `deepseek:${config.model}`;
    this.stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
  }

  async #request(messages, { maxTokens = 4000, temperature = 0.2 } = {}) {
    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let budget = maxTokens;

    let lastError = null;
    for (let attempt = 1; attempt <= this.config.llmRetries; attempt++) {
      const body = {
        model: this.config.model,
        messages,
        temperature,
        max_tokens: budget,
        response_format: { type: 'json_object' },
        stream: false
      };

      try {
        this.stats.calls++;
        const res = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.config.llmTimeoutMs)
        });

        if (res.status === 429 || res.status >= 500) {
          const text = await res.text().catch(() => '');
          lastError = new AgentError('LA008', `DeepSeek HTTP ${res.status}`, {
            retryable: true,
            details: text.slice(0, 500)
          });
          this.stats.retries++;
          await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
          continue;
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new AgentError('LA008', `DeepSeek 请求失败：HTTP ${res.status}`, {
            hint: res.status === 401 ? '检查 DEEPSEEK_API_KEY 是否正确' : '',
            details: text.slice(0, 800)
          });
        }

        const data = await res.json();
        if (data.usage) {
          this.stats.promptTokens += data.usage.prompt_tokens || 0;
          this.stats.completionTokens += data.usage.completion_tokens || 0;
        }
        const content = data.choices?.[0]?.message?.content;
        const finish = data.choices?.[0]?.finish_reason || '';
        // 推理模型可能把 max_tokens 全花在 reasoning 上，正文为空或只输出半截 JSON。
        // 这类失败只能靠放大预算重试，直接报错会让长资料永远生成失败。
        if (!content || finish === 'length') {
          lastError = new AgentError(
            'LA008',
            finish === 'length'
              ? `DeepSeek 输出被 max_tokens=${budget} 截断`
              : 'DeepSeek 返回空内容',
            { retryable: true, details: { finish_reason: finish, max_tokens: budget } }
          );
          if (attempt === this.config.llmRetries) break;
          budget = Math.min(8192, Math.max(budget * 2, budget + 2000));
          this.stats.retries++;
          await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
          continue;
        }
        return content;
      } catch (err) {
        if (err instanceof AgentError && !err.retryable) throw err;
        lastError = err;
        this.stats.retries++;
        if (attempt === this.config.llmRetries) break;
        await sleep(Math.min(8000, 600 * 2 ** (attempt - 1)));
      }
    }
    this.stats.failures++;
    throw lastError instanceof AgentError
      ? lastError
      : new AgentError('LA008', `DeepSeek 调用失败：${lastError?.message || '未知错误'}`, {
          hint: '检查网络与 API Key',
          cause: lastError
        });
  }

  /**
   * @param {{system: string, user: string|object, maxTokens?: number, temperature?: number}} req
   * @returns {Promise<object>}
   */
  async chatJSON({ system, user, maxTokens = 4000, temperature = 0.2 }) {
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: userText }
    ];
    let raw = await this.#request(messages, { maxTokens, temperature });
    try {
      return JSON.parse(stripFence(raw));
    } catch (err) {
      // 一次修复：把原始输出与错误回传，要求只输出 JSON
      const repair = await this.#request(
        [
          { role: 'system', content: '你是 JSON 修复器，只输出合法 JSON，不要任何解释或代码围栏。' },
          { role: 'user', content: `以下内容不是合法 JSON（${err.message}）：\n${raw.slice(0, 12000)}\n\n请修复为合法 JSON，保持原有结构与事实，不要新增内容。` }
        ],
        { maxTokens, temperature: 0 }
      );
      try {
        return JSON.parse(stripFence(repair));
      } catch (err2) {
        throw new AgentError('LA008', 'LLM 输出无法解析为 JSON（已尝试修复）', {
          details: { first: raw.slice(0, 1000), repair: String(repair).slice(0, 1000) },
          cause: err2
        });
      }
    }
  }
}

export function createLLM(config, opts = {}) {
  if (opts.mock) {
    throw new AgentError('LA012', 'mock 模式请使用 src/mock.mjs 提供的 MockLLM');
  }
  if (!config.apiKey) {
    throw new AgentError('LA007', '未配置 DEEPSEEK_API_KEY', {
      hint: 'export DEEPSEEK_API_KEY=...，或加 --mock 使用离线确定性生成'
    });
  }
  return new DeepSeekLLM(config, opts);
}
