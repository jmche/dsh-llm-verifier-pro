import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { orchestrate } from '../src/bon'
import { VerifierBackend } from '../src/backend'
import { createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'

/** Drive orchestrate with stub stream/backend and record every sampled request. */
async function collectSampledRequests(opts: {
  nCandidates: number
  mixModels?: string[]
}): Promise<GenerateOptions[]> {
  const mock: MockOpenAIServer = await createMockOpenAI()
  mock.setScript(() => pairwiseCompletion(' A ', ' T ')) // A (best) vs T (worst) per pair

  const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', prefill: false })
  const base: GenerateOptions = { model: 'opencode-go/deepseek-v4-flash', provider: 'omni-chat', messages: [{ role: 'user', content: 'Hello' }] }
  const streamed: GenerateOptions[] = []
  const stubbedDeps = {
    stream: (request: GenerateOptions) => {
      streamed.push(request)
      return (async function* () {})() // empty stream → rollout marked unusable, but requests captured
    },
    backend,
    verifierModel: 'opencode-go/deepseek-v4-flash',
  }
  const next = (): AsyncIterable<StreamChunk> => (async function* () {})()
  const gen = orchestrate(stubbedDeps as never, {
    nCandidates: opts.nCandidates,
    samplingTemperature: 0.7,
    timeoutMs: 5000,
    verifyTimeoutMs: 5000,
    showFooter: false,
    mixModels: opts.mixModels,
  }, base, next)
  for await (const _chunk of gen) { /* drain */ }
  await mock.close()
  return streamed
}

describe('Bo-N model mix', () => {
  it('with no mix: every non-anchor slot inherits the conversation model/provider', async () => {
    const reqs = await collectSampledRequests({ nCandidates: 3 })
    expect(reqs).toHaveLength(2)
    for (const req of reqs) {
      expect(req.model).toBe('opencode-go/deepseek-v4-flash')
      expect(req.provider).toBe('omni-chat')
      expect(req.temperature).toBe(0.7)
    }
  })

  it('assigns mix entries to non-anchor slots in order (model id override only, provider kept)', async () => {
    const reqs = await collectSampledRequests({
      nCandidates: 5,
      mixModels: [
        'ollama-local/qwen3.8:27b',
        'agnes/agnes-2.5-flash',
        'ollama-local/ornith-1.5:35b',
      ],
    })
    expect(reqs).toHaveLength(4)
    // Provider stays the conversation's (omni-chat); only the model id changes.
    expect(reqs[0]).toMatchObject({ provider: 'omni-chat', model: 'ollama-local/qwen3.8:27b', temperature: 0.7 })
    expect(reqs[1]).toMatchObject({ provider: 'omni-chat', model: 'agnes/agnes-2.5-flash' })
    expect(reqs[2]).toMatchObject({ provider: 'omni-chat', model: 'ollama-local/ornith-1.5:35b' })
    // Slot beyond the mix list → fallback to anchor model.
    expect(reqs[3]).toMatchObject({ provider: 'omni-chat', model: 'opencode-go/deepseek-v4-flash' })
    // Sanity: the anchor itself never appears in sampled (it rides next()).
    expect(reqs.every((req) => req.model === 'opencode-go/deepseek-v4-flash')).toBe(false)
  })

  it('a mix entry is used verbatim as the full model id (never re-split)', async () => {
    const reqs = await collectSampledRequests({
      nCandidates: 3,
      mixModels: ['ollama-local/qwen3.8:27b'],
    })
    expect(reqs).toHaveLength(2)
    expect(reqs[0]).toMatchObject({ provider: 'omni-chat', model: 'ollama-local/qwen3.8:27b' })
  })

  it('fewer mix entries than candidates: the tail falls back to anchor-model variants', async () => {
    const reqs = await collectSampledRequests({
      nCandidates: 6,
      mixModels: ['ollama-local/qwen3.8:27b'],
    })
    expect(reqs).toHaveLength(5)
    expect(reqs[0]).toMatchObject({ provider: 'omni-chat', model: 'ollama-local/qwen3.8:27b' })
    for (let i = 1; i < reqs.length; i++) {
      expect(reqs[i]!.model).toBe('opencode-go/deepseek-v4-flash')
    }
  })
})