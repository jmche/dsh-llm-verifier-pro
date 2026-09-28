/**
 * dsh-llm-verifier-pro: LLM-as-a-Verifier for DeepSeek Harness (unified).
 *
 * Merges the engineering of dsh-llm-as-a-verifier (TaurenMountain, MIT) —
 * fine-grained logprob scoring, Probabilistic Pivot Tournament, vLLM/SGLang
 * prefill, concurrency + timeout + token accounting — with the Best-of-N
 * conversation mode of @aispin/plugin-verifier (Aispin, MIT). Method by the LLM-as-a-Verifier paper (arXiv:2607.05391).
 *
 * Three faces:
 *  1. Tools — `verify_compare` / `verify_select` / `verify_track` (agent calls
 *     them on demand for fine-grained probabilistic feedback).
 *  2. Service — `ctx.verifierPro.verify/compare/select/track` for code consumers.
 *  3. Mode — Best-of-N conversation mode: every assistant turn of a Bo-N
 *     session is sampled N ways and only the winning response replayed.
 *     Gating: `config.boN` → off.
 *
 * Verifier credentials resolve zero-config from the dsh provider state:
 * plugin config (baseUrl/apiKey/model) → the provider route's own Loader entry
 * config (read through `configEditor`) → the credentials seam (`credential:<name>` or the ambient key env) →
 * OPENAI_BASE_URL/OPENAI_API_KEY/DEEPSEEK_API_KEY.
 *
 * @module dsh-llm-verifier-pro
 */
import { Service } from '@deepseek-ai/cordis';
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import { VerifierBackend } from './backend.js';
import { type CompareOptions, type SelectOptions, type TrackOptions } from './verifier.js';
import type { TokenUsageSnapshot } from './backend.js';
export { VerifierBackend, TokenUsage, MissingAPIKeyError, VerifierError, } from './backend.js';
export type { BackendConfig, TokenUsageSnapshot } from './backend.js';
export { Verifier } from './verifier.js';
export { extractScore, SCALE, GRANULARITY, normalizeCriteria, buildPairwisePrompt } from './scoring.js';
export type { Criterion, CriteriaInput, LogprobToken, VerifierOutput } from './scoring.js';
export { selectBest, bradleyTerry, ringCycle, pivotRoundPairs, selectPivots, createRng, DEFAULT_PIVOTS, accumulate } from './tournament.js';
export { extractProgressScores, buildProgressPrompt, LETTER_TO_VALUE, defaultCheckpoints } from './progress.js';
export { orchestrate, collectRollout, replayWithFooter, verifyBest, taskOf, isInternalRequest, markInternalRequest } from './bon.js';
export type { BoNConfig, BoNTurnSummary, Rollout, VerifyResult, OrchestrateDeps } from './bon.js';
/** Cordis plugin name used by loader diagnostics. */
export declare const name = "llm-verifier-pro";
/** Services required. `tools` + `systemPrompt` for the tool face; `llm` for the Bo-N sampling re-entry. */
export declare const inject: readonly ["tools", "systemPrompt", "llm"];
/** Plugin configuration (dsh config cascade). */
export interface Config {
    /** OpenAI-compatible base URL. Empty (default) resolves: session provider route → OPENAI_BASE_URL → DEEPSEEK_API_KEY implies api.deepseek.com. */
    baseUrl?: string;
    /** API key. Supports `credential:<name>` (dsh credentials seam), `env:VAR`, or a plain value. Empty → seam/ambient env. */
    apiKey?: string;
    /** Verifier model. Empty → the conversation's model (DeepSeek routes only) → deepseek-v4-flash, or /models on non-DeepSeek endpoints. */
    model?: string;
    /**
     * Verifier as a `provider/model` ROUTE (preferred): endpoint and API key are
     * looked up from dsh's provider config (exactly like Model mix entries), so
     * a user who already configured a gateway and models never types a base
     * URL. A bare model id (no `/`) rides the session provider. Empty (default)
     * follows the session model entirely.
     */
    verifier?: string;
    /** Per-request timeout in milliseconds. Defaults to 60000. */
    timeoutMs?: number;
    /** Maximum in-flight verifier calls. Defaults to 8. */
    maxConcurrency?: number;
    /** Force the DeepSeek call path. Auto-detected from the base URL. */
    deepseek?: boolean;
    /** vLLM/SGLang prefill pass for score tags on non-DeepSeek servers. Defaults to true. */
    prefill?: boolean;
    /**
     * When the endpoint returns no token-level logprobs: `true` (default) falls
     * back to sampling-style scoring (footer marks "sampling scoring");
     * `false` is strict mode and raises instead of silently downgrading.
     */
    autoDegrade?: boolean;
    /** Register `verify_compare`. Defaults to true. */
    compare?: boolean;
    /** Register `verify_select`. Defaults to true. */
    select?: boolean;
    /** Register `verify_track`. Defaults to true. */
    track?: boolean;
    /** Deployment-level default for the mode. */
    boN?: boolean;
    /** Candidates per Bo-N turn when active. Defaults to 5. */
    boNCandidates?: number;
    /** Sampling temperature for the diversity rollouts. Defaults to 0.7. */
    samplingTemperature?: number;
    /**
     * Candidate rollout schedule: `parallel` (default) fires every rollout at
     * once; `serial` collects one at a time — safer when several candidates
     * share one slow local model.
     */
    samplingMode?: string;
    /** Wall-clock budget for the sampling phase. Defaults to 120s. */
    timeoutMsBoN?: number;
    /** INDEPENDENT wall-clock budget for the verify phase. Defaults to 90s. */
    verifyTimeoutMsBoN?: number;
    /** Append a muted Best-of-N footer under the winning answer. Defaults to true. */
    showFooter?: boolean;
    /** Extra grading criteria appended to the Bo-N comparison prompt. */
    criteria?: string[];
    /** PPT pivots k used by Bo-N selection. Defaults to 2. */
    boNPivots?: number;
    /** PPT ring seed (default 0: fixed, reproducible). */
    boNSeed?: number;
    /**
     * Model mix for Bo-N candidates beyond the greedy anchor. Candidate 0 is
     * always the conversation's own model; each later slot draws one entry in
     * order, and slots beyond the list fall back to the anchor model.
     *
     * Each entry is either:
     *   - a FULL model id string (e.g. `ollama-local/qwen3.8:27b`) — sampled
     *     with the conversation's own provider; or
     *   - `{ provider, model }` — sampled with an EXPLICIT provider route
     *     (e.g. `{ provider: 'omni-message', model: 'opencode-go/minimax-m3' }`),
     *     overriding the conversation's provider for that candidate only.
     */
    boNModelMix?: Array<ModelMixEntry>;
}
/**
 * One entry of the Bo-N model mix: either a full model id string (conversation
 * provider) or an explicit `{ provider, model }` route.
 */
export type ModelMixEntry = string | {
    provider?: string;
    model: string;
};
/**
 * `.volatile()` fields are what dsh 0.1.7 builds the Plugins-page form from
 * (dsh-settings `describe()` skips an entry with none), and the Loader commits
 * an edit to them into the running references without remounting. They are
 * read per call through {@link currentConfig}. `apiKey` (a secret), the
 * `deepseek`/`prefill` call-path overrides and the tool registration flags
 * stay ordinary: editing them in the profile patch remounts the plugin.
 *
 * The ranges make the Host refuse a nonsensical save (a 0 ms timeout would
 * abort every verifier call) instead of storing it.
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    baseUrl: z<string, string, "volatile">;
    apiKey: z<string, string, "plain">;
    model: z<string, string, "volatile">;
    verifier: z<string, string, "volatile">;
    timeoutMs: z<number, number, "volatile">;
    maxConcurrency: z<number, number, "volatile">;
    deepseek: z<boolean, boolean, "plain">;
    prefill: z<boolean, boolean, "plain">;
    autoDegrade: z<boolean, boolean, "volatile-defined">;
    compare: z<boolean, boolean, "defined">;
    select: z<boolean, boolean, "defined">;
    track: z<boolean, boolean, "defined">;
    boN: z<boolean, boolean, "volatile-defined">;
    boNCandidates: z<number, number, "volatile-defined">;
    samplingTemperature: z<number, number, "volatile-defined">;
    samplingMode: z<string, string, "volatile-defined">;
    timeoutMsBoN: z<number, number, "volatile-defined">;
    verifyTimeoutMsBoN: z<number, number, "volatile-defined">;
    showFooter: z<boolean, boolean, "volatile-defined">;
    criteria: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    boNPivots: z<number, number, "volatile-defined">;
    boNSeed: z<number, number, "volatile-defined">;
    boNModelMix: z<NoInfer<(string | ({
        provider?: string | null | undefined;
        model?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict))[]>, NoInfer<(string | Schemastery.ObjectT<NoInfer<{
        provider: z<string, string, "plain">;
        model: z<string, string, "plain">;
    }>>)[]>, "volatile-defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    baseUrl: z<string, string, "volatile">;
    apiKey: z<string, string, "plain">;
    model: z<string, string, "volatile">;
    verifier: z<string, string, "volatile">;
    timeoutMs: z<number, number, "volatile">;
    maxConcurrency: z<number, number, "volatile">;
    deepseek: z<boolean, boolean, "plain">;
    prefill: z<boolean, boolean, "plain">;
    autoDegrade: z<boolean, boolean, "volatile-defined">;
    compare: z<boolean, boolean, "defined">;
    select: z<boolean, boolean, "defined">;
    track: z<boolean, boolean, "defined">;
    boN: z<boolean, boolean, "volatile-defined">;
    boNCandidates: z<number, number, "volatile-defined">;
    samplingTemperature: z<number, number, "volatile-defined">;
    samplingMode: z<string, string, "volatile-defined">;
    timeoutMsBoN: z<number, number, "volatile-defined">;
    verifyTimeoutMsBoN: z<number, number, "volatile-defined">;
    showFooter: z<boolean, boolean, "volatile-defined">;
    criteria: z<NoInfer<string[]>, NoInfer<string[]>, "volatile-defined">;
    boNPivots: z<number, number, "volatile-defined">;
    boNSeed: z<number, number, "volatile-defined">;
    boNModelMix: z<NoInfer<(string | ({
        provider?: string | null | undefined;
        model?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict))[]>, NoInfer<(string | Schemastery.ObjectT<NoInfer<{
        provider: z<string, string, "plain">;
        model: z<string, string, "plain">;
    }>>)[]>, "volatile-defined">;
}>>, "plain">;
/**
 * The plain config values as of now. A Loader-parsed config holds volatile
 * fields as `{ get() }` references; a config built by hand (tests, embedders)
 * holds plain values. Both read the same.
 */
/**
 * The config as the Loader hands it to `apply`: every volatile field is a
 * `{ get() }` reference. Typed apart from {@link Config} so that using a
 * volatile field without {@link currentConfig} fails to compile wherever a
 * plain value is expected.
 */
export type LiveConfig = ReturnType<typeof Config>;
export declare function currentConfig(config: LiveConfig | Config): Config;
/**
 * Normalize one model-mix value to the runtime entry shape (`string` or
 * `{ provider, model }`). A plugin-config value may be an object or a string.
 * A legacy `omni-chat/agnes/agnes-2.5-flash` string whose head is a REAL
 * provider name is split into `{ provider, model }`; anything else stays a
 * full model id (inherits the conversation provider).
 */
export declare function normalizeMixEntry(entry: ModelMixEntry | string, knownProviders: ReadonlySet<string>): string | {
    provider?: string;
    model: string;
};
/**
 * Resolve a session provider's endpoint configuration from the adapter that
 * owns that route.
 *
 * The adapter publishes the mapping itself: `listConfigurableProviders()` gives
 * each route a `settingsNs` (the owning Loader entry's id) and a `settingsPath`
 * into that entry's config -- `["providers", "<route>"]` for a multi-route
 * adapter, `[]` when the whole config is one route's profile. Following it means
 * this never guesses a key or an id, which is what the two previous versions
 * both got wrong: a route named `omni-chat` was never in a namespace called
 * `llm-omni-chat`, and `deepseek-official` lives in an entry called
 * `llm-deepseek`.
 *
 * Returns `{}` when the route is unknown or unconfigured -- the caller falls
 * back to its env chain.
 */
export declare function sessionProviderEndpoint(ctx: Context, provider: string): {
    baseUrl?: string;
    apiKeyEnv?: string;
};
/**
 * Resolve the verifier backend connection from dsh's configured provider
 * state. Default (no explicit config, no `verifier` route and no
 * three-part endpoint): the verifier FOLLOWS THE SESSION — same provider
 * route, endpoint and model as the conversation, so a user who only turns on
 * Best-of-N gets the zero-config self-verification experience (generate N
 * variants and grade them all with the conversation's own model).
 *
 * Resolution order:
 *  1. `config.verifier` route — a `provider/model` string like the Model mix
 *     entries: endpoint + key env are read from that provider's Loader entry
 *     config; a bare model id rides the session provider.
 *  2. three-part endpoint: config.baseUrl/apiKey/model → session provider
 *     endpoint → env chain.
 *  3. model falls back to the conversation's own model (any provider route).
 */
export declare function resolveBackend(ctx: Context, config: Config, conversation?: GenerateOptions): Promise<VerifierBackend>;
/** The Bo-N mode decision for one conversation request. */
export interface BoNModeDecision {
    readonly enabled: boolean;
    readonly nCandidates: number;
    readonly source: 'config-default' | 'off';
}
/**
 * The Bo-N mode decision, evaluated per turn (hot).
 *
 * Since dsh 0.1.7 the plugin Config is the only settings layer, so this is one
 * switch: `config.boN: true` turns the mode on for EVERY conversation at
 * `config.boNCandidates`, anything else is off.
 */
export declare function resolveBoNMode(config: Config): BoNModeDecision;
/** The `ctx.verifierPro` service (service face). Unique name: the original
 * `verifier` service is already registered by @aispin/plugin-verifier — both
 * plugins coexist in one profile. */
export declare class VerifierService extends Service {
    private readonly config;
    private backend;
    constructor(ctx: Context, config: LiveConfig | Config);
    private backendFor;
    /** Rank N candidates best-first with the PPT. */
    verify(options: {
        task: string;
        candidates: readonly string[];
        criteria?: Record<string, string>;
        pivots?: number;
        seed?: number;
        nEvaluations?: number;
    }): Promise<{
        bestIndex: number;
        ranking: {
            index: number;
            score: number;
            normalized: number;
        }[];
        callsSpent: number;
    }>;
    /** Fine-grained rewards for one directed comparison. */
    compare(problem: string, traceA: string, traceB: string, criteriaInput: Record<string, string>, opts?: CompareOptions): Promise<{
        scoreA: number;
        scoreB: number;
        criteria: string[];
        usage: TokenUsageSnapshot;
    }>;
    /** PPT best-of-N selection (tool face parity). */
    select(problem: string, candidates: string[], criteriaInput: Record<string, string>, opts?: SelectOptions): Promise<{
        index: number;
        best: string;
        scores: number[];
        ranking: number[];
        nComparisons: number;
        criteria: string[];
        usage: TokenUsageSnapshot;
    }>;
    /** Per-step progress tracking. */
    track(problem: string, steps: string[], opts?: TrackOptions): Promise<{
        steps: number[];
        scores: number[];
        perRep: Array<Array<number | null>>;
        final: number;
        usage: TokenUsageSnapshot;
    }>;
}
export declare function apply(ctx: Context, config: LiveConfig | Config): void;
declare module '@deepseek-ai/cordis' {
    interface Context {
        verifierPro: VerifierService;
    }
}
//# sourceMappingURL=index.d.ts.map