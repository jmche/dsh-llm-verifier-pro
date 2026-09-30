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
    # conversation model (DeepSeek route) → deepseek-v4-flash, or /models on
    # non-DeepSeek endpoints
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
    boN: false              # master switch — this line is the only place it lives
    boNCandidates: 5        # Candidates sampled per assistant turn
    samplingTemperature: 0.7
    samplingMode: parallel  # 'parallel' (default) fires N rollouts at once; 'serial' waits one-at-a-time (safer for slow local models)
    timeoutMsBoN: 120000        # Sampling-phase budget (independent of the verify phase)
    verifyTimeoutMsBoN: 90000   # Verify-phase budget
    showFooter: true
    # ── Selector: who scores pairwise comparisons (Bo-N, verify_select, verify_compare) ──
    selector: llm           # 'llm' (default) or 'jev' (System One endpoint; verify_track stays on the LLM)
    jevBaseUrl: https://opencode.ai/zen/v1   # …/v1 base or full …/systemone URL; empty = https://api.typesafe.ai/v1
    jevModel: jev-1.13-free                  # empty = jev-latest
    jevApiKey: env:OPENCODE_API_KEY          # credential:<name> | env:VAR | plain; empty sends no key
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

When enabled, every assistant turn that produces a **final text answer** is
sampled N ways and only the winner is replayed to you. **Tool-call turns are
never sampled** — an action turn (reading a file, running a command, calling
a tool) is replayed exactly as produced; Best-of-N ranks plain-text answers
only, and sampling a working turn would waste tokens on unusable candidates.
The decision is re-evaluated per turn and is **all-or-nothing — it covers
every conversation; there is no per-session tier**:

It is one switch: `config.boN: true` turns the mode on for every conversation
at `config.boNCandidates`; anything else is off. Since dsh 0.1.7 the plugin
config is the only layer — there is no settings document above it.

Every failure path fails **open**: a sampling overrun degrades Bo-N → Bo-K →
a normal answer, with an explanatory footer under the answer. Never a dead
turn.

## Endpoint resolution order (zero-config inheritance)

```
explicit config (config) → the session provider route's own Loader entry config
(read through the configEditor service) → credentials seam (credential:<name> /
provider key env) → OPENAI_BASE_URL / OPENAI_API_KEY → DEEPSEEK_API_KEY
(implies api.deepseek.com)
```

## Jev as the selector (optional)

`selector: jev` hands every **pairwise** comparison to a System One endpoint
([TypeSafe Jev](https://docs.typesafe.ai/)) instead of the LLM verifier. It
covers Best-of-N ranking, `verify_select` and `verify_compare`;
`verify_track` always stays on the LLM verifier. The default `selector: llm`
changes nothing.

**How a comparison is scored.** Jev does not generate text. Each directed
comparison is one request whose `state` holds the task and both responses,
with one 9-level Score question per slot (A and B) under the criterion. The
reward is the expectation over the Score levels, normalized to [0, 1] — the
same range and orientation as the LLM path — so the tournament, slot swaps and
Bradley–Terry aggregation are unchanged. The plugin builds the Jev request
itself; you only choose the endpoint. A comparison typically returns in under
a second.

**Choosing a provider.** The endpoint is provider-agnostic. `jevBaseUrl` takes
a `…/v1` base (the plugin appends `/systemone`) or the full `…/systemone` URL:

| Provider | `jevBaseUrl` | `jevModel` | `jevApiKey` |
|---|---|---|---|
| TypeSafe (default when empty) | `https://api.typesafe.ai/v1` | `jev-latest` | `env:TYPESAFE_API_KEY` |
| OpenCode Zen | `https://opencode.ai/zen/v1` | `jev-1.13-free` (free for a limited time) or `jev-1.13` | `env:OPENCODE_API_KEY`, or empty for the keyless free tier |

`jevApiKey` accepts `credential:<name>`, `env:VAR` or a plain value; empty
sends no `Authorization` header. In the Web UI, **Plugins →
dsh-llm-verifier-pro → Selector** edits `selector`, `jevBaseUrl` and
`jevModel`; `jevApiKey` is a secret and is set in `cordis.patch.yml` only. An
unknown `selector` value logs one warning and falls back to the LLM verifier.

**Failure behavior.** Jev follows the same fail-open rules as the LLM path:

- HTTP 429/529 are retried up to three times with backoff, honoring
  `Retry-After` but never waiting longer than `timeoutMs`; a cancelled call
  stops waiting at once.
- Any other failure raises a verifier error. Best-of-N then returns the first
  candidate with a `Best-of-N skipped` footer; `verify_select` scores that
  comparison as a tie (its `onError: 'tie'` default); `verify_compare`
  returns the error to the agent.
- Jev's context budget is 32k tokens for the `state` plus the longest
  question. Two responses that together exceed it return HTTP 400
  (`max_tokens_exceeded`) and fail open as above.
- The Best-of-N verify deadline (`verifyTimeoutMsBoN`) cancels every
  in-flight Jev request.
- An LLM verifier config that cannot resolve (e.g. a missing `credential:`
  key) is logged and does not block Jev; only `verify_track` needs it.

When Jev ranked a Best-of-N turn, the footer shows `· Jev`.

**Caveats.** Jev 1.13 is weak at arithmetic, counting and dates (see the
[jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)),
and it gives no reasoning for its scores. The task and both responses are sent
to the configured provider, so check its data policy — OpenCode Zen documents
none for `jev-1.13-free`.

## Development

```bash
npm install
npm run check      # typecheck + full test suite
npm run build      # tsc
```

## License

MIT. The implementation is ported from two upstream projects (both MIT):

- [dsh-llm-as-a-verifier](https://github.com/TaurenMountain/dsh-llm-as-a-verifier) (TaurenMountain)
- [llm-as-a-Verifier-dsh](https://github.com/aispin-dev/llm-as-a-Verifier-dsh) (Aispin)

Method: LLM-as-a-Verifier (arXiv:2607.05391).