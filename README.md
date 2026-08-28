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

When enabled, every assistant turn that produces a **final text answer** is
sampled N ways and only the winning response is replayed to you. **Tool-call
turns are never sampled** — when the model's turn is an action (reading a
file, running a command, calling a tool), the turn is replayed exactly as
produced: Best-of-N ranks text answers only, and sampling a working turn
would waste tokens and produce unusable candidates. The decision is
re-evaluated per turn and is deliberately **all-or-nothing — the mode covers
every conversation, there is no per-session tier**:

| Layer | Switch |
|---|---|
| Settings (Web UI panel) | `boN: true` / `boN: false` — an explicit **Off** is the master kill-switch and overrides the config default |
| Config default | `boN: true` in the plugin config (only when the section is unset) |

> **Behavior change:** a `bo-n` session preset in the dsh session UI no longer
> has any effect — the mode is all-or-nothing. If you previously opted
> specific sessions in via a preset, enable the mode globally instead (or
> scope it per profile).

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

The switch, candidate counts, verify budget and model mix are all editable
live from the Web settings panel — see
[Web settings panel](#web-settings-panel-best-of-n).

## Web settings panel (Best-of-N)

The dsh Web UI exposes one settings section (`verifier-pro` → **Best-of-N**).
Every control writes the settings document and applies to the **very next
turn** — no restart. The per-turn decision is `resolveBoNMode` (settings →
config default → off) and it is **all-or-nothing**: the mode applies to every
conversation; there is **no per-session tier**.

### Current effect (live banner)

A status banner at the top of the panel states the actual outcome of the
current settings in plain English — there is no "which sessions" question
left to guess:

- `Best-of-N is ON for every conversation · 5-way`
- `Best-of-N is OFF for every conversation`

### Best-of-N mode (the whole decision)

- **Off** — writes `boN: false`. The master kill-switch: nothing is sampled,
  and it overrides the config default too.
- **Fast · 3-way** — `boN: true`, `boNCandidates: 3`. ≈2–3× tokens, ≈2×
  latency.
- **Accurate · 5-way** — `boN: true`, `boNCandidates: 5`. ≈3–5× tokens,
  2–4× latency (≈16 model calls — the paper's Bo5).
- **Custom** — `boN: true`, `boNCandidates: N`, with N clamped to 2–8.

### Advanced settings (folded by default)

- **Verify timeout (seconds)** — independent wall-clock budget for the
  **ranking phase only** (default 90 s, range 30–600). Sampling is budgeted
  separately (`timeoutMsBoN`). On timeout the turn degrades to a plain answer
  with a footer note.
- **Rollout schedule** — Parallel (default): all candidates fire at once,
  fastest on fast models. Serial: one candidate at a time, safer when several
  candidates share one slow local model.
- **Verifier (scoring model)** — the single model that grades every candidate
  pair. One line, **same rule as the Model mix**: `provider/model` looks the
  endpoint and API key up from dsh's provider configuration (no base URL to
  type); a bare model id without `/` rides the session's provider. Empty →
  **follows the session model** (zero-config default, the paper's
  self-verification). The resolved endpoint must return token-level logprobs.
- **Model mix (candidate diversity)** — textarea, one entry per line:
  `provider/model` names an explicit provider route (split at the **first**
  `/`); a bare model id with no `/` rides the conversation's provider.
  Candidate 0 is always the conversation's model (greedy anchor); slots
  1..N−1 fill from the list in order; slots beyond the list fall back to
  anchor-model variants at the sampling temperature.
  - **Save model mix** parses and writes `boNModelMix` (momentary "Saved ✓"
    feedback); **Restore config defaults** empties the section value (the
    plugin-config base re-applies); the **Available models** badges
    click-to-append with an explicit provider route.
- **Auto-degrade when the endpoint lacks logprobs** — ON (default): when the
  endpoint returns no token-level logprobs, grading falls back to sampling
  the score letter, and the turn footer marks "sampling scoring" (slightly
  less precise). OFF: strict mode — unsupported endpoints surface the error
  directly and Bo-N turns return as plain answers; never a silent downgrade.

### How do I know it's running?

Every Best-of-N turn appends a muted footer to the answer — "⚡ Best-of-N ·
5-choose-1 → …" — with the tier, elapsed time and token use; the server
console also logs `[bo-n] mode: …` per turn.

## Faithfulness to the paper

The tools, the service and the Bo-N mode implement the LLM-as-a-Verifier
method (arXiv:2607.05391) exactly as shipped by the
[official repository](https://github.com/llm-as-a-verifier/llm-as-a-verifier)
(MIT): fine-grained reward = expectation over the verifier's top-20 logprob
distribution at the `<score_A>` / `<score_B>` positions of a 20-letter
(A–T) scale, normalized to [0, 1] (paper Eq. 3.1); Bradley–Terry preference
p = σ(R_A − R_B) (Eq. 3.2); Probabilistic Pivot Tournament with a random
Hamiltonian-cycle ring pass, top-k pivots by mean preference and pivot
rounds — N + k(N−k) + C(k,2) = O(Nk) comparisons, seeded and reproducible
(Algorithm 1); criteria decomposition (C) and repeated evaluations (K);
per-checkpoint progress tracking (A = 0% … T = 100%); and the vLLM/SGLang
score-tag prefill pass for logit-restricted backends (paper Appendix B.6).
The pairwise and progress prompts match the official templates.

Documented deviations vs. the official repo / paper — none changes the method:

1. **Bo-N uses a full round-robin for N ≤ 3** (`src/bon.ts`): PPT only
   applies from N ≥ 4, where it is cheaper and lower-variance; exhaustive
   scoring of tiny pools is exact. `verify_select` always uses PPT.
2. **Defaults are weaker than the paper's headline protocol** (G=20, K=8,
   three-criterion decomposition): `verify_compare` K=1, `verify_select` K=4
   (the official repo's default), the Bo-N turn K=1 with a single
   `correctness` criterion. All are configurable (`nEvaluations`,
   `criteria`, …).
3. **`verify_track` is the offline one-call variant** (same as the official
   `track()`): one call scores every checkpoint and sees the whole
   trajectory; the strict per-prefix protocol (the official
   `ProgressTracker`) is not ported.
4. **No multimodal (image/video) inputs** — the official repo accepts
   `images`; the TS backend does not.
5. **No persistent JSON score cache** — `select` keeps an in-memory cache per
   run only.
6. **Not bit-reproducible across implementations** — the PRNG is mulberry32
   (not Python's `random`), so a seed reproduces a tournament within JS but
   not the same ring as Python; criterion-id slugging uses `-` instead of
   `_`.

## Configuration

**Zero-config default:** with no explicit `baseUrl` / `apiKey` / `model` (and
the panel's Verifier fields empty), the verifier **follows the session** —
same provider route, endpoint and model as the conversation. Turning on
Best-of-N alone gives the paper's *self-verification* experience: candidates
are sampled as variants of the conversation's own model, and that same model
grades them. The endpoint for the session provider is read from its settings
namespace (`llm-pi-ai.providers.<name>` style). Only when the session
provider is unknown does the resolution fall back to:

plugin config → the `verifier` settings section →
session provider endpoint → `OPENAI_BASE_URL` / `OPENAI_API_KEY` /
`DEEPSEEK_API_KEY` → `api.deepseek.com`.

The verifier must sit on an endpoint that returns **token-level logprobs**
(vLLM, SGLang, OpenAI, DeepSeek, and modern Ollama all do; a plain gateway
that strips `logprobs` will not). Non-DeepSeek servers get the optional
vLLM/SGLang prefill pass so score tags land exactly at the label position.

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: llm-verifier-pro
  config:
    # Leave baseUrl/apiKey/model empty to follow the session model.
    # Set them explicitly to use a dedicated scoring endpoint:
    baseUrl: https://your-gateway/v1
    apiKey: credential:YOUR_API_KEY_ENV
    model: opencode-go/deepseek-v4-flash
    boN: false          # master switch — the Web panel or this line turns it on; an explicit Off wins over everything
    boNCandidates: 5
    samplingMode: parallel   # rollouts per turn: 'parallel' (default) fires N at once; 'serial' waits one-at-a-time (safer when several candidates share one slow local model)
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