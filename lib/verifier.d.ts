/**
 * The verifier orchestration: `compare` (raw pairwise fine-grained rewards),
 * `select` (Probabilistic Pivot Tournament best-of-N), and `track`
 * (per-step progress). Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * @module dsh-llm-as-a-verifier/verifier
 */
import { VerifierBackend, type BackendConfig, type TokenUsageSnapshot } from './backend.js';
import { type CriteriaInput } from './scoring.js';
export interface CompareOptions {
    /** Repeated verifications K per criterion. Defaults to 1. */
    nEvaluations?: number;
    /** Caller cancellation forwarded to every verifier request. */
    signal?: AbortSignal;
    /** Verifier model override for this call. */
    model?: string;
    /** Note the verifier always sees (e.g. the reference patch location). */
    groundTruthNote?: string;
}
export interface CompareResult {
    /** Fine-grained reward of trace A in [0, 1]. */
    scoreA: number;
    /** Fine-grained reward of trace B in [0, 1]. */
    scoreB: number;
    criteria: string[];
    usage: TokenUsageSnapshot;
}
export interface SelectOptions {
    /** Repeated verifications K per criterion. Defaults to 4. */
    nEvaluations?: number;
    /** Number of pivots k. Cost grows as O(Nk). Defaults to 2. */
    pivots?: number;
    /** Seed for the random ring pass. Defaults to 0. */
    seed?: number;
    /** Verifier model override. */
    model?: string;
    /** Note the verifier always sees. */
    groundTruthNote?: string;
    /** "tie" scores a failed verifier call 0.5/0.5; "raise" re-raises. Defaults to "tie". */
    onError?: 'tie' | 'raise';
    /** Caller cancellation forwarded to every verifier request. */
    signal?: AbortSignal;
}
export interface SelectResult {
    /** Index of the winning candidate in the input list. */
    index: number;
    /** The winning candidate itself. */
    best: string;
    /** Per-candidate mean preference w_i / c_i from the tournament. */
    scores: number[];
    /** Candidate indices sorted best-first. */
    ranking: number[];
    /** Number of directed verifier comparisons run. */
    nComparisons: number;
    criteria: string[];
    usage: TokenUsageSnapshot;
}
export interface TrackOptions {
    /** 1-indexed step numbers to score. Defaults to the interior steps 2..T-1. */
    checkpoints?: number[];
    /** Independent repeats K; the curve is their mean. Defaults to 1. */
    nEvaluations?: number;
    /** Verifier model override. */
    model?: string;
    /** Caller cancellation forwarded to every verifier request. */
    signal?: AbortSignal;
}
export interface TrackResult {
    /** 1-indexed agent-step numbers that were scored as checkpoints. */
    steps: number[];
    /** Progress score in [0, 1] after each checkpoint step. */
    scores: number[];
    /** Raw per-repeat curves (nEvaluations x len(steps)); null = unreadable. */
    perRep: Array<Array<number | null>>;
    /** Progress score at the last checkpoint. */
    final: number;
    usage: TokenUsageSnapshot;
}
export declare class Verifier {
    readonly backend: VerifierBackend;
    constructor(config?: BackendConfig);
    /** Score (A, B) for a single criterion: fine-grained rewards (R_A, R_B) in [0, 1]. */
    private scorePairCriterion;
    /**
     * Fine-grained rewards (R_A, R_B) in [0, 1] for one directed comparison,
     * averaged over all criteria and `nEvaluations` repeats. `trace_a` stays
     * in slot A — a single directed call does not cancel slot bias the way
     * `select`'s ring pass does.
     */
    compare(problem: string, traceA: string, traceB: string, criteriaInput: CriteriaInput, opts?: CompareOptions): Promise<CompareResult>;
    /**
     * Select the best of N candidates with a Probabilistic Pivot Tournament —
     * O(Nk) verifier comparisons instead of a full O(N^2) round-robin.
     * Identical inputs with the same `seed` run the identical tournament.
     */
    select(problem: string, candidates: string[], criteriaInput: CriteriaInput, opts?: SelectOptions): Promise<SelectResult>;
    /**
     * Score an agent trajectory's progress after each checkpoint step. One
     * verifier call scores every checkpoint (repeated `nEvaluations` times and
     * averaged), so cost is O(K) calls regardless of trajectory length.
     */
    track(problem: string, steps: string[], opts?: TrackOptions): Promise<TrackResult>;
}
//# sourceMappingURL=verifier.d.ts.map