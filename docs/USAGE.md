# 分步使用文档

本文从零开始，按顺序说明如何安装、配置、生成、校验并导入学习库。命令默认在 `services/aimcram-agent/` 目录执行；其它目录请自行替换路径。

---

## 第 0 步：确认环境

| 项 | 要求 |
|---|---|
| Node.js | ≥ 20（本项目在 v26.5.0 验证） |
| 操作系统 | macOS 推荐（OCR 用系统 Vision）；Linux 需 tesseract + 中文包 |
| 磁盘 | 单次生成通常 < 20MB；`.work/` 可随时删除 |
| 网络 | 模式二 / 三需要公网；模式一可完全离线 |

```bash
node -v
```

## 第 1 步：安装依赖

```bash
cd services/aimcram-agent
npm install
```

依赖作用：

| 依赖 | 用途 |
|---|---|
| `@mozilla/readability` + `jsdom` + `cheerio` | 本地 HTML 文件正文提取 |
| `pdfjs-dist` | PDF 文本层提取 |
| `mammoth` | DOCX 解析（内置 OOXML 兜底） |

可选：macOS 无需额外安装 OCR；Linux 执行 `sudo apt install tesseract-ocr tesseract-ocr-chi-sim`。

## 第 2 步：配置模型（可跳过）

**在 Harness 里用时不用配这一步**：插件通过 `agent.session.requestHeader().config` 读取**当前会话选中的模型**，再用 `ctx.llm` 走 Harness 的凭据，`study_library_generate` 不需要 `DEEPSEEK_API_KEY`。返回值里的 `model` 字段会显示实际使用的模型（如 `harness:deepseek/deepseek-chat`）。

只用 CLI 时才需要自己准备 Key：

```bash
export DEEPSEEK_API_KEY=sk-...
export DEEPSEEK_BASE_URL=https://api.deepseek.com   # 可选
export DEEPSEEK_MODEL=deepseek-chat                 # 可选
```

两者都没有也能跑：所有命令加 `--mock`，使用本地确定性生成（结果可复现、零网络，适合演示与测试）。

## 第 3 步：环境自检

```bash
node cli.mjs doctor
```

期望输出（节选）：

```
依赖  cheerio✓ jsdom✓ @mozilla/readability✓ pdfjs-dist✓ mammoth✓
kshare ✓ 已找到 services/tools/kshare.mjs
OCR   macOS Vision ✓
DeepSeek 未配置（可用 --mock 离线生成）
抓取  DeepSeek Search/Fetch · 最多 8 页 · 超时 20000ms
```

退出码为 0 表示依赖与 `services/tools/kshare.mjs` 均可用。

## 第 4 步：模式一（指定输入源）

### 4.1 本地 Markdown / TXT

```bash
node cli.mjs generate --topic 系统架构设计 \
  --source samples/architecture-notes.md --out out
```

### 4.2 多来源一次生成

```bash
node cli.mjs generate --topic 网络体系结构 \
  --source ./notes.md,./spec.docx,./slides.pdf,./osi.png,https://example.com/osi
```

`--source` 可重复，也可用逗号分隔。支持的输入：

| 输入形式 | 说明 |
|---|---|
| `./a.md` `./a.txt` | 纯文本 / Markdown（支持 front matter 与 H1 标题） |
| `./a.html` | 本地网页，剥离导航与广告 |
| `./a.docx` | Word 文档，段落顺序保留 |
| `./a.pdf` | 文本层提取；扫描件会告警 |
| `./a.png` `.jpg` `.jpeg` `.webp` `.bmp` `.gif` | 图片 OCR（中英） |
| `https://…` | 在线页面，经 DeepSeek Fetch 抓取为 Markdown 正文 |
| `text:任意文本` | 直接作为内联内容 |
| `@clipboard` | macOS 剪贴板文本 |

说明：

- 模式一省略 `--topic` 时，自动取首个来源标题；建议显式指定，避免标题过泛。
- 单个来源失败不会中断整批；但只有 1 个来源时会直接报错。跳过原因写入报告的 `notes`。
- 图片 OCR 的引擎、逐行置信度与整体置信度记录在报告的 `coverage.ocr`。

### 4.3 元数据

```bash
node cli.mjs generate --topic 系统架构设计 --source samples/architecture-notes.md \
  --slug arch-design --version 1.0.1 \
  --title 系统架构设计 --subject 系统架构设计师 --category "职业资格" \
  --license CC-BY-NC-4.0 --exam "系统架构设计师（高级）" --year 2026 \
  --author "AimCram Learning Agent" --tags "架构,软考"
```

## 第 5 步：模式二（联网检索抓取）

```bash
node cli.mjs generate --topic "系统架构设计" --pages 6 --depth 1
```

流程：DeepSeek 检索候选 → 逐页 DeepSeek Fetch 抓取 Markdown 正文 → 质量门槛（有效字符 / 主题相关度）→ 相似度去重 → 生成。

联网搜索与网页抓取统一由 **DeepSeek 官方 Search/Fetch API** 提供：

- 需 `DEEPSEEK_API_KEY`，按次计费；未配置时模式二 / 三会抛 `LA007`，离线场景可加 `--mock` 并改用本地文件输入。
- 搜索只取标题 / URL / 摘要（`need_content=false`），正文逐页走 Fetch，失败直接报错提示，不做静默回退。
- 常见错误：`401` Key 无效（`LA007`）；`402` 余额不足（先充值）；`403` 目标站点安全策略拒绝（`LA005`，该页跳过）；`404` 未能获取可用网页内容（`LA006`）；`408 / 429 / 5xx` 自动指数退避重试。

也可以直接给种子页（跳过检索）：

```bash
node cli.mjs generate --topic "系统架构设计" \
  --seed https://example.com/arch/overview,https://example.com/arch/patterns
```

抓取参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--pages` | 8 | 最多采纳页数 |
| `--depth` | 1 | 站内跟进深度，`0` 表示只看种子 |
| `LA_CRAWL_TIMEOUT_MS` | 20000 | 单次搜索 / 抓取请求超时 |
| `LA_MAX_BYTES` | 5MB | 单页响应体上限 |

无可用内容时返回 `LA011`，`details.rejected` 会列出每页被拒原因（`LA005` / `too-short` / `low-relevance` / `duplicate`）。

## 第 6 步：模式三（指定源 + 自主抓取）

```bash
node cli.mjs generate --topic "数据库系统" \
  --source ./db.md --mode combined --pages 4
# 等价写法
node cli.mjs generate --topic "数据库系统" --source ./db.md --with-web --pages 4
```

自主抓取失败时会降级为仅使用已有输入源，并在报告 `crawl.error` 中记录原因。

## 第 7 步：校验、解包与导出

```bash
# 严格校验（警告也视为失败）
node cli.mjs verify out/<slug>-<version>.zip --strict

# 目录包同样可校验
node cli.mjs verify out/<slug>-<version>/ --strict --json

# 解包（输出到 <目标目录>/<slug>-<version>/）
node cli.mjs unpack out/<slug>-<version>.zip -o work/

# 同时生成 App 运行数据 data.js / kb.js
node cli.mjs generate --topic 系统架构设计 --source samples/architecture-notes.md \
  --emit app --app-dir ../apps/desktop/src
```

`verify` 退出码：0 通过，1 失败。常见错误码含义见第 10 步。

### 7.1 多学科合并成一个 ZIP

多个主题/学科分别生成后，用 `bundle` 收成一个合集 ZIP，传输时只传一个文件：

```bash
node cli.mjs bundle out/jiakao-subject1-1.0.0 out/jiakao-subject4-1.0.0 \
  --name jiakao --title 驾考学习库 -o out/
# → out/jiakao-1.0.0.zip

node cli.mjs verify out/jiakao-1.0.0.zip --strict
```

- 输入可以是目录，也可以是已有的 `.zip`；
- 合集根目录只有一个：`jiakao-1.0.0/`，内含 `collection.json` 与各子包；
- 子包内容不改写，解包后仍可单独 `verify` / 导入；
- 同名合集已存在时报 `LA015`，提升 `--version` 或加 `--force`。

### 7.2 生成之后：导入 AimCram 刷题

产物是可直接导入的学习库包，不需要解压或转换：

1. 打开 AimCram 桌面端 →「导入学习库」；
2. 选择 `out/<slug>-<version>/` 这个**文件夹**（合集选 `.zip`）；
3. 题目、知识图谱与解析立刻出现在刷题页。

还没有 App：[aimcram.aimlocal.xyz](https://www.aimcram.aimlocal.xyz/)，macOS 与 Windows 都有安装包。

## 第 8 步：作为 DeepSeek Harness 插件使用

本包根目录就是合法 bundle 包（`package.json` 声明 `dsh.bundle.patch` + `cordis.patch.yml`），两种用法任选。

### 8.1 安装

外部用户直接装 npm 包：

```bash
dsh plugin --profile desktop add @aimcram/agent
```

本地开发时换成包根的绝对路径（必须是含 `package.json` 的目录，不是 `dsh-plugin/`）：

```bash
dsh plugin --profile desktop add /path/to/aimcram-agent
```

桌面版也可以在**设置 → 插件 → 安装**里填包名或绝对路径，重启 Harness 后 `study_library_*` 四个工具即可使用（生成时自动复用 Harness 当前所选模型）。

### 8.2 不装插件，直接用 CLI

```bash
npx @aimcram/agent doctor
npx @aimcram/agent generate --topic "系统架构设计" --pages 6
```

本仓库内开发时用 `node cli.mjs ...` 等价替代。

### 8.3 工具参数

| 工具 | 关键参数 |
|---|---|
| `study_library_generate` | `topic` `sources` `mode` `seeds` `pages` `depth` `perSection` `outDir` `slug` `version` `mock` `emitAppDir` `force` |
| `study_library_bundle` | `paths` `outFile` `outDir` `name` `version` `title` `force` |
| `study_library_verify` | `path` `strict` `appVersion` |
| `study_library_doctor` | 无 |

生成工具的返回值只包含结构化摘要（规模、来源、抓取、校验、路径），进度实时写入 stderr，避免大段正文占用模型上下文。

工具参数里的相对路径（`sources` / `seeds` / `outDir` / `paths` / `path`）按当前会话工作目录解析；省略 `outDir` 时写到 `<会话工作目录>/out`。推理模型出现空输出或 max-tokens 截断时会自动重试，并在必要时退到分步大纲。

## 第 9 步：测试与质量评测

```bash
npm test            # 71 项测试
node cli.mjs eval   # 提取质量评测
```

测试覆盖：

| 文件 | 内容 |
|---|---|
| `tests/extract.test.mjs` | md / html / docx / pdf / OCR、类型识别、旧版 .doc、缺失文件 |
| `tests/web.test.mjs` | DeepSeek Search/Fetch 客户端（错误映射 / 重试）、检索合并去重、质量筛选、深挖链接 |
| `tests/pack.test.mjs` | 组包结构、计数 / 指纹、目录与 ZIP strict 校验、篡改检测、LA015 |
| `tests/pipeline.test.mjs` | 模式一 / 二 / 三、进度事件、`--emit app`、LA001 / LA011 |
| `tests/cli.test.mjs` | generate → verify → unpack、NDJSON 进度、退出码、doctor |
| `tests/plugin.test.mjs` | DSH 插件契约、四个工具联调、Harness 模型复用、相对路径解析 |
| `tests/generate-structure.test.mjs` | 大纲补足 / 分步 / 失败回退、空壳题、出题批次兜底 |
| `tests/harness-llm.test.mjs` | Harness 流式接口、空输出 / 截断重试、模型选择 |

本机评测结果：

```
Markdown 100.0%  纯文本 100.0%  HTML 97.8%  DOCX 100.0%  PDF 100.0%  OCR 100.0%
数字文本类平均 F1：99.6%   OCR 平均 F1：100.0%   阈值 95%：通过
```

评测口径为归一化后的字符 bigram F1，OCR 使用独立阈值（≤60%）。HTML 的差值来自被判定为噪音的标题，可通过 `coverage.warnings` 追踪。

## 第 10 步：进度、报告与错误码

### 10.1 进度

- 默认：终端进度条（阶段 + 百分比 + 消息）。
- 脚本集成：`--json-progress` 输出 NDJSON，每条 `{type:'progress', stage, label, percent, message, at}`，最后一条 `{type:'result', ...}`。
- 阶段：`resolve → extract → crawl → dedupe → outline → knowledge → questions → render → pack → verify → done`。

### 10.2 报告字段（`<slug>-<version>.report.json`）

| 字段 | 说明 |
|---|---|
| `mode` / `topic` / `slug` / `version` | 本次生成标识 |
| `stats` | 章节 / 小节 / 题目 / 知识板块数量 |
| `coverage` | 来源数、总有效字符、按类型统计、OCR 置信度、低置信度来源、告警 |
| `crawl` | 抓取报告：采纳 / 拒绝、DeepSeek 搜索与抓取调用次数、重试与字节数 |
| `sources` | 每个来源的类型、路径 / URL、质量、告警 |
| `notes` | 被跳过的来源与原因 |
| `verification` | 包校验错误与警告 |

### 10.3 Agent 错误码（LAxxx）

| 码 | 含义 | 处理建议 |
|---|---|---|
| `LA001` | 未提供输入源或主题 | 至少给 `--topic` 或 `--source` |
| `LA002` | 不支持的文件格式 | 转成 md/txt/html/pdf/docx/图片 |
| `LA003` | 内容提取失败 | 检查文件损坏；确认 OCR 后端可用 |
| `LA004` | 输入源不存在 / 不可读 | 检查路径与权限 |
| `LA005` | 目标站点安全策略拒绝抓取（DeepSeek Fetch 403） | 换来源；不要抓取非公开资源 |
| `LA006` | 网络失败 / 超时 / 搜索无结果 / 余额不足 | 检查网络与账户余额；降低 `--pages` 后重试 |
| `LA007` | DeepSeek Key 缺失或无效 | Harness 内先在设置里选模型；CLI 下设 `DEEPSEEK_API_KEY`，或加 `--mock` |
| `LA008` | LLM 空输出 / 截断 / 无法解析 | 适配层会自动重试并放大预算；仍失败时换更强模型或减少单次资料量 |
| `LA009` | 未通过 kshare 校验 | 查看报告中的 E0xx |
| `LA010` | 学习库包校验失败 | `verify` 查看 E1xx / W1xx |
| `LA011` | 没有可用有效内容 | 检查空文件 / 扫描件 / 反爬 |
| `LA012` | 参数非法 | `--help` |
| `LA013` | 输出目录不可写 | 换 `--out` |
| `LA014` | 依赖缺失 | `npm install` |
| `LA015` | slug+version 内容冲突 | 提升 `--version` 或加 `--force` |

包校验码（E1xx / W1xx）完整定义见 [`STUDY-LIBRARY-SPEC.md`](../../STUDY-LIBRARY-SPEC.md)。

## 第 11 步：常见问题

**Q：模式二一直返回 LA011 / LA006？**
先看报告 `crawl.rejected`：若多为 `LA005`，说明目标站点安全策略拒绝；若为 `too-short`，多为页面正文过短；若为 `low-relevance`，换更具体的主题。`LA006` 且提示余额不足时先充值，提示搜索无结果时改用 `--seed` / `--source` 或本地文件输入。

**Q：DeepSeek Search/Fetch 报 401 / 402？**
`401` 表示 `DEEPSEEK_API_KEY` 无效或已失效，检查 Key 是否正确；`402` 表示账户余额不足，先到 DeepSeek 开放平台充值。两者都会直接报错，不会静默回退。

**Q：PDF 提取为空？**
扫描版 PDF 没有文本层，会告警。请把页面导出为 PNG 后用图片输入走 OCR。

**Q：OCR 不可用？**
macOS 检查 `xcode-select --install` 是否可用（需要 `swiftc`）；Linux 安装 `tesseract` 与中文包。`doctor` 会显示当前引擎。

**Q：生成结果章节太少？**
Mock 模式只按输入结构切分；真实模式请检查输入有效字符数与 `LA_MIN_CONTENT_CHARS`，或降低门槛：`LA_MIN_CONTENT_CHARS=200`。

**Q：能直接导入 App 吗？**
可以。生成完成后用 App 的「导入学习库」直接选 `<slug>-<version>/` 这个文件夹即可（无需解压、无需 zip），其中包含 `manifest.json` + `content/library.json` + `resources/`；单选、多选、判断题都会进入刷题页。需要运行时数据时也可用 `--emit app --app-dir <目录>` 生成 `data.js` / `kb.js`。

**Q：`--quiet` 会吞掉错误吗？**
不会。错误始终写 stderr，退出码非 0；`--quiet` 只影响进度与普通信息。
