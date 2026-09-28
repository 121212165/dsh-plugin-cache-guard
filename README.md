# dsh-plugin-cache-guard

DeepSeek Harness (dsh) 插件：前缀缓存健康守卫。DeepSeek 的前缀缓存是省钱命脉——系统提示、工具列表或任何位于上下文开头的内容一旦被改写，整个前缀重新按未缓存全价计费。本插件监听 usage 流，对每轮"未缓存输入"维护滑动基线，检测异常尖峰，估算多付的 token，并在前缀疑似不稳定时直接在上下文里提醒模型住手。

同系列：[price-aware](https://github.com/121212165/dsh-plugin-price-aware)（花了多少）· [cost-ledger](https://github.com/121212165/dsh-plugin-cost-ledger)（台账）· 本插件（**为什么多花**）。

## 功能

- **滑动基线尖峰检测**：最近 N 轮未缓存输入的中位数 × factor + 绝对地板 = 允许带；超出即记一次抖动（turn、基线、超额 token）。持续偏高的负载会成为新常态，不再误报。
- **`/cache`**：命中率、判定（✅ 稳定 / ⚠ 观察 / ❌ 不稳定）、抖动轮次明细、多付合计。
- **`cache_status` 工具**：agent 自查。
- **`adviseModel`**（默认开）：检测到不稳定时通过 `tools/post-execute` 注入插件提示（price-aware 验证过的腿），要求模型停止改写上下文头部。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `window` | 8 | 基线滑动窗口 |
| `factor` | 2.5 | 尖峰倍数 |
| `floorTokens` | 1500 | 绝对地板（正常增长不误报） |
| `adviseModel` | `true` | 上下文内提醒 |

## 安装

克隆或 npm 安装到 profile 的 node_modules；从源码安装需先 `npm install`（prepare 自动构建）。

## 验证状态

- 检测/渲染为纯函数，6 个 node --test 全绿（含基线滑动、小流量边界）。
- 事件面（agent/request、session/event、tools/post-execute、session/disposed）与已 live-mount 验证的 price-aware/cost-ledger 完全一致。
- 未在运行中的 dsh 里 live mount 验证本插件自身。
