# dsh-plugin-cache-guard

DeepSeek Harness (dsh) 插件：前缀缓存健康守卫。DeepSeek 的前缀缓存是省钱命脉——系统提示、工具列表或任何位于上下文开头的内容一旦被改写，整个前缀重新按未缓存全价计费。本插件监听 usage 流，把"只是变长"和"前缀真被重写"分开，估算重写多付的 token，并在出现重写时把诊断注入上下文。

同系列：[price-aware](https://github.com/121212165/dsh-plugin-price-aware)（花了多少）· [cost-ledger](https://github.com/121212165/dsh-plugin-cost-ledger)（台账）· 本插件（**为什么多花**）。

## 功能

- **三闸门尖峰判定**：只有同时满足"未缓存输入超过滑动基线带"、"该步缓存命中相对自身基线塌陷"、"重计的量约等于上一步整个 prompt"三步，才记一次**前缀重写**。只过大小组的（大工具结果、长粘贴：未缓存暴涨但前缀仍命中）记为**变长（growth）**，不算抖动、不计入浪费。
- **`/cache`**：命中率、判定（✅ 稳定 / ⚠ 观察 / ❌ 不稳定）、重写明细（含塌陷前后与上一步 prompt）、变长步数、多付合计。
- **`cache_status` 工具**：agent 自查。
- **`adviseModel`**（默认开）：出现**新的**重写时通过 `tools/post-execute` 注入插件提示（price-aware 验证过的腿）。同一次断裂只提醒一次，不会在后续每一步重复刷屏。

### 为什么不是"未缓存变高就算抖动"

dsh 的 usage 三桶互斥（`@deepseek-ai/dsh-llm` 的 `TokenUsage` 注释原文：*`inputTokens` is uncached input only*，billed input = `inputTokens + cacheReadTokens + cacheWriteTokens`）。单看 `inputTokens` 无法区分两种形状：

| 形状 | uncachedInput | cacheRead | 结论 |
|---|---|---|---|
| 大工具结果 / 长粘贴 | 暴涨 | **仍高** | 正常变长，不浪费 |
| 前缀真被改写 | 暴涨 | **塌到块粒度残值** | 整个前缀按全价重计 |

真实会话里两者的差别非常干净：某步 `uncached=46,685`、上一步整个 prompt `46,678`（差 7 个 token）、`cacheRead` 从 34,525 塌到 128 —— 这是重写；另一步 `uncached=21,228` 而 `cacheRead=64,084`（该步命中 75%）—— 这只是变长。注意真重写的 `cacheRead` 是塌到 **128 而不是 0**（DeepSeek 前缀缓存的块粒度残值），所以判定用比值塌陷，不能用 `=== 0`。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `window` | 8 | 基线滑动窗口（同时也是"最近"的跨度） |
| `factor` | 2.5 | 大小闸：未缓存基线倍数 |
| `floorTokens` | 1500 | 大小闸：绝对地板（正常增长不误报） |
| `collapseRatio` | 0.25 | 形状闸：`cacheRead` 低于自身基线该比例算塌陷 |
| `collapseMinBaseline` | 2000 | 形状闸：基线低于此值不判塌陷（不报缓存的 provider 不误伤） |
| `rebillShare` | 0.6 | 归因闸：重计量需达到上一步 prompt 的该比例 |
| `adviseModel` | `true` | 上下文内提醒 |

## 安装

克隆或 npm 安装到 profile 的 node_modules；从源码安装需先 `npm install`（prepare 自动构建）。

## 验证状态

分三档写清楚，避免"测过"和"跑过"混为一谈：

1. **纯函数单测**：`analyze` / `renderHealth` 为纯函数，13 个 `node --test` 全绿；`npm run check`（typecheck + test + build）通过。含真重写、变长不误报、无缓存 provider 不冤枉、滑动基线吸收、索引稳定、压缩不误判、cacheWrite 计入 prompt 口径等回归用例。
2. **真实数据回放（任何人可复算）**：`test/replay-corpus.json` 是从本机真实 dsh 会话日志导出的 usage 流——**39 个会话 / 206 条 `assistant/message` 记录**，只含 token 分桶与 turn/step，不含任何提示词或回复正文。`npm run replay` 在同一份数据上并排跑旧规则与三闸门规则，并断言结果：

   ```
   old single-gate rule: 17 accusations
   three-gate rule:      11 rewrites + 6 growth-only = 17
   narrowing: 6/17 accusations withdrawn, 0 genuine rewrites lost
   ```

   即旧规则 17 次指控里 **6 次（35%）该步缓存命中完好＝误报**，新规则把它们降级为变长，**11 次真重写一个不丢**。该脚本同时断言 `src/*.ts` 与 `tsc` 产出的 `lib/*.js` 在每个会话上结果逐字节一致。
3. **挂载状态**：v0.1.0 的事件面（`session/event` → `tools/post-execute` 注入）在 web / plugtest profile 里实跑过，会话日志中可见其注入的提示——也正是在实跑日志里发现它会每步重复刷屏，v0.2.0 修掉了。**v0.2.0 本身尚未在运行中的 dsh 里 live mount 复验**，改动只经过 1 与 2 两级验证。
3. **挂载状态**：v0.1.0 的事件面（`session/event` → `tools/post-execute` 注入）在 web / plugtest profile 里实跑过，会话日志中可见其注入的提示——也正是在实跑日志里发现它会每步重复刷屏，v0.2.0 修掉了。**v0.2.0 本身尚未在运行中的 dsh 里 live mount 复验**，改动只经过 1 与 2 两级验证。

已知边界：判定只看 usage 流，无法区分"头部被重渲染"与"缓存 TTL 过期"——两者计费形状相同，所以提示语只指出断裂发生的轮次/步骤边界，不指责任何一方；`cacheWriteTokens` 参与 prompt 与命中率口径，但不参与判定（实测 relay 不返回该字段）。
