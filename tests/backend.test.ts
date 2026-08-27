import { afterEach, describe, expect, it } from 'vitest'
import { MissingAPIKeyError, TokenUsage, VerifierBackend, VerifierError } from '../src/backend'
import { createMockOpenAI, completion, type MockOpenAIServer } from './helpers/mock-openai'

const log = Math.log
let mock: MockOpenAIServer | undefined

afterEach(async () => {
  delete process.env.DEEPSEEK_API_KEY
  delete process.env.OPENAI_API_KEY
  delete process.env.OPENAI_BASE_URL
  await mock?.close()
  mock = undefined
})

describe('TokenUsage', () => {
  it('records an OpenAI-compatible usage block and derives cached/uncached', () => {
    const usage = new TokenUsage()
    usage.record({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 60 },
        completion_tokens_details: { reasoning_tokens: 5 },
      },
    })
    const snapshot = usage.snapshot()
    expect(snapshot).toMatchObject({
      calls: 1,
      inputTokens: 100,
      cachedInputTokens: 60,
      uncachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 5,
    })
    expect(snapshot.cacheHitRate).toBeCloseTo(0.6, 12)
  })

  it('is a no-op for responses without a usage block and supports reset', () => {
    const usage = new TokenUsage()
    usage.record({})
    expect(usage.snapshot().calls).toBe(0)
    usage.record({ usage: { prompt_tokens: 10, completion_tokens: 2 } })
    expect(usage.snapshot().calls).toBe(1)
    usage.reset()
    expect(usage.snapshot().calls).toBe(0)
  })
})

describe('VerifierBackend.chat', () => {
  it('calls the chat completions endpoint with logprobs and parses the result', async () => {
    mock = await createMockOpenAI()
    const response = completion('analysis', ['<score_A>', 'G'], [
      { token: '<score_A>', logprob: 0 },
      { token: 'G', logprob: 0, top_logprobs: [{ token: 'G', logprob: log(1) }] },
    ])
    mock.setResponses([response])

    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'test', model: 'm' })
    const out = await backend.chat('prompt')
    expect(out.text).toBe('analysis')
    expect(out.tokens).toEqual(['<score_A>', 'G'])
    expect(out.positionLogprobs).toHaveLength(2)
    expect(out.positionLogprobs[1]?.[0]?.token).toBe('G')

    const req = mock.requests[0]!
    expect(req.path).toBe('/v1/chat/completions')
    expect(req.body).toMatchObject({ model: 'm', logprobs: true, top_logprobs: 20, temperature: 1 })
    expect(backend.usage.snapshot().calls).toBe(1)
  })

  it('raises MissingAPIKeyError when no credentials are configured', async () => {
    const backend = new VerifierBackend({})
    await expect(backend.chat('prompt')).rejects.toBeInstanceOf(MissingAPIKeyError)
  })

  it('resolves DeepSeek credentials from the environment', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const backend = VerifierBackend.fromEnvironment({})
    expect(backend.config).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'sk-test',
      deepseek: true,
    })
  })

  it('sends the DeepSeek thinking params and budget on the deepseek path', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([completion('x', [], [])])

    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', deepseek: true })
    await backend.chat('prompt')
    const req = mock.requests[0]!
    expect(req.body).toMatchObject({ model: 'deepseek-v4-flash', max_tokens: 32768 })
    expect(req.body.extra_body).toMatchObject({ thinking: { type: 'enabled' } })
  })

  it('resolves the model from GET /models once when none is configured', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([completion('a', [], []), completion('b', [], [])])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k' })
    await backend.chat('p1')
    await backend.chat('p2')
    expect(mock.requests.filter((r) => r.path === '/v1/models')).toHaveLength(1)
    expect(mock.requests.filter((r) => r.path === '/v1/chat/completions')).toHaveLength(2)
    expect(mock.requests[1]!.body.model).toBe('mock-verifier-model')
  })

  it('raises VerifierError with the status when every attempt fails', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([500, 500])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm' })
    await expect(backend.chat('prompt')).rejects.toThrowError(/500/)
    await expect(backend.chat('prompt')).rejects.toBeInstanceOf(VerifierError)
  })

  it('retries without the chat_template_kwargs extra body when the server rejects it', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([400, completion('ok', [], [])])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm' })
    const out = await backend.chat('prompt')
    expect(out.text).toBe('ok')
    expect(mock.requests).toHaveLength(2)
    expect(mock.requests[0]!.body.extra_body).toMatchObject({ chat_template_kwargs: { enable_thinking: false } })
    expect(mock.requests[1]!.body.extra_body).toBeUndefined()
  })

  it('skips prefill when the main response already carries a scoreable tag + logprobs', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([
      completion('<score_A> G </score_A>\n<score_B> T </score_B>', ['<score_A>', 'G', '<score_B>', 'T'], [
        { token: '<score_A>', logprob: 0 },
        { token: 'G', logprob: 0, top_logprobs: [{ token: 'G', logprob: log(1) }] },
        { token: '<score_B>', logprob: 0 },
        { token: 'T', logprob: 0, top_logprobs: [{ token: 'T', logprob: log(1) }] },
      ]),
    ])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm' })
    const out = await backend.chat('...<score_A>...<score_B>...')
    // Scoreable in the main response: no prefill call, tokens stay verbatim.
    expect(out.tokens).toEqual(['<score_A>', 'G', '<score_B>', 'T'])
    expect(mock.requests).toHaveLength(1)
  })

  it('runs the prefill pass per missing tag and reconstructs the tag tokens', async () => {
    mock = await createMockOpenAI()
    // Main call returns analysis without tags; two prefill calls follow, one per tag.
    mock.setResponses([
      completion('careful analysis only', ['careful'], [{ token: 'careful', logprob: 0 }]),
      {
        choices: [{ message: { content: 'B' }, logprobs: { content: [{ token: 'B', logprob: 0, top_logprobs: [{ token: 'B', logprob: 0 }] }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
      {
        choices: [{ message: { content: 'T' }, logprobs: { content: [{ token: 'T', logprob: 0, top_logprobs: [{ token: 'T', logprob: 0 }] }] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      },
    ])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm' })
    const out = await backend.chat('...<score_A>...<score_B>...')
    expect(out.tokens).toEqual(['\n<score_A>', 'B', '</score_A>', '\n<score_B>', 'T', '</score_B>'])
    expect(mock.requests).toHaveLength(3)
    expect(mock.requests[1]!.body.extra_body).toMatchObject({
      add_generation_prompt: false,
      continue_final_message: true,
    })
    expect(mock.requests[1]!.body.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: 'careful analysis only\n<score_A>',
    })
  })

  it('falls back to the tag-less reply when prefill fails', async () => {
    mock = await createMockOpenAI()
    mock.setResponses([completion('no tags', ['no'], [{ token: 'no', logprob: 0 }]), 400])
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm' })
    const out = await backend.chat('...<score_A>...<score_B>...')
    expect(out.text).toBe('no tags')
    // Upstream parity: a failed prefill leaves the analysis without tokens.
    expect(out.tokens).toBeUndefined()
  })
})

describe('VerifierBackend.runAll', () => {
  it('bounds in-flight requests by maxConcurrency', async () => {
    mock = await createMockOpenAI()
    const inFlight = { now: 0, max: 0 }
    mock.setResponses(
      Array.from({ length: 6 }, () => ({
        choices: [{ message: { content: 'ok' }, logprobs: { content: [] } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    )
    const backend = new VerifierBackend({ baseUrl: mock.baseUrl, apiKey: 'k', model: 'm', maxConcurrency: 2 })
    const wrapped = (prompt: string) => async () => {
      inFlight.now++
      inFlight.max = Math.max(inFlight.max, inFlight.now)
      try {
        return await backend.chat(prompt)
      } finally {
        inFlight.now--
      }
    }
    const results = await backend.runAll(['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(wrapped))
    expect(results).toHaveLength(6)
    expect(inFlight.max).toBe(2)
  })
})
