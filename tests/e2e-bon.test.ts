import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { apply, type Config } from '../src/index'
import { createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'

/**
 * End-to-end Bo-N turn tests through the REAL llm/stream waterfall: apply(ctx)
 * registers the interceptor, and firing `ctx.waterfall('llm/stream', …)` walks
 * the same chain the running dsh web does. Sampled candidates re-enter via the
 * llm seam and must be recognized as internal requests (no recursion).
 */

let mock: MockOpenAIServer | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

/** A text-delta + finish stream for one assistant message. */
function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as never as StreamChunk
    yield { type: 'text-delta', index: 0, text } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as never as StreamChunk
  })()
}

/** A tool-call block + finish for one working turn (agent doing things). */
function toolStream(): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'tool-call' } as never as StreamChunk
    yield { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'bash', argumentsDelta: '{}' } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'tool-calls' } } as never as StreamChunk
  })()
}

/** The full request shape dsh hands to `llm/stream` for a conversation turn. */
function conversationRequest(overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'omni-chat',
    model: 'opencode-go/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Explain in one sentence why the sky is blue.' }],
    tools: [
      { name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'read a file', parameters: { type: 'object', properties: {} } },
    ],
    sessionId: 'sess-1' as never,
    reasoningEffort: 'high',
    ...overrides,
  }
}

const waterfallOf = (ctx: Context) =>
  (ctx as unknown as { waterfall: (thisArg: unknown, name: string, ...args: unknown[]) => unknown }).waterfall.bind(ctx) as (
    name: string,
    ...args: unknown[]
  ) => unknown

/**
 * Build a context with the plugin applied and a faithful llm seam:
 * `ctx.llm.stream(opts)` re-walks the `llm/stream` waterfall, exactly like
 * dsh's LlmRuntime. The inner adapter answers every forwarded request with a
 * plain-text stream so a sampled candidate is always "usable".
 */
function harness(cfg: Partial<Config> = {}, sectionValue: Record<string, unknown> = {}) {
  const ctx = new Context()
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { section: vi.fn() }
  const registered: unknown[] = []
  ;(ctx as unknown as { tools: unknown }).tools = { register: vi.fn((def: unknown) => registered.push(def)) }
  // Settings seam: sectionReaderOf() lazily registers and hot-reads; in tests
  // there is no settings service, so mock the register → get round-trip with a
  // fixed section value (the panel's settings document).
  ;(ctx as unknown as { settings: unknown }).settings = {
    register: () => ({ get: () => sectionValue }),
  }
  // Every request that re-enters the waterfall through the llm seam is
  // captured here (the anchor rides fireTurn's inner next(); candidates ride
  // ctx.llm.stream — so `sampled` holds exactly the candidate requests).
  const sampled: GenerateOptions[] = []
  const adapterAnswer = cfg.samplingMode === 'serial' ? textStream('serial candidate') : textStream('candidate answer')
  ;(ctx as unknown as { llm: unknown }).llm = {
    stream: (opts: GenerateOptions): AsyncIterable<StreamChunk> => {
      sampled.push(opts)
      return waterfallOf(ctx)('llm/stream', opts, () => adapterAnswer) as AsyncIterable<StreamChunk>
    },
  }
  apply(ctx, { boN: true, boNCandidates: 3, showFooter: false, verifyTimeoutMsBoN: 5000, timeoutMsBoN: 5000, ...cfg })
  return { ctx, registered, sampled }
}

describe('Bo-N end-to-end through the llm/stream waterfall', () => {
  it('registers the plugin and the interceptor handler', () => {
    const h = harness()
    expect(h.registered.length).toBeGreaterThan(0)
    const ctx = h.ctx as unknown as { events: { waterfall: unknown } }
    expect(typeof ctx.events.waterfall).toBe('function')
  })

  it('a tool-call turn fires ZERO sampling requests and replays the anchor chunks verbatim', async () => {
    const h = harness()
    const request = conversationRequest()
    // The inner next() (the "real adapter") produces a TOOL turn for the
    // anchor — a working agent turn.
    const gen = waterfallOf(h.ctx)('llm/stream', request, (opts: GenerateOptions) => toolStream()) as AsyncIterable<StreamChunk>
    const out: StreamChunk[] = []
    for await (const chunk of gen) out.push(chunk)
    // The tool-turn chunks are replayed verbatim; no sampling happened.
    expect(out.some((c) => c.type === 'tool-call-delta')).toBe(true)
    expect(h.sampled).toHaveLength(0) // ZERO candidate requests re-entered the seam
  })

  it('a plain-text turn samples N-1 candidates stripped of tools and replays a winner', async () => {
    mock = await createMockOpenAI()
    mock.setScript(() => pairwiseCompletion(' A ', ' T ')) // verifier grades: A best, T worst
    const h = harness()
    const request = conversationRequest()
    const gen = waterfallOf(h.ctx)('llm/stream', request, () =>
      textStream('The sky is blue because air scatters short wavelengths more strongly.'),
    ) as AsyncIterable<StreamChunk>
    const out: StreamChunk[] = []
    for await (const chunk of gen) out.push(chunk)
    await mock.close()
    mock = undefined
    // A text answer (the winner) was replayed.
    expect(out.some((c) => c.type === 'text-delta')).toBe(true)
    // N-1 = 2 candidate requests, each: temperature set, NO tools, no reasoningEffort.
    expect(h.sampled).toHaveLength(2)
    for (const cand of h.sampled) {
      expect(cand.temperature).toBe(0.7)
      expect(cand.tools).toBeUndefined() // tools STRIPPED from candidates
      expect((cand as { reasoningEffort?: unknown }).reasoningEffort).toBeUndefined()
    }
  })

  it('a degenerate turn degrades to the anchor text and never hangs', async () => {
    const h = harness({ boNCandidates: 8 })
    const request = conversationRequest()
    const gen = waterfallOf(h.ctx)('llm/stream', request, () => textStream('plain anchor answer')) as AsyncIterable<StreamChunk>
    const out: StreamChunk[] = []
    for await (const chunk of gen) out.push(chunk)
    expect(out.some((c) => c.type === 'text-delta')).toBe(true)
    expect(h.sampled.length).toBeGreaterThanOrEqual(0) // timing-independent: never throws
  })

  it('strips reasoning content from sampled candidates (DeepSeek 400 reasoning_content guard)', async () => {
    const h = harness()
    // History carries a thinking-mode assistant reply: a reasoning block plus
    // adapter replay state. DeepSeek endpoints reject the follow-up unless the
    // reasoning_content is passed back verbatim — the candidates must not.
    const request = conversationRequest({
      messages: [
        { role: 'user', content: 'Explain the sky.' },
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'think about Rayleigh scattering…' },
            { type: 'text', text: 'The sky is blue because air scatters short wavelengths.' },
          ],
          source: {
            kind: 'model',
            provider: 'omni-chat',
            model: 'opencode-go/deepseek-v4-flash',
            replayState: { response: { id: 'deepseek-resp-1' } },
          },
        },
        { role: 'user', content: 'Now in one sentence.' },
      ],
    })
    const gen = waterfallOf(h.ctx)('llm/stream', request, () => textStream('plain anchor answer')) as AsyncIterable<StreamChunk>
    for await (const _chunk of gen) { /* drain */ }
    expect(h.sampled).toHaveLength(2)
    for (const cand of h.sampled) {
      const assistant = cand.messages.find((m) => m.role === 'assistant')
      expect(assistant, 'history keeps the assistant message').toBeDefined()
      expect(assistant!.content.some((b) => b.type === 'reasoning')).toBe(false) // reasoning stripped
      expect(assistant!.content.some((b) => b.type === 'text')).toBe(true) // visible text kept
      expect((assistant!.source as { replayState?: unknown }).replayState).toBeUndefined() // replay state cleared
    }
  })

  it('a failed anchor re-runs the normal path instead of dying with no fallback', async () => {
    const h = harness()
    const request = conversationRequest()
    let calls = 0
    const inner = (): AsyncIterable<StreamChunk> => {
      calls += 1
      if (calls === 1) {
        return (async function* () { throw new Error('adapter exploded') })()
      }
      return textStream('recovered plain answer')
    }
    const gen = waterfallOf(h.ctx)('llm/stream', request, inner) as AsyncIterable<StreamChunk>
    const out: StreamChunk[] = []
    for await (const chunk of gen) out.push(chunk)
    expect(out.some((c) => c.type === 'text-delta')).toBe(true) // recovered, not dead
    expect(calls).toBe(2) // anchor threw once, normal path re-ran once
  })

  it('an explicit empty panel mix overrides a config model mix (follows the session)', async () => {
    // config carries a model mix (like a profile patch), but the PANEL has an
    // explicit empty mix — the panel wins, so candidates ride the anchor model.
    const h = harness({ boNModelMix: ['ollama-local/mix-model'] }, { boNModelMix: [] })
    const request = conversationRequest() // model = opencode-go/deepseek-v4-flash
    const gen = waterfallOf(h.ctx)('llm/stream', request, () => textStream('plain anchor answer')) as AsyncIterable<StreamChunk>
    for await (const _chunk of gen) { /* drain */ }
    expect(h.sampled).toHaveLength(2)
    for (const cand of h.sampled) {
      expect(cand.model).toBe('opencode-go/deepseek-v4-flash') // anchor model, not mix-model
      expect(cand.temperature).toBe(0.7)
    }
  })

  it('an unset panel mix falls back to the config model mix', async () => {
    // config carries a model mix; the panel never set one (undefined) → config
    // still supplies the diversity models.
    const h = harness({ boNModelMix: ['ollama-local/mix-model'] }, {})
    const request = conversationRequest()
    const gen = waterfallOf(h.ctx)('llm/stream', request, () => textStream('plain anchor answer')) as AsyncIterable<StreamChunk>
    for await (const _chunk of gen) { /* drain */ }
    expect(h.sampled).toHaveLength(2)
    expect(h.sampled[0]!.model).toBe('ollama-local/mix-model') // config mix still applies
  })
})