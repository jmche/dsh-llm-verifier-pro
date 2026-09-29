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
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { VerifierBackend } from './backend.js';
import { Verifier } from './verifier.js';
import { JevBackend } from './jev.js';
import { orchestrate, isInternalRequest, verifyBest } from './bon.js';
export { VerifierBackend, TokenUsage, MissingAPIKeyError, VerifierError, } from './backend.js';
export { Verifier } from './verifier.js';
export { JevBackend, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL, systemOneEndpoint } from './jev.js';
export { extractScore, SCALE, GRANULARITY, normalizeCriteria, buildPairwisePrompt } from './scoring.js';
export { selectBest, bradleyTerry, ringCycle, pivotRoundPairs, selectPivots, createRng, DEFAULT_PIVOTS, accumulate } from './tournament.js';
export { extractProgressScores, buildProgressPrompt, LETTER_TO_VALUE, defaultCheckpoints } from './progress.js';
export { orchestrate, collectRollout, replayWithFooter, verifyBest, taskOf, isInternalRequest, markInternalRequest } from './bon.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-verifier-pro';
/** Services required. `tools` + `systemPrompt` for the tool face; `llm` for the Bo-N sampling re-entry. */
export const inject = ['tools', 'systemPrompt', 'llm'];
/**
 * `.volatile()` fields are what dsh 0.1.7 builds the Plugins-page form from
 * (dsh-settings `describe()` skips an entry with none), and the Loader commits
 * an edit to them into the running references without remounting. They are
 * read per call through {@link currentConfig}. `apiKey` (a secret), the
 * `deepseek`/`prefill` call-path overrides and the tool registration flags
 * stay ordinary: editing them in the profile patch remounts the plugin.
 *
 * The ranges make the Host refuse a nonsensical save (a 0 ms timeout would
 * abort every verifier call) instead of storing it.
 */
export const Config = z.object({
    baseUrl: z.string().volatile(),
    apiKey: z.string(),
    model: z.string().volatile(),
    verifier: z.string().volatile(),
    timeoutMs: z.number().min(1).volatile(),
    maxConcurrency: z.number().min(1).step(1).volatile(),
    deepseek: z.boolean(),
    prefill: z.boolean(),
    autoDegrade: z.boolean().default(true).volatile(),
    selector: z.string().default('llm').volatile(),
    jevBaseUrl: z.string().volatile(),
    jevModel: z.string().volatile(),
    jevApiKey: z.string(),
    compare: z.boolean().default(true),
    select: z.boolean().default(true),
    track: z.boolean().default(true),
    boN: z.boolean().default(false).volatile(),
    boNCandidates: z.number().min(2).step(1).default(5).volatile(),
    samplingTemperature: z.number().min(0).max(2).default(0.7).volatile(),
    samplingMode: z.string().default('parallel').volatile(),
    timeoutMsBoN: z.number().min(1).default(300_000).volatile(),
    verifyTimeoutMsBoN: z.number().min(1).default(300_000).volatile(),
    showFooter: z.boolean().default(true).volatile(),
    criteria: z.array(z.string()).default([]).volatile(),
    boNPivots: z.number().min(1).step(1).default(2).volatile(),
    boNSeed: z.number().step(1).default(0).volatile(),
    boNModelMix: z.array(z.union([z.string(), z.object({ provider: z.string(), model: z.string() })])).default([]).volatile(),
});
export function currentConfig(config) {
    const plain = {};
    for (const [key, value] of Object.entries(config)) {
        plain[key] = typeof value === 'object' && value !== null && !Array.isArray(value) && typeof value.get === 'function'
            ? value.get()
            : value;
    }
    return plain;
}
/**
 * Normalize one model-mix value to the runtime entry shape (`string` or
 * `{ provider, model }`). A plugin-config value may be an object or a string.
 * A legacy `omni-chat/agnes/agnes-2.5-flash` string whose head is a REAL
 * provider name is split into `{ provider, model }`; anything else stays a
 * full model id (inherits the conversation provider).
 */
export function normalizeMixEntry(entry, knownProviders) {
    if (typeof entry !== 'string')
        return entry;
    const slash = entry.indexOf('/');
    if (slash > 0) {
        const head = entry.slice(0, slash);
        if (knownProviders.has(head) && entry.slice(slash + 1).length > 0) {
            return { provider: head, model: entry.slice(slash + 1) };
        }
    }
    return entry;
}
/** Best-effort set of real provider route names routed by the llm service. */
function knownProvidersOf(ctx) {
    const names = new Set(['deepseek-official']);
    try {
        const providers = ctx.llm?.listProviders?.() ?? [];
        for (const entry of providers) {
            // LlmProviderInfo: { id (route key), name (display) }.
            if (typeof entry?.id === 'string' && entry.id.length > 0) {
                names.add(entry.id);
            }
        }
    }
    catch {
        // llm seam unavailable — keep the built-in name only.
    }
    return names;
}
/** Resolve an explicit API-key override: `env:VAR` or a plain value. `credential:<name>` handled in resolveBackend. */
function resolveApiKeyOverride(raw) {
    if (raw.startsWith('env:')) {
        const value = process.env[raw.slice(4)];
        if (value === undefined || value.length === 0) {
            throw new Error(`verifier: API key environment variable "${raw.slice(4)}" is not set`);
        }
        return value;
    }
    return raw;
}
/** Resolve an explicit key value: `credential:<name>`, `env:VAR`, or a plain value. */
async function resolveExplicitKey(ctx, explicit) {
    if (explicit.startsWith('credential:')) {
        const credentials = ctx.get('credentials');
        const ref = credentialRef(explicit.slice('credential:'.length));
        const hit = credentials === undefined ? undefined : await credentials.resolve(ref);
        if (hit === undefined)
            throw new Error(`verifier: credential "${explicit.slice('credential:'.length)}" is not configured`);
        return hit.value;
    }
    return resolveApiKeyOverride(explicit);
}
/** Resolve one API key from the full chain. */
async function resolveApiKey(ctx, config, apiKeyEnv) {
    const explicit = (config.apiKey ?? '').trim();
    if (explicit.length > 0)
        return resolveExplicitKey(ctx, explicit);
    const credentials = ctx.get('credentials');
    const ref = credentialRef(apiKeyEnv);
    const hit = credentials === undefined ? undefined : await credentials.resolve(ref);
    if (hit !== undefined)
        return hit.value;
    const ambient = process.env[apiKeyEnv];
    if (ambient !== undefined && ambient.length > 0)
        return ambient;
    return undefined;
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
export function sessionProviderEndpoint(ctx, provider) {
    if (!provider)
        return {};
    try {
        const llm = ctx.llm;
        const route = llm?.listConfigurableProviders?.().find((candidate) => candidate.provider === provider);
        if (route === undefined)
            return {};
        // Config, not settings: dsh 0.1.7 removed `SettingsForms.get` and imported
        // the settings document into the profile patch, so the entry the adapter
        // names is where its profile now lives.
        const editor = ctx.get('configEditor');
        const owner = editor?.entries().find((entry) => entry.options.id === route.settingsNs);
        let node = owner?.options.config;
        for (const key of route.settingsPath) {
            if (node === null || typeof node !== 'object')
                return {};
            node = node[key];
        }
        if (node === null || typeof node !== 'object')
            return {};
        const profile = node;
        if (typeof profile.baseURL !== 'string' || profile.baseURL.length === 0)
            return {};
        return {
            baseUrl: profile.baseURL,
            apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
        };
    }
    catch {
        // degrade: fall through to the environment chain
    }
    return {};
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
export async function resolveBackend(ctx, config, conversation) {
    const provider = conversation?.provider ?? '';
    const sessionEndpoint = provider ? sessionProviderEndpoint(ctx, provider) : {};
    // Preferred form: a `provider/model` route (Model mix semantics). The
    // endpoint and key env come from that provider's dsh configuration, not
    // from the user; empty → still follow the session / explicit 3-part config.
    const routeText = (config.verifier ?? '').trim();
    let baseUrl = '';
    let apiKeyEnv = 'DEEPSEEK_API_KEY';
    let model = '';
    if (routeText) {
        const parsed = normalizeMixEntry(routeText, knownProvidersOf(ctx));
        const routeProvider = typeof parsed === 'string'
            ? provider
            : (parsed.provider && parsed.provider.length > 0 ? parsed.provider : provider);
        const routeModel = typeof parsed === 'string' ? parsed : parsed.model;
        const routeEndpoint = routeProvider ? sessionProviderEndpoint(ctx, routeProvider) : {};
        baseUrl = routeEndpoint.baseUrl?.trim() ?? '';
        apiKeyEnv = routeEndpoint.apiKeyEnv ?? apiKeyEnv;
        model = routeModel;
    }
    else {
        baseUrl =
            (config.baseUrl ?? '').trim() ||
                sessionEndpoint.baseUrl?.trim() ||
                process.env.OPENAI_BASE_URL?.trim() ||
                '';
        if (baseUrl.length === 0)
            baseUrl = '';
        apiKeyEnv = sessionEndpoint.apiKeyEnv ?? apiKeyEnv;
        const inheritedModel = conversation?.model ?? '';
        model = (config.model ?? '').trim() || inheritedModel || '';
    }
    if (baseUrl.length === 0 && process.env.DEEPSEEK_API_KEY?.trim())
        baseUrl = 'https://api.deepseek.com';
    const apiKey = await resolveApiKey(ctx, config, apiKeyEnv);
    const deepseek = config.deepseek ?? baseUrl.includes('api.deepseek.com');
    const backendConfig = {
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        apiKey,
        timeoutMs: config.timeoutMs,
        maxConcurrency: config.maxConcurrency,
        deepseek,
        prefill: config.prefill,
        autoDegrade: config.autoDegrade ?? true,
    };
    console.error(`[verifier] backend resolved: baseUrl=${baseUrl || '(session endpoint)'} ` +
        `model=${model || '(conversation model)'} deepseek=${String(deepseek)}`);
    return new VerifierBackend(backendConfig);
}
/**
 * The Jev selector for this call, or `undefined` when `config.selector` is not
 * `jev` (the LLM verifier scores the comparisons). The endpoint, model and key
 * come only from the jev* fields — never from the LLM verifier's endpoint.
 */
export async function resolveJev(ctx, config) {
    if ((config.selector ?? 'llm').trim() !== 'jev')
        return undefined;
    const explicit = (config.jevApiKey ?? '').trim();
    const jev = new JevBackend({
        baseUrl: config.jevBaseUrl,
        model: config.jevModel,
        apiKey: explicit ? await resolveExplicitKey(ctx, explicit) : undefined,
        timeoutMs: config.timeoutMs,
        maxConcurrency: config.maxConcurrency,
    });
    console.error(`[verifier] selector: jev endpoint=${jev.config.endpoint} model=${jev.config.model}`);
    return jev;
}
/**
 * The Bo-N mode decision, evaluated per turn (hot).
 *
 * Since dsh 0.1.7 the plugin Config is the only settings layer, so this is one
 * switch: `config.boN: true` turns the mode on for EVERY conversation at
 * `config.boNCandidates`, anything else is off.
 */
export function resolveBoNMode(config) {
    const nCandidates = config.boNCandidates ?? 5;
    if (config.boN)
        return { enabled: true, nCandidates, source: 'config-default' };
    return { enabled: false, nCandidates: 0, source: 'off' };
}
/** The `ctx.verifierPro` service (service face). Unique name: the original
 * `verifier` service is already registered by @aispin/plugin-verifier — both
 * plugins coexist in one profile. */
export class VerifierService extends Service {
    config;
    backend;
    constructor(ctx, config) {
        super(ctx, 'verifierPro');
        this.config = config;
    }
    async backendFor(conversation) {
        // Lazy per-call resolution: a missing key fails the CALL, not the mount.
        return resolveBackend(this.ctx, currentConfig(this.config), conversation);
    }
    async jevFor() {
        return resolveJev(this.ctx, currentConfig(this.config));
    }
    /** Rank N candidates best-first with the PPT. */
    async verify(options) {
        if (options.candidates.length < 2)
            throw new Error('verifier: at least 2 candidates are required');
        const backend = await this.backendFor();
        const jev = await this.jevFor();
        const result = await verifyBest(backend, backend.config.model ?? 'deepseek-v4-flash', options.task, options.candidates, {
            criteria: options.criteria ? Object.keys(options.criteria) : undefined,
            pivots: options.pivots,
            seed: options.seed,
            nEvaluations: options.nEvaluations,
            ...(jev ? { jev } : {}),
        });
        return { bestIndex: result.bestIndex, ranking: result.ranking, callsSpent: result.callsSpent };
    }
    /** Fine-grained rewards for one directed comparison. */
    async compare(problem, traceA, traceB, criteriaInput, opts) {
        const backend = await this.backendFor();
        const verifier = new Verifier(backend.config, await this.jevFor());
        return verifier.compare(problem, traceA, traceB, criteriaInput, opts);
    }
    /** PPT best-of-N selection (tool face parity). */
    async select(problem, candidates, criteriaInput, opts) {
        const backend = await this.backendFor();
        const verifier = new Verifier(backend.config, await this.jevFor());
        return verifier.select(problem, candidates, criteriaInput, opts);
    }
    /** Per-step progress tracking. */
    async track(problem, steps, opts) {
        const backend = await this.backendFor();
        const verifier = new Verifier(backend.config);
        return verifier.track(problem, steps, opts);
    }
}
/** Format token usage for footers and diagnostics. */
function formatUsage(usage) {
    const u = usage;
    if (!u)
        return '';
    const rate = u.inputTokens > 0 ? (100 * u.cachedInputTokens) / u.inputTokens : 0;
    return `${u.calls} verifier call(s), input ${u.inputTokens} tokens (cached ${u.cachedInputTokens}, ${rate.toFixed(1)}% hit), output ${u.outputTokens} tokens (reasoning ${u.reasoningTokens})`;
}
export function apply(ctx, config) {
    // `compare`/`select`/`track` are ordinary fields read once here; every
    // volatile field is read per call/turn through currentConfig(config).
    const cfg = config;
    // Service face.
    const service = new VerifierService(ctx, cfg);
    ctx.verifierPro = service;
    const backendFor = async () => {
        // Lazily-created shared backend (Bo-N and tools share one instance so
        // token accounting is holistic). A missing key fails the first CALL.
        return service['backendFor']();
    };
    // ── Tool face ────────────────────────────────────────────────────────────
    // verify_compare / verify_select / verify_track (inject verify* guidance).
    ctx.systemPrompt.section({
        name: 'tool:verify',
        order: 120,
        text: 'Use the verify_* tools to get fine-grained probabilistic feedback on ' +
            'your own work before committing to it: verify_compare scores two ' +
            'candidates against evaluation criteria (expected score over the ' +
            "verifier's logprob distribution); verify_select picks the best of N " +
            'candidates with a Probabilistic Pivot Tournament (O(Nk) comparisons, ' +
            'cheaper than a full round-robin); verify_track scores your progress ' +
            'after each step.',
    });
    if (cfg.compare ?? true) {
        ctx.tools.register(defineTool({
            name: 'verify_compare',
            description: 'Score two candidate solutions/trajectories against evaluation criteria with a fine-grained reward model: the verifier distribution over a 20-letter scale is read at the score-tag logprobs and normalized to [0,1]. Returns (scoreA, scoreB) plus token usage.',
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
                    const v = value;
                    const winner = v.scoreA >= v.scoreB ? 'candidate A' : 'candidate B';
                    const margin = Math.abs(v.scoreA - v.scoreB);
                    const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage) : '';
                    return [{ type: 'text', text: [
                                `Fine-grained rewards on criteria ${(v.criteria ?? []).join(', ')}:`,
                                `  candidate A: ${v.scoreA.toFixed(4)}`,
                                `  candidate B: ${v.scoreB.toFixed(4)}`,
                                `Winner: ${winner} (margin ${margin.toFixed(4)})`,
                                usage,
                            ].filter(Boolean).join('\n') }];
                },
            },
            timeoutMs: 120_000,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const backend = await backendFor();
                const verifier = new Verifier(backend.config, await service['jevFor']());
                const result = await verifier.compare(args.problem, args.candidateA, args.candidateB, args.criteria, {
                    nEvaluations: args.nEvaluations ?? 1,
                    groundTruthNote: args.groundTruthNote,
                    signal: exec.signal,
                });
                return { scoreA: result.scoreA, scoreB: result.scoreB, criteria: result.criteria, usage: result.usage };
            },
        }));
    }
    if (cfg.select ?? true) {
        ctx.tools.register(defineTool({
            name: 'verify_select',
            description: 'Select the best of N candidate solutions/trajectories with a Probabilistic Pivot Tournament: a seeded ring pass plus pivot rounds aggregate pairwise fine-grained rewards into per-candidate preferences. Runs O(Nk) verifier comparisons instead of O(N^2); identical inputs with the same seed run the identical tournament.',
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
                    const v = value;
                    const ranking = (v.ranking ?? []).map((index, rank) => `  ${rank + 1}. candidate ${index}: ${(v.scores?.[index] ?? 0).toFixed(4)}`).join('\n');
                    const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage) : '';
                    return [{ type: 'text', text: [
                                `Best candidate: ${v.index} (${v.nComparisons ?? 0} directed comparisons)`,
                                'Ranking:',
                                ranking,
                                usage,
                            ].filter(Boolean).join('\n') }];
                },
            },
            timeoutMs: 360_000,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const backend = await backendFor();
                const verifier = new Verifier(backend.config, await service['jevFor']());
                const result = await verifier.select(args.problem, args.candidates, args.criteria, {
                    nEvaluations: args.nEvaluations ?? 4,
                    pivots: args.pivots ?? 2,
                    seed: args.seed ?? 0,
                    groundTruthNote: args.groundTruthNote,
                    signal: exec.signal,
                });
                return {
                    index: result.index,
                    best: result.best,
                    scores: result.scores,
                    ranking: result.ranking,
                    nComparisons: result.nComparisons,
                    criteria: result.criteria,
                    usage: result.usage,
                };
            },
        }));
    }
    if (cfg.track ?? true) {
        ctx.tools.register(defineTool({
            name: 'verify_track',
            description: 'Score an agent trajectory\'s progress after each checkpoint step: a skeptical verifier judges whether the state after each step already satisfies the task\'s hidden grader, decoded from the logprob expectation over the A(0%)..T(100%) scale. One call scores all checkpoints; repeated evaluations are averaged.',
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
                    const v = value;
                    const curve = (v.steps ?? []).map((step, i) => `  after step ${step}: ${(v.scores?.[i] ?? 0).toFixed(4)}`).join('\n');
                    const usage = typeof v.usage === 'object' && v.usage !== null ? formatUsage(v.usage) : '';
                    return [{ type: 'text', text: [
                                `Progress curve (final ${(v.final ?? 0).toFixed(4)}):`,
                                curve,
                                usage,
                            ].filter(Boolean).join('\n') }];
                },
            },
            timeoutMs: 180_000,
            isConcurrencySafe: () => true,
            async execute(args, exec) {
                const backend = await backendFor();
                const verifier = new Verifier(backend.config);
                const result = await verifier.track(args.problem, args.steps, {
                    checkpoints: args.checkpoints,
                    nEvaluations: args.nEvaluations ?? 1,
                    signal: exec.signal,
                });
                return {
                    steps: result.steps,
                    scores: result.scores,
                    final: result.final,
                    usage: result.usage,
                };
            },
        }));
    }
    // ── Best-of-N mode face ──────────────────────────────────────────────────
    const summariesBySession = new Map();
    const currentTurnOf = (sessionId) => {
        const sessions = ctx.get('sessions');
        const session = sessions?.get(sessionId);
        const events = session?.events;
        if (!events)
            return 0;
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const event = events[i];
            if (event?.type === 'turn/start' && typeof event.data?.turn === 'number')
                return event.data.turn;
        }
        return 0;
    };
    // Client RPC (available in the dynamic-plugin runner; a regular
    // profile/filesystem plugin loads without it — CLI diagnostic covers that case).
    const harness = globalThis.harness;
    if (harness !== undefined) {
        harness.handle('verifier-pro.bo-n.summaries', (args) => {
            const sessionId = args?.sessionId;
            if (!sessionId)
                return [];
            return (summariesBySession.get(sessionId) ?? []).map(summary => ({
                turn: summary.turn,
                task: summary.task,
                ranking: summary.ranking.map(entry => ({ index: entry.index, score: entry.score, normalized: entry.normalized })),
                winnerIndex: summary.winnerIndex,
                winnerScore: summary.winnerScore,
                runnerUpScore: summary.runnerUpScore,
                reason: summary.reason,
            }));
        });
        // Available models for the Bo-N mix picker. `ctx.llm.listProviders()`
        // yields `{ id, name }` route entries; each route's advisory catalog comes
        // from `await ctx.llm.listModels(providerId)` as `{ provider, id, name }`
        // rows. Returns `{ provider, model }` rows sorted by provider then model —
        // exactly what the mix list consumes.
        harness.handle('verifier-pro.available-models', async () => {
            try {
                const rows = [];
                for (const { id: provider } of ctx.llm.listProviders()) {
                    let models;
                    try {
                        models = await ctx.llm.listModels(provider);
                    }
                    catch {
                        // A provider whose catalog is unavailable is simply omitted; the
                        // catalog is advisory and never a request-routing gate.
                        continue;
                    }
                    for (const { id: model } of models)
                        if (model)
                            rows.push({ provider, model });
                }
                rows.sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model));
                return rows;
            }
            catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
            }
        });
    }
    ctx.on('llm/stream', (options, next) => {
        if (isInternalRequest(options))
            return next();
        // Main-conversation filter: auxiliary model calls (session titles, …)
        // carry a `purpose`; ordinary conversation requests leave it unset.
        if (options.purpose !== undefined)
            return next();
        const sessionId = options.sessionId;
        if (sessionId === undefined)
            return next();
        // One switch (cfg.boN), fail-open. Read per turn: a panel edit applies to the next turn.
        return (async function* boNTurn() {
            const cfg = currentConfig(config);
            const decision = resolveBoNMode(cfg);
            if (!decision.enabled) {
                yield* next();
                return;
            }
            console.error(`[bo-n] mode: ${decision.source} (n=${String(decision.nCandidates)})`);
            let backend;
            let jev;
            try {
                backend = await resolveBackend(ctx, cfg, options);
                jev = await resolveJev(ctx, cfg);
            }
            catch (error) {
                console.error(`[bo-n] verifier config unavailable, degrading to normal answer: ${error instanceof Error ? error.message : String(error)}`);
                yield* next();
                return;
            }
            const boNConfig = {
                nCandidates: decision.nCandidates,
                samplingTemperature: cfg.samplingTemperature ?? 0.7,
                // An empty mix means "follow the session model". Normalized: strings like `omni-chat/agnes/...` whose head is a real
                // provider become explicit routes; anything else stays a full model id
                // (conversation provider).
                mixModels: (() => {
                    const raw = cfg.boNModelMix;
                    const known = knownProvidersOf(ctx);
                    return (raw ?? []).map((entry) => normalizeMixEntry(entry, known));
                })(),
                timeoutMs: cfg.timeoutMsBoN ?? 300_000,
                verifyTimeoutMs: cfg.verifyTimeoutMsBoN ?? 300_000,
                samplingMode: cfg.samplingMode === 'serial' ? 'serial' : 'parallel',
                showFooter: cfg.showFooter ?? true,
                criteria: cfg.criteria,
                pivots: cfg.boNPivots ?? 2,
                seed: cfg.boNSeed ?? 0,
            };
            yield* orchestrate({
                stream: request => ctx.llm.stream(request),
                backend,
                verifierModel: backend.config.model,
                ...(jev ? { jev } : {}),
                onTurnSummary: (summary) => {
                    const list = summariesBySession.get(sessionId) ?? [];
                    list.push({ ...summary, turn: currentTurnOf(sessionId) });
                    summariesBySession.set(sessionId, list);
                },
            }, boNConfig, options, next);
        })();
    }, { global: true });
}
//# sourceMappingURL=index.js.map