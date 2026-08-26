# dsh-llm-verifier-pro 用户指南

本文档说明如何在 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 中安装、
配置和使用本插件。如有疑问，请先阅读根目录 `README.md`。

## 安装

```bash
# 方式一：从 npm 安装（发布后可用）
dsh plugin --profile web add dsh-llm-verifier-pro

# 方式二：本地开发安装（file: / link: 依赖）
dsh plugin --profile web add /path/to/dsh-llm-verifier-pro
```

插件名（bundle 行 id）：`llm-verifier-pro`。

## 配置

在 profile 的 `cordis.patch.yml` 中覆写 bundle 默认值：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-verifier-pro
  config:
    # OpenAI-compatible verifier 端点（vLLM / SGLang / OpenAI / DeepSeek 均可用）
    baseUrl: https://your-gateway/v1
    # 密钥：credential:<name>（dsh 凭据接缝）｜env:VAR｜明文
    apiKey: credential:YOUR_API_KEY_ENV
    # 评分模型；留空时：显式配置 → settings 分区 → 会话模型（DeepSeek 路由）
    # → deepseek-v4-flash，或非 DeepSeek 端点的 /models
    model: opencode-go/deepseek-v4-flash
    timeoutMs: 60000        # 单次 verifier 请求超时
    maxConcurrency: 8       # 并发 verifier 调用上限（工具 + Bo-N 共享）
    deepseek: false         # 强制 DeepSeek 调用路径（thinking + 大输出预算）
    prefill: true           # 非 DeepSeek 服务器上启用 vLLM/SGLang 标签 prefill
    # 三个工具的开关
    compare: true
    select: true
    track: true
    # ── Best-of-N 对话模式 ──
    boN: false              # 部署级默认开关（也可用 Web 面板/会话 preset 开启）
    boNCandidates: 5        # 每轮采样候选数
    boNPresetIds: ['bo-n']  # 命中即开启模式的会话 preset id 列表
    samplingTemperature: 0.7
    timeoutMsBoN: 120000        # 采样阶段预算（与验证阶段独立）
    verifyTimeoutMsBoN: 90000   # 验证阶段预算
    showFooter: true
```

## 三个使用面

### 1. 工具（agent 按需调用）

| 工具 | 作用 |
|---|---|
| `verify_compare` | 在给定准则下对两个候选做单次方向性比较，返回细粒度奖励 (R_A, R_B) ∈ [0,1] |
| `verify_select` | 概率枢轴锦标赛（PPT）从 N 个候选中选最优：O(Nk) 次比较而非 O(N²)，seed 可复现 |
| `verify_track` | 对轨迹的每个 checkpoint 打分：A(0%)…T(100%) 的 20 进制进度曲线 |

### 2. 服务（面向代码）

```ts
import { Context } from '@deepseek-ai/cordis'
// 在插件上下文中：
ctx.verifierPro.verify({ task, candidates, criteria })   // 排序
ctx.verifierPro.compare(problem, traceA, traceB, criteria)
ctx.verifierPro.select(problem, candidates, criteria)
ctx.verifierPro.track(problem, steps)
```

### 3. 模式（Best-of-N 对话模式）

开启后，会话中**每个助手回合**被采样 N 路，仅把胜者回放给你。三态门控：

| 层级 | 开关 |
|---|---|
| Settings 全局（Web UI 面板） | `verifier-pro.boN: true` |
| 会话 preset | 会话 `agentPreset` ∈ `boNPresetIds`（默认 `['bo-n']`） |
| 配置默认 | `config.boN: true` |

所有失败路径均**fail-open**：采样超时降级 Bo-N → Bo-K → 普通回答，并在回答下方附加说明 footer，绝不产出死回合。

## 端点解析顺序（零配置继承）

```
显式配置(config) → settings 分区(verifier-pro) → 凭据接缝(credential:<name>/提供方 key 环境)
→ OPENAI_BASE_URL / OPENAI_API_KEY → DEEPSEEK_API_KEY（暗示 api.deepseek.com）
```

## Web 设置面板

插件附带浏览器端设置面板（`src/client.js`），注册为 settings 分区
`verifier-pro`（slot id `verifier-pro`，标题 “Best-of-N”）。可用于：
- 全局开关 Best-of-N
- 全局候选数
- 会话 preset 候选数
- 验证阶段超时
- 额外评分准则

## 开发

```bash
npm install
npm run check      # typecheck + 全部测试（80 个）
npm run build      # tsc + 复制 client.js 到 lib/
```

## 许可证

MIT。实现移植自两个上游（均为 MIT）：

- [dsh-llm-as-a-verifier](https://github.com/TaurenMountain/dsh-llm-as-a-verifier)（TaurenMountain）
- [llm-as-a-Verifier-dsh](https://github.com/aispin-dev/llm-as-a-Verifier-dsh)（Aispin）

方法来源：LLM-as-a-Verifier（arXiv:2607.05391）。