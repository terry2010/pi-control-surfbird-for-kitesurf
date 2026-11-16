# pi-control-surfbird-for-kitesurf 开发规范

pi 包（pi-package）：通过 Kitesurf CDP 协议控制浏览器引擎（surfbird raw/auth、上游 kitesurf 均可）。
工具前缀 `surfbird_*`（与 DSH/OpenCode 版一致，互不占位）。

## 推送/发布规则（用户明确要求）

- **git push 和 npm publish 只在用户明确说"推"时才执行**
- 平时所有改动只做本地 commit（不 push）
- 版本号 bump 也只在发布前做

## 开发流程

- `npm test`（unit，node --test，.mjs 测试文件 import .ts 源码）+ `npm run check`（tsc --noEmit）全绿才能提交
- `test/live/` 需要真实引擎：`SURFBIRD_URL`+`SURFBIRD_TOKEN`（或 `KITESURF_ENDPOINT`+`KITESURF_TOKEN`）环境变量，
  或 `ssh -L 18080:127.0.0.1:8080 user@surfbird-host` 隧道到 surfbird 容器
- pi 直接加载 `.ts` 扩展——**没有构建步骤**；`extensions/surfbird.ts` 是入口
- 本地验证：`pi -e /path/to/pi-control-surfbird-for-kitesurf`（或 `pi -e ./extensions/surfbird.ts`）

## 共享代码约定（与 dsh/opencode 两仓）

- `src/cdp/` 是三仓共享的 host 无关核心（还有 `find.ts`/`links.ts`/`tokenfile.ts`/`token-store.ts`/`schema.ts` spec 类型）
- 共享文件内**禁止** import `@earendil-works/*`、opencode、DSH 等 host 框架包或 host 专属模块；
  只依赖通用 npm 包（`ws`、`@mozilla/readability`、`turndown`、`yaml`）+ node builtins
- 改共享文件后需人工同步另外两个仓库（在 commit message 注明）
- `tools.ts` 的工具表（TOOLS/spec/run）与另两仓保持一致，只有文件头注释、imports、
  `toResult`、`registerSurfbirdTools` 适配层是 pi 专属——改工具行为时务必三仓同步

## pi 宿主约束

- extension 实例随会话切换重建（session_shutdown → 重新加载）：`session_shutdown` 必须 disposeAll
- 会话隔离键：`ctx.sessionManager.getSessionId()`（pi session id 即隔离边界）
- 无宿主 options 通道——配置放自己的 `~/.pi/agent/surfbird.json`（全局）+ `.pi/surfbird.json`（受信任项目）
- 工具结果是 `{content:(text|image)[], details}`——截图直接内联 `{type:'image',data:base64,mimeType}`
- host 提供 `typebox`/`@earendil-works/*` 作 peer（peerDeps "*"），不打包；npm deps 照常在 `dependencies`
- `ctx.hasUI` 为 false（print/json 模式）时禁用交互命令路径

## 引擎边界（不要假设）

- `src/`、`extensions/`、`test/` 只用可擦除 TS 语法（Node type stripping：禁 enum/namespace/参数属性）；
  相对 import 写 `.ts` 扩展名
- 每 WS 连接 = 一台独立浏览器（per-connection BrowserState），断线=所有 tab 蒸发
- 单 WS 60 分钟硬上限、10 分钟 idle 超时（keepalive 必须 <10min）
- Kitesurf 是 Boa + DOM shim 不是 V8/Chromium：无 JS dialog、无文件上传/下载、
  无剪贴板、无 drag/touch、KeyboardEvent 不完整、hit-testing partial
