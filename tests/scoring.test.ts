import { describe, expect, it } from 'vitest'
import {
  GRANULARITY,
  SCALE,
  buildPairwisePrompt,
  extractScore,
  normalizeCriteria,
} from '../src/scoring'

const log = Math.log

/** Position logprob alternatives shaped like a backend response. */
function alts(entries: Array<[string, number]>): Array<{ token: string; logprob: number }> {
  return entries.map(([token, logprob]) => ({ token, logprob }))
}

describe('SCALE', () => {
  it('defines a granularity-20 letter scale', () => {
    expect(GRANULARITY).toBe(20)
    expect(Object.keys(SCALE.valid_tokens)).toHaveLength(40)
  })

  it('maps A=best (20) and T=worst (1), both cases', () => {
    expect(SCALE.valid_tokens.A).toBe(20)
    expect(SCALE.valid_tokens.T).toBe(1)
    expect(SCALE.valid_tokens.a).toBe(20)
    expect(SCALE.valid_tokens.t).toBe(1)
  })
})

describe('extractScore', () => {
  it('returns the expectation over the logprob distribution, normalized to [0,1]', () => {
    const tokens = ['<score_A>', 'G', '<score_B>', 'T']
    const positionLogprobs = [
      alts([['<score_A>', 0]]),
      alts([['G', log(0.9)], ['H', log(0.05)], ['I', log(0.05)]]),
      alts([['<score_B>', 0]]),
      alts([['T', log(1)] ]),
    ]
    // E = 0.9*14 + 0.05*13 + 0.05*12 = 13.85 -> (13.85 - 1) / 19
    const score = extractScore('', tokens, positionLogprobs, '<score_A>')
    expect(score).toBeCloseTo((13.85 - 1) / 19, 10)
  })

  it('scores a deterministic letter at the extremes', () => {
    const mk = (letter: string) => {
      const tokens = ['<score_A>', letter]
      const positionLogprobs = [alts([['<score_A>', 0]]), alts([[letter, log(1)]])]
      return extractScore('', tokens, positionLogprobs, '<score_A>')
    }
    expect(mk('A')).toBeCloseTo(1.0, 10)
    expect(mk('T')).toBeCloseTo(0.0, 10)
  })

  it('strips a fused ">A" tokenizer artifact before matching the scale', () => {
    const tokens = ['<score_A', '>B']
    const positionLogprobs = [
      alts([['<score_A', 0]]),
      alts([['>B', log(0.7)], ['>C', log(0.3)]]),
    ]
    // E = 0.7*19 + 0.3*18 = 18.7 -> (18.7 - 1) / 19
    const score = extractScore('', tokens, positionLogprobs, '<score_A>')
    expect(score).toBeCloseTo((18.7 - 1) / 19, 10)
  })

  it('accepts lowercase scale letters in logprobs', () => {
    const tokens = ['<score_A>', 't']
    const positionLogprobs = [alts([['<score_A>', 0]]), alts([['t', log(1)]])]
    expect(extractScore('', tokens, positionLogprobs, '<score_A>')).toBeCloseTo(0.0, 10)
  })

  it('uses the LAST score block when the model quotes the format mid-analysis', () => {
    const tokens = [
      'a', 'n', '<score_A>', 'T', ' ', 'f', 'i', 'n', 'a', 'l', '<score_A>', 'G',
    ]
    const positionLogprobs = [
      alts([['a', 0]]), alts([['n', 0]]), alts([['<score_A>', 0]]),
      alts([['T', log(1)]]), alts([[' ', 0]]), alts([['f', 0]]),
      alts([['i', 0]]), alts([['n', 0]]), alts([['a', 0]]),
      alts([['l', 0]]), alts([['<score_A>', 0]]), alts([['G', log(1)]]),
    ]
    const score = extractScore('', tokens, positionLogprobs, '<score_A>')
    expect(score).toBeCloseTo((14 - 1) / 19, 10)
  })

  it('falls back to parsing the literal text tag when no logprobs are present', () => {
    const text = 'analysis...\n<score_A> G </score_A>\n<score_B> T </score_B>'
    expect(extractScore(text, [], [], '<score_A>')).toBeCloseTo((14 - 1) / 19, 10)
    expect(extractScore(text, [], [], '<score_B>')).toBeCloseTo(0.0, 10)
  })

  it('reads the last literal match and ignores case', () => {
    const text = '<score_a>A</score_a> then finally <score_a>f</score_a>'
    // f = 6th letter: value 20 - 5 = 15
    expect(extractScore(text, [], [], '<score_A>')).toBeCloseTo((15 - 1) / 19, 10)
  })

  it('defaults to 0.5 when no score can be read', () => {
    expect(extractScore('no tags here', [], [], '<score_A>')).toBe(0.5)
    expect(extractScore('', [], [], '<score_B>')).toBe(0.5)
  })
})

describe('buildPairwisePrompt', () => {
  const prompt = buildPairwisePrompt(
    'Fix the bug in utils.py.',
    'trajectory A text',
    'trajectory B text',
    { id: 'root-cause', name: 'Root cause', description: 'Did the agent fix the real cause?' },
    'The reference patch is in tests/fixtures.',
  )

  it('contains the task, both trajectories and the ground-truth note', () => {
    expect(prompt).toContain('Fix the bug in utils.py.')
    expect(prompt).toContain('trajectory A text')
    expect(prompt).toContain('trajectory B text')
    expect(prompt).toContain('The reference patch is in tests/fixtures.')
  })

  it('ends with the score tags and the criterion text', () => {
    expect(prompt).toContain('<score_A> LETTER_A_TO_T </score_A>')
    expect(prompt).toContain('<score_B> LETTER_A_TO_T </score_B>')
    expect(prompt).toContain('Root cause')
    expect(prompt).toContain('Did the agent fix the real cause?')
    const criterionIdx = prompt.indexOf('Root cause')
    const tagIdx = prompt.indexOf('<score_A>')
    expect(criterionIdx).toBeLessThan(tagIdx)
  })

  it('keeps criterion-specific text strictly at the tail (prefix-cache friendly)', () => {
    const scaleIdx = prompt.indexOf('Rating Scale')
    const criterionIdx = prompt.indexOf('Did the agent fix the real cause?')
    expect(scaleIdx).toBeLessThan(criterionIdx)
  })
})

describe('normalizeCriteria', () => {
  it('accepts a {name: description} mapping', () => {
    const criteria = normalizeCriteria({ Correctness: 'Does it solve the problem?' })
    expect(criteria).toEqual([
      { id: 'correctness', name: 'Correctness', description: 'Does it solve the problem?' },
    ])
  })

  it('accepts a list of criterion objects and slugs their ids', () => {
    const criteria = normalizeCriteria([
      { id: 'pinned', name: 'Pinned', description: 'd' },
      { name: 'Root Cause', description: 'did the agent fix it?' },
    ])
    expect(criteria).toEqual([
      { id: 'pinned', name: 'Pinned', description: 'd' },
      { id: 'root-cause', name: 'Root Cause', description: 'did the agent fix it?' },
    ])
  })

  it('accepts a list of plain strings', () => {
    const criteria = normalizeCriteria(['Does it compile?', 'Are tests green?'])
    expect(criteria.map((c) => c.id)).toEqual(['does-it-compile', 'are-tests-green'])
    expect(criteria[0]?.name).toBe('Does it compile?')
  })

  it('rejects an empty criteria set', () => {
    expect(() => normalizeCriteria({})).toThrow()
    expect(() => normalizeCriteria([])).toThrow()
  })
})
