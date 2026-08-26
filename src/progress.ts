/**
 * Progress tracking: fine-grained reward over trajectory prefixes.
 * Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * The verifier is shown the task, the numbered agent steps, and a list of
 * checkpoints, and asked per checkpoint whether the agent's CURRENT state
 * would already satisfy the task. Each answer letter (A = 0% ... T = 100%)
 * is decoded as the expectation over the top-20 logprobs at the answer
 * position, giving a continuous progress curve.
 *
 * @module dsh-llm-as-a-verifier/progress
 */

import type { LogprobToken } from './scoring.js'

/** Letter scale — A = 0% progress, T = 100% progress (inverted relative to the pairwise reward scale). */
export const GRANULARITY = 20
const LETTERS = Array.from({ length: GRANULARITY }, (_, i) => String.fromCharCode(65 + i))
export const LETTER_TO_VALUE: Record<string, number> = Object.fromEntries([
  ...LETTERS.map((c, i) => [c, i / (GRANULARITY - 1)] as const),
  ...LETTERS.map((c, i) => [c.toLowerCase(), i / (GRANULARITY - 1)] as const),
])

/** Number the agent steps the way the checkpoint prompt refers to them. */
export function formatSteps(steps: string[]): string {
  const parts: string[] = []
  steps.forEach((step, k) => {
    parts.push(`=== Agent Step ${k + 1} ===`)
    parts.push(step.trim())
    parts.push('')
  })
  return parts.join('\n')
}

/**
 * Neutral progress-scoring prompt. It never reveals whether the trajectory
 * eventually succeeded — successes and failures see the same template.
 */
export function buildProgressPrompt(
  problem: string,
  trajectoryText: string,
  nSteps: number,
  checkpointSteps: number[],
): string {
  const n = checkpointSteps.length
  const out: string[] = [
    'You are a strict, skeptical evaluator of agent task attempts. ' +
      'Agents routinely declare victory while their environment still ' +
      'shows errors, edit the wrong target, or never actually run the ' +
      'verification the task asks for. Trust observed output — NOT the ' +
      "agent's narration.",
    '',
    '**Task instruction:**',
    problem.trim(),
    '',
    `**Agent trajectory (${nSteps} agent steps; each step is one ` +
      'action by the agent, with its observed output):**',
    trajectoryText,
    '',
    `You will score the trajectory at ${n} CHECKPOINTS. The score ` +
      'measures exactly ONE thing:',
    '',
    '    "Given everything the agent has done up to and including ' +
      "this step, would the agent's CURRENT state actually satisfy the " +
      "task's hidden grader (i.e. produce the expected files / output / " +
      'behavior the task requires)?"',
    '',
    'Use the 20-letter A..T scale:',
    '  A = certainly NO — nothing useful done yet, or the agent is ' +
      'going down a clearly wrong path.',
    '  B-G = leans NO — partial work exists but key pieces are missing ' +
      'or broken.',
    '  H-M = uncertain — a plausible solution is taking shape, but no ' +
      'convincing verification yet.',
    '  N-S = leans YES — the right artifacts appear to be in place and ' +
      'partial verification has worked, with minor concerns.',
    '  T = essentially certain YES — the agent has run the relevant ' +
      'verification and the observed output literally matches what the ' +
      'task calls for, with no outstanding errors.',
    '',
    'CRITICAL CALIBRATION RULES:',
    '  * Effort, exploration, step count, and confident-sounding ' +
      'narration are NOT progress. An agent that ran 20 commands and ' +
      'still has not produced the right output deserves a score near A.',
    '  * Default to skepticism. The hidden grader is NOT visible to ' +
      'you. A result with no real verification step should not exceed ' +
      '~K, and even a verified-looking one should rarely exceed ~R ' +
      'unless the verification clearly matches the task\'s stated ' +
      'success criterion.',
    '  * Treat the agent\'s prose declarations ("done!", "all tests ' +
      'pass") as ZERO evidence. Ground your score in the actual actions ' +
      'and the actual output you can see.',
    '',
    'EXPECTED PATTERNS — successive checkpoints do NOT have to rise:',
    '  * On a trajectory that genuinely solves the task, scores ' +
      'typically rise from A toward T.',
    '  * On a trajectory committed to a WRONG approach, scores should ' +
      'PLATEAU once the wrong artifact is in place.',
    '  * If the agent regresses (breaks something that worked), scores ' +
      'should DECREASE.',
    '',
    'The N checkpoints to score are:',
  ]
  checkpointSteps.forEach((k, i) => {
    out.push(`  Checkpoint ${i + 1} = state right after Agent Step ${k}`)
  })
  out.push('')
  out.push(
    'Score each checkpoint INDEPENDENTLY based on the agent\'s current ' +
      'best attempt at that point in the trajectory. Output EXACTLY N ' +
      'lines and nothing else, in the format:',
  )
  for (let i = 1; i <= n; i++) out.push(`<c${i}>LETTER</c${i}>`)
  out.push('')
  out.push('where each LETTER is a single letter from A to T.')
  return out.join('\n')
}

/** Default checkpoint steps: the interior steps 2..T-1 (every step when T < 3). */
export function defaultCheckpoints(totalSteps: number): number[] {
  if (totalSteps === 0) throw new Error('need at least one step')
  if (totalSteps > 2) return Array.from({ length: totalSteps - 2 }, (_, i) => i + 2)
  return Array.from({ length: totalSteps }, (_, i) => i + 1)
}

/** Validate 1-indexed checkpoint steps against a trajectory length. */
export function validateCheckpoints(checkpoints: number[], totalSteps: number): number[] {
  const bad = checkpoints.filter((k) => k < 1 || k > totalSteps)
  if (bad.length > 0) throw new Error(`checkpoint_steps out of range 1..${totalSteps}: ${bad.join(', ')}`)
  return [...checkpoints]
}

/**
 * Expectation over the letter values present in one position's top-K
 * logprob alternatives, renormalized with the softmax trick; undefined when
 * no scale letter appears.
 */
function expectedValueFromAlts(alts: LogprobToken[] | undefined): number | undefined {
  if (!alts) return undefined
  const valsToLp = new Map<number, number>()
  for (const { token, logprob } of alts) {
    // Some BPE tokenizers merge the tag's closing ">" with the answer
    // letter into one token (">B"); strip it so the letter still counts.
    const t = (token ?? '').replace(/^\s+/, '').replace(/^>/, '').replace(/^\s+/, '')
    if (!t) continue
    const c = t[0]!
    if (c in LETTER_TO_VALUE) {
      const v = LETTER_TO_VALUE[c]!
      const prev = valsToLp.get(v)
      if (prev === undefined || logprob > prev) valsToLp.set(v, logprob)
    }
  }
  if (valsToLp.size === 0) return undefined
  const maxLp = Math.max(...valsToLp.values())
  let total = 0
  let sum = 0
  for (const [v, lp] of valsToLp) {
    const p = Math.exp(lp - maxLp)
    total += p
    sum += v * p
  }
  return sum / total
}

/**
 * Decode the n checkpoint scores from one verifier response: logprob
 * expectation at the answer position after each `<c{i}>` tag, with a
 * text-parsing fallback. Unreadable checkpoints are null.
 */
export function extractProgressScores(
  text: string,
  tokens: string[] | undefined,
  positionLogprobs: LogprobToken[][] | undefined,
  n: number,
): Array<number | null> {
  const scores: Array<number | null> = new Array(n).fill(null)
  if (tokens && positionLogprobs) {
    let joined = ''
    const positionsAfter: Array<[number, number]> = []
    tokens.forEach((tok, j) => {
      joined += tok
      positionsAfter.push([joined.length, j + 1])
    })
    for (let i = 1; i <= n; i++) {
      const tag = `<c${i}>`
      const idx = joined.indexOf(tag)
      if (idx < 0) continue
      const targetChar = idx + tag.length
      for (const [endChar, nextPos] of positionsAfter) {
        if (endChar > targetChar) {
          const answerPos = nextPos - 1
          if (answerPos >= 0 && answerPos < positionLogprobs.length) {
            const v = expectedValueFromAlts(positionLogprobs[answerPos])
            if (v !== undefined) scores[i - 1] = v
          }
          break
        }
      }
    }
  }
  // Fallback: tagged letters in the text, then bare one-letter lines.
  for (let i = 1; i <= n; i++) {
    if (scores[i - 1] === null) {
      const m = new RegExp(`<c${i}>\\s*([A-Ta-t])\\s*</c${i}>`).exec(text ?? '')
      if (m?.[1]) scores[i - 1] = LETTER_TO_VALUE[m[1]] ?? null
    }
  }
  if (scores.some((s) => s === null)) {
    const bare = (text ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length === 1 && line in LETTER_TO_VALUE)
    if (bare.length === n) {
      for (let i = 0; i < n; i++) {
        if (scores[i] === null && bare[i] !== undefined) scores[i] = LETTER_TO_VALUE[bare[i]!]!
      }
    }
  }
  return scores
}

/**
 * Average per-checkpoint scores across repeats; a checkpoint that is
 * unreadable in every repeat defaults to 0.5.
 */
export function meanScores(perRep: Array<Array<number | null>>): number[] {
  const n = perRep[0]?.length ?? 0
  const scores: number[] = []
  for (let i = 0; i < n; i++) {
    const vals = perRep.map((rep) => rep[i]).filter((v): v is number => v !== null)
    scores.push(vals.length > 0 ? vals.reduce((sum, v) => sum + v, 0) / vals.length : 0.5)
  }
  return scores
}
