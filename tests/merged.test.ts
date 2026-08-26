import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, inject, resolveBoNMode, resolveBackend } from '../src/index'
import { createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'
import { verifyBest } from '../src/bon'
import { VerifierBackend } from '../src/backend'

let mock: MockOpenAIServer | undefined

afterEach(async () => {
  await mock?.close()
  mock = undefined
})

function harness() {
  const registered: ToolDefinition[] = []
  const ctx = new Context()
  ;(ctx as unknown as { tools: unknown }).tools = {
    register: vi.fn((def: ToolDefinition) => registered.push(def)),
  }
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = {
    section: vi.fn(),
  }
  ;(ctx as unknown as { llm: unknown }).llm = {
    stream: vi.fn(() => [][Symbol.asyncIterator]()),
  }
  return { ctx, registered }
}

async function execute(def: ToolDefinition, args: Record<string, unknown>) {
  const controller = new AbortController()
  return def.execute(args, { signal: controller.signal } as never)
}

function scoreLetter(letter: string): Record<string, unknown> {
  return pairwiseCompletion(` ${letter} `, ` ${letter} `)
}

describe('plugin shape (merged)', () => {
  it('declares the merged plugin name and service injections', () => {
    expect(name).toBe('llm-verifier-pro')
    expect(inject).toContain('tools')
    expect(inject).toContain('systemPrompt')
    expect(inject).toContain('llm') // Best-of-N sampling re-entry
  })

  it('registers verify_compare, verify_select and verify_track by default', () => {
    const h = harness()
    apply(h.ctx, {})
    const names = h.registered.map((def) => def.name).sort()
    expect(names).toEqual(['verify_compare', 'verify_select', 'verify_track'])
    expect(h.ctx.systemPrompt.section).toHaveBeenCalledOnce()
  })

  it('honours the per-tool enable flags', () => {
    const h = harness()
    apply(h.ctx, { compare: false, track: false })
    const names = h.registered.map((def) => def.name)
    expect(names).toEqual(['verify_select'])
  })

  it('declares coherent tool schemas', () => {
    const h = harness()
    apply(h.ctx, {})
    for (const def of h.registered) {
      expect(def.parameters, `${def.name} parameters`).toBeDefined()
      const params = def.parameters as { properties?: Record<string, unknown> }
      expect(params.properties?.problem, `${def.name} problem param`).toBeDefined()
    }
  })
})

describe('resolveBoNMode (three-state gating)', () => {
  const ctx = { get: vi.fn(() => undefined) } as never

  it('is off by default', () => {
    const decision = resolveBoNMode(ctx, {}, undefined, () => ({}))
    expect(decision).toEqual({ enabled: false, nCandidates: 0, source: 'off' })
  })

  it('settings-global switch wins', () => {
    const decision = resolveBoNMode(ctx, { boN: false }, undefined, () => ({ boN: true, boNCandidates: 3 }))
    expect(decision).toEqual({ enabled: true, nCandidates: 3, source: 'settings-global' })
  })

  it('config default applies when no session preset matches', () => {
    const decision = resolveBoNMode(ctx, { boN: true, boNCandidates: 5 }, 's1', () => ({}))
    expect(decision.source).toBe('config-default')
    expect(decision.enabled).toBe(true)
    expect(decision.nCandidates).toBe(5)
  })

  it('explicit settings false beats config default', () => {
    const decision = resolveBoNMode(ctx, { boN: true }, undefined, () => ({ boN: false }))
    expect(decision.source).toBe('off')
  })
})

describe('verifyBest over the TM backend (merged path)', () => {
  it('ranks candidates via the mock server and returns the best index', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([
      scoreLetter('A'), // ring pair 0->1: A beats B
      scoreLetter('B'), // ring pair 1->2: B beats C
      scoreLetter('C'), // ring pair 2->0: C loses to A (ring closes)
      scoreLetter('A'), // pivot rounds non-pivot x pivot
    ])
    const backend = new VerifierBackend({
      baseUrl: mock.baseUrl,
      apiKey: 'test-key',
      prefill: false,
    })
    const result = await verifyBest(backend, 'mock-model', 'Pick the best.', ['candidate A', 'candidate B', 'candidate C'], {})
    expect(result.ranking.length).toBe(3)
    expect(result.callsSpent).toBeGreaterThan(0)
    expect(mock.requests.length).toBeGreaterThan(0)
    // Every request must have carried the pairwise prompt with both score tags.
    for (const req of mock.requests) {
      const body = req.body as { messages?: Array<{ content?: string }> }
      const content = body.messages?.[0]?.content ?? ''
      expect(content).toContain('<score_A>')
      expect(content).toContain('<score_B>')
    }
  })
})

describe('resolveBackend (zero-config inheritance)', () => {
  it('resolves explicit config when nothing else is set', async () => {
    const ctx = { get: vi.fn(() => undefined) } as never
    const backend = await resolveBackend(ctx, {
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      model: 'deepseek-v4-flash',
    })
    expect(backend.config.baseUrl).toBe('https://api.deepseek.com')
    expect(backend.config.apiKey).toBe('sk-test')
    expect(backend.config.model).toBe('deepseek-v4-flash')
    expect(backend.config.deepseek).toBe(true)
  })

  it('accepts the credential: reference form and falls back to the settings section', async () => {
    const ctx = {
      get: vi.fn(() => ({
        resolve: async () => ({ value: 'seam-key' }),
      })),
    } as never
    const backend = await resolveBackend(ctx, {}, undefined, () => ({ baseURL: 'https://omni.example/v1', apiKey: 'credential:OMNI_CHAT_API_KEY' }))
    expect(backend.config.baseUrl).toBe('https://omni.example/v1')
    expect(backend.config.apiKey).toBe('seam-key')
  })
})