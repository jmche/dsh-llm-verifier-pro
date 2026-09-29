/**
 * The Jev selector: pairwise fine-grained rewards served by a System One
 * endpoint (TypeSafe's Jev) instead of an OpenAI-compatible chat model.
 *
 * Jev does not generate text. One request carries a `state` and typed
 * `questions`; a Score question returns a probability for every level of an
 * ordered rubric. A directed comparison asks one Score per slot (A and B)
 * against the same state, and the reward is the expectation over the levels,
 * normalized to [0, 1] — the same range and orientation as the LLM path's
 * logprob expectation, so the tournament, the Bradley-Terry aggregation and
 * the slot-swap bookkeeping are unchanged.
 *
 * Protocol: https://docs.typesafe.ai/api.md
 *
 * @module dsh-llm-verifier-pro/jev
 */
import { TokenUsage, VerifierError } from './backend.js';
/** TypeSafe's own endpoint and flagship model alias. */
export const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';
export const DEFAULT_JEV_MODEL = 'jev-latest';
/** Ordered Score levels, worst first: the level index is the reward numerator. */
export const JEV_LEVELS = [
    'Clearly and completely fails the task',
    'Failed, with only a little partial progress',
    'Below average: significant issues remain',
    'Uncertain, leans toward failure',
    'Uncertain, leans toward success',
    'Above average: mostly correct with some issues',
    'Succeeded with only minor issues',
    'Succeeded, with trivial nits at most',
    'Clearly and completely succeeds, correct and verified',
];
const MAX_RETRIES = 3;
/** The System One endpoint for a configured base: `<base>/systemone`, or the base itself when it already is one. */
export function systemOneEndpoint(baseUrl) {
    const base = baseUrl.trim().replace(/\/+$/, '');
    return base.endsWith('/systemone') ? base : `${base}/systemone`;
}
/** Expected level of one Score answer, normalized to [0, 1]. */
export function scoreReward(answer, levels) {
    const probabilities = answer?.probabilities;
    if (!probabilities || typeof probabilities !== 'object') {
        throw new VerifierError('malformed Jev response: score answer has no probabilities');
    }
    let expected = 0;
    let mass = 0;
    for (const [level, p] of Object.entries(probabilities)) {
        const index = Number(level);
        if (!Number.isInteger(index) || typeof p !== 'number' || !Number.isFinite(p))
            continue;
        expected += index * p;
        mass += p;
    }
    if (mass <= 0)
        throw new VerifierError('malformed Jev response: score probabilities are empty');
    return expected / mass / (levels - 1);
}
export class JevBackend {
    config;
    usage = new TokenUsage();
    constructor(config = {}) {
        const baseUrl = config.baseUrl?.trim() || DEFAULT_JEV_BASE_URL;
        const apiKey = config.apiKey?.trim();
        this.config = {
            endpoint: systemOneEndpoint(baseUrl),
            model: config.model?.trim() || DEFAULT_JEV_MODEL,
            ...(apiKey ? { apiKey } : {}),
            timeoutMs: config.timeoutMs ?? 60_000,
            maxConcurrency: Math.max(1, config.maxConcurrency ?? 8),
        };
    }
    /** POST one System One request; 429/529 are retried with backoff as the provider documents. */
    async post(body, signal) {
        for (let attempt = 0;; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(new Error(`Jev request timed out after ${this.config.timeoutMs}ms`)), this.config.timeoutMs);
            const onAbort = () => controller.abort(signal?.reason);
            if (signal) {
                if (signal.aborted)
                    onAbort();
                else
                    signal.addEventListener('abort', onAbort, { once: true });
            }
            let res;
            try {
                res = await fetch(this.config.endpoint, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
                    },
                    body: JSON.stringify(body),
                    signal: controller.signal,
                });
                if ((res.status === 429 || res.status === 529) && attempt < MAX_RETRIES) {
                    const retryAfter = Number(res.headers.get('retry-after'));
                    const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
                    await new Promise((resolve) => setTimeout(resolve, delay));
                    continue;
                }
                if (!res.ok) {
                    const detail = (await res.text().catch(() => '')).slice(0, 200);
                    throw new VerifierError(`Jev endpoint returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
                }
                return (await res.json());
            }
            catch (error) {
                if (error instanceof VerifierError)
                    throw error;
                throw new VerifierError(`Jev call failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
            }
            finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
            }
        }
    }
    /**
     * Fine-grained rewards (R_A, R_B) in [0, 1] for one directed comparison
     * under one criterion. `traceA` is the response in slot A.
     */
    async scorePair(task, traceA, traceB, criterion, groundTruthNote = '', signal) {
        const question = (slot) => ({
            type: 'score',
            instructions: {
                criterion: { name: criterion.name, description: criterion.description },
                question: `On \`criterion\` only, how well does \`response_${slot}\` solve \`task\`? ` +
                    `Judge response ${slot}; the other response is there for comparison.`,
            },
            criteria: JEV_LEVELS,
        });
        const note = groundTruthNote.trim();
        const response = await this.post({
            model: this.config.model,
            state: { task, response_A: traceA, response_B: traceB, ...(note ? { reference_note: note } : {}) },
            questions: { score_A: question('A'), score_B: question('B') },
        }, signal);
        const answers = response.answers;
        if (!answers)
            throw new VerifierError('malformed Jev response: no answers');
        const usage = response.usage;
        const tokens = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0);
        this.usage.add(tokens(usage?.input_tokens), 0, tokens(usage?.output_tokens));
        return [scoreReward(answers.score_A, JEV_LEVELS.length), scoreReward(answers.score_B, JEV_LEVELS.length)];
    }
    /** Run the workers with at most `maxConcurrency` in flight (same contract as VerifierBackend.runAll). */
    async runAll(workers) {
        if (workers.length === 0)
            return [];
        const results = new Array(workers.length);
        let next = 0;
        const runner = async () => {
            while (true) {
                const i = next++;
                if (i >= workers.length)
                    return;
                results[i] = await workers[i]();
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.config.maxConcurrency, workers.length) }, () => runner()));
        return results;
    }
}
//# sourceMappingURL=jev.js.map