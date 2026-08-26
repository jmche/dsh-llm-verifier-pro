import { afterEach, describe, expect, it } from 'vitest'
import { Verifier } from '../src/verifier'
import { createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'

let mock: MockOpenAIServer | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

/** Quality letters per candidate trajectory (A = best, T = worst). */
const QUALITY: Record<string, string> = { zero: 'T', one: 'A', two: 'F', a: 'A', b: 'T' }

function slotTexts(body: Record<string, unknown>): { a: string; b: string } {
  const prompt = String(body.messages[0].content)
  const a = prompt.split('**Trajectory A:**\n')[1]?.split('\n')[0] ?? ''
  const b = prompt.split('**Trajectory B:**\n')[1]?.split('\n')[0] ?? ''
  return { a, b }
}

/** Answer every request with the quality letters of the current slot contents. */
function qualityScript(mock: MockOpenAIServer): void {
  mock.setScript((body) => {
    const { a, b } = slotTexts(body)
    return pairwiseCompletion(QUALITY[a] ?? 'K', QUALITY[b] ?? 'K')
  })
}

/** A verifier pointed at the mock with prefill off (orchestration-focused tests). */
function mockVerifier(opts: Record<string, unknown> = {}) {
  return new Verifier({ baseUrl: mock!.baseUrl, apiKey: 'k', model: 'm', maxConcurrency: 1, prefill: false, ...opts })
}

describe('Verifier.compare', () => {
  it('averages fine-grained rewards over criteria and repeated evaluations', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([
      pairwiseCompletion('A', 'T'),
      pairwiseCompletion('T', 'A'),
      pairwiseCompletion('A', 'T'),
      pairwiseCompletion('T', 'A'),
    ])
    const verifier = mockVerifier()
    const result = await verifier.compare(
      'problem',
      'trace-a',
      'trace-b',
      { Correctness: 'does it work?' },
      { nEvaluations: 2 },
    )
    // Rep 1: (1.0, 0.0); rep 2: (0.0, 1.0) — averaged to (0.5, 0.5).
    expect(result.scoreA).toBeCloseTo(0.5, 10)
    expect(result.scoreB).toBeCloseTo(0.5, 10)
    expect(mock.requests).toHaveLength(2)
  })

  it('keeps candidate a in slot A for a plain directed compare', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([pairwiseCompletion('A', 'T')])
    const verifier = mockVerifier()
    await verifier.compare('problem', 'first-candidate', 'second-candidate', { C: 'c' })
    const prompt = String(mock.requests[0]!.body.messages[0].content)
    expect(prompt.indexOf('first-candidate')).toBeLessThan(prompt.indexOf('second-candidate'))
  })
})

describe('Verifier.select', () => {
  it('runs the PPT and picks the best of N candidates', async () => {
    mock = await createMockOpenAI()
    qualityScript(mock)
    const verifier = mockVerifier()
    const result = await verifier.select(
      'problem',
      ['zero', 'one', 'two'],
      { Correctness: 'does it solve?' },
      { nEvaluations: 1, pivots: 2, seed: 0 },
    )
    expect(result.index).toBe(1)
    expect(result.nComparisons).toBe(6)
    expect(result.ranking[0]).toBe(1)
    // Pairs shared between the ring and the pivot rounds reuse cached scores
    // (upstream parity), so API calls <= comparisons.
    expect(mock.requests.length).toBeGreaterThanOrEqual(3)
    expect(mock.requests.length).toBeLessThanOrEqual(6)
    expect(mock.requests.every((r) => r.path === '/v1/chat/completions')).toBe(true)
  })

  it('swaps prompt slots on odd repeats and records scores in candidate order', async () => {
    mock = await createMockOpenAI()
    qualityScript(mock)
    const verifier = mockVerifier()
    // n=2, pivots=1, nEvaluations=2: ring pairs (0,1),(1,0) + pivot pair
    // (1,0) — the overlap reuses the cache, so 2 unique pairs x 2 reps = 4
    // calls; rep 1 swaps the prompt slots.
    await verifier.select('problem', ['a', 'b'], { C: 'c' }, { nEvaluations: 2, pivots: 1, seed: 0 })
    expect(mock.requests).toHaveLength(4)
    // Both slot assignments appear for each directed pair: rep 0 keeps the
    // pair order, rep 1 swaps the prompt slots.
    const assignments = mock.requests
      .map((r) => {
        const { a, b } = slotTexts(r.body)
        return `${a}|${b}`
      })
      .sort()
    expect(assignments).toEqual(['a|b', 'a|b', 'b|a', 'b|a'])
  })

  it('returns the single candidate without any comparison', async () => {
    const verifier = new Verifier({ baseUrl: 'http://unused.invalid/v1', apiKey: 'k', model: 'm' })
    const result = await verifier.select('problem', ['only'], { C: 'c' })
    expect(result.index).toBe(0)
    expect(result.scores).toEqual([1])
    expect(result.nComparisons).toBe(0)
  })
})

describe('Verifier.track', () => {
  function progressResponse(letters: string[]) {
    const tokens: string[] = []
    const positions: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> = []
    letters.forEach((letter, i) => {
      tokens.push(`<c${i + 1}>`, letter)
      positions.push({ token: `<c${i + 1}>`, logprob: 0 })
      positions.push({ token: letter, logprob: 0, top_logprobs: [{ token: letter, logprob: 0 }] })
    })
    return {
      choices: [
        {
          message: { content: letters.map((l, i) => `<c${i + 1}>${l}</c${i + 1}>`).join('\n') },
          logprobs: { content: positions },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: tokens.length },
    }
  }

  it('scores checkpoints over the trajectory with repeated evaluations', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([progressResponse(['G', 'T']), progressResponse(['H', 'S'])])
    const verifier = mockVerifier()
    const result = await verifier.track('problem', ['s1', 's2', 's3', 's4'], {
      checkpoints: [1, 4],
      nEvaluations: 2,
    })
    expect(result.steps).toEqual([1, 4])
    expect(result.scores[0]).toBeCloseTo((6 / 19 + 7 / 19) / 2, 10)
    expect(result.scores[1]).toBeCloseTo((1 + 18 / 19) / 2, 10)
    expect(result.final).toBe(result.scores[1])
    expect(mock.requests).toHaveLength(2)
  })

  it('defaults checkpoints to the interior steps and rejects out-of-range ones', async () => {
    const verifier = new Verifier({ baseUrl: 'http://unused.invalid/v1', apiKey: 'k', model: 'm' })
    await expect(verifier.track('p', ['a', 'b', 'c', 'd', 'e'], { checkpoints: [6] })).rejects.toThrow(/out of range/)
  })
})
