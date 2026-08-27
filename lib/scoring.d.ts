/**
 * Fine-grained reward scoring, ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * Instead of collapsing the verifier's judgement into one discrete label, we
 * read its probability distribution over an ordered set of score tokens and
 * take the expectation:
 *
 *     R(t, tau) = (1 / C K) sum_c sum_k sum_g p_theta(v_g | t, c, tau) * phi(v_g)
 *
 * with C criteria, K repeated verifications, and G score tokens (granularity);
 * phi maps each score token to its scalar value.
 *
 * @module dsh-llm-as-a-verifier/scoring
 */
/** Number of score tokens on the letter scale (A..T). */
export declare const GRANULARITY = 20;
/** One evaluation criterion: an id (score-cache key), a display name, and the instruction. */
export interface Criterion {
    id: string;
    name: string;
    description: string;
}
/**
 * The granularity-20 rating scale: A = clearly succeeded (best) down to
 * T = clearly failed (worst). Uppercase and lowercase letters are both
 * accepted because some tokenizers emit the letter differently.
 */
export declare const SCALE: {
    scale_description: string;
    score_format: string;
    valid_tokens: Record<string, number>;
};
/** One token alternative from a logprobs response. */
export interface LogprobToken {
    token: string;
    logprob: number;
}
/** A token stream plus per-position top-logprob alternatives. */
export interface VerifierOutput {
    text: string;
    tokens?: string[];
    positionLogprobs?: LogprobToken[][];
}
/** Accepted criteria input shapes. */
export type CriteriaInput = Record<string, string> | Array<string | {
    id?: string;
    name?: string;
    description?: string;
}>;
/**
 * Normalize any accepted criteria form into criterion dicts with unique ids.
 *
 * @param input - a `{name: description}` mapping, or a list of strings or
 *   `{id, name, description}` objects.
 */
export declare function normalizeCriteria(input: CriteriaInput): Criterion[];
/**
 * Expected score over the verifier's token distribution at `tag`, normalized
 * to [0, 1]. Falls back to parsing the literal text token; unreadable scores
 * default to 0.5.
 */
export declare function extractScore(text: string, tokens: string[] | undefined, positionLogprobs: LogprobToken[][] | undefined, tag: string): number;
/**
 * One pairwise prompt focused on a single evaluation criterion. Everything
 * not specific to the criterion (task, both trajectories, rating scale)
 * comes first; only the criterion varies at the tail. This maximizes the
 * shared prompt prefix across criteria, so a prefix-caching backend serves
 * the trace-heavy body from cache.
 */
export declare function buildPairwisePrompt(problem: string, traceA: string, traceB: string, criterion: Criterion, groundTruthNote: string): string;
//# sourceMappingURL=scoring.d.ts.map