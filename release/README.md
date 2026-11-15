# 天梯 · A股涨停复盘

一个专注于「连板天梯」与「K线复盘」的 Windows 桌面工具。

![天梯 · 连板天梯](./docs/screenshots/ladder-dark.png)

界面为深色「墨夜」与浅色「宣纸」两套主题；涨停数据来自同花顺公开接口，K线来自东方财富公开接口。所有行情、K线、设置与搜索历史都写入 SQLite，不使用 JSON 数据文件。

## 功能

- **连板天梯**：按当前连续涨停高度分层，最高标使用独立的 feature 卡片；首板以高密度卡片收纳。
- **涨停池**：高度、现价、封单、首封、换手、题材、主线一屏复盘；支持按连板/首板/一字/换手筛选与排序。
- **K线**：日 / 周 / 月 K，前复权；EMA 5 / 10 / 20 / 60 与 KDJ（9, 3, 3）；成交量；十字光标、滚轮缩放、拖动平移、方向键查看。
- **搜索**：代码、名称、拼音首字母；最近查看会保存在本地。
- **交易日历**：近一年交易日切换；数据本地缓存，离线仍可查看已拉取过的日期与 K线。
- **设置**：主题、数据目录、数据库体积、行情缓存清理。

## 便携版

- 可执行文件：`release/TianTi.exe`
- 首次启动后会在 exe 同级创建 `data/`：
  - `data/tianti.db`：SQLite 数据库（行情、K线、设置、搜索历史）
  - `data/tianti.db-wal` / `data/tianti.db-shm`：SQLite 运行时文件
- 直接把 `TianTi.exe` 和 `data/` 一起拷贝到另一台 Windows 机器即可继续使用。
- 运行需要系统的 Microsoft Edge WebView2 Runtime（Windows 10/11 通常已内置）。

> 不使用 JSON 作为数据存储。接口响应只在内存中解析后写入 SQLite。

## 快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Ctrl K` | 呼出搜索 |
| `←` `→` | 切换交易日 |
| `Esc` | 关闭浮层 |
| K线内 `←` `→` | 移动十字光标 |
| K线内 `+` `-` | 缩放 |
| 双击 K线 / 滚轮 | 重置 / 缩放 |

## 本地开发

需要 Rust 1.77+、Node.js 20+、pnpm。

```bash
pnpm install
pnpm dev            # 浏览器调试（带 dev mock 数据）
pnpm build
cargo build --release --manifest-path src-tauri/Cargo.toml --features custom-protocol
```

`custom-protocol` 是 Tauri 的正式构建特性：启用后 exe 内嵌前端资源，不再依赖 `localhost:1420`。未启用时按开发模式运行。

前端生产构建：

```bash
pnpm build
```

Tauri 应用的窗口资源由 `src-tauri/tauri.conf.json` 配置；数据目录固定为 exe 同级 `data/`。

## 数据来源

- 涨停池 / 连板高度 / 板块：同花顺公开数据接口
- K线 / 指数 / 搜索：东方财富公开数据接口

仅供学习与复盘，不构成投资建议。

## 从旧版保留与移除

保留：涨停池、连板高度、板块主线、个股 K线。

移除：热点事件流、炸板池、跌停池、复盘报告导出、LLM 提示词、代理设置、同花顺 iframe 资料页、TradingView 外链与相应设置。产品聚焦在「看高度、看主线、看K线」。
