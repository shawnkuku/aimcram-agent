# AimCram 智能学习库生成 Agent

基于 **DeepSeek Harness（DSH）** 的智能学习库生成 Agent。输入可以是本地文档、图片、网页链接，也可以只给一个学习主题；Agent 负责内容提取、知识梳理、分类归档，最终产出**可直接导入 AimCram 的 `kshare-pack/v1` 学习库包**（目录 + ZIP）。

## 1. 能力总览

| 能力 | 实现 |
|---|---|
| 深度内容理解与结构化 | 优先复用 **当前会话选中的模型** 与 Harness 凭据（`agent.session.requestHeader().config` + `ctx.llm`）；CLI 下走 DeepSeek OpenAI 兼容接口；离线可用确定性 Mock |
| 非结构化 → 结构化 | 大纲 → 章节 / 小节 → 知识板块（含关联标注）→ 单选题 / 判断题；章数按资料体量设目标，不足则补足并回退到分步大纲 |
| 多格式解析 | Markdown / TXT / HTML / DOCX / PDF 文本层 / PNG·JPG·WebP·BMP OCR |
| 图片 OCR | macOS Vision（`swiftc` 编译缓存，中英双语）+ tesseract 兜底 |
| 网页正文提取 | `@mozilla/readability` 主路径 + 容器打分兜底，剥离导航 / 广告 / 页脚 |
| 知识图谱关联 | `## 知识图谱` 板块：知识点、高频考点、图解、关联章节 |
| 联网搜索与抓取 | 统一走 DeepSeek 官方 Search/Fetch API（需 `DEEPSEEK_API_KEY`，按次计费），正文为 Markdown，失败直接报错不回退 |
| 输出规范 | `kshare-pack/v1`：manifest + content/library.json + resources/ + source/，指纹 SHA-256 |
| 进度反馈 | 统一事件模型，文本进度条 / `--json-progress` NDJSON / DSH 工具实时 stderr |
| 异常处理 | `LA001`–`LA015` 错误目录，带 hint 与 details |

三种生成模式：

- **模式一 `sources`**：用户指定本地文档 / 图片 / 网页链接，只做提取与整理。
- **模式二 `web`**：只给主题，经 DeepSeek 联网检索 + 抓取 + 去重 + 质量筛选。
- **模式三 `combined`**：模式一 + 模式二，指定源与自主抓取合并生成（`--with-web` 等价）。

## 2. 目录结构

```
aimcram-agent/
├── package.json               # npm 包声明 + DSH bundle 声明（dsh.bundle.patch）
├── cordis.patch.yml           # bundle 自带 patch：插入本插件
├── cli.mjs                    # 命令行入口（generate / verify / unpack / doctor / eval）
├── dsh-plugin/
│   └── index.mjs              # DSH 插件：注册 5 个原生工具
├── samples/architecture-notes.md
├── src/
│   ├── config.mjs             # 环境变量与默认值
│   ├── errors.mjs             # LA001–LA017 错误目录
│   ├── extract/               # md/txt/html/pdf/docx/image 提取
│   ├── web/                   # DeepSeek Search/Fetch 客户端、主题检索与抓取编排
│   ├── llm.mjs                # DeepSeek 直连客户端（CLI / 无 Harness 环境）
│   ├── llm-harness.mjs        # 复用 Harness 的模型与凭据（插件内首选）
│   ├── mock.mjs               # 离线确定性生成
│   ├── generate.mjs           # 大纲 → 题目 → kshare Markdown → kshare.mjs 严格校验
│   ├── pack.mjs               # kshare-pack/v1 组包 / 校验 / 解包
│   ├── pipeline.mjs           # 三模式流水线
│   ├── exports.mjs            # App 运行数据（data.js / kb.js）
│   └── vendor/                # 内置 kshare 校验器与 3 个导出转换器（零三方依赖）
├── tests/                     # 71 项自动化测试 + 提取质量评测
└── docs/USAGE.md              # 分步使用文档
```

## 3. 安装

```bash
npm install
```

要求：Node.js ≥ 20（已在 v26.5.0 验证）。

- macOS：OCR 使用系统 Vision；首次运行会用 `swiftc` 编译 `src/extract/vision-ocr.swift`，结果缓存到临时目录。
- Linux：需安装 `tesseract` 与中文语言包（`tesseract-ocr-chi-sim`）作为 OCR 后端。
- PDF 依赖 `pdfjs-dist` 文本层；扫描件请先导出为图片走 OCR。

配置 DeepSeek（不配置时可加 `--mock` 离线跑通全链路；联网搜索与网页抓取同样需要该 Key）：

```bash
export DEEPSEEK_API_KEY=sk-...
# 可选
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export DEEPSEEK_MODEL=deepseek-chat
```

常用可调项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LA_CRAWL_TIMEOUT_MS` | `20000` | 单次搜索 / 抓取请求超时 |
| `LA_MAX_PAGES` | `8` | 单次最多抓取页数 |
| `LA_MAX_DEPTH` | `1` | 站内跟进深度 |
| `LA_MIN_CONTENT_CHARS` | `400` | 有效内容下限 |
| `LA_MAX_BYTES` | `5242880` | 单页响应体上限 |
| `LA_SAME_HOST_ONLY` | `1` | 深挖链接仅限同主机，设 `0` 关闭 |
| `LA_OUT_DIR` | `./out` | 产物目录 |

## 4. 快速开始

```bash
# 环境自检
node cli.mjs doctor

# 模式一：本地 Markdown（离线 Mock，零网络）
node cli.mjs generate --topic 系统架构设计 \
  --source samples/architecture-notes.md --mock --out out

# 模式一：文档 + 图片 + 网页
node cli.mjs generate --topic 网络体系结构 \
  --source ./notes.pdf,./osi.png,https://example.com/osi

# 模式二：只给主题（联网搜索由 DeepSeek Search/Fetch 提供，需 DEEPSEEK_API_KEY，按次计费）
node cli.mjs generate --topic "系统架构设计" --pages 6

# 模式三：本地资料 + 自主补充
node cli.mjs generate --topic "数据库系统" --source ./db.md --mode combined --pages 4

# 校验 / 解包
node cli.mjs verify out/study-xxxx-1.0.0.zip --strict
node cli.mjs unpack out/study-xxxx-1.0.0.zip -o work/
```

产物：

```
out/
├── <slug>-<version>/            # 目录包（可直接校验 / 上传）
├── <slug>-<version>.zip         # ZIP 包（分发单元）
├── <slug>-<version>.report.json # 生成报告：来源、抓取、去重、校验、耗时
└── .work/<slug>-<version>/      # 中间产物：library.md、images/、sources.json
```

学习库包格式严格遵循 [`STUDY-LIBRARY-SPEC.md`](../STUDY-LIBRARY-SPEC.md)，包含完整的 `manifest.json`、`content/library.json`、`resources/images/*` 与 `source/library.md`，`verify --strict` 通过后即可直接导入，无需格式转换。

### 4.1 多学科合成一个 ZIP（合集）

每科单独生成会得到多个 `<slug>-<version>/` 目录和同名 ZIP。分发时用 `bundle` 收成一个文件：

```bash
node cli.mjs bundle out/jiakao-subject1-1.0.0 out/jiakao-subject4-1.0.0 \
  --name jiakao --title 驾考学习库 -o out/
# → out/jiakao-1.0.0.zip

node cli.mjs verify out/jiakao-1.0.0.zip --strict
```

结构为 `jiakao-1.0.0/collection.json` + 若干原样嵌入的 `kshare-pack/v1` 子包：

```
jiakao-1.0.0/
├── collection.json
├── jiakao-subject1-1.0.0/{manifest.json,content/,source/}
└── jiakao-subject4-1.0.0/{manifest.json,content/,source/}
```

合集不改写子包内容，解包后每个子包仍可单独校验、导入；`verify` 会自动识别合集并逐包校验。

### 4.2 导入 AimCram（用户主动要求时）

产物就是可直接导入的学习库包，不需要解压或格式转换。Agent 不会主动提示导入；只有在用户明确要求时，才调用 `aimcram_import` 或手动导入：

- 对话里说「把这个学习库导入 AimCram」，插件通过 `aimcram://import?path=<包目录>` 唤起 App 并导入
- 也可以手动：打开 AimCram →「导入学习库」→ 选 `out/<slug>-<version>/` 文件夹（合集选 `.zip`）

检测不到 App 时，工具只返回官网地址：[aimcram.aimlocal.xyz](https://www.aimcram.aimlocal.xyz/)（macOS 与 Windows 都有安装包）。

## 5. 作为 DSH 插件运行

插件入口 [dsh-plugin/index.mjs](dsh-plugin/index.mjs) 注册五个工具：

| 工具 | 作用 |
|---|---|
| `study_library_generate` | 三模式生成，参数与 CLI 对齐 |
| `study_library_bundle` | 多个学习库包 → 一个 ZIP 合集 |
| `study_library_verify` | 校验单个包或合集（目录 / ZIP） |
| `study_library_doctor` | 依赖、OCR、DeepSeek、抓取配置自检 |
| `aimcram_import` | 用户明确要求时，唤起 AimCram 导入包；未安装则返回官网地址 |

### 5.1 安装

包根即插件包（`package.json` 声明 `dsh.bundle.patch`，[cordis.patch.yml](cordis.patch.yml) 负责插入自身），两种安装方式：

**外部用户（npm 包名）**

```bash
dsh plugin --profile desktop add @aimcram/agent
```

或在桌面版 **设置 → 插件 → 安装** 里填 `@aimcram/agent`。

**本地开发（绝对路径）**

```bash
dsh plugin --profile desktop add /path/to/aimcram-agent
```

注意填的是**包根**目录（含 `package.json`），不是 `dsh-plugin/`。

装完按提示重启 Harness，五个工具即可在对话中使用（`aimcram_import` 需要 AimCram 桌面端支持 `aimcram://` 协议）。

### 5.2 不装插件，直接用 CLI

插件与 CLI 共用同一套实现，CLI 下不依赖 Harness：

```bash
npx @aimcram/agent doctor
npx @aimcram/agent generate --topic 系统架构设计 --source ./notes.md --out out
```

本仓库内开发时等价于 `node cli.mjs ...`。

插件遵循 DSH 的 Cordis 插件契约：`export const name` / `export const inject = ['tools']` / `export function apply(ctx)`，通过 `ctx.tools.register(definition)` 注册带输出声明的原始工具定义，不引入额外依赖。

工具参数里的相对路径（`sources` / `seeds` / `outDir` / `paths` / `path`）按**当前会话的工作目录**解析，而不是 Host 进程 cwd；省略 `outDir` 时产物写到 `<会话工作目录>/out`。

## 6. 质量与测试

```bash
npm test          # 测试：提取 / DeepSeek 检索抓取 / 组包校验 / 三模式流水线 / 大纲结构 / 长资料重试 / 合集 / CLI / DSH 插件
node cli.mjs eval # 提取质量评测（字符 bigram F1）
```

本机实测（`node cli.mjs eval`）：

```
Markdown 100.0%  纯文本 100.0%  HTML 97.8%  DOCX 100.0%  PDF 100.0%  OCR 100.0%
数字文本类平均 F1：99.6%   OCR 平均 F1：100.0%   阈值 95%：通过
```

说明：评测口径是「归一化后的字符级 F1」，覆盖漏字与混入噪音；HTML 的少量差值来自正文抽取时被判定为噪音的标题，属于预期行为。真实网页因模板差异较大，准确率会低于本地数字文本，请以 `report.json` 中的 `coverage` 与 `warnings` 为准。

### 6.1 生成质量兜底

模型（尤其是小参数模型）可能把整库压成 1 章，或写出「这一表述属于本节内容」这类空壳题。生成层按三级策略兜底，并把过程写入 `report.stats.quality`：

| 层级 | 触发条件 | 动作 |
|---|---|---|
| 1 | 大纲章数 < 目标章数（按有效字符 / 2500 推算，2–6 章） | 带目标章数与上一版结构重试一次 |
| 2 | 重试仍不足 | 分步大纲：先只出章名，再逐章展开小节 |
| 3 | 小节题量不足 / 出现空壳题 | 丢弃空壳题，补题一次；仍缺才用知识点原文兜底 |

`quality` 字段：`planChapters` / `actualChapters` / `outlineRetried` / `outlineStaged` / `outlineFallback` / `questionBatchesFailed` / `shellDropped` / `sectionsFilled`。CLI 与 DSH 工具都会直接展示，便于判断这一版是否值得替换线上库。

### 6.2 长资料与推理模型

推理模型会把输出预算的一部分花在 reasoning 上。输入较长时，reasoning 可能吃满单次 `maxTokens`，流以 `finish=max-tokens` 结束且没有任何正文，表现为 `LA008 Harness 模型返回空内容`。现在做了三层处理：

1. 适配层累计 `reasoning-delta`，空输出 / 截断 / 限流会自动重试，并放大输出预算、降低 reasoning 档位；
2. 一次大纲失败会自动退到「先章名、再逐章展开」的分步大纲，不再直接终止；
3. 出题按小节分批（默认每批约 12 题）并限制单次 token，单批失败只影响该批，最后用兜底题补齐。

因此 8 KB 量级的资料也能稳定生成；若仍失败，错误信息会带上 `finish` 与 `reasoning` 长度，便于判断是模型限制还是资料问题。

## 7. 合规边界

- 联网搜索与网页抓取统一走 DeepSeek 官方 Search/Fetch API，不做本地直连抓取；目标站点拒绝时返回 `LA005` 并跳过。
- 单次抓取有页数、深度与响应体上限（`LA_MAX_PAGES` / `LA_MAX_DEPTH` / `LA_MAX_BYTES`），避免无界爬取。
- 不抓取需要登录、付费墙或明确声明禁止的资源；不绕过任何访问控制。
- 请遵守《网络安全法》《数据安全法》及目标站点条款，生成内容的使用范围由 `manifest.rights` / `license` 标注。

## 8. 已知限制

- 联网搜索与抓取由 DeepSeek Search/Fetch 提供，需 `DEEPSEEK_API_KEY` 且按次计费；余额不足（402）或 Key 无效（401）会直接报错，可改用 `--source` / `--seed` 或本地文件。
- 模式二依赖搜索结果质量；无结果时返回 `LA006`，抓不到可用内容时返回 `LA011` 并列出被拒页面原因。
- 扫描版 PDF 只做文本层检测并告警，需先导出图片走 OCR。
- OCR 质量受图片分辨率影响，`coverage.lowConfidence` 会列出低置信度来源。

详细分步说明、错误码与故障排查见 [docs/USAGE.md](docs/USAGE.md)。
