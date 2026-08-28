import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { orchestrate, type BoNConfig, type OrchestrateDeps } from '../src/bon'
import { VerifierBackend } from '../src/backend'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** A rollout that finishes "unusable" (empty text), so the turn degrades and
 * no real verifier call is made — keeps the test off the network. */
function unusable(delayMs: number): AsyncGenerator<StreamChunk> {
  return (async function* () {
    await sleep(delayMs)
    yield { type: 'finish', reason: { kind: 'length' } } as never as StreamChunk
  })()
}

/** A rollout that finishes as a USABLE plain-text answer (the anchor's shape). */
function textRollout(text = 'candidate answer'): AsyncGenerator<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as never as StreamChunk
    yield { type: 'text-delta', index: 0, text } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as never as StreamChunk
  })()
}

/** A rollout that finishes as a tool-call turn (the anchor's shape on working turns). */
function toolRollout(): AsyncGenerator<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' } as never as StreamChunk
    yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read_file', argumentsDelta: '{}' } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{}' } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as never as StreamChunk
  })()
}

function baseConfig(samplingMode: 'parallel' | 'serial'): BoNConfig {
  return {
    nCandidates: 5,
    samplingTemperature: 0.7,
    samplingMode,
    timeoutMs: 3000,
    verifyTimeoutMs: 3000,
    showFooter: false,
  }
}

const options = {
  messages: [{ role: 'user' as const, content: 'hi' }],
  model: 'm',
  provider: 'omni-chat',
  reasoningEffort: 'high', // the main turn's effort must NOT leak into sampled candidates
} as never as GenerateOptions

async function run(mode: 'parallel' | 'serial') {
  const startTimes: number[] = []
  const receivedOptions: Array<Record<string, unknown>> = []
  const stream = vi.fn((opts: GenerateOptions) => {
    startTimes.push(Date.now())
    receivedOptions.push(opts as unknown as Record<string, unknown>)
    return unusable(30)
  })
  const backend = new VerifierBackend({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', prefill: false })
  const deps: OrchestrateDeps = { stream, backend, onTurnSummary: vi.fn() }
  const out: StreamChunk[] = []
  // Anchor must be a USABLE text answer for sampling to start at all.
  for await (const chunk of orchestrate(deps, baseConfig(mode), options, () => textRollout())) out.push(chunk)
  return { startTimes, out, receivedOptions }
}

describe('orchestrate sampling schedule', () => {
  it('sampled candidates never inherit the main turn reasoningEffort', async () => {
    const { receivedOptions } = await run('parallel')
    expect(receivedOptions.length).toBe(4)
    for (const opt of receivedOptions) {
      expect(opt.reasoningEffort).toBeUndefined()
    }
  })

  it('serial: waits for each rollout to settle before starting the next', async () => {
    const { startTimes } = await run('serial')
    expect(startTimes.length).toBe(4) // N-1 = 4 sampled slots
    for (let i = 1; i < startTimes.length; i++) {
      expect(startTimes[i]! - startTimes[i - 1]!).toBeGreaterThanOrEqual(20)
    }
  })

  it('parallel (default): fires every rollout concurrently', async () => {
    const { startTimes } = await run('parallel')
    expect(startTimes.length).toBe(4)
    const spread = Math.max(...startTimes) - Math.min(...startTimes)
    expect(spread).toBeLessThan(20)
  })

  it('a broken single rollout does not sink the whole turn (parallel)', async () => {
    let calls = 0
    const stream = vi.fn(() => {
      calls += 1
      if (calls === 2) throw new Error('llm route failed') // one bad candidate
      return unusable(0)
    })
    const backend = new VerifierBackend({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', prefill: false })
    const deps: OrchestrateDeps = { stream, backend, onTurnSummary: vi.fn() }
    const out: StreamChunk[] = []
    try {
      for await (const chunk of orchestrate(deps, baseConfig('parallel'), options, () => textRollout())) out.push(chunk)
    } catch (error) {
      throw new Error(`turn should degrade, not die: ${error instanceof Error ? error.message : String(error)}`)
    }
    expect(out.length).toBeGreaterThan(0)
    expect(stream).toHaveBeenCalledTimes(4) // the other three slots still ran
  })
})

describe('orchestrate anchor-first gating', () => {
  it('a tool-call anchor is replayed verbatim WITHOUT sampling (working turns)', async () => {
    const stream = vi.fn(() => unusable(0))
    const backend = new VerifierBackend({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', prefill: false })
    const deps: OrchestrateDeps = { stream, backend, onTurnSummary: vi.fn() }
    const out: StreamChunk[] = []
    for await (const chunk of orchestrate(deps, baseConfig('parallel'), options, () => toolRollout())) out.push(chunk)
    // The tool-turn chunks are replayed as-is; no diversity samples were fired.
    expect(out.length).toBeGreaterThan(0)
    expect(stream).not.toHaveBeenCalled()
  })

  it('a failed/empty anchor is replayed or surfaced, never sampled', async () => {
    const stream = vi.fn(() => unusable(0))
    const backend = new VerifierBackend({ baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'x', prefill: false })
    const deps: OrchestrateDeps = { stream, backend, onTurnSummary: vi.fn() }
    const out: StreamChunk[] = []
    for await (const chunk of orchestrate(deps, baseConfig('parallel'), options, () => unusable(0))) out.push(chunk)
    expect(out.length).toBeGreaterThan(0)
    expect(stream).not.toHaveBeenCalled()
  })
})