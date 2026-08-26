/**
 * A tiny in-process OpenAI-compatible mock server for tests. It serves
 * GET /v1/models and POST /v1/chat/completions, and lets each test decide
 * every response (or status) in FIFO order, while logging every request.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface RequestLog {
  path: string
  body: Record<string, unknown>
}

export interface MockOpenAIServer {
  /** Base URL ending in /v1 (no trailing slash). */
  baseUrl: string
  requests: RequestLog[]
  /** Replace the response queue (each item: HTTP status or a response body). */
  setResponses(responses: Array<number | Record<string, unknown>>): void
  /** Answer every chat.completions request through a live function of its body. */
  setScript(fn: (body: Record<string, unknown>) => Record<string, unknown>): void
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => (data += chunk.toString()))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export async function createMockOpenAI(): Promise<MockOpenAIServer> {
  const requests: RequestLog[] = []
  let responses: Array<number | Record<string, unknown>> = []
  let script: ((body: Record<string, unknown>) => Record<string, unknown>) | undefined

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (req.method === 'GET' && url.pathname === '/v1/models') {
          requests.push({ path: url.pathname, body: {} })
          respond(200, { data: [{ id: 'mock-verifier-model' }] })
          return
        }
        if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
          const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
          requests.push({ path: url.pathname, body })
          if (script) {
            respond(200, script(body))
            return
          }
          const next = responses.shift()
          if (typeof next === 'number') {
            respond(next, { error: { message: `mock status ${next}` } })
          } else if (next === undefined) {
            respond(200, {})
          } else {
            respond(200, next)
          }
          return
        }
        respond(404, { error: { message: `unexpected ${req.method} ${url.pathname}` } })
      } catch (error) {
        respond(500, { error: { message: String(error) } })
      }
    })()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    setResponses(next) {
      script = undefined
      responses = [...next]
    },
    setScript(fn) {
      responses = []
      script = fn
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

export interface LogprobsPosition {
  token: string
  logprob: number
  top_logprobs?: Array<{ token: string; logprob: number }>
}

/**
 * Build an OpenAI chat.completions response with token-level logprobs.
 * `positions` parallel `tokens`; the letter positions carry the controlled
 * distributions the score extractors read.
 */
export function completion(
  content: string,
  tokens: string[],
  positions: LogprobsPosition[],
  usage: Record<string, unknown> = {
    prompt_tokens: 10,
    completion_tokens: tokens.length,
    prompt_tokens_details: { cached_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  },
): Record<string, unknown> {
  return {
    choices: [
      {
        message: { role: 'assistant', content },
        finish_reason: 'stop',
        logprobs: { content: positions },
      },
    ],
    usage,
  }
}

/**
 * A pairwise response emitting `<score_A> G </score_A>` / `<score_B> T
 * </score_B>` with full probability mass on the emitted letters.
 */
export function pairwiseCompletion(scoreA: string, scoreB: string, usage?: Record<string, unknown>) {
  const tokens = ['<score_A>', scoreA, '<score_B>', scoreB]
  return completion(
    `<score_A> ${scoreA} </score_A>\n<score_B> ${scoreB} </score_B>`,
    tokens,
    [
      { token: '<score_A>', logprob: 0 },
      { token: scoreA, logprob: 0, top_logprobs: [{ token: scoreA, logprob: 0 }] },
      { token: '<score_B>', logprob: 0 },
      { token: scoreB, logprob: 0, top_logprobs: [{ token: scoreB, logprob: 0 }] },
    ],
    usage,
  )
}
