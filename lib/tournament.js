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
export const DEFAULT_PIVOTS = 2;
/** A seeded PRNG (mulberry32) so a tournament with a fixed seed is reproducible. */
export function createRng(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
/**
 * The N directed adjacent pairs of a random Hamiltonian cycle over `n`
 * candidates.
 */
export function ringCycle(n, rng) {
    if (n <= 1)
        return [];
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    return Array.from({ length: n }, (_, t) => [perm[t], perm[(t + 1) % n]]);
}
/** p(a beats b) under the Bradley-Terry model on rewards in [0, 1]. */
export function bradleyTerry(ra, rb) {
    return 1.0 / (1.0 + Math.exp(-(ra - rb)));
}
/** Score each directed pair and aggregate soft wins into w, c in place. */
export function accumulate(pairs, score, w, c) {
    for (const [a, b] of pairs) {
        const [ra, rb] = score(a, b);
        const p = bradleyTerry(ra, rb);
        w[a] += p;
        c[a] += 1;
        w[b] += 1.0 - p;
        c[b] += 1;
    }
}
/** Top-k candidates by mean preference w_i / c_i (ties broken by index). */
export function selectPivots(w, c, k) {
    const n = w.length;
    k = Math.min(k, n);
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
        const prefA = c[a] ? w[a] / c[a] : 0;
        const prefB = c[b] ? w[b] / c[b] : 0;
        return prefB - prefA || a - b;
    });
    return order.slice(0, k);
}
/**
 * Directed pairs for step 3: every non-pivot vs pivot, plus pivot vs pivot.
 * Non-pivots take slot A; within P the lower index takes slot A.
 */
export function pivotRoundPairs(n, pivots) {
    const pivotSet = new Set(pivots);
    const nonPivots = Array.from({ length: n }, (_, i) => i).filter((i) => !pivotSet.has(i));
    const pairs = [];
    for (const i of nonPivots)
        for (const p of pivots)
            pairs.push([i, p]);
    const sorted = [...pivots].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++)
            pairs.push([sorted[i], sorted[j]]);
    }
    return pairs;
}
/**
 * Run the full PPT given a directed `score(a, b) -> (R_a, R_b)` and a seed
 * for the random ring pass.
 */
export function selectBest(n, k, score, seed) {
    if (n <= 0)
        throw new Error('need at least one candidate');
    if (n === 1)
        return { best: 0, scores: [1], nComparisons: 0 };
    const ring = ringCycle(n, createRng(seed));
    // Step 1: ring pass; step 2: pivots = empirical leaders from the ring pass.
    const w = new Array(n).fill(0);
    const c = new Array(n).fill(0);
    accumulate(ring, score, w, c);
    const pivots = selectPivots(w, c, k);
    // Step 3: pivot rounds, aggregated into a fresh w, c together with the ring.
    const prPairs = pivotRoundPairs(n, pivots);
    const wFinal = new Array(n).fill(0);
    const cFinal = new Array(n).fill(0);
    accumulate(ring, score, wFinal, cFinal);
    accumulate(prPairs, score, wFinal, cFinal);
    let best = 0;
    let bestPref = -Infinity;
    const scores = new Array(n);
    for (let i = 0; i < n; i++) {
        const pref = cFinal[i] ? wFinal[i] / cFinal[i] : 0;
        scores[i] = pref;
        if (pref > bestPref) {
            bestPref = pref;
            best = i;
        }
    }
    return { best, scores, nComparisons: ring.length + prPairs.length };
}
//# sourceMappingURL=tournament.js.map