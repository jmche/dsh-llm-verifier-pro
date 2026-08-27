# dsh-llm-verifier-pro User Guide

This document explains how to install, configure and use the plugin inside
[DeepSeek Harness](https://github.com/deepseek-ai/dsh). For a quick overview
read the root `README.md` first.

## Installation

```bash
# Option A: install from GitHub (recommended — the compiled lib/ is tracked
# in the repo, so this works immediately)
dsh plugin --profile web add github:jmche/dsh-llm-verifier-pro

# Option B: local development install (file: / link: dependency)
dsh plugin --profile web add /path/to/dsh-llm-verifier-pro
```

Plugin id (bundle row id): `llm-verifier-pro`.

## Configuration

Override the bundle defaults in the profile's `cordis.patch.yml`:

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-verifier-pro
  config:
    # OpenAI-compatible verifier endpoint (vLLM / SGLang / OpenAI / DeepSeek)
    baseUrl: https://your-gateway/v1
    # Secret: credential:<name> (dsh credentials seam) | env:VAR | plain text
    apiKey: credential:YOUR_API_KEY_ENV
    # Scoring model; when empty, the resolution chain is: explicit config →
    # settings section → conversation model (DeepSeek route) →
    # deepseek-v4-flash, or /models on non-DeepSeek endpoints
    model: opencode-go/deepseek-v4-flash
    timeoutMs: 60000        # Per-call verifier request timeout
    maxConcurrency: 8       # Concurrent verifier calls (tools + Bo-N shared)
    deepseek: false         # Force the DeepSeek call path (thinking + large output budget)
    prefill: true           # Enable vLLM/SGLang tag prefill on non-DeepSeek servers
    # Switches for the three tools
    compare: true
    select: true
    track: true
    # ── Best-of-N conversation mode ──
    boN: false              # Deployment-level default switch (Web panel / session preset can enable)
    boNCandidates: 5        # Candidates sampled per assistant turn
    boNPresetIds: ['bo-n']  # Session presets that opt the session into the mode
    samplingTemperature: 0.7
    timeoutMsBoN: 120000        # Sampling-phase budget (independent of the verify phase)
    verifyTimeoutMsBoN: 90000   # Verify-phase budget
    showFooter: true
```

## The three usage surfaces

### 1. Tools (agent calls on demand)

| Tool | What it does |
|---|---|
| `verify_compare` | Single directional comparison of two candidates under a criterion; returns fine-grained rewards (R_A, R_B) ∈ [0,1] |
| `verify_select` | Probabilistic Pivot Tournament (PPT): picks the best of N candidates in O(Nk) comparisons instead of O(N²); seed is reproducible |
| `verify_track` | Scores each checkpoint of a trajectory: A(0%)…T(100%) 20-letter progress curve |

### 2. Service (for code)

```ts
import { Context } from '@deepseek-ai/cordis'
// inside a plugin context:
ctx.verifierPro.verify({ task, candidates, criteria })   // rank
ctx.verifierPro.compare(problem, traceA, traceB, criteria)
ctx.verifierPro.select(problem, candidates, criteria)
ctx.verifierPro.track(problem, steps)
```

### 3. Mode (Best-of-N conversation mode)

When enabled, **every assistant turn** of the session is sampled N ways and
only the winner is replayed to you. Three-state gating:

| Layer | Switch |
|---|---|
| Settings global (Web UI panel) | `verifier-pro.boN: true` |
| Session preset | session `agentPreset` ∈ `boNPresetIds` (default `['bo-n']`) |
| Config default | `config.boN: true` |

Every failure path fails **open**: a sampling overrun degrades Bo-N → Bo-K →
a normal answer, with an explanatory footer under the answer. Never a dead
turn.

## Endpoint resolution order (zero-config inheritance)

```
explicit config (config) → settings section (verifier-pro) → credentials seam
(credential:<name> / provider key env) → OPENAI_BASE_URL / OPENAI_API_KEY →
DEEPSEEK_API_KEY (implies api.deepseek.com)
```

## Web settings panel

The plugin ships a browser-side settings panel (`src/client.js`) registered as
the `verifier-pro` settings section (slot id `verifier-pro`, title
"Best-of-N"). It can control:
- the global Best-of-N switch
- the global candidate count
- the session-preset candidate count
- the verify-phase timeout
- extra grading criteria
- the candidate model mix (`provider/model` lines; the first `/` splits the
  provider from the model id — a model id containing `/` must include its real
  provider, only a `/`-free id can ride the conversation's provider)

## Development

```bash
npm install
npm run check      # typecheck + full test suite
npm run build      # tsc + copy client.js into lib/
```

## License

MIT. The implementation is ported from two upstream projects (both MIT):

- [dsh-llm-as-a-verifier](https://github.com/TaurenMountain/dsh-llm-as-a-verifier) (TaurenMountain)
- [llm-as-a-Verifier-dsh](https://github.com/aispin-dev/llm-as-a-Verifier-dsh) (Aispin)

Method: LLM-as-a-Verifier (arXiv:2607.05391).