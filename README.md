# AimCram 智能学习库生成 Agent

把「一堆资料」或「一个主题」变成**可直接导入 AimCram 的学习库**。

输入可以是本地文档、图片、网页链接，也可以只给一个主题；Agent 负责提取、梳理、出题、组包，最终产出 `kshare-pack/v1` 学习库包（目录 + ZIP），校验通过后即可导入 App。

| 模式 | 输入 | 说明 |
|---|---|---|
| `sources` | 本地文档 / 图片 / 网页链接 | 只整理你给的材料 |
| `web` | 一个主题 | DeepSeek 联网检索 + 抓取 + 去重 + 筛选 |
| `combined` | 材料 + 主题 | 先整理材料，再联网补充 |

## 1. 功能

- **多格式解析**：Markdown / TXT / HTML / DOCX / PDF 文本层 / PNG·JPG·WebP·BMP OCR
- **结构化生成**：大纲 → 章节 / 小节 → 知识板块 → 单选题 / 判断题，附带知识图谱（知识点、高频考点、图解、关联章节）
- **复用会话模型**：在 DSH 里直接用当前会话所选模型和凭据；CLI 下走 DeepSeek OpenAI 兼容接口
- **质量兜底**：章数不足自动重试、分步大纲、空壳题丢弃与补题，过程写入 `report.stats.quality`
- **严格产物**：`manifest.json` + `content/library.json` + `resources/` + `source/`，SHA-256 指纹，`verify --strict` 通过即可导入
- **两种入口**：DSH 插件（5 个工具 + `/aimcram` 命令）或 CLI（`npx` 直接跑）
- **离线可测**：`--mock` 不调用模型，确定性生成，适合跑通流程和写测试

## 2. 安装

### 2.1 作为 DSH 插件（推荐）

要求 DSH ≥ 0.2.0。

```bash
dsh plugin --profile desktop add @aimcram/agent
```

也可以在桌面版 **设置 → 插件 → 安装** 里填 `@aimcram/agent`。

本地开发时可以直接装目录（填**包根**，不是 `dsh-plugin/`）：

```bash
dsh plugin --profile desktop add /path/to/aimcram-agent
```

装完完全退出并重启 Harness。重启后：

- 对话里可以直接让模型调用 5 个工具（见 3.1）
- 输入 `/`，菜单里会出现 `/aimcram`（见 3.2）
- 不确定是否装好，发一句「用 study_library_doctor 自检」

### 2.2 用 CLI（不装插件）

要求 Node.js ≥ 20。

```bash
npx @aimcram/agent doctor
npx @aimcram/agent generate --topic 系统架构设计 --source ./notes.md --out out
```

本仓库内开发时先 `npm install`，再用 `node cli.mjs ...` 等价运行。Markdown / TXT 不依赖三方库；PDF / HTML / DOCX 解析需要 `pdfjs-dist` / jsdom / mammoth 等依赖。

### 2.3 环境准备

```bash
export DEEPSEEK_API_KEY=sk-...
# 可选
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export DEEPSEEK_MODEL=deepseek-chat
```

- 不配 Key 也能用 `--mock` 离线跑通全链路；模式二 / 三的联网检索和抓取必须配 Key，且按次计费
- macOS OCR 走系统 Vision，首次运行会用 `swiftc` 编译并缓存
- Linux OCR 需安装 `tesseract` 与中文语言包（`tesseract-ocr-chi-sim`）
- 扫描版 PDF 只检测文本层，需先导出图片走 OCR

常用可调项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LA_CRAWL_TIMEOUT_MS` | `20000` | 单次搜索 / 抓取超时 |
| `LA_MAX_PAGES` | `8` | 单次最多抓取页数 |
| `LA_MAX_DEPTH` | `1` | 站内跟进深度 |
| `LA_MIN_CONTENT_CHARS` | `400` | 有效内容下限 |
| `LA_MAX_BYTES` | `5242880` | 单页响应体上限 |
| `LA_SAME_HOST_ONLY` | `1` | 深挖链接仅限同主机，`0` 关闭 |
| `LA_OUT_DIR` | `./out` | 默认产物目录 |

## 3. 使用

### 3.1 在 DSH 对话里用工具

直接说需求即可，模型会自动选工具；想强制指定时点名工具：

| 工具 | 作用 | 最小示例 |
|---|---|---|
| `study_library_generate` | 三模式生成 | 「用 study_library_generate 把 ./notes.md 生成学习库，主题『系统架构设计』」 |
| `study_library_bundle` | 多个包 → 一个 ZIP 合集 | 「用 study_library_bundle 把 out/a-1.0.0 和 out/b-1.0.0 打成合集」 |
| `study_library_verify` | 校验包 / 合集 | 「用 study_library_verify 校验 out/system-design-1.0.0」 |
| `study_library_doctor` | 环境自检 | 「用 study_library_doctor 看看环境是否正常」 |
| `aimcram_import` | 唤起 App 导入 | 「把这个学习库导入 AimCram」 |

约定：

- `sources` 支持本地文件、图片、URL、`text:内联文本`、`@clipboard`
- 相对路径按**当前会话工作目录**解析；省略 `outDir` 时产物写到 `<会话目录>/out`
- 生成 / 打包默认会弹一次权限确认，选择「允许」即可
- `aimcram_import` 只在用户明确要求导入时调用，不会主动提示；未安装 App 时只返回官网地址

### 3.2 斜杠命令 `/aimcram`

在 DSH 对话框输入：

```
/aimcram 系统架构设计
```

直接按联网模式（`web`）生成学习库，产物写到当前会话目录的 `out/`。命令由你主动输入，视为已授权，不再弹权限确认。

- 只传主题，不支持其它参数；需要指定源、页数、题量时改用 `study_library_generate`
- 同步执行到结束，联网生成通常需要几分钟
- 只在提供 `commands` 服务的宿主（DSH 桌面端）出现；CLI / ACP 无头环境不可用，也不影响工具调用

### 3.3 用 CLI

```bash
# 模式一：本地 Markdown（离线 Mock，零网络）
node cli.mjs generate --topic 系统架构设计 \
  --source samples/architecture-notes.md --mock --out out

# 模式一：文档 + 图片 + 网页
node cli.mjs generate --topic 网络体系结构 \
  --source ./notes.pdf,./osi.png,https://example.com/osi

# 模式二：只给主题（需 DEEPSEEK_API_KEY）
node cli.mjs generate --topic "系统架构设计" --pages 6

# 模式三：本地资料 + 联网补充
node cli.mjs generate --topic "数据库系统" --source ./db.md --mode combined --pages 4

# 交互式：先出大纲让你确认，再逐章生成
node cli.mjs interact --topic "操作系统"

# 校验 / 解包 / 自检
node cli.mjs verify out/study-xxxx-1.0.0.zip --strict
node cli.mjs unpack out/study-xxxx-1.0.0.zip -o work/
node cli.mjs doctor
```

常用选项：

| 选项 | 说明 |
|---|---|
| `--topic <主题>` | 学习主题；模式一可省略，取首个来源标题 |
| `--source <列表>` | 文件 / 图片 / URL / `text:...` / `@clipboard`，可重复或逗号分隔 |
| `--mode <auto\|sources\|web\|combined\|import>` | 默认 `auto`：有输入源走模式一，否则模式二 |
| `--seed <URL>` | 模式二 / 三的种子页面 |
| `--with-web` | 模式一同时联网补充（等价 `combined`） |
| `--pages` / `--depth` / `--per-section` | 抓取页数 / 跟进深度 / 每节题量（默认 8 / 1 / 3） |
| `--questions` / `--cases` | 题目总数 / 案例精析数量（精确值） |
| `--outline <文件>` | 沿用已有目录 JSON，跳过大纲生成 |
| `--out <目录>` | 产物目录，默认 `./out` |
| `--slug` / `--version` | 学习库标识 / 内容版本（默认 1.0.0） |
| `--mock` | 不调用模型，离线确定性生成 |
| `--json-progress` | 进度输出为 NDJSON，便于上层消费 |
| `--force` | 覆盖同 slug + version 的已有产物 |

完整参数与交互说明见 [docs/USAGE.md](docs/USAGE.md)。

### 3.4 产物

```
out/
├── <slug>-<version>/            # 目录包（可直接导入 / 校验）
├── <slug>-<version>.zip         # ZIP 包（分发单元）
├── <slug>-<version>.report.json # 生成报告：来源、抓取、去重、校验、耗时
└── .work/<slug>-<version>/      # 中间产物：library.md、images/、sources.json
```

包格式遵循 [`STUDY-LIBRARY-SPEC.md`](../STUDY-LIBRARY-SPEC.md)，无需格式转换。

### 3.5 导入 AimCram

产物就是可导入的学习库包。Agent 不会主动提醒导入；需要时：

- 对话里说「把这个学习库导入 AimCram」→ 插件通过 `aimcram://import?path=<包目录>` 唤起 App
- 或手动：打开 AimCram →「导入学习库」→ 选 `out/<slug>-<version>/` 文件夹（合集选 `.zip`）

需要 AimCram ≥ 1.0.4（支持 `aimcram://` 协议）。未安装时工具只返回官网地址：[aimcram.aimlocal.xyz](https://www.aimcram.aimlocal.xyz/)，macOS 与 Windows 均有安装包。

### 3.6 多学科合成一个 ZIP（合集）

```bash
node cli.mjs bundle out/jiakao-subject1-1.0.0 out/jiakao-subject4-1.0.0 \
  --name jiakao --title 驾考学习库 -o out/
# → out/jiakao-1.0.0.zip

node cli.mjs verify out/jiakao-1.0.0.zip --strict
```

合集结构为 `collection.json` + 原样嵌入的子包；不改写子包内容，解包后每个子包仍可单独校验、导入。`verify` 会自动识别合集并逐包校验。

## 4. 生成质量与排错

模型可能把整库压成 1 章，或写出空壳题。生成层按三级策略兜底，并把过程写入 `report.stats.quality`：

| 层级 | 触发条件 | 动作 |
|---|---|---|
| 1 | 大纲章数 < 目标章数（按有效字符 / 2500 推算，2–6 章） | 带目标章数与上一版结构重试一次 |
| 2 | 重试仍不足 | 分步大纲：先出章名，再逐章展开 |
| 3 | 小节题量不足 / 出现空壳题 | 丢弃空壳题并补题；仍缺才用知识点原文兜底 |

`quality` 字段包括 `planChapters` / `actualChapters` / `outlineRetried` / `outlineStaged` / `outlineFallback` / `questionBatchesFailed` / `shellDropped` / `sectionsFilled`，可直接判断这一版是否值得替换线上库。

长资料 + 推理模型可能因 reasoning 吃满预算导致空输出（`LA008`）。适配层会自动重试、放大输出预算、降低 reasoning 档位，并退到分步大纲与分批出题；仍失败时错误信息会带 `finish` 与 `reasoning` 长度。

常见问题：

| 现象 | 原因 / 处理 |
|---|---|
| `401` / `402` | Key 无效或余额不足；改用 `--source`，或先 `--mock` 跑通流程 |
| `LA006` | 搜索无结果；换个更具体的主题或直接用 `--seed` |
| `LA011` | 抓到的内容不可用；报告里会列出被拒页面原因 |
| `LA017` | 权限提示未允许；在弹窗中选「允许」后重试 |
| 扫描版 PDF 没内容 | 只检测文本层，先导出图片走 OCR |
| 生成太慢 | 减少 `--pages` / `--depth`，或改用 `--source` 指定材料 |

错误码目录见 [src/errors.mjs](src/errors.mjs)。

## 5. 开发与测试

```bash
npm test          # 115 项：提取 / 检索抓取 / 组包校验 / 三模式 / 大纲 / 合集 / CLI / DSH 插件
node cli.mjs eval # 提取质量评测（字符 bigram F1）
```

本机实测：

```
Markdown 100.0%  纯文本 100.0%  HTML 97.8%  DOCX 100.0%  PDF 100.0%  OCR 100.0%
数字文本类平均 F1：99.6%   OCR 平均 F1：100.0%   阈值 95%：通过
```

评测口径是归一化后的字符级 F1，覆盖漏字与混入噪音；HTML 的少量差值来自被判定为噪音的标题，属于预期行为。真实网页受模板影响较大，请以 `report.json` 的 `coverage` 与 `warnings` 为准。

目录结构：

```
aimcram-agent/
├── cli.mjs                # CLI：generate / interact / bundle / verify / unpack / doctor / eval
├── dsh-plugin/index.mjs   # DSH 插件：5 个工具 + /aimcram 命令
├── src/
│   ├── pipeline.mjs       # 三模式流水线
│   ├── generate.mjs       # 大纲 → 题目 → 校验
│   ├── extract/           # md / txt / html / pdf / docx / 图片
│   ├── web/               # DeepSeek Search/Fetch 与抓取编排
│   ├── llm-harness.mjs    # 复用 Harness 模型与凭据（插件内首选）
│   ├── llm.mjs            # DeepSeek 直连（CLI）
│   ├── mock.mjs           # 离线确定性生成
│   ├── pack.mjs           # 组包 / 校验 / 解包
│   ├── collection.mjs     # 合集
│   └── vendor/            # 内置 kshare 校验与导出转换（零三方依赖）
├── samples/
├── tests/
└── docs/USAGE.md
```

插件遵循 DSH 的 Cordis 契约：`export const name` / `export const inject = ['tools']` / `export function apply(ctx)`，通过 `ctx.tools.register()` 注册工具，`ctx.inject(['commands'], ...)` 延迟注册斜杠命令；激活阶段不加载任何第三方 DOM 依赖。

## 6. 合规与限制

- 联网搜索与抓取统一走 DeepSeek 官方 Search/Fetch API，不做本地直连抓取；目标站点拒绝时返回 `LA005` 并跳过
- 单次抓取有页数、深度与响应体上限，避免无界爬取
- 不抓取需要登录、付费墙或明确禁止的资源，不绕过访问控制
- 请遵守《网络安全法》《数据安全法》及目标站点条款；生成内容的使用范围由 `manifest.rights` / `license` 标注
- 模式二依赖搜索结果质量；无结果返回 `LA006`，抓不到可用内容返回 `LA011`
- OCR 质量受图片分辨率影响，`coverage.lowConfidence` 会列出低置信度来源
