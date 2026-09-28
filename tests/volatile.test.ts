import { describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile, isVolatile, updateVolatile } from '@deepseek-ai/cosmokit'
import { apply, Config } from '../src/index'

/**
 * dsh 0.1.7 builds a plugin's settings form only from `.volatile()` Config
 * fields (dsh-settings describe()), and the Loader commits a volatile-only
 * edit into the running references without remounting. These tests pin both
 * halves: the schema exposes the panel fields as volatile, and the plugin
 * reads them per turn instead of freezing them at apply time.
 */

/** Fields the Plugins-page form edits. */
const PANEL_FIELDS = [
  'verifier', 'baseUrl', 'model', 'timeoutMs', 'maxConcurrency', 'autoDegrade',
  'boN', 'boNCandidates', 'samplingTemperature', 'samplingMode', 'timeoutMsBoN',
  'verifyTimeoutMsBoN', 'showFooter', 'criteria', 'boNPivots', 'boNSeed', 'boNModelMix',
] as const

/** Fields that stay ordinary: a secret, the call-path overrides, and the tool registration flags read once at apply. */
const ORDINARY_FIELDS = ['apiKey', 'deepseek', 'prefill', 'compare', 'select', 'track'] as const

function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as never as StreamChunk
    yield { type: 'text-delta', index: 0, text } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as never as StreamChunk
  })()
}

describe('volatile Config (Plugins-page form)', () => {
  it('parses the panel fields as volatile references and keeps the rest ordinary', () => {
    const parsed = (Config as unknown as (value: unknown) => Record<string, unknown>)({ boN: true, apiKey: 'k', compare: false })
    for (const field of PANEL_FIELDS) expect(isVolatile(parsed[field]), field).toBe(true)
    for (const field of ORDINARY_FIELDS) expect(isVolatile(parsed[field]), field).toBe(false)
    expect((parsed.boN as { get(): unknown }).get()).toBe(true)
    expect((parsed.boNCandidates as { get(): unknown }).get()).toBe(5)
    expect(parsed.compare).toBe(false)
  })

  it('applies a Loader volatile commit on the next turn without remounting', async () => {
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { section: vi.fn() }
    ;(ctx as unknown as { tools: unknown }).tools = { register: vi.fn() }
    const sampled: GenerateOptions[] = []
    const waterfall = (ctx as unknown as { waterfall: (thisArg: unknown, name: string, ...args: unknown[]) => unknown }).waterfall.bind(ctx) as (
      name: string,
      ...args: unknown[]
    ) => AsyncIterable<StreamChunk>
    ;(ctx as unknown as { llm: unknown }).llm = {
      stream: (opts: GenerateOptions) => {
        sampled.push(opts)
        return waterfall('llm/stream', opts, () => textStream('candidate answer'))
      },
    }
    const config = (Config as unknown as (value: unknown) => Record<string, unknown>)({
      boN: false,
      boNCandidates: 3,
      showFooter: false,
      timeoutMsBoN: 5000,
      verifyTimeoutMsBoN: 5000,
    })
    apply(ctx, config as never)

    const request: GenerateOptions = {
      provider: 'omni-chat',
      model: 'opencode-go/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Why is the sky blue?' }],
      sessionId: 'sess-volatile' as never,
    }
    const turn = async () => {
      for await (const _chunk of waterfall('llm/stream', { ...request }, () => textStream('anchor answer'))) { /* drain */ }
    }

    await turn()
    expect(sampled).toHaveLength(0) // Bo-N off: no candidates

    // What the Loader does on a volatile-only edit: write into the running reference.
    updateVolatile(config.boN as never, createVolatile(true) as never)
    await turn()
    expect(sampled).toHaveLength(2) // Bo-N now on at boNCandidates=3 → N-1 candidates
  })
})
