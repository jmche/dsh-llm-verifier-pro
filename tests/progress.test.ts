import { describe, expect, it } from 'vitest'
import {
  LETTER_TO_VALUE,
  buildProgressPrompt,
  defaultCheckpoints,
  extractProgressScores,
  formatSteps,
  meanScores,
} from '../src/progress'

describe('LETTER_TO_VALUE', () => {
  it('maps A=0% and T=100%, inverted from the pairwise scale', () => {
    expect(LETTER_TO_VALUE.A).toBe(0)
    expect(LETTER_TO_VALUE.T).toBe(1)
    expect(LETTER_TO_VALUE.G).toBe(6 / 19)
    expect(LETTER_TO_VALUE.t).toBe(1)
    expect(Object.keys(LETTER_TO_VALUE)).toHaveLength(40)
  })
})

describe('formatSteps', () => {
  it('numbers agent steps for the checkpoint prompt', () => {
    const text = formatSteps(['step one', 'step two'])
    expect(text).toContain('=== Agent Step 1 ===')
    expect(text).toContain('step one')
    expect(text).toContain('=== Agent Step 2 ===')
    expect(text).toContain('step two')
  })
})

describe('buildProgressPrompt', () => {
  const prompt = buildProgressPrompt('Write a function that reverses a string.', formatSteps(['a', 'b', 'c']), 3, [2, 3])

  it('contains the task, the trajectory and the checkpoint lines', () => {
    expect(prompt).toContain('Write a function that reverses a string.')
    expect(prompt).toContain('Checkpoint 1 = state right after Agent Step 2')
    expect(prompt).toContain('Checkpoint 2 = state right after Agent Step 3')
  })

  it('demands exactly N tagged letters', () => {
    expect(prompt).toContain('<c1>LETTER</c1>')
    expect(prompt).toContain('<c2>LETTER</c2>')
  })

  it('is skeptical and neutral about the outcome', () => {
    expect(prompt).toContain('strict, skeptical')
    expect(prompt).toContain('hidden grader')
  })
})

describe('extractProgressScores', () => {
  it('reads the logprob expectation at each checkpoint answer position', () => {
    const tokens = ['<c1>', 'G', '<c2>', 'T']
    const positionLogprobs = [
      [{ token: '<c1>', logprob: 0 }],
      [{ token: 'G', logprob: Math.log(1) }],
      [{ token: '<c2>', logprob: 0 }],
      [{ token: 'T', logprob: Math.log(1) }],
    ]
    const scores = extractProgressScores('', tokens, positionLogprobs, 2)
    expect(scores[0]).toBeCloseTo(6 / 19, 10)
    expect(scores[1]).toBeCloseTo(1, 10)
  })

  it('renormalizes a partial letter distribution with the softmax trick', () => {
    // G (6/19) with 70% and H (7/19) with 30%: E = 0.7*6/19 + 0.3*7/19
    const tokens = ['<c1>', 'G']
    const positionLogprobs = [
      [{ token: '<c1>', logprob: 0 }],
      [
        { token: 'G', logprob: Math.log(0.7) },
        { token: 'H', logprob: Math.log(0.3) },
      ],
    ]
    const scores = extractProgressScores('', tokens, positionLogprobs, 1)
    expect(scores[0]).toBeCloseTo(0.7 * (6 / 19) + 0.3 * (7 / 19), 10)
  })

  it('falls back to tagged letters in the text', () => {
    const text = '<c1>T</c1>\n<c2>A</c2>'
    const scores = extractProgressScores(text, [], [], 2)
    expect(scores).toEqual([1, 0])
  })

  it('falls back to bare one-letter lines', () => {
    const text = 'analysis\nH\nT'
    const scores = extractProgressScores(text, [], [], 2)
    expect(scores[0]).toBeCloseTo(7 / 19, 10)
    expect(scores[1]).toBe(1)
  })

  it('marks unreadable checkpoints as null', () => {
    const scores = extractProgressScores('nothing useful', [], [], 2)
    expect(scores).toEqual([null, null])
  })
})

describe('defaultCheckpoints', () => {
  it('scores the interior steps for long trajectories', () => {
    expect(defaultCheckpoints(5)).toEqual([2, 3, 4])
  })

  it('scores every step for trajectories with fewer than 3 steps', () => {
    expect(defaultCheckpoints(2)).toEqual([1, 2])
    expect(defaultCheckpoints(1)).toEqual([1])
  })
})

describe('meanScores', () => {
  it('averages readable scores across repeats', () => {
    expect(meanScores([[1, 0.5], [1, null]])).toEqual([1, 0.5])
  })

  it('defaults to 0.5 when a checkpoint is unreadable in every repeat', () => {
    expect(meanScores([[null, 0.5], [null, 1]])).toEqual([0.5, 0.75])
  })
})
