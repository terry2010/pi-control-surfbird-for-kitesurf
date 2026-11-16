# pi-control-surfbird-for-kitesurf

[English](../README.md) · **中文**

一个 [Pi](https://pi.dev/) 包：让 AI agent 通过 Chrome DevTools Protocol（CDP）"像人一样"完整控制 [Kitesurf](https://github.com/cloudflare/kitesurf) 浏览器引擎。支持自托管的 [surfbird](https://github.com/terry2010/surfbird) 发行版（raw 或 token 认证模式）和上游 Kitesurf 部署。暴露 **28 个 `surfbird_*` 工具**：标签页管理、导航、语义无障碍快照、click/type/fill、等待、JavaScript 求值、截图、PDF 导出、console/network 检查、WebMCP 和裸 CDP 逃生舱——每个 agent 会话独占一台隔离浏览器。

姊妹项目：[`dsh-control-surfbird-for-kitesurf`](https://github.com/terry2010/dsh-control-surfbird-for-kitesurf)（DSH 版）和 [`opencode-control-surfbird-for-kitesurf`](https://github.com/terry2010/opencode-control-surfbird-for-kitesurf)（OpenCode 版）——同一套工具，不同 agent 宿主。三者共享 host 无关的 `src/cdp/` 核心。

## 环境要求

- [Pi](https://pi.dev/) coding agent（`@earendil-works/pi-coding-agent`，extensions API）
- Node.js >= 22.19
- 一个 Kitesurf 兼容的 CDP 端点——如 surfbird 容器（`auth` 或 `raw` 模式）或上游 `kitesurf`

## 安装

```bash
pi install npm:pi-control-surfbird-for-kitesurf
```

或者不安装、单会话试用：

```bash
pi -e npm:pi-control-surfbird-for-kitesurf
# 或本地 checkout：
pi -e /path/to/pi-control-surfbird-for-kitesurf
```

## 配置

优先级：`.pi/surfbird.json`（受信任项目）> `~/.pi/agent/surfbird.json`（全局）> 环境变量 > 默认值。

**最省事：**在 pi 里运行 `/surfbird-settings`——交互式编辑器（endpoint、token 文件、会话上限、超时、截图目录、debug 日志），带 `/json/version` 实时探活和粘贴/导入 token 操作。

或直接写 `~/.pi/agent/surfbird.json`：

```json
{
  "endpoint": "http://127.0.0.1:8080",
  "tokenFile": "~/.pi/agent/surfbird-token",
  "requestTimeoutMs": 120000,
  "keepaliveMs": 300000,
  "maxSessions": 8,
  "idleEvictMs": 300000,
  "screenshotDir": "",
  "debugLog": false
}
```

| 选项 | 默认值 | 含义 |
|---|---|---|
| `endpoint` | `http://127.0.0.1:8080` | CDP HTTP 基址或完整 `ws(s)://` URL。env：`SURFBIRD_URL` → `SURFBIRD_ENDPOINT` → `KITESURF_URL` → `KITESURF_ENDPOINT` |
| `tokenFile` | — | token 文件路径——明文或 `surfbird-v1:` 机器绑定密文。留空回落 `token`/env |
| `token` | — | Bearer token（也可用 env `SURFBIRD_TOKEN`/`KITESURF_TOKEN`） |
| `requestTimeoutMs` | `120000` | 单条 CDP 调用超时（下限 1000） |
| `keepaliveMs` | `300000` | WS 保活间隔（下限 30000；引擎 10 分钟 idle 硬断） |
| `maxSessions` | `8` | 并发会话浏览器数；超额只驱逐空闲会话（下限 1） |
| `idleEvictMs` | `300000` | 会话允许被驱逐前的最短空闲时长（下限 60000） |
| `screenshotDir` | `$TMPDIR/surfbird` | 截图/PDF 输出目录 |
| `debugLog` | `false` | 诊断日志写入 `~/.pi/agent/surfbird-debug.log` |

**token 加密：**`/surfbird-settings` → "Paste token…"/"Import token file…" 用本机 UUID（macOS `IOPlatformUUID`、Linux `machine-id`）推导密钥、AES-256-GCM 加密写 `surfbird-v1:` 文件，权限 `0600`。密文换台机器解不开。token 明文永不写入 `surfbird.json`。

## 28 个工具

| 工具 | 作用 |
|---|---|
| `surfbird_status` | 引擎探活：product/version、tab 数、会话统计、配置来源（绝不回显 token） |
| `surfbird_tabs` | 列出/新建/选择/关闭 tab（默认 `action=list`） |
| `surfbird_navigate` | 加载 URL；`back`/`forward`/`reload` 是独立工具 |
| `surfbird_back` / `surfbird_forward` / `surfbird_reload` | 历史导航 |
| `surfbird_snapshot` | 有界语义摘要：`[eN]` 交互引用、标题、文本块 |
| `surfbird_ax` | 当前 tab 的原始无障碍树 |
| `surfbird_click` / `surfbird_double_click` | 按 ref/selector/坐标点击，支持修饰键 |
| `surfbird_fill` | 设置控件值（Kitesurf `setControlValue`，React/Vue 兼容） |
| `surfbird_type` | 向字段输入文本（逐键事件） |
| `surfbird_press_key` | 具名键 + 修饰键（enter/tab/escape/方向键…） |
| `surfbird_scroll` | 按量滚动页面/元素或滚到目标 |
| `surfbird_wait` | 谓词等待：load/domcontentloaded/url/text/visible/hidden/enabled/networkidle/stable |
| `surfbird_evaluate` | 页面上下文 `Runtime.evaluate` |
| `surfbird_extract` | 正文→Markdown（Readability + Turndown） |
| `surfbird_find` | Ctrl+F 语义：count/next/prev/clear + 上下文片段 |
| `surfbird_links` | 页面全部链接 `{url,text}`，dedupe `url`/`base`，可限定 selector |
| `surfbird_screenshot` | 视口 / `clip` 区域 / `target`+padding 元素 / `fullPage`——内联图片 + 落盘路径 |
| `surfbird_pdf` | `Page.printToPDF`——落盘路径 |
| `surfbird_console` | console 消息 + 异常，`since` 游标，错误过滤 |
| `surfbird_network` | 请求日志，`since` 游标，`action=body` 取响应体 |
| `surfbird_webmcp` | 列出/调用/取消页面声明的 WebMCP 工具 |
| `surfbird_cdp` | 裸 CDP 逃生舱 |

完整用法模式（observe → act → verify、refs 与 docTokens、WebMCP、限制）在随包 skill 里：`skills/surfbird-control/SKILL.md`。

## 引擎限制（上游 Kitesurf 的边界，非本插件问题）

- Boa JS + DOM shim，不是 V8/Chromium——无 JS dialog、无文件上传/下载、无剪贴板、无拖拽/触摸、`KeyboardEvent` 不完整、hit-testing 部分支持
- 一条 WS 连接 = 一台独立浏览器；断连即该浏览器所有 tab 蒸发
- 单 WS 60 分钟硬上限；10 分钟 idle 超时（keepalive 必须小于它）
- `fullPage` 截图靠临时视口 resize 模拟，上限约 1440px

## 开发

```bash
npm install
npm run check     # tsc --noEmit
npm test          # 单元测试（无需引擎）
npm run test:live # live 冒烟——需要 SURFBIRD_URL/TOKEN 或到真实引擎的隧道
```

`src/cdp/` 是共享的 host 无关核心——禁止 import Pi/宿主包；此处的改动必须手动同步到 `dsh-control-surfbird-for-kitesurf` 和 `opencode-control-surfbird-for-kitesurf`（反之亦然）。

## 许可证

[Apache-2.0](../LICENSE)

## 相关项目

- [surfbird](https://github.com/terry2010/surfbird) —— Kitesurf 的自托管 Docker 发行版，含 token 认证、REST 代理和 MCP 服务
- [dsh-control-surfbird-for-kitesurf](https://github.com/terry2010/dsh-control-surfbird-for-kitesurf) —— 同一套 28 个工具的 DSH（DeepSeek Harness）版本
- [opencode-control-surfbird-for-kitesurf](https://github.com/terry2010/opencode-control-surfbird-for-kitesurf) —— 同一套 28 个工具的 OpenCode 版本（桌面端 + TUI）
- [Kitesurf](https://github.com/cloudflare/kitesurf) —— Cloudflare 的实验性浏览器引擎，为 AI agent 而生
- [Pi](https://pi.dev/) —— 本包所扩展的 agent 运行时
