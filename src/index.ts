/**
 * dsh-llm-verifier-pro: LLM-as-a-Verifier for DeepSeek Harness (unified).
 *
 * Merges the engineering of dsh-llm-as-a-verifier (TaurenMountain, MIT) —
 * fine-grained logprob scoring, Probabilistic Pivot Tournament, vLLM/SGLang
 * prefill, concurrency + timeout + token accounting — with the Best-of-N
 * conversation mode of @aispin/plugin-verifier (Aispin, MIT). Method by the LLM-as-a-Verifier paper (arXiv:2607.05391).
 *
 * Three faces:
 *  1. Tools — `verify_compare` / `verify_select` / `verify_track` (agent calls
 *     them on demand for fine-grained probabilistic feedback).
 *  2. Service — `ctx.verifierPro.verify/compare/select/track` for code consumers.
 *  3. Mode — Best-of-N conversation mode: every assistant turn of a Bo-N
 *     session is sampled N ways and only the winning response replayed.
 *     Gating: `config.boN` → off.
 *
 * Verifier credentials resolve zero-config from the dsh provider state:
 * plugin config (baseUrl/apiKey/model) → the provider route's own Loader entry
 * config (read through `configEditor`) → the credentials seam (`credential:<name>` or the ambient key env) →
 * OPENAI_BASE_URL/OPENAI_API_KEY/DEEPSEEK_API_KEY.
 *
 * @module dsh-llm-verifier-pro
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { StreamChunk, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { VerifierBackend, type BackendConfig } from './backend.js'
import { Verifier, type CompareOptions, type SelectOptions, type TrackOptions } from './verifier.js'
import type { TokenUsageSnapshot } from './backend.js'
import { orchestrate, isInternalRequest, markInternalRequest, verifyBest, taskOf } from './bon.js'
import type { BoNConfig, BoNTurnSummary } from './bon.js'

/**
 * Arbitrary lossless JSON, used below only to type the `usage` payload a tool
 * result carries. Declared here rather than imported: dsh-tools re-exported
 * this in 0.1.1 and stopped in 0.1.7 (it now lives in @deepseek-ai/dsh-util-values),
 * and since TypeScript is structural an identical local declaration is
 * interchangeable with the core's — one fewer core import to track.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export {
  VerifierBackend,
  TokenUsage,
  MissingAPIKeyError,
  VerifierError,
} from './backend.js'
export type { BackendConfig, TokenUsageSnapshot } from './backend.js'
export { Verifier } from './verifier.js'
export { extractScore, SCALE, GRANULARITY, normalizeCriteria, buildPairwisePrompt } from './scoring.js'
export type { Criterion, CriteriaInput, LogprobToken, VerifierOutput } from './scoring.js'
export { selectBest, bradleyTerry, ringCycle, pivotRoundPairs, selectPivots, createRng, DEFAULT_PIVOTS, accumulate } from './tournament.js'
export { extractProgressScores, buildProgressPrompt, LETTER_TO_VALUE, defaultCheckpoints } from './progress.js'
export { orchestrate, collectRollout, replayWithFooter, verifyBest, taskOf, isInternalRequest, markInternalRequest } from './bon.js'
export type { BoNConfig, BoNTurnSummary, Rollout, VerifyResult, OrchestrateDeps } from './bon.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-verifier-pro'

/** Services required. `tools` + `systemPrompt` for the tool face; `llm` for the Bo-N sampling re-entry. */
export const inject = ['tools', 'systemPrompt', 'llm'] as const

/** Plugin configuration (dsh config cascade). */
export interface Config {
  // ── verifier endpoint (shared by the tool, service and Bo-N faces) ──
  /** OpenAI-compatible base URL. Empty (default) resolves: session provider route → OPENAI_BASE_URL → DEEPSEEK_API_KEY implies api.deepseek.com. */
  baseUrl?: string
  /** API key. Supports `credential:<name>` (dsh credentials seam), `env:VAR`, or a plain value. Empty → seam/ambient env. */
  apiKey?: string
  /** Verifier model. Empty → the conversation's model (DeepSeek routes only) → deepseek-v4-flash, or /models on non-DeepSeek endpoints. */
  model?: string
  /**
   * Verifier as a `provider/model` ROUTE (preferred): endpoint and API key are
   * looked up from dsh's provider config (exactly like Model mix entries), so
   * a user who already configured a gateway and models never types a base
   * URL. A bare model id (no `/`) rides the session provider. Empty (default)
   * follows the session model entirely.
   */
  verifier?: string
  /** Per-request timeout in milliseconds. Defaults to 60000. */
  timeoutMs?: number
  /** Maximum in-flight verifier calls. Defaults to 8. */
  maxConcurrency?: number
  /** Force the DeepSeek call path. Auto-detected from the base URL. */
  deepseek?: boolean
  /** vLLM/SGLang prefill pass for score tags on non-DeepSeek servers. Defaults to true. */
  prefill?: boolean
  /**
   * When the endpoint returns no token-level logprobs: `true` (default) falls
   * back to sampling-style scoring (footer marks "sampling scoring");
   * `false` is strict mode and raises instead of silently downgrading.
   */
  autoDegrade?: boolean
  /** Register `verify_compare`. Defaults to true. */
  compare?: boolean
  /** Register `verify_select`. Defaults to true. */
  select?: boolean
  /** Register `verify_track`. Defaults to true. */
  track?: boolean
  // ── Best-of-N mode face ──
  /** Deployment-level default for the mode. */
  boN?: boolean
  /** Candidates per Bo-N turn when active. Defaults to 5. */
  boNCandidates?: number
  /** Sampling temperature for the diversity rollouts. Defaults to 0.7. */
  samplingTemperature?: number
  /**
   * Candidate rollout schedule: `parallel` (default) fires every rollout at
   * once; `serial` collects one at a time — safer when several candidates
   * share one slow local model.
   */
  samplingMode?: string
  /** Wall-clock budget for the sampling phase. Defaults to 120s. */
  timeoutMsBoN?: number
  /** INDEPENDENT wall-clock budget for the verify phase. Defaults to 90s. */
  verifyTimeoutMsBoN?: number
  /** Append a muted Best-of-N footer under the winning answer. Defaults to true. */
  showFooter?: boolean
  /** Extra grading criteria appended to the Bo-N comparison prompt. */
  criteria?: string[]
  /** PPT pivots k used by Bo-N selection. Defaults to 2. */
  boNPivots?: number
  /** PPT ring seed (default 0: fixed, reproducible). */
  boNSeed?: number
  /**
   * Model mix for Bo-N candidates beyond the greedy anchor. Candidate 0 is
   * always the conversation's own model; each later slot draws one entry in
   * order, and slots beyond the list fall back to the anchor model.
   *
   * Each entry is either:
   *   - a FULL model id string (e.g. `ollama-local/qwen3.8:27b`) — sampled
   *     with the conversation's own provider; or
   *   - `{ provider, model }` — sampled with an EXPLICIT provider route
   *     (e.g. `{ provider: 'omni-message', model: 'opencode-go/minimax-m3' }`),
   *     overriding the conversation's provider for that candidate only.
   */
  boNModelMix?: Array<ModelMixEntry>
}

/**
 * One entry of the Bo-N model mix: either a full model id string (conversation
 * provider) or an explicit `{ provider, model }` route.
 */
export type ModelMixEntry = string | { provider?: string; model: string }

/**
 * `.volatile()` fields are what dsh 0.1.7 builds the Plugins-page form from
 * (dsh-settings `describe()` skips an entry with none), and the Loader commits
 * an edit to them into the running references without remounting. They are
 * read per call through {@link currentConfig}. `apiKey` (a secret), the
 * `deepseek`/`prefill` call-path overrides and the tool registration flags
 * stay ordinary: editing them in the profile patch remounts the plugin.
 */
export const Config = z.object({
  baseUrl: z.string().volatile(),
  apiKey: z.string(),
  model: z.string().volatile(),
  verifier: z.string().volatile(),
  timeoutMs: z.number().volatile(),
  maxConcurrency: z.number().volatile(),
  deepseek: z.boolean(),
  prefill: z.boolean(),
  autoDegrade: z.boolean().default(true).volatile(),
  compare: z.boolean().default(true),
  select: z.boolean().default(true),
  track: z.boolean().default(true),
  boN: z.boolean().default(false).volatile(),
  boNCandidates: z.number().default(5).volatile(),
  samplingTemperature: z.number().default(0.7).volatile(),
  samplingMode: z.string().default('parallel').volatile(),
  timeoutMsBoN: z.number().default(300_000).volatile(),
  verifyTimeoutMsBoN: z.number().default(300_000).volatile(),
  showFooter: z.boolean().default(true).volatile(),
  criteria: z.array(z.string()).default([]).volatile(),
  boNPivots: z.number().default(2).volatile(),
  boNSeed: z.number().default(0).volatile(),
  boNModelMix: z.array(z.union([z.string(), z.object({ provider: z.string(), model: z.string() })])).default([]).volatile(),
})

/**
 * The plain config values as of now. A Loader-parsed config holds volatile
 * fields as `{ get() }` references; a config built by hand (tests, embedders)
 * holds plain values. Both read the same.
 */
export function currentConfig(config: Config): Config {
  const plain: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    plain[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { get?: unknown }).get === 'function'
      ? (value as { get(): unknown }).get()
      : value
  }
  return plain as Config
}


/**
 * Normalize one model-mix value to the runtime entry shape (`string` or
 * `{ provider, model }`). A plugin-config value may be an object or a string.
 * A legacy `omni-chat/agnes/agnes-2.5-flash` string whose head is a REAL
 * provider name is split into `{ provider, model }`; anything else stays a
 * full model id (inherits the conversation provider).
 */
export function normalizeMixEntry(entry: ModelMixEntry | string, knownProviders: ReadonlySet<string>): string | { provider?: string; model: string } {
  if (typeof entry !== 'string') return entry
  const slash = entry.indexOf('/')
  if (slash > 0) {
    const head = entry.slice(0, slash)
    if (knownProviders.has(head) && entry.slice(slash + 1).length > 0) {
      return { provider: head, model: entry.slice(slash + 1) }
    }
  }
  return entry
}

/** Best-effort set of real provider route names routed by the llm service. */
function knownProvidersOf(ctx: Context): Set<string> {
  const names = new Set<string>(['deepseek-official'])
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const entry of providers) {
      // LlmProviderInfo: { id (route key), name (display) }.
      if (typeof (entry as { id?: unknown })?.id === 'string' && (entry as { id: string }).id.length > 0) {
        names.add((entry as { id: string }).id)
      }
    }
  } catch {
    // llm seam unavailable — keep the built-in name only.
  }
  return names
}


/** Resolve an explicit API-key override: `env:VAR` or a plain value. `credential:<name>` handled in resolveBackend. */
function resolveApiKeyOverride(raw: string): string {
  if (raw.startsWith('env:')) {
    const value = process.env[raw.slice(4)]
    if (value === undefined || value.length === 0) {
      throw new Error(`verifier: API key environment variable "${raw.slice(4)}" is not set`)
    }
    return value
  }
  return raw
}

/** Resolve one API key from the full chain. */
async function resolveApiKey(ctx: Context, config: Config, apiKeyEnv: string): Promise<string | undefined> {
  const explicit = (config.apiKey ?? '').trim()
  if (explicit.length > 0) {
    if (explicit.startsWith('credential:')) {
      const credentials = ctx.get('credentials')
      const ref = credentialRef(explicit.slice('credential:'.length))
      const hit = credentials === undefined ? undefined : await credentials.resolve(ref)
      if (hit === undefined) throw new Error(`verifier: credential "${explicit.slice('credential:'.length)}" is not configured`)
      return hit.value
    }
    return resolveApiKeyOverride(explicit)
  }
  const credentials = ctx.get('credentials')
  const ref = credentialRef(apiKeyEnv)
  const hit = credentials === undefined ? undefined : await credentials.resolve(ref)
  if (hit !== undefined) return hit.value
  const ambient = process.env[apiKeyEnv]
  if (ambient !== undefined && ambient.length > 0) return ambient
  return undefined
}

/**
 * Resolve a session provider's endpoint configuration from the adapter that
 * owns that route.
 *
 * The adapter publishes the mapping itself: `listConfigurableProviders()` gives
 * each route a `settingsNs` (the owning Loader entry's id) and a `settingsPath`
 * into that entry's config -- `["providers", "<route>"]` for a multi-route
 * adapter, `[]` when the whole config is one route's profile. Following it means
 * this never guesses a key or an id, which is what the two previous versions
 * both got wrong: a route named `omni-chat` was never in a namespace called
 * `llm-omni-chat`, and `deepseek-official` lives in an entry called
 * `llm-deepseek`.
 *
 * Returns `{}` when the route is unknown or unconfigured -- the caller falls
 * back to its env chain.
 */
export function sessionProviderEndpoint(ctx: Context, provider: string): { baseUrl?: string; apiKeyEnv?: string } {
  if (!provider) return {}
  try {
    const llm = (ctx as { llm?: { listConfigurableProviders?: () => ReadonlyArray<{ provider: string; settingsNs: string; settingsPath: readonly string[] }> } }).llm
    const route = llm?.listConfigurableProviders?.().find((candidate) => candidate.provider === provider)
    if (route === undefined) return {}
    // Config, not settings: dsh 0.1.7 removed `SettingsForms.get` and imported
    // the settings document into the profile patch, so the entry the adapter
    // names is where its profile now lives.
    const editor = ctx.get('configEditor') as { entries(): Array<{ options: { id: string; config?: unknown } }> } | undefined
    const owner = editor?.entries().find((entry) => entry.options.id === route.settingsNs)
    let node: unknown = owner?.options.config
    for (const key of route.settingsPath) {
      if (node === null || typeof node !== 'object') return {}
      node = (node as Record<string, unknown>)[key]
    }
    if (node === null || typeof node !== 'object') return {}
    const profile = node as { baseURL?: unknown; apiKeyEnv?: unknown }
    if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0) return {}
    return {
      baseUrl: profile.baseURL,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
    }
  } catch {
    // degrade: fall through to the environment chain
  }
  return {}
}

/**
 * Resolve the verifier backend connection from dsh's configured provider
 * state. Default (no explicit config, no `verifier` route and no
 * three-part endpoint): the verifier FOLLOWS THE SESSION — same provider
 * route, endpoint and model as the conversation, so a user who only turns on
 * Best-of-N gets the zero-config self-verification experience (generate N
 * variants and grade them all with the conversation's own model).
 *
 * Resolution order:
 *  1. `config.verifier` route — a `provider/model` string like the Model mix
 *     entries: endpoint + key env are read from that provider's Loader entry
 *     config; a bare model id rides the session provider.
 *  2. three-part endpoint: config.baseUrl/apiKey/model → session provider
 *     endpoint → env chain.
 *  3. model falls back to the conversation's own model (any provider route).
 */
export async function resolveBackend(
  ctx: Context,
  config: Config,
  conversation?: GenerateOptions,
): Promise<VerifierBackend> {
  const provider = conversation?.provider ?? ''
  const sessionEndpoint = provider ? sessionProviderEndpoint(ctx, provider) : {}

  // Preferred form: a `provider/model` route (Model mix semantics). The
  // endpoint and key env come from that provider's dsh configuration, not
  // from the user; empty → still follow the session / explicit 3-part config.
  const routeText = (config.verifier ?? '').trim()
  let baseUrl = ''
  let apiKeyEnv = 'DEEPSEEK_API_KEY'
  let model = ''

  if (routeText) {
    const parsed = normalizeMixEntry(routeText, knownProvidersOf(ctx))
    const routeProvider = typeof parsed === 'string'
      ? provider
      : (parsed.provider && parsed.provider.length > 0 ? parsed.provider : provider)
    const routeModel = typeof parsed === 'string' ? parsed : parsed.model
    const routeEndpoint = routeProvider ? sessionProviderEndpoint(ctx, routeProvider) : {}
    baseUrl = routeEndpoint.baseUrl?.trim() ?? ''
    apiKeyEnv = routeEndpoint.apiKeyEnv ?? apiKeyEnv
    model = routeModel
  } else {
    baseUrl =
      (config.baseUrl ?? '').trim() ||
      sessionEndpoint.baseUrl?.trim() ||
      process.env.OPENAI_BASE_URL?.trim() ||
      ''
    if (baseUrl.length === 0) baseUrl = ''
    apiKeyEnv = sessionEndpoint.apiKeyEnv ?? apiKeyEnv
    const inheritedModel = conversation?.model ?? ''
    model = (config.model ?? '').trim() || inheritedModel || ''
  }

  if (baseUrl.length === 0 && process.env.DEEPSEEK_API_KEY?.trim()) baseUrl = 'https://api.deepseek.com'

  const apiKey = await resolveApiKey(ctx, config, apiKeyEnv)
  const deepseek = config.deepseek ?? baseUrl.includes('api.deepseek.com')

  const backendConfig: BackendConfig = {
    model: model || undefined,
    baseUrl: baseUrl || undefined,
    apiKey,
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
    deepseek,
    prefill: config.prefill,
    autoDegrade: config.autoDegrade ?? true,
  }
  console.error(
    `[verifier] backend resolved: baseUrl=${baseUrl || '(session endpoint)'} ` +
      `model=${model || '(conversation model)'} deepseek=${String(deepseek)}`,
  )
  return new VerifierBackend(backendConfig)
}

/** The Bo-N mode decision for one conversation request. */
export interface BoNModeDecision {
  readonly enabled: boolean
  readonly nCandidates: number
  readonly source: 'config-default' | 'off'
}

/**
 * The Bo-N mode decision, evaluated per turn (hot).
 *
 * Since dsh 0.1.7 the plugin Config is the only settings layer, so this is one
 * switch: `config.boN: true` turns the mode on for EVERY conversation at
 * `config.boNCandidates`, anything else is off.
 */
export function resolveBoNMode(config: Config): BoNModeDecision {
  const nCandidates = config.boNCandidates ?? 5
  if (config.boN) return { enabled: true, nCandidates, source: 'config-default' }
  return { enabled: false, nCandidates: 0, source: 'off' }
}

/** The `ctx.verifierPro` service (service face). Unique name: the original
 * `verifier` service is already registered by @aispin/plugin-verifier — both
 * plugins coexist in one profile. */
export class VerifierService extends Service {
  private readonly config: Config
  private backend: VerifierBackend | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'verifierPro')
    this.config = config
  }

  private async backendFor(conversation?: GenerateOptions): Promise<VerifierBackend> {
    // Lazy per-call resolution: a missing key fails the CALL, not the mount.
    return resolveBackend(this.ctx, currentConfig(this.config), conversation)
  }

  /** Rank N candidates best-first with the PPT. */
  async verify(options: { task: string; candidates: readonly string[]; criteria?: Record<string, string>; pivots?: number; seed?: number; nEvaluations?: number }): Promise<{ bestIndex: number; ranking: { index: number; score: number; normalized: number }[]; callsSpent: number }> {
    if (options.candidates.length < 2) throw new Error('verifier: at least 2 candidates are required')
    const backend = await this.backendFor()
    const result = await verifyBest(backend, backend.config.model ?? 'deepseek-v4-flash', options.task, options.candidates, {
      criteria: options.criteria ? Object.keys(options.criteria) : undefined,
      pivots: options.pivots,
      seed: options.seed,
      nEvaluations: options.nEvaluations,
    })
    return { bestIndex: result.bestIndex, ranking: result.ranking as never, callsSpent: result.callsSpent }
  }

  /** Fine-grained rewards for one directed comparison. */
  async compare(problem: string, traceA: string, traceB: string, criteriaInput: Record<string, string>, opts?: CompareOptions): Promise<{ scoreA: number; scoreB: number; criteria: string[]; usage: TokenUsageSnapshot }> {
    const backend = await this.backendFor()
    const verifier = new Verifier(backend.config)
    return verifier.compare(problem, traceA, traceB, criteriaInput, opts)
  }

  /** PPT best-of-N selection (tool face parity). */
  async select(problem: string, candidates: string[], criteriaInput: Record<string, string>, opts?: SelectOptions): Promise<{ index: number; best: string; scores: number[]; ranking: number[]; nComparisons: number; criteria: string[]; usage: TokenUsageSnapshot }> {
    const backend = await this.backendFor()
    const verifier = new Verifier(backend.config)
    return verifier.select(problem, candidates, criteriaInput, opts)
  }

  /** Per-step progress tracking. */
  async track(problem: string, steps: string[], opts?: TrackOptions): Promise<{ steps: number[]; scores: number[]; perRep: Array<Array<number | null>>; final: number; usage: TokenUsageSnapshot }> {
    const backend = await this.backendFor()
    const verifier = new Verifier(backend.config)
    return verifier.track(problem, steps, opts)
  }
}

/** Format token usage for footers and diagnostics. */
function formatUsage(usage?: TokenUsageSnapshot): string {
  const u = usage
  if (!u) return ''
  const rate = u.inputTokens > 0 ? (100 * u.cachedInputTokens) / u.inputTokens : 0
  return `${u.calls} verifier call(s), input ${u.inputTokens} tokens (cached ${u.cachedInputTokens}, ${rate.toFixed(1)}% hit), output ${u.outputTokens} tokens (reasoning ${u.reasoningTokens})`
}

export function apply(ctx: Context, config: Config): void {
  const cfg: Config = { ...config }


  // Service face.
  const service = new VerifierService(ctx, cfg)
  ctx.verifierPro = service

  const backendFor = async (): Promise<VerifierBackend> => {
    // Lazily-created shared backend (Bo-N and tools share one instance so
    // token accounting is holistic). A missing key fails the first CALL.
    return service['backendFor']()
  }

  // ── Tool face ────────────────────────────────────────────────────────────
  // verify_compare / verify_select / verify_track (inject verify* guidance).
  ctx.systemPrompt.section({
    name: 'tool:verify',
    order: 120,
    text:
      'Use the verify_* tools to get fine-grained probabilistic feedback on ' +
      'your own work before committing to it: verify_compare scores two ' +
      'candidates against evaluation criteria (expected score over the ' +
      "verifier's logprob distribution); verify_select picks the best of N " +
      'candidates with a Probabilistic Pivot Tournament (O(Nk) comparisons, ' +
      'cheaper than a full round-robin); verify_track scores your progress ' +
      'after each step.',
  })

  if (cfg.compare ?? true) {
    ctx.tools.register(defineTool({
      name: 'verify_compare',
      description:
        'Score two candidate solutions/trajectories against evaluation criteria with a fine-grained reward model: the verifier distribution over a 20-letter scale is read at the score-tag logprobs and normalized to [0,1]. Returns (scoreA, scoreB) plus token usage.',
      parameters: {
        problem: { type: 'string', required: true, description: 'The task description both candidates attempt to solve.' },
        candidateA: { type: 'string', required: true, description: 'First candidate (code, plan, or agent trajectory).' },
        candidateB: { type: 'string', required: true, description: 'Second candidate.' },
        criteria: { type: 'object', additionalProperties: true, required: true, description: 'Evaluation criteria as a {name: description} map, e.g. {"Correctness": "Does the code actually reverse the string?"}.' },
        nEvaluations: { type: 'integer', description: 'Repeated verifications per criterion to average. Defaults to 1.' },
        groundTruthNote: { type: 'string', description: 'Optional note the verifier always sees (e.g. reference patch location).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scoreA: { type: 'number', required: true },
            scoreB: { type: 'number', required: true },
            criteria: { type: 'array', required: true, items: { type: 'string' } },
            usage: { type: 'json', required: true },
          },
        },
        render: (args, value) => {
          const v = value as { scoreA: number; scoreB: number; criteria: string[]; usage?: JsonValue }
          const winner = v.scoreA >= v.scoreB ? 'candidate A' : 'candidate B'
          const margin = Math.abs(v.scoreA - v.scoreB)
          const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage as unknown as TokenUsageSnapshot) : ''
          return [{ type: 'text', text: [
            `Fine-grained rewards on criteria ${(v.criteria ?? []).join(', ')}:`,
            `  candidate A: ${v.scoreA.toFixed(4)}`,
            `  candidate B: ${v.scoreB.toFixed(4)}`,
            `Winner: ${winner} (margin ${margin.toFixed(4)})`,
            usage,
          ].filter(Boolean).join('\n') }]
        },
      },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const backend = await backendFor()
        const verifier = new Verifier(backend.config)
        const result = await verifier.compare(args.problem, args.candidateA, args.candidateB, args.criteria as Record<string, string>, {
          nEvaluations: args.nEvaluations ?? 1,
          groundTruthNote: args.groundTruthNote,
          signal: exec.signal,
        })
        return { scoreA: result.scoreA, scoreB: result.scoreB, criteria: result.criteria, usage: result.usage as unknown as JsonValue }
      },
    }))
  }

  if (cfg.select ?? true) {
    ctx.tools.register(defineTool({
      name: 'verify_select',
      description:
        'Select the best of N candidate solutions/trajectories with a Probabilistic Pivot Tournament: a seeded ring pass plus pivot rounds aggregate pairwise fine-grained rewards into per-candidate preferences. Runs O(Nk) verifier comparisons instead of O(N^2); identical inputs with the same seed run the identical tournament.',
      parameters: {
        problem: { type: 'string', required: true, description: 'The task description every candidate attempts to solve.' },
        candidates: { type: 'array', required: true, items: { type: 'string' }, description: 'List of N candidate solutions/trajectories to rank.' },
        criteria: { type: 'object', additionalProperties: true, required: true, description: 'Evaluation criteria as a {name: description} map. Each criterion is scored separately and averaged.' },
        nEvaluations: { type: 'integer', description: 'Repeated verifications per criterion per comparison. Defaults to 4.' },
        pivots: { type: 'integer', description: 'Number of pivots k. Cost grows as O(Nk); more pivots = more accurate. Defaults to 2.' },
        seed: { type: 'integer', description: 'Seed for the random ring pass. Defaults to 0.' },
        groundTruthNote: { type: 'string', description: 'Optional note the verifier always sees.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            index: { type: 'integer', required: true },
            best: { type: 'string', required: true },
            scores: { type: 'array', required: true, items: { type: 'number' } },
            ranking: { type: 'array', required: true, items: { type: 'integer' } },
            nComparisons: { type: 'integer', required: true },
            criteria: { type: 'array', required: true, items: { type: 'string' } },
            usage: { type: 'json', required: true },
          },
        },
        render: (args, value) => {
          const v = value as { index: number; scores: number[]; ranking: number[]; nComparisons: number; usage?: JsonValue }
          const ranking = (v.ranking ?? []).map((index, rank) => `  ${rank + 1}. candidate ${index}: ${(v.scores?.[index] ?? 0).toFixed(4)}`).join('\n')
          const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage as unknown as TokenUsageSnapshot) : ''
          return [{ type: 'text', text: [
            `Best candidate: ${v.index} (${v.nComparisons ?? 0} directed comparisons)`,
            'Ranking:',
            ranking,
            usage,
          ].filter(Boolean).join('\n') }]
        },
      },
      timeoutMs: 360_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const backend = await backendFor()
        const verifier = new Verifier(backend.config)
        const result = await verifier.select(args.problem, args.candidates, args.criteria as Record<string, string>, {
          nEvaluations: args.nEvaluations ?? 4,
          pivots: args.pivots ?? 2,
          seed: args.seed ?? 0,
          groundTruthNote: args.groundTruthNote,
          signal: exec.signal,
        })
        return {
          index: result.index,
          best: result.best,
          scores: result.scores,
          ranking: result.ranking,
          nComparisons: result.nComparisons,
          criteria: result.criteria,
          usage: result.usage as unknown as JsonValue,
        }
      },
    }))
  }

  if (cfg.track ?? true) {
    ctx.tools.register(defineTool({
      name: 'verify_track',
      description:
        'Score an agent trajectory\'s progress after each checkpoint step: a skeptical verifier judges whether the state after each step already satisfies the task\'s hidden grader, decoded from the logprob expectation over the A(0%)..T(100%) scale. One call scores all checkpoints; repeated evaluations are averaged.',
      parameters: {
        problem: { type: 'string', required: true, description: 'The task instruction the trajectory attempts.' },
        steps: { type: 'array', required: true, items: { type: 'string' }, description: 'The agent\'s steps, one string per step (action + observed output).' },
        checkpoints: { type: 'array', items: { type: 'integer' }, description: '1-indexed step numbers to score. Defaults to the interior steps 2..T-1.' },
        nEvaluations: { type: 'integer', description: 'Independent repeats to average. Defaults to 1.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            steps: { type: 'array', required: true, items: { type: 'integer' } },
            scores: { type: 'array', required: true, items: { type: 'number' } },
            final: { type: 'number', required: true },
            usage: { type: 'json', required: true },
          },
        },
        render: (args, value) => {
          const v = value as { steps: number[]; scores: number[]; final: number; usage?: JsonValue }
          const curve = (v.steps ?? []).map((step, i) => `  after step ${step}: ${(v.scores?.[i] ?? 0).toFixed(4)}`).join('\n')
          const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage as unknown as TokenUsageSnapshot) : ''
          return [{ type: 'text', text: [
            `Progress curve (final ${(v.final ?? 0).toFixed(4)}):`,
            curve,
            usage,
          ].filter(Boolean).join('\n') }]
        },
      },
      timeoutMs: 180_000,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const backend = await backendFor()
        const verifier = new Verifier(backend.config)
        const result = await verifier.track(args.problem, args.steps, {
          checkpoints: args.checkpoints,
          nEvaluations: args.nEvaluations ?? 1,
          signal: exec.signal,
        })
        return {
          steps: result.steps,
          scores: result.scores,
          final: result.final,
          usage: result.usage as unknown as JsonValue,
        }
      },
    }))
  }

  // ── Best-of-N mode face ──────────────────────────────────────────────────
  const summariesBySession = new Map<string, BoNTurnSummary[]>()

  const currentTurnOf = (sessionId: string): number => {
    const sessions = ctx.get('sessions')
    const session = sessions?.get(sessionId as never)
    const events = (session as { events?: readonly { type?: string; data?: { turn?: number } }[] } | undefined)?.events
    if (!events) return 0
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if (event?.type === 'turn/start' && typeof event.data?.turn === 'number') return event.data.turn
    }
    return 0
  }

  // Client RPC (available in the dynamic-plugin runner; a regular
  // profile/filesystem plugin loads without it — CLI diagnostic covers that case).
  const harness = (globalThis as { harness?: { handle(method: string, handler: (args: any) => unknown): () => void } }).harness
  if (harness !== undefined) {
    harness.handle('verifier-pro.bo-n.summaries', (args: { sessionId?: string }) => {
      const sessionId = args?.sessionId
      if (!sessionId) return []
      return (summariesBySession.get(sessionId) ?? []).map(summary => ({
        turn: summary.turn,
        task: summary.task,
        ranking: summary.ranking.map(entry => ({ index: entry.index, score: entry.score, normalized: entry.normalized })),
        winnerIndex: summary.winnerIndex,
        winnerScore: summary.winnerScore,
        runnerUpScore: summary.runnerUpScore,
        reason: summary.reason,
      }))
    })
    // Available models for the Bo-N mix picker. `ctx.llm.listProviders()`
    // yields `{ id, name }` route entries; each route's advisory catalog comes
    // from `await ctx.llm.listModels(providerId)` as `{ provider, id, name }`
    // rows. Returns `{ provider, model }` rows sorted by provider then model —
    // exactly what the mix list consumes.
    harness.handle('verifier-pro.available-models', async () => {
      try {
        const rows: Array<{ provider: string; model: string }> = []
        for (const { id: provider } of ctx.llm.listProviders()) {
          let models: readonly { id: string }[]
          try {
            models = await ctx.llm.listModels(provider)
          } catch {
            // A provider whose catalog is unavailable is simply omitted; the
            // catalog is advisory and never a request-routing gate.
            continue
          }
          for (const { id: model } of models) if (model) rows.push({ provider, model })
        }
        rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model))
        return rows
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    })
  }

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) => {
    if (isInternalRequest(options as object)) return next()
    // Main-conversation filter: auxiliary model calls (session titles, …)
    // carry a `purpose`; ordinary conversation requests leave it unset.
    if ((options as { purpose?: unknown }).purpose !== undefined) return next()
    const sessionId = (options as { sessionId?: string }).sessionId
    if (sessionId === undefined) return next()
    // One switch (cfg.boN), fail-open. Read per turn: a panel edit applies to the next turn.
    return (async function* boNTurn(): AsyncGenerator<StreamChunk> {
      const cfg = currentConfig(config)
      const decision = resolveBoNMode(cfg)
      if (!decision.enabled) {
        yield* next()
        return
      }
      console.error(`[bo-n] mode: ${decision.source} (n=${String(decision.nCandidates)})`)
      let backend: VerifierBackend
      try {
        backend = await resolveBackend(ctx, cfg, options)
      } catch (error) {
        console.error(`[bo-n] verifier config unavailable, degrading to normal answer: ${error instanceof Error ? error.message : String(error)}`)
        yield* next()
        return
      }
      const boNConfig: BoNConfig = {
        nCandidates: decision.nCandidates,
        samplingTemperature: cfg.samplingTemperature ?? 0.7,
        // An empty mix means "follow the session model". Normalized: strings like `omni-chat/agnes/...` whose head is a real
        // provider become explicit routes; anything else stays a full model id
        // (conversation provider).
        mixModels: (() => {
          const raw = cfg.boNModelMix
          const known = knownProvidersOf(ctx)
          return (raw ?? []).map((entry) => normalizeMixEntry(entry as ModelMixEntry, known)) as BoNConfig['mixModels']
        })(),
        timeoutMs: cfg.timeoutMsBoN ?? 300_000,
        verifyTimeoutMs: cfg.verifyTimeoutMsBoN ?? 300_000,
        samplingMode: cfg.samplingMode === 'serial' ? 'serial' : 'parallel',
        showFooter: cfg.showFooter ?? true,
        criteria: cfg.criteria,
        pivots: cfg.boNPivots ?? 2,
        seed: cfg.boNSeed ?? 0,
      }
      yield* orchestrate(
        {
          stream: request => ctx.llm.stream(request),
          backend,
          verifierModel: backend.config.model,
          onTurnSummary: (summary) => {
            const list = summariesBySession.get(sessionId) ?? []
            list.push({ ...summary, turn: currentTurnOf(sessionId) })
            summariesBySession.set(sessionId, list)
          },
        },
        boNConfig,
        options,
        next,
      )
    })()
  }, { global: true })
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    verifierPro: VerifierService
  }
}