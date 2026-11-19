# 天梯（TianTi）项目指令

本文件是本仓库的项目级指令，优先于 `~/.dsh/AGENTS.md` 的全局委派规则；
两者不冲突时同时生效。产品与视觉方向见 `docs/DESIGN.md`，功能清单见 `README.md`。

## 1. 项目速览

- 产品：Windows 桌面「A股涨停复盘」工具，产品名 **TianTi / 天梯**，界面上是深色「墨夜」+ 浅色「宣纸」两套主题。
- 技术栈：**Tauri 2 + Rust + 原生 TypeScript + Vite**，没有前端框架、没有状态库、没有 CSS 预处理器。
- 数据：全部落 **SQLite（WAL）**，位于 exe 同级 `data/tianti.db`；**不使用 JSON 作为数据存储**。
- 版本号需同步三份清单：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`；界面里的 `vX.Y.Z` 文案（`src/views/common.ts`、`src/main.ts` 的「关于」）也要一起改。

## 2. 命令与验证基线

```bash
pnpm install         # 依赖（Node 20+ / pnpm；Rust 1.77+ 仅在构建 exe 时需要）
pnpm dev             # Vite，端口 1420 严格占用；走 dev mock 数据
pnpm build           # tsc --noEmit + vite build —— 这是类型与构建门禁
pnpm build:exe       # 全量构建 release/TianTi.exe（会先跑 pnpm build）
pnpm build:exe:debug # 调试版 exe
```

**验证要求（每次改动的完成标准）**
- 任何 TS/TSX 改动：`pnpm build` 必须通过（`tsc --noEmit` 严格模式，零报错）。
- 涉及 Rust：`cargo check --manifest-path src-tauri/Cargo.toml` 通过；需要产物再跑 `pnpm build:exe`。
- 涉及界面：在 `pnpm dev` 下自查深/浅两套主题 + 三档字号（102% / 110% / 118%）+ 1080×720 最小窗口。
- 涉及策略面板：`pnpm build` + `cargo check` 都要过，并在 `pnpm dev` 下看 `#/strategy` 的深/浅主题与 1080×720。
- 构建 exe 前必须关闭 `TianTi.exe`（构建脚本会主动检测并中止）。
- 没有单元测试框架，不要声称"测试通过"；只写实际跑过的命令与结果。

## 3. 目录地图与热点文件

| 区域 | 文件 | 说明 |
|---|---|---|
| 前端入口 | `src/main.ts`（~79 KB） | 所有事件绑定、路由/浮层状态机、刷新节流；**改动需谨慎，易与其它视图冲突** |
| 视图 | `src/views/{ladder,pool,timeline,chart,strategy,common}.ts` | 按页面拆分，只做渲染与局部更新；`strategy` 是策略面板（一进二 / 竞价观察 / 策略库） |
| 图表引擎 | `src/chart.ts`（~35 KB）、`src/timeshare.ts` | Canvas K线与分时，坐标/缩放/十字光标 |
| 样式 | `src/styles.css`（~113 KB） | 主题 token、组件、动效；**全局单文件，天然冲突热点** |
| 前端库 | `src/lib/{api,state,types,ui,dropdown,market}.ts` | `api` 只封装 Tauri command；`state` 是唯一 UI 状态源 |
| mock | `src/lib/mock.ts`（~176 KB）、`mockApi.ts` | 仅 dev 用；不要为了改一处 UI 重排整个 mock |
| Rust | `src-tauri/src/{lib,commands,db,source,models,strategy,splash,win}.rs` | 网络抓取、SQLite、交易日历、窗口与启动板；`strategy.rs` 是策略筛选与历史回填 |
| 构建 | `scripts/build-exe.ps1` | 前端→Rust→复制到 `release/`，不产 zip/校验文件 |
| 文档 | `docs/DESIGN.md`、`docs/REALTIME_WS_PLAN.md`、`docs/STRATEGY_CONTRACT.md`、`docs/STRATEGY_YIJINER_PLAN.md`、`docs/screenshots/` | 设计说明、实时推送方案、策略契约与一进二方案、截图基线 |

## 4. 架构红线（不得破坏）

1. **前端不直接联网**：所有 HTTP 抓取在 Rust 侧（`source.rs`），前端只调用 `src/lib/api.ts` 封装的 Tauri command。
2. **不新增 JSON 数据文件**：接口响应只在内存解析后写入 SQLite；新增持久化一律加表 + command。
3. **数据目录固定**：运行时数据在 exe 同级 `data/`，不要改到 `%APPDATA%`。
4. **主题必须成对**：新增颜色/组件同时适配 `html[data-theme="dark"]`（墨夜）与 `html[data-theme="light"]`（宣纸），只用 `src/styles.css` 里的语义 token（`--bg` / `--surface` / `--line` / `--brass-*` / `--text` 等），**禁止硬编码色值**。主题切换由 `index.html` 读取 `localStorage["tianti.theme"]` 写入 `data-theme`。
5. **下拉框统一用 `.dd` 自绘浮层**（`src/lib/dropdown.ts`，挂在 body 顶层 portal），不要用原生 `<select>`。
6. **滚动条**：thumb 用中性灰、track 与 corner 透明；不跟随铜金强调色，不给轨道铺底色。
7. **动效克制**：只保留天梯入场编排；悬停仅边框/颜色/1px 位移；必须遵循 `prefers-reduced-motion`。
8. **字号缩放走 WebView 系统缩放**（设置里的 102/110/118%），不要用 CSS `transform: scale()`，否则 Canvas 命中区会错位。
9. **字体本地打包**（`public/fonts/*.woff2`），不引外链字体/CDN。
10. **无框架**：不要引入 React/Vue/Svelte/Tailwind 等依赖；确有必要先征求用户同意。
11. **策略只读**：策略筛选只读日快照与历史缓存，**不得写 `save_day` 的当日表**；新增持久化走 `limit_up_history` / `stock_stats` / `auction_snapshot` / `strategy_profile`。

## 5. 版本与发版

- 改代码需要发版时：同时更新 `package.json`、`src-tauri/tauri.conf.json` 与 `src-tauri/Cargo.toml` 的 `version`，三者必须一致；界面里的 `vX.Y.Z` 文案同步改。
- 本地产物只放 `release/`（`TianTi.exe`、`README.md`、`DESIGN.md`、`RELEASE_NOTES-vX.Y.Z.md`、`使用说明.txt`、`docs/` 副本）。
- GitHub Actions（`.github/workflows/release.yml`）在 tag 上另产 `release-package/`（exe、zip、`SHA256SUMS.txt`），只进 Release，不写 `release/`。
- `dist/`、`release/*.exe` 是构建产物，**不要手改**；`dist/` 已在 `.gitignore`。
- 未经用户明确要求，不执行 `git commit` / `git push` / `git merge`，也不改版本号。

## 6. 本项目的委派写域（配合全局规则使用）

满足全局"必须委派"条件时，按下面划分写域，**同一写域同一时间只能有一个执行者**：

| 写域 | 覆盖文件 | 典型任务 |
|---|---|---|
| A. Rust 数据层 | `src-tauri/src/{source,db,commands,models}.rs`、`Cargo.toml` | 新接口、缓存表、command 契约 |
| B. 状态与 API | `src/lib/{api,state,types}.ts` | 新增类型、状态字段、command 封装 |
| C. 视图 | `src/views/*.ts` | 页面渲染与交互 |
| D. 图表引擎 | `src/chart.ts`、`src/timeshare.ts` | 坐标、指标、绘制 |
| E. 样式 | `src/styles.css` | 主题 token、组件样式、动效 |
| F. 文档与脚本 | `README.md`、`docs/`、`scripts/` | 文档、截图、构建脚本 |

- **`src/main.ts` 与 `src/styles.css` 是串行区**：任何涉及它们的改动都放在最后合并，避免并发冲突。
- 跨写域的契约（如新 command 的入参/返回结构）由主代理先定，再分发给子代理；子代理不得自行改契约。
- 子代理必须自包含提示词：写域文件清单、禁止触碰的文件、`pnpm build` 通过作为交付条件。

## 7. 禁止与已知坑

- 禁止顺手重构 `src/main.ts` 或整段重排 `styles.css`；最小 diff。
- 禁止改 `src/lib/mock.ts` 之外的数据去"修"真实行为——mock 只服务 `pnpm dev`。
- `pnpm dev` 端口 1420 是 `--strictPort`，被占用会直接失败；先查占用再重启。
- `pnpm build` 只做类型检查与打包，不会启动 Tauri；验证窗口行为必须跑 exe 或 `pnpm dev`。
- 盘中刷新节流（天梯 60s、分时 30s、收盘停止）是产品行为，不要为了提高响应而缩短。
- 炸板/跌停时间是 `time_preview` 推断值，界面用 `~` 标注；不要把推断值当精确时间展示。
