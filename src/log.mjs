/**
 * 进度反馈
 *
 * 事件结构固定，CLI 文本渲染、--json-progress 的 NDJSON、DSH 工具回调共用同一份数据。
 * 事件字段：{ stage, label, percent, message, detail, at }
 */

import { errorPayload } from './errors.mjs';

const STAGES = [
  { stage: 'resolve', label: '解析输入源' },
  { stage: 'extract', label: '内容提取' },
  { stage: 'crawl', label: '合规抓取' },
  { stage: 'dedupe', label: '去重与质量筛选' },
  { stage: 'outline', label: '构建大纲' },
  { stage: 'knowledge', label: '生成知识板块' },
  { stage: 'questions', label: '生成题目' },
  { stage: 'render', label: '渲染与内容校验' },
  { stage: 'pack', label: '组装学习库包' },
  { stage: 'verify', label: '包校验' },
  { stage: 'done', label: '完成' }
];

export function stageLabel(stage) {
  return STAGES.find((s) => s.stage === stage)?.label || stage;
}

function bar(percent, width = 20) {
  const filled = Math.round((percent / 100) * width);
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

export function createReporter(options = {}) {
  const {
    json = false,
    quiet = false,
    stream = process.stdout,
    errStream = process.stderr,
    onProgress = null,
    now = () => Date.now()
  } = options;

  const events = [];
  let lastLineLen = 0;

  function write(line) {
    if (quiet) return;
    if (stream.isTTY && !json) {
      stream.write('\r' + line.padEnd(lastLineLen, ' ') + (line.length < lastLineLen ? '' : ''));
      lastLineLen = line.length;
    } else {
      stream.write(line + '\n');
    }
  }

  function emit(raw) {
    const event = {
      stage: raw.stage || 'progress',
      label: raw.label || stageLabel(raw.stage),
      percent: Math.round(Math.min(100, Math.max(0, raw.percent ?? 0))),
      message: raw.message || '',
      detail: raw.detail ?? null,
      at: new Date(now()).toISOString()
    };
    events.push(event);
    if (json) {
      if (!quiet) stream.write(JSON.stringify({ type: 'progress', ...event }) + '\n');
    } else if (!quiet) {
      const line = `[${String(event.percent).padStart(3)}%] ${bar(event.percent)} ${event.label}${event.message ? ' · ' + event.message : ''}`;
      write(line);
      if (event.percent >= 100) {
        stream.write('\n');
        lastLineLen = 0;
      }
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress(event);
      } catch {
        /* 进度回调不应影响主流程 */
      }
    }
    return event;
  }

  return {
    events,
    emit,
    stage(stage, percent, message, detail) {
      return emit({ stage, percent, message, detail });
    },
    info(message) {
      if (json) return;
      if (!quiet) stream.write(message + '\n');
    },
    warn(message) {
      if (json) {
        if (!quiet) stream.write(JSON.stringify({ type: 'warning', message, at: new Date().toISOString() }) + '\n');
        return;
      }
      if (!quiet) stream.write(`! ${message}\n`);
    },
    error(err) {
      const payload = errorPayload(err);
      if (json) {
        stream.write(JSON.stringify({ type: 'error', ...payload, at: new Date().toISOString() }) + '\n');
      } else {
        // 错误信息不受 --quiet 影响，且始终写 stderr，避免静默失败
        errStream.write(`\n✗ [${payload.code}] ${payload.message}\n`);
        if (payload.hint) errStream.write(`  提示：${payload.hint}\n`);
        if (payload.details) errStream.write(`  详情：${JSON.stringify(payload.details).slice(0, 1500)}\n`);
      }
    },
    result(summary) {
      if (json) {
        stream.write(JSON.stringify({ type: 'result', ...summary, at: new Date().toISOString() }) + '\n');
      }
    }
  };
}

export { STAGES };
