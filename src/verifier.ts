/**
 * The verifier orchestration: `compare` (raw pairwise fine-grained rewards),
 * `select` (Probabilistic Pivot Tournament best-of-N), and `track`
 * (per-step progress). Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * @module dsh-llm-as-a-verifier/verifier
 */

import { VerifierBackend, type BackendConfig, type TokenUsageSnapshot } from './backend.js'
import {
  buildPairwisePrompt,
  extractScore,
  normalizeCriteria,
  type CriteriaInput,
  type Criterion,
} from './scoring.js'
import { DEFAULT_PIVOTS, accumulate, pivotRoundPairs, ringCycle, selectPivots, createRng } from './tournament.js'
import {
  buildProgressPrompt,
  defaultCheckpoints,
  extractProgressScores,
  formatSteps,
  meanScores,
  validateCheckpoints,
} from './progress.js'

export interface CompareOptions {
  /** Repeated verifications K per criterion. Defaults to 1. */
  nEvaluations?: number
  /** Caller cancellation forwarded to every verifier request. */
  signal?: AbortSignal
  /** Verifier model override for this call. */
  model?: string
  /** Note the verifier always sees (e.g. the reference patch location). */
  groundTruthNote?: string
}

export interface CompareResult {
  /** Fine-grained reward of trace A in [0, 1]. */
  scoreA: number
  /** Fine-grained reward of trace B in [0, 1]. */
  scoreB: number
  criteria: string[]
  usage: TokenUsageSnapshot
}

export interface SelectOptions {
  /** Repeated verifications K per criterion. Defaults to 4. */
  nEvaluations?: number
  /** Number of pivots k. Cost grows as O(Nk). Defaults to 2. */
  pivots?: number
  /** Seed for the random ring pass. Defaults to 0. */
  seed?: number
  /** Verifier model override. */
  model?: string
  /** Note the verifier always sees. */
  groundTruthNote?: string
  /** "tie" scores a failed verifier call 0.5/0.5; "raise" re-raises. Defaults to "tie". */
  onError?: 'tie' | 'raise'
  /** Caller cancellation forwarded to every verifier request. */
  signal?: AbortSignal
}

export interface SelectResult {
  /** Index of the winning candidate in the input list. */
  index: number
  /** The winning candidate itself. */
  best: string
  /** Per-candidate mean preference w_i / c_i from the tournament. */
  scores: number[]
  /** Candidate indices sorted best-first. */
  ranking: number[]
  /** Number of directed verifier comparisons run. */
  nComparisons: number
  criteria: string[]
  usage: TokenUsageSnapshot
}

export interface TrackOptions {
  /** 1-indexed step numbers to score. Defaults to the interior steps 2..T-1. */
  checkpoints?: number[]
  /** Independent repeats K; the curve is their mean. Defaults to 1. */
  nEvaluations?: number
  /** Verifier model override. */
  model?: string
  /** Caller cancellation forwarded to every verifier request. */
  signal?: AbortSignal
}

export interface TrackResult {
  /** 1-indexed agent-step numbers that were scored as checkpoints. */
  steps: number[]
  /** Progress score in [0, 1] after each checkpoint step. */
  scores: number[]
  /** Raw per-repeat curves (nEvaluations x len(steps)); null = unreadable. */
  perRep: Array<Array<number | null>>
  /** Progress score at the last checkpoint. */
  final: number
  usage: TokenUsageSnapshot
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('verification aborted')
  }
}

export class Verifier {
  readonly backend: VerifierBackend

  constructor(config: BackendConfig = {}) {
    this.backend = new VerifierBackend(config)
  }

  /** Score (A, B) for a single criterion: fine-grained rewards (R_A, R_B) in [0, 1]. */
  private async scorePairCriterion(
    problem: string,
    traceA: string,
    traceB: string,
    criterion: Criterion,
    groundTruthNote: string,
    model?: string,
    signal?: AbortSignal,
  ): Promise<[number, number]> {
    throwIfAborted(signal)
    const prompt = buildPairwisePrompt(problem, traceA, traceB, criterion, groundTruthNote)
    const out = await this.backend.chat(prompt, { ...(model ? { model } : {}), ...(signal ? { signal } : {}) })
    const ra = extractScore(out.text, out.tokens, out.positionLogprobs, '<score_A>')
    const rb = extractScore(out.text, out.tokens, out.positionLogprobs, '<score_B>')
    return [ra, rb]
  }

  /**
   * Fine-grained rewards (R_A, R_B) in [0, 1] for one directed comparison,
   * averaged over all criteria and `nEvaluations` repeats. `trace_a` stays
   * in slot A — a single directed call does not cancel slot bias the way
   * `select`'s ring pass does.
   */
  async compare(
    problem: string,
    traceA: string,
    traceB: string,
    criteriaInput: CriteriaInput,
    opts: CompareOptions = {},
  ): Promise<CompareResult> {
    const criteria = normalizeCriteria(criteriaInput)
    const nEvaluations = opts.nEvaluations ?? 1
    if (nEvaluations < 1) throw new Error('nEvaluations must be >= 1')
    const note = opts.groundTruthNote ?? ''
    const jobs = criteria.flatMap((criterion) =>
      Array.from({ length: nEvaluations }, () => criterion),
    )
    const results = await this.backend.runAll(
      jobs.map((criterion) => () =>
        this.scorePairCriterion(problem, traceA, traceB, criterion, note, opts.model, opts.signal),
      ),
    )
    const scoreA = results.reduce((sum, [ra]) => sum + ra, 0) / results.length
    const scoreB = results.reduce((sum, [, rb]) => sum + rb, 0) / results.length
    return {
      scoreA,
      scoreB,
      criteria: criteria.map((c) => c.id),
      usage: this.backend.usage.snapshot(),
    }
  }

  /**
   * Select the best of N candidates with a Probabilistic Pivot Tournament —
   * O(Nk) verifier comparisons instead of a full O(N^2) round-robin.
   * Identical inputs with the same `seed` run the identical tournament.
   */
  async select(
    problem: string,
    candidates: string[],
    criteriaInput: CriteriaInput,
    opts: SelectOptions = {},
  ): Promise<SelectResult> {
    const criteria = normalizeCriteria(criteriaInput)
    const criterionIds = criteria.map((c) => c.id)
    const nEvaluations = opts.nEvaluations ?? 4
    const pivots = opts.pivots ?? DEFAULT_PIVOTS
    const seed = opts.seed ?? 0
    const onError = opts.onError ?? 'tie'
    if (!['tie', 'raise'].includes(onError)) throw new Error(`onError must be 'tie' or 'raise', got ${onError}`)
    const note = opts.groundTruthNote ?? ''

    const n = candidates.length
    if (n === 0) throw new Error('need at least one candidate')
    if (n === 1) {
      return {
        index: 0,
        best: candidates[0]!,
        scores: [1],
        ranking: [0],
        nComparisons: 0,
        criteria: criterionIds,
        usage: this.backend.usage.snapshot(),
      }
    }

    // Directed comparisons are cached per (criterion, pair, rep); odd reps
    // swap the prompt slots and scores are recorded back in candidate order.
    const cache = new Map<string, { score_A: number; score_B: number }>()
    const cacheKey = (critId: string, a: number, b: number, rep: number) => `${critId}|${a},${b}|${rep}`

    const directedScore = (a: number, b: number): [number, number] => {
      let sa = 0
      let sb = 0
      let count = 0
      for (const criterion of criteria) {
        for (let rep = 0; rep < nEvaluations; rep++) {
          const entry = cache.get(cacheKey(criterion.id, a, b, rep))
          sa += entry?.score_A ?? 0.5
          sb += entry?.score_B ?? 0.5
          count++
        }
      }
      return count > 0 ? [sa / count, sb / count] : [0.5, 0.5]
    }

    const scorePairs = async (pairs: Array<[number, number]>): Promise<void> => {
      const jobs: Array<{
        key: string
        a: number
        b: number
        criterion: Criterion
        traceA: string
        traceB: string
        swap: boolean
      }> = []
      for (const [a, b] of pairs) {
        for (const criterion of criteria) {
          for (let rep = 0; rep < nEvaluations; rep++) {
            const key = cacheKey(criterion.id, a, b, rep)
            if (cache.has(key)) continue
            const swap = rep % 2 === 1
            jobs.push({
              key,
              a,
              b,
              criterion,
              traceA: swap ? candidates[b]! : candidates[a]!,
              traceB: swap ? candidates[a]! : candidates[b]!,
              swap,
            })
          }
        }
      }
      await this.backend.runAll(
        jobs.map((job) => async () => {
          try {
            let [ra, rb] = await this.scorePairCriterion(problem, job.traceA, job.traceB, job.criterion, note, opts.model, opts.signal)
            if (job.swap) [ra, rb] = [rb, ra] // scores back in candidate order
            cache.set(job.key, { score_A: ra, score_B: rb })
          } catch (error) {
            if (onError === 'raise') throw error
            cache.set(job.key, { score_A: 0.5, score_B: 0.5 })
          }
        }),
      )
    }

    // Phase A: ring pass (slot bias cancels around the cycle).
    const ring = ringCycle(n, createRng(seed))
    await scorePairs(ring)

    // Pivots = empirical leaders from the ring pass.
    const w: number[] = new Array(n).fill(0)
    const c: number[] = new Array(n).fill(0)
    accumulate(ring, directedScore, w, c)
    const pivotSet = selectPivots(w, c, pivots)

    // Phase B: score the pivot rounds, then aggregate everything.
    const prPairs = pivotRoundPairs(n, pivotSet)
    await scorePairs(prPairs)

    const wFinal: number[] = new Array(n).fill(0)
    const cFinal: number[] = new Array(n).fill(0)
    accumulate(ring, directedScore, wFinal, cFinal)
    accumulate(prPairs, directedScore, wFinal, cFinal)

    let best = 0
    let bestPref = -Infinity
    const scores = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      const pref = cFinal[i]! > 0 ? wFinal[i]! / cFinal[i]! : 0
      scores[i] = pref
      if (pref > bestPref) {
        bestPref = pref
        best = i
      }
    }
    const ranking = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b]! - scores[a]! || a - b)
    return {
      index: best,
      best: candidates[best]!,
      scores,
      ranking,
      nComparisons: ring.length + prPairs.length,
      criteria: criterionIds,
      usage: this.backend.usage.snapshot(),
    }
  }

  /**
   * Score an agent trajectory's progress after each checkpoint step. One
   * verifier call scores every checkpoint (repeated `nEvaluations` times and
   * averaged), so cost is O(K) calls regardless of trajectory length.
   */
  async track(problem: string, steps: string[], opts: TrackOptions = {}): Promise<TrackResult> {
    const total = steps.length
    if (total === 0) throw new Error('need at least one step')
    const checkpoints = validateCheckpoints(opts.checkpoints ?? defaultCheckpoints(total), total)
    const nEvaluations = opts.nEvaluations ?? 1
    if (nEvaluations < 1) throw new Error('nEvaluations must be >= 1')

    const prompt = buildProgressPrompt(problem, formatSteps(steps), total, checkpoints)
    const perRep = await this.backend.runAll(
      Array.from({ length: nEvaluations }, () => async () => {
        throwIfAborted(opts.signal)
        const out = await this.backend.chat(prompt, { ...(opts.model ? { model: opts.model } : {}), ...(opts.signal ? { signal: opts.signal } : {}) })
        return extractProgressScores(out.text, out.tokens, out.positionLogprobs, checkpoints.length)
      }),
    )
    const scores = meanScores(perRep)
    return {
      steps: checkpoints,
      scores,
      perRep,
      final: scores[scores.length - 1] ?? 0.5,
      usage: this.backend.usage.snapshot(),
    }
  }
}
