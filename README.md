# dsh-llm-verifier-pro

[![License](https://img.shields.io/github/license/jmche/dsh-llm-verifier-pro)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-DeepSeek%20Harness-6a4cff)](https://github.com/deepseek-ai/dsh)
[![Type](https://img.shields.io/badge/type-dsh%20plugin-2ea44f)]()
[![Method](https://img.shields.io/badge/method-LLM--as--a--Verifier-ff6c37)]()

**A quality gate for DeepSeek Harness: sample N candidate answers, score them
with fine-grained logprob rewards, and replay only the best one — instead of
handing the model's first draft straight to you.**

- **Best-of-N conversation mode** — each text turn is sampled N ways, ranked by
  expected score, and the winner is replayed with a muted `⚡ Best-of-N` footer;
- **Three `verify_*` tools** — `verify_compare` / `verify_select` /
  `verify_track` for self-checking, best-of-N selection, and progress tracking;
- **Paper method** — fine-grained reward as the expectation over the verifier's
  top-20 logprob distribution at the `<score_A>` position (arXiv:2607.05391),
  with Bradley–Terry + Probabilistic Pivot Tournament (O(N·k), not O(N²));
- **Fails open, always** — sampling overruns, scoring failures, endpoints
  without logprobs: everything degrades gracefully, never a dead turn.

Based on the LLM-as-a-Verifier paper ([arXiv:2607.05391](https://arxiv.org/abs/2607.05391));
engineering core from `dsh-llm-as-a-verifier` (TaurenMountain), product layer
from `@aispin/plugin-verifier` (Aispin), both MIT.

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
every conversation, there is no per-session tier**. It is one switch: `boN: true` in the plugin config turns the mode on for every
conversation at `boNCandidates`; anything else is off.

> **Behavior change (dsh 0.1.7):** there is no settings layer above the plugin
> config any more, so the plugin config is the only place the switch lives —
> see [Configuration](#configuration). (The `bo-n` session-preset tier is a
> separate, earlier removal — this plugin's own 0.2.0.)

**Model mix (candidate diversity).** Candidate 0 always rides the
conversation's own model (the greedy anchor). Each later slot draws a
`{ provider, model }` entry from `boNModelMix` in order; slots beyond the list
fall back to anchor-model variants at the sampling temperature. Configure it in
the patch layer.

`provider` is a REAL dsh provider route (`omni-chat`, `omni-message`,
`deepseek-official`…); `model` is the FULL model id exactly as that provider
advertises it (possibly containing its own `/`, e.g. `agnes/agnes-2.5-flash`).
A string entry is split at its FIRST `/` — so a model id that itself contains
`/` (e.g. `ollama-local/qwen3.8:27b`) MUST be written with its real provider
(`omni-chat/ollama-local/qwen3.8:27b`); only a model id WITHOUT `/` can ride
the conversation's provider as a bare string.

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

**Zero-config default:** with no explicit `baseUrl` / `apiKey` / `model`, the
verifier **follows the session** —
same provider route, endpoint and model as the conversation. Turning on
Best-of-N alone gives the paper's *self-verification* experience: candidates
are sampled as variants of the conversation's own model, and that same model
grades them. The endpoint for the session provider is read from that adapter's
own Loader entry config (`llm-pi-ai` style, `providers.<name>.baseURL`), through
the `configEditor` service. Only when the session provider is unknown does the
resolution fall back to:

plugin config → session provider endpoint → `OPENAI_BASE_URL` /
`OPENAI_API_KEY` / `DEEPSEEK_API_KEY` → `api.deepseek.com`.

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
    boN: false          # master switch — this line is the only place it lives
    boNCandidates: 5
    samplingMode: parallel   # rollouts per turn: 'parallel' (default) fires N at once; 'serial' waits one-at-a-time (safer when several candidates share one slow local model)
    showFooter: true
```

### Jev as the selector (optional)

`selector: jev` hands every **pairwise** comparison — Best-of-N ranking,
`verify_select`, `verify_compare` — to a System One endpoint
([TypeSafe Jev](https://docs.typesafe.ai/)) instead of the LLM verifier. Jev
does not generate text: each comparison is one request with the task and both
responses as `state` and one ordered Score question per slot; the reward is the
expectation over the Score levels, normalized to [0, 1] like the logprob
expectation, so the tournament, slot swaps and Bradley–Terry aggregation are
unchanged. A comparison typically returns in under a second. `verify_track`
always stays on the LLM verifier. The default `selector: llm` changes nothing.

The endpoint is provider-agnostic: `jevBaseUrl` is a `…/v1` base (the plugin
appends `/systemone`) or the full `…/systemone` URL.

```yaml
- id: llm-verifier-pro
  config:
    selector: jev
    # TypeSafe directly (the default when jevBaseUrl/jevModel are empty):
    #   jevBaseUrl: https://api.typesafe.ai/v1
    #   jevModel: jev-latest
    #   jevApiKey: env:TYPESAFE_API_KEY
    # OpenCode Zen (jev-1.13-free is free for a limited time):
    jevBaseUrl: https://opencode.ai/zen/v1
    jevModel: jev-1.13-free
    jevApiKey: env:OPENCODE_API_KEY   # credential:<name> | env:VAR | plain; empty sends no key
```

Jev's context budget is 32k tokens for the `state` plus the longest question;
a comparison whose two responses exceed it returns HTTP 400
(`max_tokens_exceeded`) and the turn fails open like any other verifier error.
Jev 1.13 is weak at arithmetic, counting and dates
([jaggedness notes](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)),
and the state is sent to the configured provider — check its data policy.

### Configuring in the Web UI

Open **Plugins → dsh-llm-verifier-pro** in `dsh web`: the bundle page carries a
form for every parameter below except `apiKey`, `jevApiKey`, `deepseek`, `prefill` and
`compare`/`select`/`track`. **Save** writes the same `cordis.patch.yml` block
shown above, and the change applies to the next turn without a restart (the
form's fields are `.volatile()` Config fields, which the Loader commits into
the running plugin). The excluded fields are edited in the patch; changing one
there remounts the plugin.

Out-of-range values (a timeout below 1 ms, fewer than 2 candidates, a
temperature outside 0–2, a fractional count) are refused on save. The form is
bound to the entry id `llm-verifier-pro`; a row renamed in the patch, or a
second instance under another id, is configured in the patch only. Model mix
and criteria take one entry per line.

### Parameters

Every parameter lives in the plugin config (the profile's `cordis.patch.yml`)
and overrides the built-in default. Since dsh 0.1.7 that is the only layer:
`~/.dsh/settings.yaml` no longer exists (dsh imported it into the profile patch
and renamed it `settings.yaml.imported`).

| Parameter | Default | Meaning |
|---|---|---|
| `boN` | `false` | Best-of-N master switch. |
| `boNCandidates` | `5` | Candidates sampled per text-answer turn. |
| `samplingTemperature` | `0.7` | Diversity temperature for the sampled candidates. |
| `samplingMode` | `parallel` | Rollout schedule: `parallel` (all at once) or `serial` (one at a time). |
| `boNModelMix` | `[]` | Model mix for non-anchor candidates; empty = same-model (follow the session). |
| `timeoutMs` | `300000` | Per-request verifier HTTP timeout in ms. |
| `timeoutMsBoN` | `300000` | Wall-clock budget for the sampling phase. |
| `verifyTimeoutMsBoN` | `300000` | Wall-clock budget for the ranking phase. |
| `showFooter` | `true` | Append the muted `⚡ Best-of-N …` footer under the winner. |
| `criteria` | `[]` | Extra grading criteria appended to the comparison prompt. |
| `boNPivots` | `2` | PPT pivot count `k`. |
| `boNSeed` | `0` | Seed for the tournament ring pass. |
| `verifier` | `''` | Verifier as a `provider/model` route; empty = follow the session model. |
| `autoDegrade` | `true` | Fall back to sampling scoring when the endpoint lacks logprobs. |
| `baseUrl` / `apiKey` / `model` | `''` | Explicit verifier endpoint three-part; empty = follow the session. |
| `maxConcurrency` | `8` | Max in-flight verifier calls. |
| `selector` | `llm` | Pairwise scorer: `llm` (the verifier above) or `jev` (a System One endpoint). |
| `jevBaseUrl` | TypeSafe | System One `…/v1` base or full `…/systemone` URL; empty = `https://api.typesafe.ai/v1`. |
| `jevModel` | `jev-latest` | System One model id, e.g. `jev-1.13-free` on OpenCode Zen. |
| `jevApiKey` | `''` | `credential:<name>`, `env:VAR` or plain; empty sends no Authorization header. |
| `deepseek` | auto | Force the DeepSeek call path. |
| `prefill` | `true` | vLLM/SGLang score-tag prefill pass. |
| `compare` / `select` / `track` | `true` | Register the three `verify_*` tools. |

`maxConcurrency`, `deepseek`, `prefill` and `compare`/`select`/`track` are
deployment knobs rather than things a user tunes per turn.

## Development

```bash
npm install
npm run check      # typecheck + tests (112 tests)
npm run build      # tsc
```

## License

MIT. Implementation ports from the two upstreams above, both MIT.