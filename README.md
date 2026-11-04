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
| 合规抓取 | robots.txt（含 Crawl-delay）、UA 标识、同主机串行限速、超时 / 体积上限、内网拒绝、重定向逐跳校验 |
| 输出规范 | `kshare-pack/v1`：manifest + content/library.json + resources/ + source/，指纹 SHA-256 |
| 进度反馈 | 统一事件模型，文本进度条 / `--json-progress` NDJSON / DSH 工具实时 stderr |
| 异常处理 | `LA001`–`LA015` 错误目录，带 hint 与 details |

三种生成模式：

- **模式一 `sources`**：用户指定本地文档 / 图片 / 网页链接，只做提取与整理。
- **模式二 `web`**：只给主题，自主检索 + 合规抓取 + 去重 + 质量筛选。
- **模式三 `combined`**：模式一 + 模式二，指定源与自主抓取合并生成（`--with-web` 等价）。

## 2. 目录结构

```
platform/aimcram-agent/
├── cli.mjs                    # 命令行入口（generate / verify / unpack / doctor / eval）
├── dsh-plugin/
│   ├── index.mjs              # DSH 插件：注册 4 个原生工具
│   ├── package.json           # bundle 包声明（dsh.bundle.patch）
│   ├── cordis.patch.yml       # bundle 自带 patch：插入本插件
│   └── dsh.yml                # CLI 覆盖层示例（--patch）
├── samples/architecture-notes.md
├── src/
│   ├── config.mjs             # 环境变量与默认值
│   ├── errors.mjs             # LA001–LA015 错误目录
│   ├── extract/               # md/txt/html/pdf/docx/image 提取
│   ├── web/                   # 合规抓取、检索 provider、主题抓取编排
│   ├── llm.mjs                # DeepSeek 直连客户端（CLI / 无 Harness 环境）
│   ├── llm-harness.mjs        # 复用 Harness 的模型与凭据（插件内首选）
│   ├── mock.mjs               # 离线确定性生成
│   ├── generate.mjs           # 大纲 → 题目 → kshare Markdown → kshare.mjs 严格校验
│   ├── pack.mjs               # kshare-pack/v1 组包 / 校验 / 解包
│   ├── pipeline.mjs           # 三模式流水线
│   └── exports.mjs            # App 运行数据（data.js / kb.js）
├── tests/                     # 71 项自动化测试 + 提取质量评测
└── docs/USAGE.md              # 分步使用文档
```

## 3. 安装

```bash
cd platform/aimcram-agent
npm install
```

要求：Node.js ≥ 20（已在 v26.5.0 验证）。

- macOS：OCR 使用系统 Vision；首次运行会用 `swiftc` 编译 `src/extract/vision-ocr.swift`，结果缓存到临时目录。
- Linux：需安装 `tesseract` 与中文语言包（`tesseract-ocr-chi-sim`）作为 OCR 后端。
- PDF 依赖 `pdfjs-dist` 文本层；扫描件请先导出为图片走 OCR。

配置 DeepSeek（不配置时可加 `--mock` 离线跑通全链路）：

```bash
export DEEPSEEK_API_KEY=sk-...
# 可选
export DEEPSEEK_BASE_URL=https://api.deepseek.com
export DEEPSEEK_MODEL=deepseek-chat
```

常用可调项：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LA_RATE_LIMIT_MS` | `1500` | 同主机最小请求间隔 |
| `LA_MAX_PAGES` | `8` | 单次最多抓取页数 |
| `LA_MAX_DEPTH` | `1` | 站内跟进深度 |
| `LA_MIN_CONTENT_CHARS` | `400` | 有效内容下限 |
| `LA_MAX_BYTES` | `5242880` | 单页响应体上限 |
| `LA_USER_AGENT` | `AimCramAgent/1.0.0 (+https://aimcram.example/bot; …)` | 抓取 UA，请改成真实联系方式 |
| `LA_SEARCH_PROVIDER` | `searxng` | `auto` / `wikipedia` / `duckduckgo` / `searxng` / `custom`；无本地实例时可改回 `duckduckgo` |
| `LA_SEARXNG_URL` | `http://127.0.0.1:8888` | 本地 / 自建 SearXNG 地址（推荐） |
| `LA_SEARXNG_AUTOSTART` | `1` | 本机 SearXNG 未运行时自动执行 `searxng/run.sh`；设 `0` 关闭 |
| `LA_SEARCH_ENDPOINT` | 空 | 自定义检索网关，支持 `{query}` 占位符 |
| `LA_ALLOW_PRIVATE_HOSTS` | `0` | 设为 `1` 才允许内网地址（仅本地调试） |
| `LA_OUT_DIR` | `./out` | 产物目录 |

### 3.1 本地 SearXNG（解决检索反爬）

默认检索源在部分网络环境会被反爬。仓库内置一键脚本，在本机 `127.0.0.1:8888` 起一个只供 Agent 使用的 SearXNG：

```bash
./searxng/run.sh
```

模式二 / 三在检索前会先探活：**本机地址且端口拒绝连接时自动执行上面的脚本并等待就绪**（默认最多 120 秒），已运行则直接复用。端口上已有别的服务时不会接管，远端地址永不启动；`LA_SEARXNG_AUTOSTART=0` 可关闭自动启动，恢复手动模式。

首次运行会浅克隆 SearXNG、用 `uv` 创建 Python 3.12 虚拟环境并安装依赖、生成随机 `secret_key`，之后直接启动（前台运行，Ctrl+C 停止）。配置见 [searxng/settings.yml](searxng/settings.yml)：仅监听本机、关闭 limiter、开启 `format=json`、允许 GET、不使用 valkey。

验证并启用：

```bash
curl 'http://127.0.0.1:8888/search?q=系统架构&format=json'
node cli.mjs generate --topic 系统架构设计 --search searxng --pages 6
```

- 运行时文件在 `searxng/.runtime/`（已 gitignore），删除即可重装。
- 只对**检索接口**放行本机地址；页面正文仍按公网规则校验，不会因为配了本地检索就放开内网抓取。
- 换端口：`SEARXNG_PORT=8890 ./searxng/run.sh`，并设置 `LA_SEARXNG_URL=http://127.0.0.1:8890`。

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

# 模式二：只给主题（推荐先启动本地 SearXNG：./searxng/run.sh）
node cli.mjs generate --topic "系统架构设计" --search searxng --pages 6

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

## 5. 作为 DSH 插件运行

插件入口 [dsh-plugin/index.mjs](dsh-plugin/index.mjs) 注册四个工具：

| 工具 | 作用 |
|---|---|
| `study_library_generate` | 三模式生成，参数与 CLI 对齐 |
| `study_library_bundle` | 多个学习库包 → 一个 ZIP 合集 |
| `study_library_verify` | 校验单个包或合集（目录 / ZIP） |
| `study_library_doctor` | 依赖、OCR、DeepSeek、抓取配置自检 |

### 5.1 桌面版「插件」界面安装

`dsh-plugin/` 是一个合法的 DSH bundle 包（`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 负责插入自身），因此可以直接在桌面版安装：

1. 打开 **设置 → 插件 → 安装**。
2. 填入**绝对路径**（相对路径会被判为“不是有效包”）：

   ```
   /Users/kuangjixiang/dev/aimcram/platform/aimcram-agent/dsh-plugin
   ```

3. 确认后按提示重启 Harness，三个 `study_library_*` 工具即可在对话中使用。

也可以在终端安装（需先退出 Harness）：

```bash
dsh plugin --profile desktop add /Users/kuangjixiang/dev/aimcram/platform/aimcram-agent/dsh-plugin
```

### 5.2 CLI 覆盖层加载（免安装）

[dsh-plugin/dsh.yml](dsh-plugin/dsh.yml) 中 `name` 为绝对路径，移动仓库后需同步修改：

```bash
npx -y @deepseek-ai/dsh --profile headless \
  --patch ./dsh-plugin/dsh.yml \
  "先运行 study_library_doctor，再用 study_library_generate 为主题「系统架构设计」生成学习库"
```

插件遵循 DSH 的 Cordis 插件契约：`export const name` / `export const inject = ['tools']` / `export function apply(ctx)`，通过 `ctx.tools.register(definition)` 注册带输出声明的原始工具定义，不引入额外依赖。

工具参数里的相对路径（`sources` / `seeds` / `outDir` / `paths` / `path`）按**当前会话的工作目录**解析，而不是 Host 进程 cwd；省略 `outDir` 时产物写到 `<会话工作目录>/out`。

## 6. 质量与测试

```bash
npm test          # 71 项测试：提取 / 抓取合规 / 组包校验 / 三模式流水线 / 大纲结构 / 长资料重试 / 合集 / CLI / DSH 插件
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

- 抓取前读取并遵守 `robots.txt`；robots 返回 5xx 或读取失败时**保守禁止**。
- 同主机串行 + 最小间隔（取 `LA_RATE_LIMIT_MS` 与 `Crawl-delay` 较大者），UA 带用途与联系方式。
- 默认拒绝 localhost、内网、链路本地地址；重定向逐跳重新校验，禁止 URL 携带账号密码。
- 只抓取 `text/html` / `text/plain` / `+xml`，有超时、响应体上限与重定向上限。
- 不抓取需要登录、付费墙或明确声明禁止的资源；不绕过任何访问控制。
- 请遵守《网络安全法》《数据安全法》及目标站点条款，生成内容的使用范围由 `manifest.rights` / `license` 标注。

## 8. 已知限制

- 默认检索 provider（DuckDuckGo / Wikipedia）在部分网络环境会被反爬或不可达；生产建议自建 SearXNG，或直接提供 `--source` / `--seed`。
- 模式二依赖搜索结果质量；无结果时返回 `LA011` 并列出被拒页面原因。
- 扫描版 PDF 只做文本层检测并告警，需先导出图片走 OCR。
- OCR 质量受图片分辨率影响，`coverage.lowConfidence` 会列出低置信度来源。

详细分步说明、错误码与故障排查见 [docs/USAGE.md](docs/USAGE.md)。
