/**
 * 统一错误模型
 *
 * 所有对外可见的失败都用 AgentError 包装，CLI / DSH 工具层据此输出可读的错误码、
 * 修复建议与可重试标记，避免把底层异常（ENOENT、fetch failed）直接抛给用户。
 */

export const ERROR_CATALOG = {
  LA001: { message: '未提供可用的输入源或学习主题', hint: '至少提供 --topic 或 --source 之一' },
  LA002: { message: '不支持的文件格式', hint: '支持的格式：md / txt / html / pdf / docx / png / jpg / jpeg / webp / bmp / gif' },
  LA003: { message: '内容提取失败', hint: '检查文件是否损坏；图片 OCR 需要 macOS Vision 或 tesseract' },
  LA004: { message: '输入源不存在或不可读', hint: '确认路径拼写，或改用 http(s) URL' },
  LA005: { message: '网页抓取被 robots 协议或站点策略拒绝', hint: '更换来源，或改用已授权的输入源' },
  LA006: { message: '网络请求失败或超时', hint: '检查网络连通性；可降低 --pages 或稍后重试', retryable: true },
  LA007: {
    message: '未配置 DeepSeek API Key',
    hint: '在 Harness 里选择模型即可复用其凭据；CLI 下设置 DEEPSEEK_API_KEY，或加 --mock 走本地确定性生成'
  },
  LA008: { message: 'LLM 返回内容为空、被截断或无法解析为约定的 JSON', hint: '适配层会自动重试；若持续失败，换用能力更强的模型或减少单次输入的资料量', retryable: true },
  LA009: { message: '生成内容未通过 kshare 校验', hint: '查看报告中的 E0xx 错误码与行号' },
  LA010: { message: '学习库包校验失败', hint: '运行 verify 查看 E1xx / W1xx 明细' },
  LA011: { message: '没有可用的有效内容', hint: '检查输入源是否为空、是否为扫描件（需 OCR）或抓取页面是否被反爬' },
  LA012: { message: '参数非法', hint: '运行 --help 查看参数说明' },
  LA013: { message: '输出目录不可写', hint: '检查目录权限或改用 --out 指定可写目录' },
  LA014: { message: '技能依赖缺失', hint: '在 services/aimcram-agent 执行 npm install' },
  LA015: { message: '写包时发现同名 slug+version 冲突', hint: '提升 --version 或换 --slug' },
  LA016: { message: '用户取消了生成', hint: '大纲未被确认，重新发起并确认大纲即可继续' },
  LA017: { message: '操作未获授权', hint: '该操作需要在 Harness 权限提示中选择「允许」后重试', retryable: true },
  LA018: { message: '用户中止了逐章生成', hint: '已生成的章节未组包；重新发起生成即可继续' }
};

export class AgentError extends Error {
  constructor(code, message, opts = {}) {
    const entry = ERROR_CATALOG[code] || {};
    super(message || entry.message || code);
    this.name = 'AgentError';
    this.code = code;
    this.hint = opts.hint || entry.hint || '';
    this.retryable = opts.retryable ?? entry.retryable ?? false;
    this.details = opts.details || null;
    if (opts.cause) this.cause = opts.cause;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      details: this.details
    };
  }
}

export function wrapError(err, code, message) {
  if (err instanceof AgentError) return err;
  return new AgentError(code, message || err?.message || String(err), { cause: err });
}

export function errorPayload(err) {
  if (err instanceof AgentError) return err.toJSON();
  return {
    code: 'LA999',
    message: err?.message || String(err),
    hint: '未预期的内部错误，请附上日志反馈',
    retryable: false,
    details: err?.stack || null
  };
}
