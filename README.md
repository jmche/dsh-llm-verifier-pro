# dsh-llm-verifier-pro

LLM-as-a-Verifier for DeepSeek Harness — one plugin that unifies the best of
two independent implementations:

- **`dsh-llm-as-a-verifier`** (TaurenMountain, MIT) — the engineering core:
  fine-grained logprob scoring, Probabilistic Pivot Tournament, vLLM/SGLang
  score-tag prefill, concurrency + timeout + cancellation + token accounting.
- **`@aispin/plugin-verifier`** (Aispin, MIT) — the product surface: the
  *Best-of-N conversation mode* (every assistant turn sampled N ways, only the
  winner replayed) plus a Web settings panel with three-state gating.

Method: the LLM-as-a-Verifier paper — fine-grained reward as the expectation
over the verifier's top-20 logprob distribution at the score position
(arXiv:2607.05391).

## Installation

Requires a [DeepSeek Harness](https://github.com/deepseek-ai/dsh) profile
(web or headless). Add the plugin to the target profile — the compiled
`lib/` is tracked in this repo, so GitHub installs work out of the box:

```bash
# from GitHub (recommended — works immediately)
dsh plugin --profile web add github:jmche/dsh-llm-verifier-pro

# or from a local checkout / path
dsh plugin --profile web add /path/to/dsh-llm-verifier-pro
```

The plugin registers as the bundle row `llm-verifier-pro`. Then configure it in
the profile's patch layer (see [Configuration](#configuration) below), restart
`dsh web`, and the plugin exposes:

- three `verify_*` tools to every agent;
- the `verifier-pro` settings section in the Web UI (Best-of-N panel);
- the optional Best-of-N conversation mode (off by default).

Full walkthrough: [`docs/USER-GUIDE.md`](docs/USER-GUIDE.md).

## Three faces

### 1. Tools (agent calls them on demand)

- `verify_compare` — fine-grained rewards (R_A, R_B) ∈ [0, 1] for one directed
  pairwise comparison under your criteria.
- `verify_select` — Probabilistic Pivot Tournament best-of-N selection:
  O(N·k) verifier comparisons instead of O(N²), seeded and reproducible.
- `verify_track` — per-step progress curve (A = 0% … T = 100%) over your
  trajectory, decoded from the logprob expectation.

### 2. Service (`ctx.verifier`)

`ctx.verifier.verify / compare / select / track` for code consumers.

### 3. Mode (Best-of-N conversation mode)

When enabled, every assistant turn of the session is sampled N ways and only
the winning response is replayed to you. Three-state gating:

| Layer | Switch |
|---|---|
| Settings global (Web UI panel) | `boN: true` |
| Session preset | `agentPreset` ∈ `boNPresetIds` (default `['bo-n']`) |
| Config default | `boN: true` in the plugin config |

**Model mix (candidate diversity).** Candidate 0 always rides the
conversation's own model (the greedy anchor). Each later slot draws a
`{ provider, model }` entry from `boNModelMix` in order; slots beyond the list
fall back to anchor-model variants at the sampling temperature. Configure it in
the patch layer, or live from the Web settings panel (the `verifier-pro`
section has a dedicated editor — one `provider/model` per line; a line without
`/` is a full model id on the conversation's provider).

`provider` is a REAL dsh provider route (`omni-chat`, `omni-message`,
`deepseek-official`…); `model` is the FULL model id exactly as that provider
advertises it (possibly containing its own `/`, e.g. `agnes/agnes-2.5-flash`).
The panel splits each line at its FIRST `/` — so a model id that itself
contains `/` (e.g. `ollama-local/qwen3.8:27b`) MUST be written with its real
provider (`omni-chat/ollama-local/qwen3.8:27b`) in the panel; only a model id
WITHOUT `/` can ride the conversation's provider as a bare line.

```yaml
boNModelMix:
  - provider: omni-chat
    model: agnes/agnes-2.5-flash
  - provider: omni-message
    model: opencode-go/minimax-m3
  - provider: omni-chat
    model: ollama-local/qwen3.8:27b
```

Every failed path fails **open**: a sampling overrun degrades Bo5 → Bo-K →
a normal answer, with a muted footer explaining what happened. Never a dead
turn.

## Configuration

Resolution order: plugin config → the `verifier` settings section →
the dsh credentials seam (`credential:<name>` / provider env) →
`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` → `api.deepseek.com`.

Any OpenAI-compatible server with token-level logprobs works (vLLM, SGLang,
OpenAI, DeepSeek). Non-DeepSeek servers get the optional vLLM/SGLang prefill
pass so score tags land exactly at the label position.

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-verifier-pro
  config:
    baseUrl: https://your-gateway/v1
    apiKey: credential:YOUR_API_KEY_ENV
    model: opencode-go/deepseek-v4-flash
    boN: false          # Web panel / preset switches it on per session
    boNCandidates: 5
    showFooter: true
```

## Development

```bash
npm install
npm run check      # typecheck + tests (79 tests)
npm run build      # tsc + copy client.js
```

## License

MIT. Implementation ports from the two upstreams above, both MIT.