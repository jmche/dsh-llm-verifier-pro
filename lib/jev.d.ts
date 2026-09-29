/**
 * The Jev selector: pairwise fine-grained rewards served by a System One
 * endpoint (TypeSafe's Jev) instead of an OpenAI-compatible chat model.
 *
 * Jev does not generate text. One request carries a `state` and typed
 * `questions`; a Score question returns a probability for every level of an
 * ordered rubric. A directed comparison asks one Score per slot (A and B)
 * against the same state, and the reward is the expectation over the levels,
 * normalized to [0, 1] — the same range and orientation as the LLM path's
 * logprob expectation, so the tournament, the Bradley-Terry aggregation and
 * the slot-swap bookkeeping are unchanged.
 *
 * Protocol: https://docs.typesafe.ai/api.md
 *
 * @module dsh-llm-verifier-pro/jev
 */
import { TokenUsage } from './backend.js';
/** TypeSafe's own endpoint and flagship model alias. */
export declare const DEFAULT_JEV_BASE_URL = "https://api.typesafe.ai/v1";
export declare const DEFAULT_JEV_MODEL = "jev-latest";
/** Ordered Score levels, worst first: the level index is the reward numerator. */
export declare const JEV_LEVELS: readonly string[];
export interface JevConfig {
    /** Provider base URL (`…/v1`) or the full `…/systemone` endpoint. Defaults to TypeSafe's. */
    baseUrl?: string;
    /** System One model id. Defaults to `jev-latest`. */
    model?: string;
    /** Bearer key. Empty sends no Authorization header (e.g. a keyless free tier). */
    apiKey?: string;
    /** Per-request timeout in milliseconds. Defaults to 60000. */
    timeoutMs?: number;
    /** Maximum in-flight Jev requests. Defaults to 8. */
    maxConcurrency?: number;
}
/** The criterion slice a comparison needs (both scoring.Criterion and a Bo-N criterion string fit). */
export interface JevCriterion {
    name: string;
    description: string;
}
/** The System One endpoint for a configured base: `<base>/systemone`, or the base itself when it already is one. */
export declare function systemOneEndpoint(baseUrl: string): string;
/** Expected level of one Score answer, normalized to [0, 1]. */
export declare function scoreReward(answer: unknown, levels: number): number;
export declare class JevBackend {
    readonly config: {
        endpoint: string;
        model: string;
        apiKey?: string;
        timeoutMs: number;
        maxConcurrency: number;
    };
    readonly usage: TokenUsage;
    constructor(config?: JevConfig);
    /** POST one System One request; 429/529 are retried with backoff as the provider documents. */
    private post;
    /**
     * Fine-grained rewards (R_A, R_B) in [0, 1] for one directed comparison
     * under one criterion. `traceA` is the response in slot A.
     */
    scorePair(task: string, traceA: string, traceB: string, criterion: JevCriterion, groundTruthNote?: string, signal?: AbortSignal): Promise<[number, number]>;
    /** Run the workers with at most `maxConcurrency` in flight (same contract as VerifierBackend.runAll). */
    runAll<T>(workers: Array<() => Promise<T>>): Promise<T[]>;
}
//# sourceMappingURL=jev.d.ts.map