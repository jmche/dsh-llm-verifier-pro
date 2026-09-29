import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { apply, resolveJev, type Config } from '../src/index'
import { JevBackend, JEV_LEVELS, systemOneEndpoint } from '../src/jev'
import { Verifier } from '../src/verifier'
import { verifyBest } from '../src/bon'
import { VerifierBackend } from '../src/backend'
import { VerifierError } from '../src/backend'

/**
 * The Jev selector: pairwise rewards from a System One endpoint. The mock
 * serves `/v1/systemone` with the documented wire shape
 * (https://docs.typesafe.ai/api.md) and logs `/v1/chat/completions` too, so a
 * test can prove the LLM verifier was never asked to score.
 */

interface Logged { path: string; body: Record<string, unknown>; auth: string | undefined }

interface MockSystemOne {
  baseUrl: string
  requests: Logged[]
  /** HTTP statuses to answer the next systemone requests with, before scoring normally. */
  failures: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>
  /** Delay every scored answer by this many ms. */
  delayMs: number
  /** Requests the client dropped before the answer was written. */
  aborted: number
  close(): Promise<void>
}

/** Score answer whose mass sits on `level` (0 = worst, top = best). */
function scoreAnswer(level: number): Record<string, unknown> {
  const probabilities: Record<string, number> = {}
  JEV_LEVELS.forEach((_, i) => { probabilities[String(i)] = i === level ? 1 : 0 })
  return { type: 'score', score: level, confidence: 1, legend: {}, probabilities }
}

/** A response is "good" when its text contains GOOD: it lands on the top level, anything else on level 1. */
const levelOf = (text: unknown) => (typeof text === 'string' && text.includes('GOOD') ? JEV_LEVELS.length - 1 : 1)

async function createMockSystemOne(): Promise<MockSystemOne> {
  const requests: Logged[] = []
  const failures: MockSystemOne['failures'] = []
  const control = { delayMs: 0, aborted: 0 }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = ''
    req.on('data', (chunk: Buffer) => (data += chunk.toString()))
    req.on('end', () => {
      const body = JSON.parse(data || '{}') as Record<string, unknown>
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      requests.push({ path, body, auth: req.headers.authorization })
      const respond = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers })
        res.end(JSON.stringify(payload))
      }
      if (path !== '/v1/systemone') return respond(404, { error: `unexpected ${path}` })
      const failure = failures.shift()
      if (failure) return respond(failure.status, failure.body ?? { detail: 'mock failure' }, failure.headers)
      const state = body.state as Record<string, unknown>
      res.on('close', () => { if (!res.writableEnded) control.aborted++ })
      const answer = () => respond(200, {
        model: 'jev-mock',
        answers: { score_A: scoreAnswer(levelOf(state.response_A)), score_B: scoreAnswer(levelOf(state.response_B)) },
        usage: { input_tokens: 300, output_tokens: 20 },
      })
      if (control.delayMs > 0) setTimeout(() => { if (!res.destroyed) answer() }, control.delayMs)
      else answer()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    failures,
    get delayMs() { return control.delayMs },
    set delayMs(ms: number) { control.delayMs = ms },
    get aborted() { return control.aborted },
    set aborted(n: number) { control.aborted = n },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

let mock: MockSystemOne | undefined
afterEach(async () => {
  await mock?.close()
  mock = undefined
  delete process.env.JEV_TEST_KEY
})

describe('systemOneEndpoint', () => {
  it('appends /systemone to a base URL and keeps a full endpoint as given', () => {
    expect(systemOneEndpoint('https://api.typesafe.ai/v1')).toBe('https://api.typesafe.ai/v1/systemone')
    expect(systemOneEndpoint('https://opencode.ai/zen/v1/')).toBe('https://opencode.ai/zen/v1/systemone')
    expect(systemOneEndpoint('https://opencode.ai/zen/v1/systemone')).toBe('https://opencode.ai/zen/v1/systemone')
  })
})

describe('JevBackend.scorePair', () => {
  it('sends the System One wire shape and maps the Score expectation to [0, 1]', async () => {
    mock = await createMockSystemOne()
    const jev = new JevBackend({ baseUrl: mock.baseUrl, model: 'jev-1.13-free', apiKey: 'k-123' })
    const [ra, rb] = await jev.scorePair('task text', 'GOOD answer', 'weak answer', { name: 'Correctness', description: 'Is it right?' }, 'see ref')
    expect(ra).toBe(1)
    expect(rb).toBeCloseTo(1 / (JEV_LEVELS.length - 1))
    const request = mock.requests[0]!
    expect(request.path).toBe('/v1/systemone')
    expect(request.auth).toBe('Bearer k-123')
    expect(request.body.model).toBe('jev-1.13-free')
    expect(request.body.state).toEqual({ task: 'task text', response_A: 'GOOD answer', response_B: 'weak answer', reference_note: 'see ref' })
    const questions = request.body.questions as Record<string, { type: string; criteria: unknown[]; instructions: { criterion: unknown } }>
    expect(Object.keys(questions)).toEqual(['score_A', 'score_B'])
    expect(questions.score_A!.type).toBe('score')
    expect(questions.score_A!.criteria).toEqual(JEV_LEVELS)
    expect(questions.score_B!.instructions.criterion).toEqual({ name: 'Correctness', description: 'Is it right?' })
    expect(jev.usage.snapshot()).toMatchObject({ calls: 1, inputTokens: 300, outputTokens: 20 })
  })

  it('sends no Authorization header without a key (keyless free tiers)', async () => {
    mock = await createMockSystemOne()
    await new JevBackend({ baseUrl: mock.baseUrl }).scorePair('t', 'a', 'b', { name: 'c', description: 'c' })
    expect(mock.requests[0]!.auth).toBeUndefined()
  })

  it('retries 429/529 and then scores', async () => {
    mock = await createMockSystemOne()
    mock.failures.push({ status: 429 }, { status: 529 })
    const [ra] = await new JevBackend({ baseUrl: mock.baseUrl }).scorePair('t', 'GOOD', 'b', { name: 'c', description: 'c' })
    expect(ra).toBe(1)
    expect(mock.requests).toHaveLength(3)
  })

  it('raises a VerifierError carrying the status when the state is too long', async () => {
    mock = await createMockSystemOne()
    mock.failures.push({ status: 400, body: { detail: { error_type: 'max_tokens_exceeded' } } })
    const error = await new JevBackend({ baseUrl: mock.baseUrl }).scorePair('t', 'a', 'b', { name: 'c', description: 'c' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VerifierError)
    expect((error as VerifierError).message).toContain('max_tokens_exceeded')
  })
})

describe('JevBackend failure edges', () => {
  it('an abort during the retry wait rejects at once, not after Retry-After', async () => {
    mock = await createMockSystemOne()
    mock.failures.push({ status: 429, headers: { 'retry-after': '30' } })
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 100)
    const started = Date.now()
    const error = await new JevBackend({ baseUrl: mock.baseUrl }).scorePair('t', 'a', 'b', { name: 'c', description: 'c' }, '', controller.signal).catch((e: unknown) => e)
    expect(Date.now() - started).toBeLessThan(2000)
    expect(String((error as Error).message)).toContain('cancelled')
  })

  it('caps Retry-After at the request timeout', async () => {
    mock = await createMockSystemOne()
    mock.failures.push({ status: 429, headers: { 'retry-after': '3600' } })
    const started = Date.now()
    const [ra] = await new JevBackend({ baseUrl: mock.baseUrl, timeoutMs: 200 }).scorePair('t', 'GOOD', 'b', { name: 'c', description: 'c' })
    expect(ra).toBe(1)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(150)
    expect(waited).toBeLessThan(2000)
  })

  it('gives up with the status after the retries run out', async () => {
    mock = await createMockSystemOne()
    for (let i = 0; i < 4; i++) mock.failures.push({ status: 429, headers: { 'retry-after': '0.01' } })
    const error = await new JevBackend({ baseUrl: mock.baseUrl }).scorePair('t', 'a', 'b', { name: 'c', description: 'c' }).catch((e: unknown) => e)
    expect((error as VerifierError).status).toBe(429)
    expect(mock.requests).toHaveLength(4)
  })
})

describe('verifyBest with the Jev selector', () => {
  it('maps swapped-slot rewards back to candidate order', async () => {
    mock = await createMockSystemOne()
    const jev = new JevBackend({ baseUrl: mock.baseUrl })
    // nEvaluations 2: the odd rep swaps the slots. A wrong swap-back would
    // hand the weak candidates the GOOD score half the time.
    const result = await verifyBest(new VerifierBackend({}), 'unused', 'pick', ['weak 0', 'GOOD 1', 'weak 2'], { jev, nEvaluations: 2 })
    expect(result.bestIndex).toBe(1)
    const byIndex = new Map(result.ranking.map((r) => [r.index, r.normalized]))
    expect(byIndex.get(1)! - byIndex.get(0)!).toBeGreaterThan(0.2)
    expect(byIndex.get(0)).toBeCloseTo(byIndex.get(2)!)
    expect(mock.requests.some((r) => (r.body.state as { response_A: string }).response_A === 'GOOD 1')).toBe(true)
    expect(mock.requests.some((r) => (r.body.state as { response_B: string }).response_B === 'GOOD 1')).toBe(true)
  })
})

describe('Verifier with the Jev selector', () => {
  it('select ranks with Jev and never calls the LLM verifier; track is untouched', async () => {
    mock = await createMockSystemOne()
    const jev = new JevBackend({ baseUrl: mock.baseUrl })
    const verifier = new Verifier({ baseUrl: mock.baseUrl, model: 'llm-verifier' }, jev)
    const result = await verifier.select('pick', ['weak 0', 'weak 1', 'GOOD 2', 'weak 3'], { Correctness: 'right?' }, { nEvaluations: 2 })
    expect(result.index).toBe(2)
    expect(mock.requests.every((r) => r.path === '/v1/systemone')).toBe(true)
    expect(result.usage.calls).toBe(mock.requests.length)
    const compared = await verifier.compare('pick', 'weak', 'GOOD', { Correctness: 'right?' })
    expect(compared.scoreB).toBeGreaterThan(compared.scoreA)
  })
})

describe('cancellation with the Jev selector', () => {
  it('a caller abort rejects select instead of being scored as ties', async () => {
    mock = await createMockSystemOne()
    mock.delayMs = 2000
    const verifier = new Verifier({}, new JevBackend({ baseUrl: mock.baseUrl }))
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled')), 100)
    const outcome = await verifier.select('pick', ['a', 'b', 'c'], { C: 'c' }, { nEvaluations: 1, signal: controller.signal }).then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(outcome).toBe('rejected')
  })
})

describe('resolveJev', () => {
  const ctx = new Context()
  it('warns once per unknown selector value', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await resolveJev(ctx, { selector: 'JEV-typo' } as Config)
    await resolveJev(ctx, { selector: 'JEV-typo' } as Config)
    expect(spy.mock.calls.filter((call) => String(call[0]).includes('JEV-typo'))).toHaveLength(1)
    spy.mockRestore()
  })
  it('is off unless selector is jev, and never resolves the Jev key when off', async () => {
    expect(await resolveJev(ctx, {} as Config)).toBeUndefined()
    expect(await resolveJev(ctx, { selector: 'llm', jevApiKey: 'env:JEV_UNSET_KEY' } as Config)).toBeUndefined()
  })
  it('defaults to TypeSafe and resolves an env: key', async () => {
    process.env.JEV_TEST_KEY = 'from-env'
    const jev = await resolveJev(ctx, { selector: 'jev', jevApiKey: 'env:JEV_TEST_KEY' } as Config)
    expect(jev!.config).toMatchObject({ endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest', apiKey: 'from-env' })
  })
  it('uses the configured provider endpoint and model', async () => {
    const jev = await resolveJev(ctx, { selector: 'jev', jevBaseUrl: 'https://opencode.ai/zen/v1', jevModel: 'jev-1.13-free' } as Config)
    expect(jev!.config).toMatchObject({ endpoint: 'https://opencode.ai/zen/v1/systemone', model: 'jev-1.13-free' })
    expect(jev!.config.apiKey).toBeUndefined()
  })
})

/** One assistant text message as a stream. */
function textStream(text: string): AsyncIterable<StreamChunk> {
  return (async function* () {
    yield { type: 'block-start', index: 0, blockType: 'text' } as never as StreamChunk
    yield { type: 'text-delta', index: 0, text } as never as StreamChunk
    yield { type: 'block-end', index: 0, block: { type: 'text', text } } as never as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as never as StreamChunk
  })()
}

/** Apply the plugin with a faithful llm seam; candidate 1 is the good one, the anchor and candidate 2 are weak. */
function boNHarness(cfg: Partial<Config>) {
  const ctx = new Context()
  ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { section: vi.fn() }
  ;(ctx as unknown as { tools: unknown }).tools = { register: vi.fn() }
  const waterfall = (ctx as unknown as { waterfall: (...args: unknown[]) => unknown }).waterfall.bind(ctx)
  let slot = 0
  ;(ctx as unknown as { llm: unknown }).llm = {
    stream: (opts: GenerateOptions) => waterfall('llm/stream', opts, () => textStream(++slot === 1 ? 'GOOD candidate answer' : 'weak candidate answer')),
  }
  apply(ctx, { boN: true, boNCandidates: 3, showFooter: true, verifyTimeoutMsBoN: 5000, timeoutMsBoN: 5000, selector: 'jev', jevBaseUrl: mock!.baseUrl, ...cfg } as Config)
  return async (): Promise<string> => {
    const request = { provider: 'omni-chat', model: 'm', messages: [{ role: 'user', content: 'Answer well.' }], sessionId: 'sess-jev' } as unknown as GenerateOptions
    const out: StreamChunk[] = []
    for await (const chunk of waterfall('llm/stream', request, () => textStream('weak anchor answer')) as AsyncIterable<StreamChunk>) out.push(chunk)
    return out.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
  }
}

describe('Bo-N turn with selector: jev', () => {
  it('still ranks with Jev when the LLM verifier config cannot resolve', async () => {
    mock = await createMockSystemOne()
    const text = await boNHarness({ apiKey: 'credential:MISSING_LLM_KEY' })()
    expect(text).toContain('GOOD candidate answer')
    expect(text).toContain('· Jev ·')
  })

  it('the verify deadline aborts in-flight Jev requests', async () => {
    mock = await createMockSystemOne()
    mock.delayMs = 3000
    const text = await boNHarness({ verifyTimeoutMsBoN: 200 })()
    expect(text).toContain('Best-of-N skipped')
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(mock.aborted).toBeGreaterThan(0)
  })

  it('ranks the candidates through the configured System One endpoint and replays the winner', async () => {
    mock = await createMockSystemOne()
    const ctx = new Context()
    ;(ctx as unknown as { systemPrompt: unknown }).systemPrompt = { section: vi.fn() }
    ;(ctx as unknown as { tools: unknown }).tools = { register: vi.fn() }
    const waterfall = (ctx as unknown as { waterfall: (...args: unknown[]) => unknown }).waterfall.bind(ctx)
    let slot = 0
    ;(ctx as unknown as { llm: unknown }).llm = {
      // Candidate 1 is the good one; the anchor and candidate 2 are weak.
      stream: (opts: GenerateOptions) => waterfall('llm/stream', opts, () => textStream(++slot === 1 ? 'GOOD candidate answer' : 'weak candidate answer')),
    }
    process.env.JEV_TEST_KEY = 'zen-key'
    apply(ctx, {
      boN: true, boNCandidates: 3, showFooter: true, verifyTimeoutMsBoN: 5000, timeoutMsBoN: 5000,
      selector: 'jev', jevBaseUrl: mock.baseUrl, jevModel: 'jev-1.13-free', jevApiKey: 'env:JEV_TEST_KEY',
      baseUrl: mock.baseUrl, model: 'llm-verifier',
    } as Config)
    const request: GenerateOptions = {
      provider: 'omni-chat',
      model: 'm',
      messages: [{ role: 'user', content: 'Answer well.' }],
      sessionId: 'sess-jev' as never,
    } as GenerateOptions
    const out: StreamChunk[] = []
    for await (const chunk of waterfall('llm/stream', request, () => textStream('weak anchor answer')) as AsyncIterable<StreamChunk>) out.push(chunk)
    const text = out.filter((c) => c.type === 'text-delta').map((c) => (c as { text: string }).text).join('')
    expect(text).toContain('GOOD candidate answer')
    expect(text).toContain('· Jev ·')
    expect(mock.requests.length).toBeGreaterThan(0)
    expect(mock.requests.every((r) => r.path === '/v1/systemone' && r.auth === 'Bearer zen-key' && r.body.model === 'jev-1.13-free')).toBe(true)
  })
})
