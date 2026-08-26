import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PIVOTS,
  accumulate,
  bradleyTerry,
  createRng,
  pivotRoundPairs,
  ringCycle,
  selectBest,
  selectPivots,
} from '../src/tournament'

describe('bradleyTerry', () => {
  it('computes the soft win probability p = sigmoid(Ra - Rb)', () => {
    const p = bradleyTerry(0.8, 0.2)
    expect(p).toBeCloseTo(1 / (1 + Math.exp(-0.6)), 12)
  })

  it('returns 0.5 for tied rewards', () => {
    expect(bradleyTerry(0.5, 0.5)).toBe(0.5)
    expect(bradleyTerry(0.9, 0.9)).toBe(0.5)
  })

  it('is antisymmetric: p(a,b) + p(b,a) = 1', () => {
    const p = bradleyTerry(0.7, 0.3)
    expect(p + bradleyTerry(0.3, 0.7)).toBeCloseTo(1, 12)
  })
})

describe('createRng (seeded)', () => {
  it('produces the same deterministic sequence for the same seed', () => {
    const a = createRng(42)
    const b = createRng(42)
    for (let i = 0; i < 20; i++) expect(a()).toBe(b())
  })

  it('produces values in [0, 1)', () => {
    const rng = createRng(7)
    for (let i = 0; i < 100; i++) {
      const v = rng()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('ringCycle', () => {
  it('returns N directed adjacent pairs of a Hamiltonian cycle', () => {
    const rng = createRng(0)
    const ring = ringCycle(5, rng)
    expect(ring).toHaveLength(5)
    const asFirst = new Set(ring.map(([a]) => a))
    const asSecond = new Set(ring.map(([, b]) => b))
    expect(asFirst).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(asSecond).toEqual(new Set([0, 1, 2, 3, 4]))
    // Adjacent pairs form one cycle.
    const next = new Map(ring.map(([a, b]) => [a, b]))
    let current = 0
    for (let i = 0; i < 5; i++) current = next.get(current)!
    expect(current).toBe(0)
  })

  it('is deterministic for a fixed seed', () => {
    const ring1 = ringCycle(8, createRng(1234))
    const ring2 = ringCycle(8, createRng(1234))
    expect(ring1).toEqual(ring2)
  })

  it('handles n <= 1', () => {
    expect(ringCycle(0, createRng(1))).toEqual([])
    expect(ringCycle(1, createRng(1))).toEqual([])
  })
})

describe('accumulate', () => {
  it('aggregates soft wins into w and c', () => {
    const w = [0, 0]
    const c = [0, 0]
    const score = (a: number, b: number): [number, number] =>
      a === 0 && b === 1 ? [1, 0] : [0, 1]
    accumulate([[0, 1], [1, 0]], score, w, c)
    const sigma1 = bradleyTerry(1, 0)
    expect(w[0]).toBeCloseTo(2 * sigma1, 12)
    expect(w[1]).toBeCloseTo(2 * (1 - sigma1), 12)
    expect(c).toEqual([2, 2])
  })
})

describe('selectPivots', () => {
  it('picks the top-k candidates by mean preference, ties broken by index', () => {
    const w = [0.9, 0.5, 0.5, 0.5, 0.5]
    const c = [1, 1, 1, 1, 1]
    expect(selectPivots(w, c, 2)).toEqual([0, 1])
  })

  it('clamps k to n', () => {
    expect(selectPivots([0.5, 0.5], [1, 1], 5)).toEqual([0, 1])
  })

  it('treats zero-count candidates as 0 preference', () => {
    expect(selectPivots([0, 1], [0, 1], 2)).toEqual([1, 0])
  })
})

describe('pivotRoundPairs', () => {
  it('returns non-pivot vs pivot pairs plus pivot-pivot combinations', () => {
    // n=5, pivots [1,3]: non-pivots [0,2,4] x [1,3] = 6, plus C(2,2)=1 -> 7
    const pairs = pivotRoundPairs(5, [1, 3])
    expect(pairs).toHaveLength(7)
    expect(pairs).toContainEqual([0, 1])
    expect(pairs).toContainEqual([0, 3])
    expect(pairs).toContainEqual([2, 1])
    expect(pairs).toContainEqual([2, 3])
    expect(pairs).toContainEqual([4, 1])
    expect(pairs).toContainEqual([4, 3])
    expect(pairs).toContainEqual([1, 3])
  })

  it('puts non-pivots in slot A and orders pivot-pivot pairs by index', () => {
    const pairs = pivotRoundPairs(4, [0, 2])
    // (n-k)*k + C(k,2) = (4-2)*2 + 1 = 5
    expect(pairs).toHaveLength(5)
    const pivotSet = new Set([0, 2])
    for (const [a, b] of pairs) {
      expect(pivotSet.has(b)).toBe(true)
      if (pivotSet.has(a)) expect(a).toBeLessThan(b)
    }
  })
})

describe('selectBest (full PPT)', () => {
  it('selects the strongest candidate and reports the comparison count', () => {
    const strengths = [0.2, 0.9, 0.3]
    const score = (a: number, b: number): [number, number] => [strengths[a]!, strengths[b]!]
    // n=3, k=2: comparisons = 3 (ring) + 2*1 (non-pivot vs pivot) + 1 (pivot-pivot) = 6
    const result = selectBest(3, DEFAULT_PIVOTS, score, 0)
    expect(result.best).toBe(1)
    expect(result.nComparisons).toBe(6)
    expect(result.scores).toHaveLength(3)
    expect(result.scores[1]!).toBeGreaterThan(result.scores[0]!)
    expect(result.scores[1]!).toBeGreaterThan(result.scores[2]!)
  })

  it('handles a single candidate without any comparison', () => {
    const result = selectBest(1, DEFAULT_PIVOTS, () => [0.5, 0.5], 0)
    expect(result.best).toBe(0)
    expect(result.nComparisons).toBe(0)
    expect(result.scores).toEqual([1])
  })

  it('is deterministic for a fixed seed', () => {
    const strengths = [0.3, 0.1, 0.8, 0.4]
    const score = (a: number, b: number): [number, number] => [strengths[a]!, strengths[b]!]
    const r1 = selectBest(4, 2, score, 99)
    const r2 = selectBest(4, 2, score, 99)
    expect(r1).toEqual(r2)
  })
})
