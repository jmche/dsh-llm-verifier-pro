/**
 * Probabilistic Pivot Tournament (PPT): O(Nk) best-of-N selection.
 * Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * Instead of a full O(N^2) round-robin, PPT selects the best candidate in
 * three steps:
 *
 *   1) Ring pass: score the N adjacent directed pairs of a random
 *      Hamiltonian cycle. Every candidate appears once in each prompt slot,
 *      so the verifier's slot bias cancels around the ring.
 *   2) Pivot selection: the top-k candidates by ring-pass mean preference
 *      w_i / c_i become the pivot set P.
 *   3) Pivot rounds: score every non-pivot-vs-pivot and pivot-vs-pivot pair,
 *      aggregate all comparisons into w_i, c_i, and return argmax_i w_i / c_i.
 *
 * Total comparisons: N + k(N - k) + C(k, 2) — linear in N for fixed k.
 *
 * Each comparison's rewards (R_a, R_b) become a soft win via Bradley-Terry,
 * p(a beats b) = sigmoid(R_a - R_b). The caller supplies a directed
 * `score(a, b) -> (R_a, R_b)` with `a` in slot A and `b` in slot B.
 *
 * @module dsh-llm-as-a-verifier/tournament
 */
export declare const DEFAULT_PIVOTS = 2;
/** A seeded PRNG (mulberry32) so a tournament with a fixed seed is reproducible. */
export declare function createRng(seed: number): () => number;
/**
 * The N directed adjacent pairs of a random Hamiltonian cycle over `n`
 * candidates.
 */
export declare function ringCycle(n: number, rng: () => number): Array<[number, number]>;
/** p(a beats b) under the Bradley-Terry model on rewards in [0, 1]. */
export declare function bradleyTerry(ra: number, rb: number): number;
/** Directed score function: rewards (R_a, R_b) with `a` in slot A, `b` in slot B. */
export type DirectedScore = (a: number, b: number) => [number, number];
/** Score each directed pair and aggregate soft wins into w, c in place. */
export declare function accumulate(pairs: Array<[number, number]>, score: DirectedScore, w: number[], c: number[]): void;
/** Top-k candidates by mean preference w_i / c_i (ties broken by index). */
export declare function selectPivots(w: number[], c: number[], k: number): number[];
/**
 * Directed pairs for step 3: every non-pivot vs pivot, plus pivot vs pivot.
 * Non-pivots take slot A; within P the lower index takes slot A.
 */
export declare function pivotRoundPairs(n: number, pivots: number[]): Array<[number, number]>;
export interface SelectBestResult {
    /** Index of the winning candidate. */
    best: number;
    /** Per-candidate mean preference w_i / c_i from the tournament. */
    scores: number[];
    /** Number of directed verifier comparisons that were run. */
    nComparisons: number;
}
/**
 * Run the full PPT given a directed `score(a, b) -> (R_a, R_b)` and a seed
 * for the random ring pass.
 */
export declare function selectBest(n: number, k: number, score: DirectedScore, seed: number): SelectBestResult;
//# sourceMappingURL=tournament.d.ts.map