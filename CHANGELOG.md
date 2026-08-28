# Changelog

## Unreleased

### Fixes — Best-of-N sampling kept producing "0 usable" rollouts
Root cause: every assistant turn was sampled N ways, **including tool-call
turns** (the common case on agentic work — reading files, running commands).
The clones inherited the tool schemas, so sampled models either called tools
too (unusable) or the tools-bearing clone was rejected by the gateway
(finish=error) — the turn degraded to "0 usable" and Best-of-N never engaged.
- **Anchor-first gating**: the anchor (the conversation's own turn) is now
  collected first, alone. Only when it is a real plain-text answer does
  sampling start; a tool-call / failed / empty anchor is replayed verbatim
  with zero sampling spent.
- **`tools` stripped from sampled candidates**: diversity rollouts are
  plain-text generators now — no tool schemas, so they cannot drift into
  tool-calls and no gateway can reject them on tool-shape grounds.
- **Real failure surfaced**: `collectRollout` now prints the adapter's
  `failure` (`code`, HTTP status, message) for `finish=error` rollouts
  instead of just `finish=error` — every earlier fix flew blind.

## 0.2.0 (2026-08-27)

Best-of-N settings panel redesigned (v3): one decision, plain English, no
per-session tier.

### Breaking changes
- **Session-preset tier removed.** The mode is now all-or-nothing: it covers
  every conversation or none. `boNPresetIds` / `boNPresetCandidates` config
  and section fields are deleted; a `bo-n` `agentPreset` stamped on a session
  no longer has any effect. An explicit **Off** in the panel is the master
  kill-switch and overrides the config default.
- `resolveBoNMode(config, sectionReader)` — the `ctx`/`sessionId` args are
  dropped (no session lookup anymore).

### Features
- Web panel rewritten (`src/client.js`):
  - live **Current effect** banner ("Best-of-N is ON for every conversation ·
    5-way" / "… is OFF"), computed from the settings every render;
  - master switch as four radio cards: Off / Fast · 3-way / Accurate · 5-way /
    Custom (2–8);
  - Advanced settings and a "How do I know it's running?" help section, both
    folded by default;
  - model-mix Save now gives momentary "Saved ✓" feedback;
  - panel copy is English throughout.
- **autoDegrade wired for real**: when the endpoint returns no token-level
  logprobs, grading falls back to sampling-style scoring and the turn footer
  marks "sampling scoring"; with `autoDegrade: false` (strict mode) the
  backend raises instead of silently downgrading. Configurable from the
  panel, the settings section, or the plugin config; the backend records
  `lastGradingMode` for diagnostics.
- **`samplingMode`** (`parallel` | `serial`): rollouts fire concurrently by
  default; `serial` collects one at a time, safer when several candidates
  share one slow local model. Exposed in the panel's Advanced settings
  (Rollout schedule) and in the plugin config.
- **Sampling hardening**: a single candidate that fails to start (e.g. an llm
  route error) is absorbed as a failed slot instead of sinking the whole
  turn — parallel and serial schedules both keep the anchor as the last
  fallback, so `no fallback rollout` can no longer be caused by one bad
  candidate.
- **`reasoningEffort` no longer leaks into candidates**: sampled rollouts drop
  the main turn's `reasoningEffort`, so a candidate model that does not
  declare that effort (e.g. `ollama-local/*`) is no longer rejected by
  dsh-llm validation ("does not support reasoning effort high") — fixing a
  common cause of `0 usable` when the main turn runs with a high effort but
  the mix includes local models.

### Docs
- README / USER-GUIDE updated: new panel section, gating matrix, and a
  behavior-change note for `bo-n` session presets.

### Tests
- 97 passing: `resolveBoNMode` rewritten for the two-layer gating; new
  `VerifierBackend.autoDegrade` suite (default fallback / strict raise /
  logprob grading); `orchestrate` sampling-schedule suite (serial waits,
  parallel concurrent, one bad candidate never sinks the turn).

## 0.1.0 (2026-08-26)

Initial release — the unified LLM-as-a-Verifier plugin for DeepSeek Harness,
merging the engineering of `dsh-llm-as-a-verifier` (TaurenMountain) with the
Best-of-N conversation surface of `@aispin/plugin-verifier` (Aispin).

### Features
- Three agent tools: `verify_compare`, `verify_select` (Probabilistic Pivot
  Tournament, O(Nk), seeded & reproducible), `verify_track` (20-level progress
  curve).
- Best-of-N conversation mode: every assistant turn sampled N ways, only the
  winner replayed; three-state gating (Web setting → session preset →
  config default); fail-open degradation chain with explanatory footer.
- Service face `ctx.verifierPro.verify/compare/select/track`.
- Shared `VerifierBackend` across all faces: fine-grained logprob-expectation
  scoring, vLLM/SGLang score-tag prefill, concurrency pool, per-request
  timeout + abort, holistic token accounting (cached/uncached/reasoning).
- Zero-config endpoint inheritance: plugin config → settings section →
  credentials seam → OPENAI_*/DEEPSEEK_API_KEY → api.deepseek.com.
- Web settings panel (settings section `verifier-pro`), coexists with
  `@aispin/plugin-verifier` in one profile (distinct service / namespace /
  slot ids).

### Fixes
- `verifyBest` exhaustive branch (N ≤ 3) now actually runs the pairwise
  verifier calls (upstream dropped them).

### Tests
- 80 passing: tournament, scoring, progress, backend, verifier, merged
  (gating + zero-config + credential seam + Bo-N over the shared backend),
  live `apply()` integration against a mock OpenAI server.

### Not yet
- Bo-N sampling over auxiliary (non-conversation) llm calls is intentionally
  skipped (`purpose` filter).