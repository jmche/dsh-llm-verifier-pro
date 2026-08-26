# Changelog

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