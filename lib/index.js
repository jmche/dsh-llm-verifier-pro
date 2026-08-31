/**
 * dsh-llm-verifier-pro: LLM-as-a-Verifier for DeepSeek Harness (unified).
 *
 * Merges the engineering of dsh-llm-as-a-verifier (TaurenMountain, MIT) —
 * fine-grained logprob scoring, Probabilistic Pivot Tournament, vLLM/SGLang
 * prefill, concurrency + timeout + token accounting — with the Best-of-N
 * conversation mode and Web settings panel of @aispin/plugin-verifier
 * (Aispin, MIT). Method by the LLM-as-a-Verifier paper (arXiv:2607.05391).
 *
 * Three faces:
 *  1. Tools — `verify_compare` / `verify_select` / `verify_track` (agent calls
 *     them on demand for fine-grained probabilistic feedback).
 *  2. Service — `ctx.verifierPro.verify/compare/select/track` for code consumers.
 *  3. Mode — Best-of-N conversation mode: every assistant turn of a Bo-N
 *     session is sampled N ways and only the winning response replayed.
 *     Three-state gating: settings global (Web UI switch) → session preset →
 *     config default → off.
 *
 * Verifier credentials resolve zero-config from the dsh provider state:
 * plugin config (baseUrl/apiKey/model) → the `verifier` settings namespace →
 * the credentials seam (`credential:<name>` or the ambient key env) →
 * OPENAI_BASE_URL/OPENAI_API_KEY/DEEPSEEK_API_KEY.
 *
 * @module dsh-llm-verifier-pro
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { settingsNamespace } from '@deepseek-ai/dsh-settings';
import { VerifierBackend } from './backend.js';
import { Verifier } from './verifier.js';
import { orchestrate, isInternalRequest, verifyBest } from './bon.js';
export { VerifierBackend, TokenUsage, MissingAPIKeyError, VerifierError, } from './backend.js';
export { Verifier } from './verifier.js';
export { extractScore, SCALE, GRANULARITY, normalizeCriteria, buildPairwisePrompt } from './scoring.js';
export { selectBest, bradleyTerry, ringCycle, pivotRoundPairs, selectPivots, createRng, DEFAULT_PIVOTS, accumulate } from './tournament.js';
export { extractProgressScores, buildProgressPrompt, LETTER_TO_VALUE, defaultCheckpoints } from './progress.js';
export { orchestrate, collectRollout, replayWithFooter, verifyBest, taskOf, isInternalRequest, markInternalRequest } from './bon.js';
/** Cordis plugin name used by loader diagnostics. */
export const name = 'llm-verifier-pro';
/** Services required. `tools` + `systemPrompt` for the tool face; `llm` for the Bo-N sampling re-entry. */
export const inject = ['tools', 'systemPrompt', 'llm'];
export const Config = z.object({
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
    verifier: z.string(),
    timeoutMs: z.number(),
    maxConcurrency: z.number(),
    deepseek: z.boolean(),
    prefill: z.boolean(),
    autoDegrade: z.boolean().default(true),
    settingsNs: z.string().default('verifier-pro'),
    compare: z.boolean().default(true),
    select: z.boolean().default(true),
    track: z.boolean().default(true),
    boN: z.boolean().default(false),
    boNCandidates: z.number().default(5),
    samplingTemperature: z.number().default(0.7),
    samplingMode: z.string().default('parallel'),
    timeoutMsBoN: z.number().default(300_000),
    verifyTimeoutMsBoN: z.number().default(300_000),
    showFooter: z.boolean().default(true),
    criteria: z.array(z.string()).default([]),
    boNPivots: z.number().default(2),
    boNSeed: z.number().default(0),
    boNModelMix: z.array(z.union([z.string(), z.object({ provider: z.string(), model: z.string() })])).default([]),
});
/** The settings section schema. Field NAMES mirror Config exactly, so the
 * settings document and the plugin-config patch share one vocabulary. Only
 * `verifier` and `boNModelMix` are optional (no default): `undefined` means
 * "panel never set" → runtime falls back to plugin config, while an explicit
 * value (including an explicit empty mix) overrides plugin config. */
const SettingsSectionSchema = z.object({
    baseUrl: z.string().default(''),
    apiKey: z.string().default(''),
    model: z.string().default(''),
    verifier: z.string().default(''),
    timeoutMs: z.number().required(false),
    autoDegrade: z.boolean().required(false),
    boN: z.boolean().required(false),
    boNCandidates: z.number().required(false),
    samplingTemperature: z.number().required(false),
    samplingMode: z.string().required(false),
    timeoutMsBoN: z.number().required(false),
    verifyTimeoutMsBoN: z.number().required(false),
    showFooter: z.boolean().required(false),
    criteria: z.array(z.string()).required(false),
    boNPivots: z.number().required(false),
    boNSeed: z.number().required(false),
    // No schema default: `undefined` = "panel never set" (runtime falls back to
    // plugin config), while an explicit `[]` from the panel = "no model mix"
    // (follow the session model) and overrides the plugin config.
    boNModelMix: z.array(z.union([z.string(), z.object({ provider: z.string(), model: z.string() })])).required(false),
});
/**
 * Normalize one model-mix value to the runtime entry shape (`string` or
 * `{ provider, model }`). Values may arrive from three places with three
 * dialects:
 *   - plugin config (object or string; exact),
 *   - the settings document (object, string, or legacy `provider/model` text),
 *   - the Web panel (parsed already).
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
/**
 * Register the verifier settings namespace and return a hot reader.
 * The settings seam is optional (delegate-and-degrade): without it the reader
 * yields the empty section and explicit plugin config carries everything.
 */
export function sectionReaderOf(ctx, config) {
    let scope;
    const register = (host) => {
        const settings = host.settings;
        if (settings === undefined)
            return;
        try {
            // The plugin config acts as the composition BASE for the settings
            // section: the Web panel shows config-layered defaults (model mix,
            // candidates, verify budget, criteria, endpoint) and only what the user
            // changed in the panel overrides them. Empty primitives stay empty so a
            // missing value reads as "unconfigured", never as a wrong default.
            const base = {};
            // Plugin-config keys → settings-section keys. Field names now MATCH
            // Config exactly (one shared vocabulary), so this is an identity map.
            //
            // `verifier` and `boNModelMix` are DELIBERATELY not forwarded into the
            // settings base: those two are panel-overridable user choices. Forwarding
            // them would make the panel's "Restore defaults / empty" fall back to the
            // plugin-config value (e.g. a profile patch's model mix) instead of the
            // bundle default (empty = follow the session). The runtime still falls
            // back to the plugin config when the section is UNSET — but an explicit
            // panel value (including an explicit empty mix) wins over it.
            const forward = [
                'baseUrl',
                'apiKey',
                'model',
                'timeoutMs',
                'autoDegrade',
                'boN',
                'boNCandidates',
                'samplingTemperature',
                'samplingMode',
                'timeoutMsBoN',
                'verifyTimeoutMsBoN',
                'showFooter',
                'criteria',
                'boNPivots',
                'boNSeed',
            ];
            for (const key of forward) {
                if (config[key] !== undefined)
                    base[key] = config[key];
            }
            scope = settings.register(settingsNamespace(config.settingsNs ?? 'verifier-pro'), SettingsSectionSchema, { base });
        }
        catch (error) {
            // Duplicate registration (or a schema conflict) — degrade to explicit config.
            console.error(`[verifier-pro] settings namespace registration failed (${error instanceof Error ? error.message : String(error)}); falling back to explicit config only`);
        }
    };
    // Preferred path: declare the settings dependency and register once it is
    // available (the real host publishes it after our mount has started). A
    // plain cordis context (tests) or an unavailable settings plugin degrades to
    // occasional probes — never a hard failure.
    const inject = ctx.inject;
    if (inject !== undefined) {
        try {
            inject(['settings'], (sctx) => register(sctx));
        }
        catch (error) {
            console.error(`[verifier-pro] settings inject failed (${error instanceof Error ? error.message : String(error)}); explicit config only`);
        }
    }
    else {
        register(ctx);
    }
    return () => {
        // Hot re-read; register lazily in case the seam arrived after first use.
        if (scope === undefined)
            register(ctx);
        return (scope?.get() ?? {});
    };
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
/** Resolve one API key from the full chain. */
async function resolveApiKey(ctx, config, section, apiKeyEnv) {
    const explicit = (config.apiKey ?? '').trim();
    if (explicit.length > 0) {
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
    if (section.apiKey?.trim().length) {
        const sectionKey = section.apiKey.trim();
        if (sectionKey.startsWith('credential:')) {
            const credentials = ctx.get('credentials');
            const ref = credentialRef(sectionKey.slice('credential:'.length));
            const hit = credentials === undefined ? undefined : await credentials.resolve(ref);
            if (hit === undefined)
                throw new Error(`verifier: credential "${sectionKey.slice('credential:'.length)}" is not configured`);
            return hit.value;
        }
        return sectionKey;
    }
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
 * Resolve a session provider's endpoint configuration from dsh's settings
 * namespaces. Container-style namespaces hold per-provider entries
 * (`llm-pi-ai.providers.<name>.{baseURL, apiKeyEnv}`); a dedicated namespace
 * (`llm-<provider>`) may itself carry the endpoint (`llm-deepseek`). Returns
 * `{}` when the provider is unknown — the caller falls back to its env chain.
 */
export function sessionProviderEndpoint(ctx, provider) {
    if (!provider)
        return {};
    try {
        const settings = ctx.get('settings');
        if (!settings)
            return {};
        for (const nsName of ['llm-pi-ai', `llm-${provider}`]) {
            const section = settings.get(settingsNamespace(nsName));
            if (!section || typeof section !== 'object')
                continue;
            const providers = (section.providers ?? {});
            const entry = providers[provider];
            if (entry && typeof entry.baseURL === 'string' && entry.baseURL.length > 0) {
                return { baseUrl: entry.baseURL, apiKeyEnv: typeof entry.apiKeyEnv === 'string' ? entry.apiKeyEnv : undefined };
            }
            if (nsName === `llm-${provider}` && typeof section.baseURL === 'string' && section.baseURL.length > 0) {
                return { baseUrl: section.baseURL, apiKeyEnv: typeof section.apiKeyEnv === 'string' ? section.apiKeyEnv : undefined };
            }
        }
    }
    catch {
        // degrade: fall through to the environment chain
    }
    return {};
}
/**
 * Resolve the verifier backend connection from dsh's configured provider
 * state. Default (no explicit config, no panel Verifier route and no
 * three-part endpoint): the verifier FOLLOWS THE SESSION — same provider
 * route, endpoint and model as the conversation, so a user who only turns on
 * Best-of-N gets the zero-config self-verification experience (generate N
 * variants and grade them all with the conversation's own model).
 *
 * Resolution order:
 *  1. `verifier` route (config.verifier / section.verifier) — a
 *     `provider/model` string like the Model mix entries: endpoint + key env
 *     are read from dsh's provider config; a bare model id rides the session
 *     provider.
 *  2. three-part endpoint: config.baseUrl/apiKey/model → section.baseUrl/
 *     apiKey/model → session provider endpoint → env chain.
 *  3. model falls back to the conversation's own model (any provider route).
 */
export async function resolveBackend(ctx, config, conversation, sectionReader = () => ({})) {
    const section = sectionReader();
    const provider = conversation?.provider ?? '';
    const sessionEndpoint = provider ? sessionProviderEndpoint(ctx, provider) : {};
    // Preferred form: a `provider/model` route (Model mix semantics). The
    // endpoint and key env come from that provider's dsh configuration, not
    // from the user; empty → still follow the session / explicit 3-part config.
    // The PANEL (settings section) wins over the plugin config: a user who sets
    // the verifier in the Web UI must override a profile-patch `verifier`.
    const routeText = ((section.verifier ?? '').trim() || (config.verifier ?? '').trim() || '');
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
                section.baseUrl?.trim() ||
                sessionEndpoint.baseUrl?.trim() ||
                process.env.OPENAI_BASE_URL?.trim() ||
                '';
        if (baseUrl.length === 0)
            baseUrl = '';
        apiKeyEnv = sessionEndpoint.apiKeyEnv ?? apiKeyEnv;
        const inheritedModel = conversation?.model ?? '';
        model = (config.model ?? '').trim() || section.model?.trim() || inheritedModel || '';
    }
    if (baseUrl.length === 0 && process.env.DEEPSEEK_API_KEY?.trim())
        baseUrl = 'https://api.deepseek.com';
    const apiKey = await resolveApiKey(ctx, config, section, apiKeyEnv);
    const deepseek = config.deepseek ?? baseUrl.includes('api.deepseek.com');
    const backendConfig = {
        model: model || undefined,
        baseUrl: baseUrl || undefined,
        apiKey,
        timeoutMs: section.timeoutMs ?? config.timeoutMs,
        maxConcurrency: config.maxConcurrency,
        deepseek,
        prefill: config.prefill,
        autoDegrade: section.autoDegrade ?? config.autoDegrade ?? true,
    };
    console.error(`[verifier] backend resolved: baseUrl=${baseUrl || '(session endpoint)'} ` +
        `model=${model || '(conversation model)'} deepseek=${String(deepseek)}`);
    return new VerifierBackend(backendConfig);
}
/**
 * The Bo-N mode decision, evaluated per turn (hot): settings global →
 * config default → off.
 *
 * The panel's explicit switch is the whole story: `boN: true` turns the mode
 * on for EVERY conversation at the section's candidate count, and an explicit
 * `boN: false` is the master kill-switch that also overrides the config
 * default. Only an unset section falls through to the deployment default
 * (`config.boN`).
 */
export function resolveBoNMode(config, sectionReader = () => ({})) {
    const section = sectionReader();
    const nCandidates = section.boNCandidates ?? config.boNCandidates ?? 5;
    // ① Settings global — the Web UI switch.
    if (section.boN === true)
        return { enabled: true, nCandidates, source: 'settings-global' };
    // ② Config deployment default.
    if (section.boN !== false && config.boN)
        return { enabled: true, nCandidates, source: 'config-default' };
    return { enabled: false, nCandidates: 0, source: 'off' };
}
/** The `ctx.verifierPro` service (service face). Unique name: the original
 * `verifier` service is already registered by @aispin/plugin-verifier — both
 * plugins coexist in one profile. */
export class VerifierService extends Service {
    config;
    sectionReader;
    backend;
    constructor(ctx, config, sectionReader = () => ({})) {
        super(ctx, 'verifierPro');
        this.config = config;
        this.sectionReader = sectionReader;
    }
    async backendFor(conversation) {
        // Lazy per-call resolution: a missing key fails the CALL, not the mount.
        return resolveBackend(this.ctx, this.config, conversation, this.sectionReader);
    }
    /** Rank N candidates best-first with the PPT. */
    async verify(options) {
        if (options.candidates.length < 2)
            throw new Error('verifier: at least 2 candidates are required');
        const backend = await this.backendFor();
        const result = await verifyBest(backend, backend.config.model ?? 'deepseek-v4-flash', options.task, options.candidates, {
            criteria: options.criteria ? Object.keys(options.criteria) : undefined,
            pivots: options.pivots,
            seed: options.seed,
            nEvaluations: options.nEvaluations,
        });
        return { bestIndex: result.bestIndex, ranking: result.ranking, callsSpent: result.callsSpent };
    }
    /** Fine-grained rewards for one directed comparison. */
    async compare(problem, traceA, traceB, criteriaInput, opts) {
        const backend = await this.backendFor();
        const verifier = new Verifier(backend.config);
        return verifier.compare(problem, traceA, traceB, criteriaInput, opts);
    }
    /** PPT best-of-N selection (tool face parity). */
    async select(problem, candidates, criteriaInput, opts) {
        const backend = await this.backendFor();
        const verifier = new Verifier(backend.config);
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
    const cfg = { ...config };
    // Settings face: register the namespace once, read hot from here on.
    const sectionReader = sectionReaderOf(ctx, cfg);
    // Service face.
    const service = new VerifierService(ctx, cfg, sectionReader);
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
                const verifier = new Verifier(backend.config);
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
                const verifier = new Verifier(backend.config);
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
        // Two-state gating (settings global → config default), fail-open.
        return (async function* boNTurn() {
            const decision = resolveBoNMode(cfg, sectionReader);
            if (!decision.enabled) {
                yield* next();
                return;
            }
            console.error(`[bo-n] mode: ${decision.source} (n=${String(decision.nCandidates)})`);
            let backend;
            try {
                backend = await resolveBackend(ctx, cfg, options, sectionReader);
            }
            catch (error) {
                console.error(`[bo-n] verifier config unavailable, degrading to normal answer: ${error instanceof Error ? error.message : String(error)}`);
                yield* next();
                return;
            }
            const boNConfig = {
                nCandidates: decision.nCandidates,
                samplingTemperature: sectionReader().samplingTemperature ?? cfg.samplingTemperature ?? 0.7,
                // Web panel wins over plugin config for the mix (hot re-read per turn).
                // `undefined` = panel never set → fall back to plugin config; an
                // explicit `[]` from the panel = "no mix" (follow the session model)
                // and OVERRIDES the plugin config. Both layers are normalized:
                // settings-document strings like `omni-chat/agnes/...` whose head is a
                // real provider become explicit routes; anything else stays a full
                // model id (conversation provider).
                mixModels: (() => {
                    const sectionMix = sectionReader().boNModelMix;
                    const raw = sectionMix !== undefined ? sectionMix : cfg.boNModelMix;
                    const known = knownProvidersOf(ctx);
                    return (raw ?? []).map((entry) => normalizeMixEntry(entry, known));
                })(),
                timeoutMs: sectionReader().timeoutMsBoN ?? cfg.timeoutMsBoN ?? 300_000,
                verifyTimeoutMs: sectionReader().verifyTimeoutMsBoN ?? cfg.verifyTimeoutMsBoN ?? 300_000,
                // Rollout schedule: panel wins over config, config over the default.
                samplingMode: sectionReader().samplingMode === 'serial'
                    ? 'serial'
                    : (cfg.samplingMode === 'serial' ? 'serial' : 'parallel'),
                showFooter: sectionReader().showFooter ?? cfg.showFooter ?? true,
                criteria: sectionReader().criteria?.length ? sectionReader().criteria : cfg.criteria,
                pivots: sectionReader().boNPivots ?? cfg.boNPivots ?? 2,
                seed: sectionReader().boNSeed ?? cfg.boNSeed ?? 0,
            };
            yield* orchestrate({
                stream: request => ctx.llm.stream(request),
                backend,
                verifierModel: backend.config.model,
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