import test from 'node:test';
import assert from 'node:assert/strict';
import { HarnessLLM } from '../src/llm-harness.mjs';
import { ensureLocalSearxng } from '../src/web/searxng-local.mjs';

/** 伪 Harness llm 服务：按预设 chunk 序列流式返回。 */
function fakeLlm(chunks) {
  return {
    seen: [],
    async *stream(options) {
      this.seen.push(options);
      for (const chunk of chunks) yield chunk;
    }
  };
}

/** 每次调用返回不同 chunk 序列，并可声明模型能力。 */
function scriptedLlm(responses, caps = null) {
  return {
    seen: [],
    async resolveModelInfo() {
      return caps;
    },
    async *stream(options) {
      this.seen.push(options);
      const chunks = responses[Math.min(this.seen.length - 1, responses.length - 1)];
      for (const chunk of chunks) yield chunk;
    }
  };
}

const JSON_CHUNKS = [
  { type: 'text-delta', index: 0, text: '{"ok":true}' },
  { type: 'finish', reason: { kind: 'stop' } }
];

const REASONING_ONLY_CHUNKS = [
  { type: 'reasoning-delta', index: 0, text: '先分析资料结构……' },
  { type: 'finish', reason: { kind: 'max-tokens' } }
];

test('HarnessLLM：走 ctx.llm 流式接口并解析 JSON', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '```json\n{"chapters":' },
    { type: 'text-delta', index: 0, text: '[{"name":"第一章"}]}' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 30 } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]);
  const model = new HarnessLLM({ llm, provider: 'deepseek', model: 'deepseek-chat' });

  assert.equal(model.name, 'harness:deepseek/deepseek-chat');
  const result = await model.chatJSON({ system: '只输出 JSON', user: '生成大纲', maxTokens: 800 });

  assert.deepEqual(result, { chapters: [{ name: '第一章' }] });
  assert.equal(model.stats.calls, 1);
  assert.equal(model.stats.promptTokens, 120);
  assert.equal(model.stats.completionTokens, 30);

  const sent = llm.seen[0];
  assert.equal(sent.provider, 'deepseek');
  assert.equal(sent.model, 'deepseek-chat');
  assert.equal(sent.system, '只输出 JSON');
  assert.equal(sent.maxTokens, 800);
  assert.deepEqual(sent.messages[0].content, [{ type: 'text', text: '生成大纲' }]);
});

test('HarnessLLM：模型侧失败转成 LA008', async () => {
  const llm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'invalid api key' } } }
  ]);
  const model = new HarnessLLM({ llm, provider: 'deepseek', model: 'deepseek-chat' });
  await assert.rejects(
    () => model.chatJSON({ system: 'x', user: 'y' }),
    (err) => err.code === 'LA008' && /invalid api key/.test(err.message)
  );
  assert.equal(model.stats.failures, 1);
});

test('HarnessLLM：空输出报 LA008', async () => {
  const llm = fakeLlm([{ type: 'finish', reason: { kind: 'stop' } }]);
  const model = new HarnessLLM({ llm, provider: 'deepseek', model: 'deepseek-chat' });
  await assert.rejects(() => model.chatJSON({ system: 'x', user: 'y' }), (err) => err.code === 'LA008');
});

test('HarnessLLM：reasoning 吃满预算时自动放大预算并降低 reasoning 档位', async () => {
  const llm = scriptedLlm([REASONING_ONLY_CHUNKS, JSON_CHUNKS], {
    defaultMaxTokens: 8192,
    reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] }
  });
  const model = new HarnessLLM({
    llm, provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'high'
  });

  const result = await model.chatJSON({ system: 'x', user: 'y', maxTokens: 800 });

  assert.deepEqual(result, { ok: true });
  assert.equal(model.stats.calls, 2);
  assert.equal(model.stats.retries, 1);
  assert.equal(model.stats.failures, 0);
  assert.equal(llm.seen[0].reasoningEffort, 'high');
  assert.equal(llm.seen[0].maxTokens, 800);
  assert.equal(llm.seen[1].reasoningEffort, 'low', '重试应降到最低 reasoning 档位');
  assert.equal(llm.seen[1].maxTokens, 4800, '重试应放大到模型上限内的更大预算');
});

test('HarnessLLM：空输出重试耗尽后报错带 finish 与 reasoning 诊断', async () => {
  const llm = scriptedLlm([REASONING_ONLY_CHUNKS], { defaultMaxTokens: 8192 });
  const model = new HarnessLLM({ llm, provider: 'deepseek', model: 'deepseek-flash' });

  await assert.rejects(
    () => model.chatJSON({ system: 'x', user: 'y', maxTokens: 500 }),
    (err) => err.code === 'LA008'
      && /finish=max-tokens/.test(err.message)
      && /reasoning=\d+ 字/.test(err.message)
  );
  assert.equal(model.stats.calls, 3, '默认最多 3 次尝试');
  assert.equal(model.stats.retries, 2);
  assert.equal(model.stats.failures, 1);
});

test('HarnessLLM：鉴权失败不重试', async () => {
  const llm = fakeLlm([
    { type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'invalid api key' } } }
  ]);
  const model = new HarnessLLM({ llm, provider: 'deepseek', model: 'deepseek-chat' });
  await assert.rejects(
    () => model.chatJSON({ system: 'x', user: 'y' }),
    (err) => err.code === 'LA008'
  );
  assert.equal(model.stats.calls, 1);
  assert.equal(model.stats.failures, 1);
});

test('HarnessLLM：缺少 provider/model 直接拒绝', () => {
  assert.throws(() => new HarnessLLM({ llm: fakeLlm([]), provider: '', model: '' }), (err) => err.code === 'LA012');
  assert.throws(() => new HarnessLLM({ llm: null, provider: 'deepseek', model: 'x' }), (err) => err.code === 'LA012');
});

test('本地 SearXNG：远端地址不接管、关闭开关时不启动', async () => {
  const remote = await ensureLocalSearxng('https://searx.example.com');
  assert.equal(remote.state, 'external');

  const skipped = await ensureLocalSearxng('http://127.0.0.1:9', { autoStart: false });
  assert.equal(skipped.state, 'skipped');
});
