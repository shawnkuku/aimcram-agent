/**
 * 复用 Harness 自身的模型：通过 DSH 的 `ctx.llm` 服务发起一次性请求。
 *
 * 与 src/llm.mjs 的区别：
 *   DeepSeekLLM   直连 api.deepseek.com，需要 DEEPSEEK_API_KEY；
 *   HarnessLLM    走 Harness 已配置的 provider / model / 凭据，
 *                 不需要插件自己持有 Key，也不会绕过用户的模型选择。
 *
 * 对上层保持同一契约：`name` / `stats` / `chatJSON({system,user,maxTokens,temperature})`。
 *
 * 推理模型（如 deepseek-flash）会把一部分输出预算花在 reasoning 上。输入较长时，
 * 若 reasoning 吃满 maxTokens，流会以 finish=max-tokens 结束且一个 text-delta 都没有，
 * 表现为「模型返回空内容」。这里做三件事：
 *   1. 同时累计 text-delta 与 reasoning-delta，失败时把 finish / reasoning 长度写进错误；
 *   2. 空输出、max-tokens 截断、限流类错误自动重试，并逐次放大输出预算；
 *   3. 重试时优先降低 reasoning effort（若模型声明了可选档位），把预算留给正文。
 */

import { AgentError } from './errors.mjs';
import { stripFence } from './llm.mjs';
import { sleep } from './util.mjs';

/** 把 Harness 的失败原因压成一行可读文本。 */
function describeFailure(failure) {
  if (!failure) return '未知错误';
  if (typeof failure === 'string') return failure;
  const parts = [failure.code, failure.message].filter(Boolean);
  return parts.length ? parts.join(' · ') : JSON.stringify(failure).slice(0, 300);
}

/** 限流 / 超时 / 5xx 才值得重试；鉴权、参数错误重试也没用。 */
function isRetryableFailure(failure) {
  if (!failure || typeof failure === 'string') return true;
  const status = Number(failure.status || 0);
  if (status === 429 || (status >= 500 && status < 600)) return true;
  return /rate|limit|timeout|overload|unavailable|temporar|busy/i.test(
    `${failure.code || ''} ${failure.message || ''}`
  );
}

const MAX_ATTEMPTS = 3;
const MAX_OUTPUT_TOKENS = 16_384;

export class HarnessLLM {
  /**
   * @param {{
   *   llm: {stream: Function, resolveModelInfo?: Function},
   *   provider: string,
   *   model: string,
   *   reasoningEffort?: string,
   *   signal?: AbortSignal
   * }} options
   */
  constructor({ llm, provider, model, reasoningEffort, signal } = {}) {
    if (!llm || typeof llm.stream !== 'function') {
      throw new AgentError('LA012', 'Harness LLM 服务不可用', { hint: '确认 Harness 已加载 dsh-llm 插件' });
    }
    if (!provider || !model) {
      throw new AgentError('LA012', 'Harness 尚未选择默认模型', { hint: '在 Harness 设置里选择一个模型后重试' });
    }
    this.llm = llm;
    this.provider = provider;
    this.model = model;
    this.reasoningEffort = reasoningEffort;
    this.signal = signal;
    this.name = `harness:${provider}/${model}`;
    this.stats = { calls: 0, retries: 0, promptTokens: 0, completionTokens: 0, failures: 0 };
    this.caps = null;
    this.capsPromise = null;
  }

  /** 模型能力（输出上限、可选 reasoning 档位）；拿不到就按保守值处理。 */
  async #modelCaps() {
    if (this.caps) return this.caps;
    if (this.capsPromise) return this.capsPromise;
    this.capsPromise = (async () => {
      if (typeof this.llm.resolveModelInfo !== 'function') return null;
      try {
        return await this.llm.resolveModelInfo(this.provider, this.model, this.signal);
      } catch {
        return null;
      }
    })();
    this.caps = await this.capsPromise;
    return this.caps;
  }

  /** 重试预算：至少翻倍，必要时抬到模型默认输出上限。 */
  #escalatedBudget(requested) {
    const cap = Number(this.caps?.defaultMaxTokens || 0);
    const desired = Math.min(MAX_OUTPUT_TOKENS, Math.max(requested * 2, requested + 4000));
    if (cap > 0) return Math.max(requested, Math.min(desired, cap));
    return Math.max(requested, desired);
  }

  /** 重试时降到模型支持的最低 reasoning 档位；模型没声明就交给默认值。 */
  #lowestReasoningEffort() {
    const efforts = this.caps?.reasoning?.efforts;
    if (!Array.isArray(efforts) || !efforts.length) return undefined;
    const idOf = (entry) => (typeof entry === 'string' ? entry : entry?.id);
    for (const preferred of ['none', 'minimal', 'low']) {
      const hit = efforts.map(idOf).find((id) => String(id).toLowerCase() === preferred);
      if (hit) return hit;
    }
    return idOf(efforts[0]);
  }

  async #streamOnce({ system, user, maxTokens, temperature, reasoningEffort }) {
    const options = {
      provider: this.provider,
      model: this.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      temperature,
      maxTokens
    };
    if (system) options.system = system;
    if (reasoningEffort) options.reasoningEffort = reasoningEffort;
    if (this.signal) options.signal = this.signal;

    this.stats.calls++;
    let text = '';
    let reasoning = '';
    let finish = 'none';

    for await (const chunk of this.llm.stream(options)) {
      if (chunk.type === 'text-delta') {
        text += chunk.text || '';
      } else if (chunk.type === 'reasoning-delta') {
        reasoning += chunk.text || '';
      } else if (chunk.type === 'block-end' && chunk.block) {
        // 个别适配器只给 block-end、不给 delta；没有 delta 时用整块文本兜底。
        if (chunk.block.type === 'text' && !text) text = chunk.block.text || '';
        else if (chunk.block.type === 'reasoning' && !reasoning) reasoning = chunk.block.text || '';
      } else if (chunk.type === 'usage' && chunk.usage) {
        this.stats.promptTokens += chunk.usage.inputTokens || 0;
        this.stats.completionTokens += chunk.usage.outputTokens || 0;
      } else if (chunk.type === 'finish' && chunk.reason) {
        finish = chunk.reason.kind || 'unknown';
        if (chunk.reason.kind === 'error') {
          const failure = chunk.reason.failure;
          throw new AgentError('LA008', `Harness 模型调用失败：${describeFailure(failure)}`, {
            hint: '在 Harness 设置里检查该模型的凭据与可用性',
            retryable: isRetryableFailure(failure),
            details: failure
          });
        }
        if (chunk.reason.kind === 'aborted') {
          throw new AgentError('LA008', 'Harness 模型调用已取消', { retryable: false });
        }
      }
    }

    return { text, reasoning, finish };
  }

  async #request({ system, user, maxTokens = 4000, temperature = 0.2 }) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (this.signal?.aborted) {
        throw new AgentError('LA008', 'Harness 模型调用已取消', { retryable: false });
      }
      await this.#modelCaps();
      const budget = attempt === 1 ? maxTokens : this.#escalatedBudget(maxTokens);
      const effort = attempt === 1 ? this.reasoningEffort : this.#lowestReasoningEffort();

      let out;
      try {
        out = await this.#streamOnce({ system, user, maxTokens: budget, temperature, reasoningEffort: effort });
      } catch (err) {
        lastError = err;
        if (!(err instanceof AgentError) || !err.retryable) {
          this.stats.failures++;
          throw err;
        }
      }

      if (out?.text?.trim()) {
        // 截断但已经有正文时，最后一次尝试仍把内容交给 JSON 解析/修复链路。
        if (out.finish !== 'max-tokens' || attempt === MAX_ATTEMPTS) return out.text;
        lastError = new AgentError('LA008', 'Harness 模型输出被 max-tokens 截断', {
          retryable: true,
          details: { finish: out.finish, textChars: out.text.length, reasoningChars: out.reasoning.length, attempt }
        });
      } else if (out) {
        lastError = new AgentError(
          'LA008',
          `Harness 模型返回空内容（finish=${out.finish}，reasoning=${out.reasoning.length} 字，attempt ${attempt}/${MAX_ATTEMPTS}）`,
          {
            retryable: true,
            hint: '模型把输出预算花在了推理上；已自动放大预算并降低 reasoning 档位后重试',
            details: { finish: out.finish, reasoningChars: out.reasoning.length, maxTokens: budget, attempt }
          }
        );
      }

      if (attempt < MAX_ATTEMPTS) {
        this.stats.retries++;
        await sleep(300 * attempt);
      }
    }

    this.stats.failures++;
    throw lastError || new AgentError('LA008', 'Harness 模型调用失败', { retryable: true });
  }

  /**
   * @param {{system: string, user: string|object, maxTokens?: number, temperature?: number}} req
   * @returns {Promise<object>}
   */
  async chatJSON({ system, user, maxTokens = 4000, temperature = 0.2 }) {
    const userText = typeof user === 'string' ? user : JSON.stringify(user);
    const raw = await this.#request({ system, user: userText, maxTokens, temperature });
    try {
      return JSON.parse(stripFence(raw));
    } catch (err) {
      // 与 DeepSeekLLM 保持一致：给一次「只输出 JSON」的修复机会
      const repair = await this.#request({
        system: '你是 JSON 修复器，只输出合法 JSON，不要任何解释或代码围栏。',
        user: `以下内容不是合法 JSON（${err.message}）：\n${raw.slice(0, 12000)}\n\n请修复为合法 JSON，保持原有结构与事实，不要新增内容。`,
        maxTokens: this.#escalatedBudget(maxTokens),
        temperature: 0
      });
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
