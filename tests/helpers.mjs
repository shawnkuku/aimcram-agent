/**
 * 测试 / 评测共用的夹具构造器
 *
 * 二进制夹具（DOCX / PDF / PNG）在运行时生成，避免把大文件提交进仓库；
 * 缺少生成工具时返回 skipped，由调用方决定跳过而不是失败。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeZip } from '../src/zip.mjs';

export const FIXTURE_TEXT = `网络体系结构

分层模型
OSI 参考模型分为七层，自下而上依次是物理层、数据链路层、网络层、传输层、会话层、表示层、应用层。每一层只与相邻层交互，通过接口向上层提供服务。

传输协议
TCP 提供面向连接的可靠传输，通过序列号、确认与重传保证可靠性。UDP 提供无连接的尽力而为传输，适合实时音视频与广播场景。

网络安全
TLS 在传输层之上提供加密、完整性校验与身份认证。证书体系解决公钥信任问题，握手阶段协商密钥与算法。

网络管理
SNMP 用于采集设备状态与告警，MIB 描述被管理对象的层次结构。运维中通常结合流量分析与日志审计定位故障。`;

export const ARTICLE_TEXT = `OSI 参考模型把网络通信划分为七层，自下而上依次是物理层、数据链路层、网络层、传输层、会话层、表示层、应用层。
每一层只与相邻层交互，通过标准接口向上层提供服务，这种分层设计降低了协议实现的耦合度。
TCP 在传输层提供面向连接的可靠传输，使用序列号、确认、重传与流量控制保证数据完整到达。
UDP 不保证可靠交付，但开销小、延迟低，适合实时音视频、广播与游戏等场景。`;

export const HTML_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>OSI 参考模型详解</title>
<meta name="description" content="OSI 七层模型与 TCP/UDP 对比">
<meta property="og:site_name" content="网络学习站">
</head>
<body>
<header><nav><a href="/">首页</a> <a href="/course">课程</a> <a href="/about">关于我们</a></nav></header>
<div class="ad">广告位：扫码加群领取资料</div>
<main><article>
<h1>OSI 参考模型详解</h1>
<p>OSI 参考模型把网络通信划分为七层，自下而上依次是物理层、数据链路层、网络层、传输层、会话层、表示层、应用层。</p>
<p>每一层只与相邻层交互，通过标准接口向上层提供服务，这种分层设计降低了协议实现的耦合度。</p>
<h2>传输层协议</h2>
<p>TCP 在传输层提供面向连接的可靠传输，使用序列号、确认、重传与流量控制保证数据完整到达。</p>
<p>UDP 不保证可靠交付，但开销小、延迟低，适合实时音视频、广播与游戏等场景。</p>
</article></main>
<footer>版权所有 © 网络学习站 | 联系我们</footer>
<script>var track = 1;</script>
</body></html>`;

function escXml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function makeTempDir(prefix = 'aimcram-agent-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 生成最小可用 DOCX。 */
export function makeDocx(text, file) {
  const paragraphs = String(text)
    .split('\n')
    .map((line) => (line.trim()
      ? `<w:p><w:r><w:t xml:space="preserve">${escXml(line)}</w:t></w:r></w:p>`
      : '<w:p/>'))
    .join('');
  const files = new Map([
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`],
    ['word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${paragraphs}<w:sectPr/></w:body></w:document>`]
  ]);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, writeZip(files));
  return file;
}

/** 生成 PDF（依赖 macOS cupsfilter）；不可用时返回 null。 */
export function makePdf(text, file) {
  const probe = spawnSync('which', ['cupsfilter'], { encoding: 'utf8' });
  if (probe.status !== 0) return null;
  const tmp = `${file}.txt`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // cupsfilter 不会自动换行，长行会被页面宽度截断，因此先按字符宽度硬换行
  const wrapLine = (line, width = 46) => {
    const chars = [...line];
    const out = [];
    let start = 0;
    while (chars.length - start > width) {
      let cut = start + width;
      for (let i = cut; i > start + Math.floor(width / 2); i--) {
        if (/[，。、；：！？,.;!?]/.test(chars[i - 1])) {
          cut = i;
          break;
        }
      }
      out.push(chars.slice(start, cut).join(''));
      start = cut;
    }
    out.push(chars.slice(start).join(''));
    return out;
  };
  const wrapped = String(text)
    .split('\n')
    .flatMap((line) => wrapLine(line))
    .join('\n');
  fs.writeFileSync(tmp, wrapped, 'utf8');
  const out = spawnSync('cupsfilter', ['-m', 'application/pdf', tmp], {
    encoding: 'buffer',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024
  });
  fs.rmSync(tmp, { force: true });
  if (out.status !== 0 || !out.stdout?.length) return null;
  fs.writeFileSync(file, out.stdout);
  return file;
}

function findChromium() {
  const bases = [
    path.join(os.homedir(), 'Library/Caches/ms-playwright'),
    path.join(os.homedir(), '.cache/ms-playwright')
  ];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort();
    for (const d of dirs.reverse()) {
      const candidate = path.join(base, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
}

/** 生成带文字的 PNG（依赖 Playwright 的 Chromium 二进制）；不可用时返回 null。 */
export function makeImagePng(html, file) {
  const chromium = findChromium();
  if (!chromium) return null;
  const tmp = `${file}.html`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, html, 'utf8');
  const out = spawnSync(chromium, [
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
    '--window-size=1100,420', `--screenshot=${file}`, `file://${tmp}`
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  fs.rmSync(tmp, { force: true });
  if (!fs.existsSync(file) || fs.statSync(file).size < 1000) return null;
  return file;
}

export const OCR_HTML = `<!doctype html><html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#fff">
<div style="padding:40px;font-family:'PingFang SC',-apple-system;font-size:44px;line-height:1.5;color:#111">
网络体系结构<br>OSI 参考模型分为七层<br>TCP 提供可靠传输
</div></body></html>`;

export const OCR_TEXT = '网络体系结构\nOSI 参考模型分为七层\nTCP 提供可靠传输';

/** 构造完整夹具目录，返回路径与期望文本。 */
export function buildFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const md = path.join(dir, 'notes.md');
  fs.writeFileSync(md, FIXTURE_TEXT
    .split('\n\n')
    .map((part, index) => `${index === 0 ? '# ' : '## '}${part}`)
    .join('\n\n') + '\n', 'utf8');
  const txt = path.join(dir, 'notes.txt');
  fs.writeFileSync(txt, FIXTURE_TEXT, 'utf8');
  const html = path.join(dir, 'page.html');
  fs.writeFileSync(html, HTML_PAGE, 'utf8');
  const docx = makeDocx(FIXTURE_TEXT, path.join(dir, 'notes.docx'));
  const pdf = makePdf(FIXTURE_TEXT, path.join(dir, 'notes.pdf'));
  const png = makeImagePng(OCR_HTML, path.join(dir, 'ocr.png'));
  return {
    dir,
    md,
    txt,
    html,
    docx,
    pdf,
    png,
    expected: {
      md: FIXTURE_TEXT,
      txt: FIXTURE_TEXT,
      html: ARTICLE_TEXT,
      docx: FIXTURE_TEXT,
      pdf: FIXTURE_TEXT,
      image: OCR_TEXT
    }
  };
}

/**
 * 启动本地站点：robots、正文、重复页、私有页、短页、检索接口。
 * @returns {Promise<{url: string, close: () => Promise<void>, hits: Record<string, number>}>}
 */
export async function startSite() {
  const hits = {};
  const articleHtml = HTML_PAGE.replace(/<nav>[\s\S]*?<\/nav>/, '<nav><a href="/">首页</a></nav>');
  const page = (body) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>系统架构设计</title></head><body>${body}</body></html>`;
  const article = page(`<article><h1>系统架构设计要点</h1>
<p>系统架构设计需要在质量属性之间做权衡，可用性、性能、安全性与可维护性往往互相制约。</p>
<p>分层架构把系统划分为表现层、业务层与数据层，降低耦合，但请求需要逐层穿透，性能敏感场景要跨层优化。</p>
<p>事件驱动架构通过事件总线解耦生产者与消费者，适合订单与风控场景，但需要处理最终一致性与重复消费。</p>
<p>微服务架构按业务能力拆分服务，每个服务独立部署与独立数据库，带来团队自治的同时也增加了分布式事务与链路追踪的复杂度。</p></article>`);
  const short = page('<article><p>系统架构设计简介，内容很短。</p></article>');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    hits[url.pathname] = (hits[url.pathname] || 0) + 1;
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nDisallow: /private\nAllow: /\nCrawl-delay: 0\n');
      return;
    }
    if (url.pathname === '/search') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        results: [
          { title: '系统架构设计要点', url: `http://127.0.0.1:${server.address().port}/article`, content: '架构设计' },
          { title: '私密页', url: `http://127.0.0.1:${server.address().port}/private/secret`, content: '架构设计' },
          { title: '重复页', url: `http://127.0.0.1:${server.address().port}/article-dup`, content: '架构设计' },
          { title: '短页', url: `http://127.0.0.1:${server.address().port}/short`, content: '架构设计' }
        ]
      }));
      return;
    }
    if (url.pathname === '/article' || url.pathname === '/article-dup') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(article);
      return;
    }
    if (url.pathname === '/private/secret') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(articleHtml);
      return;
    }
    if (url.pathname === '/short') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(short);
      return;
    }
    if (url.pathname === '/redirect') {
      res.writeHead(302, { Location: '/article' });
      res.end();
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** 字符 bigram 的 Dice 系数，用于评测文本提取保真度。 */
export function diceText(expected, actual) {
  const norm = (s) => String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  const a = norm(expected);
  const b = norm(actual);
  if (!a || !b) return 0;
  const grams = (s) => {
    const map = new Map();
    if (s.length === 1) map.set(s, 1);
    for (let i = 0; i + 2 <= s.length; i++) {
      const g = s.slice(i, i + 2);
      map.set(g, (map.get(g) || 0) + 1);
    }
    return map;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  let totalA = 0;
  let totalB = 0;
  for (const n of ga.values()) totalA += n;
  for (const n of gb.values()) totalB += n;
  for (const [g, n] of ga) overlap += Math.min(n, gb.get(g) || 0);
  if (!totalA || !totalB) return 0;
  const precision = overlap / totalB;
  const recall = overlap / totalA;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { f1, precision, recall };
}

export const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
