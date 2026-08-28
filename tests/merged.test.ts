import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Context } from '@deepseek-ai/cordis'
import { apply, name, inject, resolveBoNMode, resolveBackend } from '../src/index'
import { completion, createMockOpenAI, pairwiseCompletion, type MockOpenAIServer } from './helpers/mock-openai'
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

describe('resolveBoNMode (settings global → config default → off)', () => {
  it('is off by default', () => {
    expect(resolveBoNMode({}, () => ({}))).toEqual({ enabled: false, nCandidates: 0, source: 'off' })
  })

  it('the settings switch wins over the config default', () => {
    const decision = resolveBoNMode({ boN: true, boNCandidates: 5 }, () => ({ boN: true, boNCandidates: 3 }))
    expect(decision).toEqual({ enabled: true, nCandidates: 3, source: 'settings-global' })
  })

  it('an explicit settings Off is the master kill-switch', () => {
    const decision = resolveBoNMode({ boN: true }, () => ({ boN: false }))
    expect(decision.source).toBe('off')
    expect(decision.enabled).toBe(false)
  })

  it('the config default applies when the switch is unset', () => {
    const decision = resolveBoNMode({ boN: true, boNCandidates: 5 }, () => ({}))
    expect(decision.source).toBe('config-default')
    expect(decision.enabled).toBe(true)
    expect(decision.nCandidates).toBe(5)
  })

  it('an unset switch falls back to the section candidate count over the config', () => {
    const decision = resolveBoNMode({ boNCandidates: 5 }, () => ({ boN: true, boNCandidates: 4 }))
    expect(decision).toEqual({ enabled: true, nCandidates: 4, source: 'settings-global' })
  })
})

describe('VerifierBackend autoDegrade', () => {
  const noLogprobsCompletion = (content: string): Record<string, unknown> => ({
    choices: [
      { message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  })

  it('falls back to sampling scoring (default) when the endpoint has no logprobs', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([noLogprobsCompletion('<score_A> K </score_A>\n<score_B> L </score_B>')])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test-key', prefill: false })
    const out = await backend.chat('task with <score_A> and <score_B>')
    expect(backend.lastGradingMode).toBe('sampling')
    expect(out.text).toContain('<score_A>')
  })

  it('strict mode raises when the endpoint has no logprobs', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([noLogprobsCompletion('<score_A> K </score_A>')])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test-key', prefill: false, autoDegrade: false })
    await expect(backend.chat('task with <score_A> and <score_B>')).rejects.toThrow(/autoDegrade/i)
    expect(backend.lastGradingMode).toBeUndefined()
  })

  it('records logprob grading when the endpoint provides logprobs', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([scoreLetter('A')])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test-key', prefill: false })
    await backend.chat('task with <score_A> and <score_B>')
    expect(backend.lastGradingMode).toBe('logprob')
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

  it('zero-config: follows the session provider + model (any route)', async () => {
    const ctx = {
      get: vi.fn((key: string) => {
        if (key === 'settings') {
          return {
            get: () => ({
              providers: {
                'omni-chat': { baseURL: 'https://session-gw.example/v1', apiKeyEnv: 'OMNI_CHAT_API_KEY' },
              },
            }),
          }
        }
        if (key === 'credentials') return { resolve: async () => ({ value: 'session-key' }) }
        return undefined
      }),
    } as never
    const conversation = { provider: 'omni-chat', model: 'opencode-go/deepseek-v4-flash' } as never
    const backend = await resolveBackend(ctx, {}, conversation, () => ({}))
    expect(backend.config.baseUrl).toBe('https://session-gw.example/v1')
    expect(backend.config.model).toBe('opencode-go/deepseek-v4-flash')
    expect(backend.config.apiKey).toBe('session-key')
    expect(backend.config.deepseek).toBe(false)
  })

  it('verifier route: provider/model resolves endpoint from the provider config', async () => {
    const ctx = {
      llm: { listProviders: () => [{ id: 'omni-chat', name: '' }] },
      get: vi.fn((key: string) => {
        if (key === 'settings') {
          return { get: () => ({ providers: { 'omni-chat': { baseURL: 'https://gw.example/v1', apiKeyEnv: 'OMNI_CHAT_API_KEY' } } }) }
        }
        if (key === 'credentials') return { resolve: async () => ({ value: 'gw-key' }) }
        return undefined
      }),
    } as never
    const backend = await resolveBackend(ctx, {}, undefined, () => ({ verifier: 'omni-chat/ollama-local/qwen3.8:27b' }))
    expect(backend.config.baseUrl).toBe('https://gw.example/v1')
    expect(backend.config.model).toBe('ollama-local/qwen3.8:27b')
    expect(backend.config.apiKey).toBe('gw-key')
  })

  it('verifier bare model id rides the session provider', async () => {
    const ctx = {
      get: vi.fn((key: string) => {
        if (key === 'settings') {
          return { get: () => ({ providers: { 'omni-chat': { baseURL: 'https://gw.example/v1', apiKeyEnv: 'OMNI_CHAT_API_KEY' } } }) }
        }
        if (key === 'credentials') return { resolve: async () => ({ value: 'gw-key-2' }) }
        return undefined
      }),
    } as never
    const conversation = { provider: 'omni-chat', model: 'x' } as never
    const backend = await resolveBackend(ctx, {}, conversation, () => ({ verifier: 'deepseek-chat' }))
    expect(backend.config.baseUrl).toBe('https://gw.example/v1')
    expect(backend.config.model).toBe('deepseek-chat')
  })
})
describe('prefill gating (main response usable -> skip)', () => {
  it('skips prefill when the main response already carries a scoreable tag + logprobs', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([scoreLetter('A')])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test-key', prefill: true })
    await backend.chat('task with <score_A> and <score_B>')
    const chatCalls = mock.requests.filter((r) => r.path === '/v1/chat/completions').length
    expect(chatCalls).toBe(1)
  })

  it('prefills only when the main response lacks scoreable content', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([
      // main response: open model that omitted the score tags
      { choices: [{ message: { role: 'assistant', content: 'reasoning only, no tags' }, finish_reason: 'stop' }] },
      // prefill response per tag: constrained letter distributions
      completion('K', ['K'], [{ token: 'K', logprob: 0, top_logprobs: [{ token: 'K', logprob: 0 }] }]),
      completion('L', ['L'], [{ token: 'L', logprob: 0, top_logprobs: [{ token: 'L', logprob: 0 }] }]),
    ])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test-key', prefill: true })
    const out = await backend.chat('task with <score_A> and <score_B>')
    // main call + one prefill per score tag (<score_A>, <score_B>)
    const chatCalls = mock.requests.filter((r) => r.path === '/v1/chat/completions').length
    expect(chatCalls).toBe(3)
    expect(out.text).toContain('<score_A>')
  })
})
