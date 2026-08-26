/**
 * Verifier backend: any OpenAI-compatible server that returns token-level
 * logprobs (vLLM, SGLang, OpenAI, DeepSeek). Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * Credentials resolve in order: explicit config, `OPENAI_BASE_URL` +
 * `OPENAI_API_KEY`, then `DEEPSEEK_API_KEY` (which implies the DeepSeek
 * endpoint with thinking enabled). Token usage is accumulated per backend.
 *
 * @module dsh-llm-as-a-verifier/backend
 */

import type { LogprobToken, VerifierOutput } from './scoring.js'

/** No verifier backend could be configured. */
export class MissingAPIKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingAPIKeyError'
  }
}

/** A verifier backend call failed (HTTP error, timeout, or malformed reply). */
export class VerifierError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'VerifierError'
  }
}

export interface TokenUsageSnapshot {
  calls: number
  inputTokens: number
  cachedInputTokens: number
  uncachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  cacheHitRate: number
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0
}

/** Thread-safe (single-threaded) running total of verifier token usage. */
export class TokenUsage {
  private calls = 0
  private inputTokens = 0
  private cachedInputTokens = 0
  private outputTokens = 0
  private reasoningTokens = 0

  reset(): void {
    this.calls = 0
    this.inputTokens = 0
    this.cachedInputTokens = 0
    this.outputTokens = 0
    this.reasoningTokens = 0
  }

  add(
    inputTokens = 0,
    cachedInputTokens = 0,
    outputTokens = 0,
    reasoningTokens = 0,
    calls = 1,
  ): void {
    this.calls += calls
    this.inputTokens += inputTokens
    this.cachedInputTokens += cachedInputTokens
    this.outputTokens += outputTokens
    this.reasoningTokens += reasoningTokens
  }

  /** Record one backend response's usage; a no-op when no usage block is present. */
  record(response: Record<string, unknown>): void {
    const usage = response.usage as Record<string, unknown> | undefined
    if (!usage) return
    const promptDetails = usage.prompt_tokens_details as Record<string, unknown> | undefined
    const completionDetails = usage.completion_tokens_details as Record<string, unknown> | undefined
    let cached = int(promptDetails?.cached_tokens)
    if (!cached) cached = int(usage.prompt_cache_hit_tokens)
    const inputTokens = int(usage.prompt_tokens)
    const outputTokens = int(usage.completion_tokens)
    const reasoningTokens = int(completionDetails?.reasoning_tokens)
    if (!inputTokens && !cached && !outputTokens) return
    this.add(inputTokens, cached, outputTokens, reasoningTokens)
  }

  snapshot(): TokenUsageSnapshot {
    return {
      calls: this.calls,
      inputTokens: this.inputTokens,
      cachedInputTokens: this.cachedInputTokens,
      uncachedInputTokens: this.inputTokens - this.cachedInputTokens,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      cacheHitRate: this.inputTokens > 0 ? this.cachedInputTokens / this.inputTokens : 0,
    }
  }
}

export interface BackendConfig {
  /** Verifier model name. Defaults to `deepseek-v4-flash` on DeepSeek; otherwise resolved from the server's /models. */
  model?: string
  /** OpenAI-compatible base URL (e.g. `http://localhost:8000/v1` or `https://api.deepseek.com`). */
  baseUrl?: string
  /** API key. Falls back to `OPENAI_API_KEY`, then `DEEPSEEK_API_KEY`. */
  apiKey?: string
  /** Per-request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number
  /** Maximum in-flight verifier calls. Defaults to 8. */
  maxConcurrency?: number
  /** Force the DeepSeek call path (thinking enabled, large output budget). Auto-detected from the base URL. */
  deepseek?: boolean
  /** Run the vLLM/SGLang prefill pass for score tags on non-DeepSeek servers. Defaults to true. */
  prefill?: boolean
}

export interface ResolvedBackendConfig {
  model?: string
  baseUrl?: string
  apiKey?: string
  timeoutMs: number
  maxConcurrency: number
  deepseek: boolean
  prefill: boolean
}

export interface ChatOptions {
  model?: string
  signal?: AbortSignal
}

interface ChatResponse {
  text: string
  tokens?: string[]
  positionLogprobs?: LogprobToken[][]
}

const DEEPSEEK_MODEL = 'deepseek-v4-flash'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_MAX_TOKENS = 32768
const OPENAI_MAX_TOKENS = 4096
const GRANULARITY = 20

export class VerifierBackend {
  readonly config: ResolvedBackendConfig
  readonly usage = new TokenUsage()
  private resolvedModel: string | undefined

  constructor(config: BackendConfig = {}) {
    this.config = VerifierBackend.resolveConfig(config)
  }

  /** Merge explicit config with the process environment (upstream `create_client` order). */
  static resolveConfig(config: BackendConfig): ResolvedBackendConfig {
    const envBaseUrl = process.env.OPENAI_BASE_URL
    const envKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY
    const baseUrl = config.baseUrl ?? envBaseUrl ?? (process.env.DEEPSEEK_API_KEY ? DEEPSEEK_BASE_URL : undefined)
    const apiKey = config.apiKey ?? envKey
    const deepseek =
      config.deepseek ??
      (baseUrl?.includes('api.deepseek.com') ??
        (!envBaseUrl && !config.baseUrl && Boolean(process.env.DEEPSEEK_API_KEY)))
    return {
      model: config.model,
      baseUrl,
      apiKey,
      timeoutMs: config.timeoutMs ?? 60_000,
      maxConcurrency: Math.max(1, config.maxConcurrency ?? 8),
      deepseek,
      prefill: config.prefill ?? true,
    }
  }

  static fromEnvironment(config: BackendConfig = {}): VerifierBackend {
    return new VerifierBackend(config)
  }

  private deepseekParams(): { extraBody: Record<string, unknown>; maxTokens: number } {
    const effort = process.env.DEEPSEEK_EFFORT ?? 'high'
    const maxTokens = Number.parseInt(process.env.DEEPSEEK_MAX_TOKENS ?? '', 10) || DEEPSEEK_MAX_TOKENS
    if (effort === 'off' || effort === 'disabled' || effort === 'none') {
      return { extraBody: { thinking: { type: 'disabled' } }, maxTokens }
    }
    return { extraBody: { thinking: { type: 'enabled' }, reasoning_effort: effort }, maxTokens }
  }

  private async resolveModel(override?: string): Promise<string> {
    if (override) return override
    if (this.config.model) return this.config.model
    if (this.config.deepseek) return DEEPSEEK_MODEL
    if (this.resolvedModel) return this.resolvedModel
    if (!this.config.baseUrl) throw new MissingAPIKeyError('set baseUrl or OPENAI_BASE_URL')
    const res = await fetch(`${this.config.baseUrl}/models`, {
      headers: { authorization: `Bearer ${this.config.apiKey ?? ''}` },
    })
    if (!res.ok) throw new VerifierError(`verifier backend /models returned ${res.status}`, res.status)
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const id = body.data?.[0]?.id
    if (!id) throw new VerifierError('verifier backend /models returned no model ids')
    this.resolvedModel = id
    return id
  }

  private async post(
    url: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`verifier request timed out after ${this.config.timeoutMs}ms`)), this.config.timeoutMs)
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!res.ok) throw new VerifierError(`verifier backend returned HTTP ${res.status}`, res.status)
      return (await res.json()) as Record<string, unknown>
    } catch (error) {
      if (error instanceof VerifierError) throw error
      throw new VerifierError(`verifier backend call failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  private parse(response: Record<string, unknown>): ChatResponse {
    const choices = response.choices as Array<Record<string, unknown>> | undefined
    const choice = choices?.[0]
    if (!choice) throw new VerifierError('malformed verifier response: no choices')
    const message = (choice.message ?? {}) as Record<string, unknown>
    const text = typeof message.content === 'string' ? message.content : ''
    const logprobs = (choice.logprobs ?? {}) as { content?: Array<Record<string, unknown>> }
    const tokens: string[] = []
    const positionLogprobs: LogprobToken[][] = []
    if (Array.isArray(logprobs.content)) {
      for (const pos of logprobs.content) {
        const token = typeof pos.token === 'string' ? pos.token : ''
        tokens.push(token)
        const top = Array.isArray(pos.top_logprobs)
          ? (pos.top_logprobs as Array<{ token?: unknown; logprob?: unknown }>).map((alt) => ({
              token: String(alt.token ?? ''),
              logprob: typeof alt.logprob === 'number' ? alt.logprob : 0,
            }))
          : []
        positionLogprobs.push(top.length > 0 ? top : [{ token, logprob: 0 }])
      }
    }
    this.usage.record(response)
    return { text, tokens, positionLogprobs }
  }

  private async prefillTags(
    model: string,
    messages: Array<Record<string, unknown>>,
    analysis: string,
    tags: string[],
  ): Promise<ChatResponse> {
    let fullText = analysis
    const tokens: string[] = []
    const positionLogprobs: LogprobToken[][] = []
    const letters = Array.from({ length: GRANULARITY }, (_, i) => String.fromCharCode(65 + i))
    const choices = [...letters, ...letters.map((c) => ` ${c}`)]
    for (const tag of tags) {
      const prefix = `${fullText}\n${tag}`
      try {
        const response = await this.post(`${this.config.baseUrl}/chat/completions`, {
          model,
          messages: [...messages, { role: 'assistant', content: prefix }],
          max_tokens: 1,
          temperature: 1,
          logprobs: true,
          top_logprobs: 20,
          extra_body: {
            add_generation_prompt: false,
            continue_final_message: true,
            structured_outputs: { choice: choices },
          },
        })
        this.usage.record(response)
        const choice = (response.choices as Array<Record<string, unknown>> | undefined)?.[0]
        const message = (choice?.message ?? {}) as Record<string, unknown>
        const letter = String(
          message.content ??
            message.reasoning ??
            message.reasoning_content ??
            '',
        ).trim()
        const logprobs = (choice?.logprobs ?? {}) as { content?: Array<Record<string, unknown>> }
        const pos = logprobs.content?.[0] ?? {}
        const alts: LogprobToken[] = Array.isArray(pos.top_logprobs)
          ? (pos.top_logprobs as Array<{ token?: unknown; logprob?: unknown }>).map((alt) => ({
              token: String(alt.token ?? ''),
              logprob: typeof alt.logprob === 'number' ? alt.logprob : 0,
            }))
          : []
        const resolvedLetter = letter || String(pos.token ?? alts[0]?.token ?? '').trim()
        const closing = `</${tag.slice(1)}`
        fullText = `${prefix}${resolvedLetter}${closing}`
        tokens.push(`\n${tag}`, resolvedLetter, closing)
        positionLogprobs.push(
          [{ token: `\n${tag}`, logprob: 0 }],
          alts.length > 0 ? alts : [{ token: resolvedLetter, logprob: 0 }],
          [{ token: closing, logprob: 0 }],
        )
      } catch {
        // A server without prefill support returns the tag-less analysis
        // (scores fall back to 0.5 downstream).
        return {
          text: analysis,
          ...(tokens.length > 0 ? { tokens } : {}),
          ...(positionLogprobs.length > 0 ? { positionLogprobs } : {}),
        }
      }
    }
    return { text: fullText, tokens, positionLogprobs }
  }

  /**
   * Run one verifier call and return its text plus token-level logprobs.
   * On non-DeepSeek servers, score tags present in the prompt trigger the
   * prefill pass so the letter distribution is read at the exact tag
   * position.
   */
  async chat(prompt: string, opts: ChatOptions = {}): Promise<VerifierOutput> {
    if (!this.config.baseUrl) {
      throw new MissingAPIKeyError(
        'set baseUrl (or OPENAI_BASE_URL) to an OpenAI-compatible endpoint with logprobs ' +
          '(e.g. http://localhost:8000/v1 for vLLM, or https://api.deepseek.com for DeepSeek)',
      )
    }
    const model = await this.resolveModel(opts.model)
    const messages = [{ role: 'user', content: prompt }]
    const { extraBody, maxTokens } = this.config.deepseek ? this.deepseekParams() : { extraBody: undefined, maxTokens: OPENAI_MAX_TOKENS }
    const params: Record<string, unknown> = {
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 1,
      logprobs: true,
      top_logprobs: 20,
    }

    let response: Record<string, unknown>
    if (this.config.deepseek) {
      response = await this.post(`${this.config.baseUrl}/chat/completions`, { ...params, extra_body: extraBody }, opts.signal)
    } else {
      // vLLM/SGLang: skip hybrid-thinking so score tags come fast. Servers
      // without that option reject the request; retry without it.
      try {
        response = await this.post(
          `${this.config.baseUrl}/chat/completions`,
          { ...params, extra_body: { chat_template_kwargs: { enable_thinking: false } } },
          opts.signal,
        )
      } catch (error) {
        response = await this.post(`${this.config.baseUrl}/chat/completions`, params, opts.signal)
      }
    }
    let { text, tokens, positionLogprobs } = this.parse(response)

    const tags = ['<score_A>', '<score_B>'].filter((tag) => prompt.includes(tag))
    if (tags.length > 0 && !this.config.deepseek && this.config.prefill) {
      const idx = Math.min(...tags.map((tag) => text.indexOf(tag)).filter((i) => i >= 0), text.length)
      const analysis = text.slice(0, idx).trimEnd()
      const prefilled = await this.prefillTags(model, messages, analysis, tags)
      text = prefilled.text
      tokens = prefilled.tokens
      positionLogprobs = prefilled.positionLogprobs
    }

    return {
      text,
      ...(tokens !== undefined ? { tokens } : {}),
      ...(positionLogprobs !== undefined ? { positionLogprobs } : {}),
    }
  }

  /**
   * Run the workers with at most `maxConcurrency` in flight. The first
   * failure rejects the returned promise; the rest run to completion.
   */
  async runAll<T>(workers: Array<() => Promise<T>>): Promise<T[]> {
    if (workers.length === 0) return []
    const results = new Array<T>(workers.length)
    let next = 0
    const runner = async (): Promise<void> => {
      while (true) {
        const i = next++
        if (i >= workers.length) return
        const worker = workers[i]
        if (!worker) return
        results[i] = await worker()
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(this.config.maxConcurrency, workers.length) }, () => runner()),
    )
    return results
  }
}
