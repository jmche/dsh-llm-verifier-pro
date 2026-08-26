import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply } from '../src/index'
import { createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'

describe('live integration (post-uninstall standalone)', () => {
  it('registers and executes verify_compare via the real apply()', async () => {
    const mock: MockOpenAIServer = await createMockOpenAI()
    mock.setScript(() => pairwiseCompletion(' A ', ' G '))

    const ctx = new Context()
    const registered: ToolDefinition[] = []
    ;(ctx as unknown as { tools: unknown }).tools = { register: (def: ToolDefinition) => registered.push(def) }
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { section: () => {} }
    ;(ctx as unknown as { llm: unknown }).llm = { stream: () => [][Symbol.asyncIterator]() }
    apply(ctx as never, {
      baseUrl: mock.baseUrl,
      apiKey: 'test-key',
      model: 'mock-model',
      prefill: false,
      boN: false,
    } as never)

    const compare = registered.find((t) => t.name === 'verify_compare')
    expect(compare, 'verify_compare registered').toBeDefined()
    const controller = new AbortController()
    const result = await compare!.execute(
      { problem: 'Test task', candidateA: 'solution A', candidateB: 'solution B', criteria: { Correctness: 'Does it work?' } },
      { signal: controller.signal } as never,
    ) as { scoreA: number; scoreB: number }
    expect(mock.requests.length).toBeGreaterThan(0)
    expect(result.scoreA).toBeGreaterThan(0)
    expect(result.scoreB).toBeGreaterThan(0)
    // A (best) should outscore G on the 20-letter scale.
    expect(result.scoreA).toBeGreaterThan(result.scoreB)
    await mock.close()
  })
})