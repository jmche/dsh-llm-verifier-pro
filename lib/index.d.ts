/**
 * dsh-llm-verifier-pro: LLM-as-a-Verifier for DeepSeek Harness (unified).
 *
 * Merges the engineering of dsh-llm-as-a-verifier (TaurenMountain, MIT) —
 * fine-grained logprob scoring, Probabilistic Pivot Tournament, vLLM/SGLang
 * prefill, concurrency + timeout + token accounting — with the Best-of-N
 * conversation mode and Web settings panel of @aispin/plugin-verifier
 * (Aispin, MIT). Method by the LLM-as-a-Verifier paper (arXiv:2607.05391).
 *
 * Three faces:
 *  1. Tools — `verify_compare` / `verify_select` / `verify_track` (agent calls
 *     them on demand for fine-grained probabilistic feedback).
 *  2. Service — `ctx.verifierPro.verify/compare/select/track` for code consumers.
 *  3. Mode — Best-of-N conversation mode: every assistant turn of a Bo-N
 *     session is sampled N ways and only the winning response replayed.
 *     Three-state gating: settings global (Web UI switch) → session preset →
 *     config default → off.
 *
 * Verifier credentials resolve zero-config from the dsh provider state:
 * plugin config (baseUrl/apiKey/model) → the `verifier` settings namespace →
 * the credentials seam (`credential:<name>` or the ambient key env) →
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
    /** OpenAI-compatible base URL. Empty (default) resolves: settings section → OPENAI_BASE_URL → DEEPSEEK_API_KEY implies api.deepseek.com. */
    baseUrl?: string;
    /** API key. Supports `credential:<name>` (dsh credentials seam), `env:VAR`, or a plain value. Empty → settings section → seam/ambient env. */
    apiKey?: string;
    /** Verifier model. Empty → settings section → the conversation's model (DeepSeek routes only) → deepseek-v4-flash, or /models on non-DeepSeek endpoints. */
    model?: string;
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
    /** Settings namespace whose section supplies baseUrl/apiKey/model — and the Bo-N global switch. */
    settingsNs?: string;
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
     *
     * Configurable in the Web settings panel (verifier-pro section) too.
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
export declare const Config: z<Config>;
/** The settings section shape this plugin reads (and the Web UI panel writes). */
export interface VerifierSettingsSection {
    baseURL?: string;
    apiKey?: string;
    model?: string;
    /** Bo-N global switch. */
    boN?: boolean;
    /** Global-tier candidates override. */
    boNCandidates?: number;
    /** Rollout schedule: 'serial' to collect one-at-a-time; 'parallel' otherwise. */
    samplingMode?: string;
    /** Strict-mode switch: false = raise on endpoints without logprobs. */
    autoDegrade?: boolean;
    /** Verify-phase wall-clock budget in ms. */
    verifyTimeoutMs?: number;
    /** Extra grading criteria for Bo-N comparison prompts. */
    criteria?: string[];
    /** Best-of-N model mix (full model ids or explicit provider/model routes). */
    boNModelMix?: Array<ModelMixEntry>;
}
/** A hot reader of the resolved settings section (re-read per call/turn). */
export type SettingsSectionReader = () => VerifierSettingsSection;
/**
 * Normalize one model-mix value to the runtime entry shape (`string` or
 * `{ provider, model }`). Values may arrive from three places with three
 * dialects:
 *   - plugin config (object or string; exact),
 *   - the settings document (object, string, or legacy `provider/model` text),
 *   - the Web panel (parsed already).
 * A legacy `omni-chat/agnes/agnes-2.5-flash` string whose head is a REAL
 * provider name is split into `{ provider, model }`; anything else stays a
 * full model id (inherits the conversation provider).
 */
export declare function normalizeMixEntry(entry: ModelMixEntry | string, knownProviders: ReadonlySet<string>): string | {
    provider?: string;
    model: string;
};
/**
 * Register the verifier settings namespace and return a hot reader.
 * The settings seam is optional (delegate-and-degrade): without it the reader
 * yields the empty section and explicit plugin config carries everything.
 */
export declare function sectionReaderOf(ctx: Context, config: Config): SettingsSectionReader;
/**
 * Resolve the verifier backend connection from dsh's configured provider
 * state, with plugin-config overrides taking precedence, then the settings
 * section, then the environment:
 *
 *  - base URL: config.baseUrl → section.baseURL → OPENAI_BASE_URL →
 *    DEEPSEEK_API_KEY implies api.deepseek.com.
 *  - API key: config.apiKey (credential:/env:/plain) → section.apiKey →
 *    credentials seam (apiKeyEnv) → ambient environment.
 *  - model: config.model → section.model → the conversation's model on
 *    DeepSeek routes → deepseek-v4-flash (DeepSeek) / server /models (other).
 */
export declare function resolveBackend(ctx: Context, config: Config, conversation?: GenerateOptions, sectionReader?: SettingsSectionReader): Promise<VerifierBackend>;
/** The Bo-N mode decision for one conversation request. */
export interface BoNModeDecision {
    readonly enabled: boolean;
    readonly nCandidates: number;
    readonly source: 'settings-global' | 'config-default' | 'off';
}
/**
 * The Bo-N mode decision, evaluated per turn (hot): settings global →
 * config default → off.
 *
 * The panel's explicit switch is the whole story: `boN: true` turns the mode
 * on for EVERY conversation at the section's candidate count, and an explicit
 * `boN: false` is the master kill-switch that also overrides the config
 * default. Only an unset section falls through to the deployment default
 * (`config.boN`).
 */
export declare function resolveBoNMode(config: Config, sectionReader?: SettingsSectionReader): BoNModeDecision;
/** The `ctx.verifierPro` service (service face). Unique name: the original
 * `verifier` service is already registered by @aispin/plugin-verifier — both
 * plugins coexist in one profile. */
export declare class VerifierService extends Service {
    private readonly config;
    private readonly sectionReader;
    private backend;
    constructor(ctx: Context, config: Config, sectionReader?: SettingsSectionReader);
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
export declare function apply(ctx: Context, config: Config): void;
declare module '@deepseek-ai/cordis' {
    interface Context {
        verifierPro: VerifierService;
    }
}
//# sourceMappingURL=index.d.ts.map