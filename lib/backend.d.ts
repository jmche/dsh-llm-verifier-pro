/**
 * Verifier backend: any OpenAI-compatible server that returns token-level
 * logprobs (vLLM, SGLang, OpenAI, DeepSeek). Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * Credentials resolve in order: explicit config, `OPENAI_BASE_URL` +
 * `OPENAI_API_KEY`, then `DEEPSEEK_API_KEY` (which implies the DeepSeek
 * endpoint with thinking enabled). Token usage is accumulated per backend.
 *
 * @module dsh-llm-as-a-verifier/backend
 */
import type { VerifierOutput } from './scoring.js';
/** No verifier backend could be configured. */
export declare class MissingAPIKeyError extends Error {
    constructor(message: string);
}
/** A verifier backend call failed (HTTP error, timeout, or malformed reply). */
export declare class VerifierError extends Error {
    readonly status?: number | undefined;
    readonly cause?: unknown | undefined;
    constructor(message: string, status?: number | undefined, cause?: unknown | undefined);
}
export interface TokenUsageSnapshot {
    calls: number;
    inputTokens: number;
    cachedInputTokens: number;
    uncachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheHitRate: number;
}
/** Thread-safe (single-threaded) running total of verifier token usage. */
export declare class TokenUsage {
    private calls;
    private inputTokens;
    private cachedInputTokens;
    private outputTokens;
    private reasoningTokens;
    reset(): void;
    add(inputTokens?: number, cachedInputTokens?: number, outputTokens?: number, reasoningTokens?: number, calls?: number): void;
    /** Record one backend response's usage; a no-op when no usage block is present. */
    record(response: Record<string, unknown>): void;
    snapshot(): TokenUsageSnapshot;
}
export interface BackendConfig {
    /** Verifier model name. Defaults to `deepseek-v4-flash` on DeepSeek; otherwise resolved from the server's /models. */
    model?: string;
    /** OpenAI-compatible base URL (e.g. `http://localhost:8000/v1` or `https://api.deepseek.com`). */
    baseUrl?: string;
    /** API key. Falls back to `OPENAI_API_KEY`, then `DEEPSEEK_API_KEY`. */
    apiKey?: string;
    /** Per-request timeout in milliseconds. Defaults to 60000. */
    timeoutMs?: number;
    /** Maximum in-flight verifier calls. Defaults to 8. */
    maxConcurrency?: number;
    /** Force the DeepSeek call path (thinking enabled, large output budget). Auto-detected from the base URL. */
    deepseek?: boolean;
    /** Run the vLLM/SGLang prefill pass for score tags on non-DeepSeek servers. Defaults to true. */
    prefill?: boolean;
    /**
     * When the endpoint returns no token-level logprobs: `true` (default) falls
     * back to sampling-style (point-mass) scoring; `false` is strict mode and
     * raises instead of silently downgrading the method's granularity.
     */
    autoDegrade?: boolean;
}
export interface ResolvedBackendConfig {
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    timeoutMs: number;
    maxConcurrency: number;
    deepseek: boolean;
    prefill: boolean;
    autoDegrade: boolean;
}
export interface ChatOptions {
    model?: string;
    signal?: AbortSignal;
}
export declare class VerifierBackend {
    readonly config: ResolvedBackendConfig;
    readonly usage: TokenUsage;
    private resolvedModel;
    /**
     * How the last main verifier request was graded: `'logprob'` when the
     * endpoint supplied token-level logprobs, `'sampling'` after a fallback to
     * point-mass (sampling-style) scoring, `undefined` before any main request
     * has been parsed.
     */
    lastGradingMode: 'logprob' | 'sampling' | undefined;
    private prefillFailureNoticed;
    constructor(config?: BackendConfig);
    /** Merge explicit config with the process environment (upstream `create_client` order). */
    static resolveConfig(config: BackendConfig): ResolvedBackendConfig;
    static fromEnvironment(config?: BackendConfig): VerifierBackend;
    private deepseekParams;
    private resolveModel;
    private post;
    private parse;
    private prefillTags;
    /**
     * Run one verifier call and return its text plus token-level logprobs.
     * On non-DeepSeek servers, score tags present in the prompt trigger the
     * prefill pass so the letter distribution is read at the exact tag
     * position.
     */
    chat(prompt: string, opts?: ChatOptions): Promise<VerifierOutput>;
    /**
     * Run the workers with at most `maxConcurrency` in flight. The first
     * failure rejects the returned promise; the rest run to completion.
     */
    runAll<T>(workers: Array<() => Promise<T>>): Promise<T[]>;
}
//# sourceMappingURL=backend.d.ts.map