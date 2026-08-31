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
/** No verifier backend could be configured. */
export class MissingAPIKeyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'MissingAPIKeyError';
    }
}
/** A verifier backend call failed (HTTP error, timeout, or malformed reply). */
export class VerifierError extends Error {
    status;
    cause;
    constructor(message, status, cause) {
        super(message);
        this.status = status;
        this.cause = cause;
        this.name = 'VerifierError';
    }
}
function int(value) {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
}
/** Thread-safe (single-threaded) running total of verifier token usage. */
export class TokenUsage {
    calls = 0;
    inputTokens = 0;
    cachedInputTokens = 0;
    outputTokens = 0;
    reasoningTokens = 0;
    reset() {
        this.calls = 0;
        this.inputTokens = 0;
        this.cachedInputTokens = 0;
        this.outputTokens = 0;
        this.reasoningTokens = 0;
    }
    add(inputTokens = 0, cachedInputTokens = 0, outputTokens = 0, reasoningTokens = 0, calls = 1) {
        this.calls += calls;
        this.inputTokens += inputTokens;
        this.cachedInputTokens += cachedInputTokens;
        this.outputTokens += outputTokens;
        this.reasoningTokens += reasoningTokens;
    }
    /** Record one backend response's usage; a no-op when no usage block is present. */
    record(response) {
        const usage = response.usage;
        if (!usage)
            return;
        const promptDetails = usage.prompt_tokens_details;
        const completionDetails = usage.completion_tokens_details;
        let cached = int(promptDetails?.cached_tokens);
        if (!cached)
            cached = int(usage.prompt_cache_hit_tokens);
        const inputTokens = int(usage.prompt_tokens);
        const outputTokens = int(usage.completion_tokens);
        const reasoningTokens = int(completionDetails?.reasoning_tokens);
        if (!inputTokens && !cached && !outputTokens)
            return;
        this.add(inputTokens, cached, outputTokens, reasoningTokens);
    }
    snapshot() {
        return {
            calls: this.calls,
            inputTokens: this.inputTokens,
            cachedInputTokens: this.cachedInputTokens,
            uncachedInputTokens: this.inputTokens - this.cachedInputTokens,
            outputTokens: this.outputTokens,
            reasoningTokens: this.reasoningTokens,
            cacheHitRate: this.inputTokens > 0 ? this.cachedInputTokens / this.inputTokens : 0,
        };
    }
}
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MAX_TOKENS = 32768;
const OPENAI_MAX_TOKENS = 4096;
const GRANULARITY = 20;
export class VerifierBackend {
    config;
    usage = new TokenUsage();
    resolvedModel;
    /**
     * How the last main verifier request was graded: `'logprob'` when the
     * endpoint supplied token-level logprobs, `'sampling'` after a fallback to
     * point-mass (sampling-style) scoring, `undefined` before any main request
     * has been parsed.
     */
    lastGradingMode;
    prefillFailureNoticed = false;
    constructor(config = {}) {
        this.config = VerifierBackend.resolveConfig(config);
    }
    /** Merge explicit config with the process environment (upstream `create_client` order). */
    static resolveConfig(config) {
        const envBaseUrl = process.env.OPENAI_BASE_URL;
        const envKey = process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
        const baseUrl = config.baseUrl ?? envBaseUrl ?? (process.env.DEEPSEEK_API_KEY ? DEEPSEEK_BASE_URL : undefined);
        const apiKey = config.apiKey ?? envKey;
        const deepseek = config.deepseek ??
            (baseUrl?.includes('api.deepseek.com') ??
                (!envBaseUrl && !config.baseUrl && Boolean(process.env.DEEPSEEK_API_KEY)));
        return {
            model: config.model,
            baseUrl,
            apiKey,
            timeoutMs: config.timeoutMs ?? 300_000,
            maxConcurrency: Math.max(1, config.maxConcurrency ?? 8),
            deepseek,
            prefill: config.prefill ?? true,
            autoDegrade: config.autoDegrade ?? true,
        };
    }
    static fromEnvironment(config = {}) {
        return new VerifierBackend(config);
    }
    deepseekParams() {
        const effort = process.env.DEEPSEEK_EFFORT ?? 'high';
        const maxTokens = Number.parseInt(process.env.DEEPSEEK_MAX_TOKENS ?? '', 10) || DEEPSEEK_MAX_TOKENS;
        if (effort === 'off' || effort === 'disabled' || effort === 'none') {
            return { extraBody: { thinking: { type: 'disabled' } }, maxTokens };
        }
        return { extraBody: { thinking: { type: 'enabled' }, reasoning_effort: effort }, maxTokens };
    }
    async resolveModel(override) {
        if (override)
            return override;
        if (this.config.model)
            return this.config.model;
        if (this.config.deepseek)
            return DEEPSEEK_MODEL;
        if (this.resolvedModel)
            return this.resolvedModel;
        if (!this.config.baseUrl)
            throw new MissingAPIKeyError('set baseUrl or OPENAI_BASE_URL');
        const res = await fetch(`${this.config.baseUrl}/models`, {
            headers: { authorization: `Bearer ${this.config.apiKey ?? ''}` },
        });
        if (!res.ok)
            throw new VerifierError(`verifier backend /models returned ${res.status}`, res.status);
        const body = (await res.json());
        const id = body.data?.[0]?.id;
        if (!id)
            throw new VerifierError('verifier backend /models returned no model ids');
        this.resolvedModel = id;
        return id;
    }
    async post(url, body, signal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error(`verifier request timed out after ${this.config.timeoutMs}ms`)), this.config.timeoutMs);
        const onAbort = () => controller.abort(signal?.reason);
        if (signal) {
            if (signal.aborted)
                onAbort();
            else
                signal.addEventListener('abort', onAbort, { once: true });
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
            });
            if (!res.ok)
                throw new VerifierError(`verifier backend returned HTTP ${res.status}`, res.status);
            return (await res.json());
        }
        catch (error) {
            if (error instanceof VerifierError)
                throw error;
            throw new VerifierError(`verifier backend call failed: ${error instanceof Error ? error.message : String(error)}`, undefined, error);
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }
    parse(response) {
        const choices = response.choices;
        const choice = choices?.[0];
        if (!choice)
            throw new VerifierError('malformed verifier response: no choices');
        const message = (choice.message ?? {});
        const text = typeof message.content === 'string' ? message.content : '';
        const logprobs = (choice.logprobs ?? {});
        const tokens = [];
        const positionLogprobs = [];
        this.lastGradingMode = Array.isArray(logprobs.content) && logprobs.content.length > 0 ? 'logprob' : undefined;
        if (Array.isArray(logprobs.content)) {
            for (const pos of logprobs.content) {
                const token = typeof pos.token === 'string' ? pos.token : '';
                tokens.push(token);
                const top = Array.isArray(pos.top_logprobs)
                    ? pos.top_logprobs.map((alt) => ({
                        token: String(alt.token ?? ''),
                        logprob: typeof alt.logprob === 'number' ? alt.logprob : 0,
                    }))
                    : [];
                positionLogprobs.push(top.length > 0 ? top : [{ token, logprob: 0 }]);
            }
        }
        this.usage.record(response);
        return { text, tokens, positionLogprobs };
    }
    async prefillTags(model, messages, analysis, tags) {
        let fullText = analysis;
        const tokens = [];
        const positionLogprobs = [];
        const letters = Array.from({ length: GRANULARITY }, (_, i) => String.fromCharCode(65 + i));
        const choices = [...letters, ...letters.map((c) => ` ${c}`)];
        for (const tag of tags) {
            const prefix = `${fullText}\n${tag}`;
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
                });
                this.usage.record(response);
                const choice = response.choices?.[0];
                const message = (choice?.message ?? {});
                // The score letter may arrive in any model-specific slot: `content`
                // (plain text), `reasoning` (vLLM), `reasoning_content` (DeepSeek-style
                // OpenAI-compatible), or a content ARRAY of text blocks (ChatML). Read
                // them defensively — never crash on an unfamiliar wire shape, fall back
                // to the sampled token below.
                const digest = (value) => {
                    if (typeof value === 'string')
                        return value;
                    if (Array.isArray(value))
                        return value.map(digest).join('');
                    if (value !== null && typeof value === 'object') {
                        const block = value;
                        return digest(block.text ?? block.content);
                    }
                    return '';
                };
                const letter = String(digest(message.content) ||
                    digest(message.reasoning) ||
                    digest(message.reasoning_content) ||
                    '').trim();
                const logprobs = (choice?.logprobs ?? {});
                const pos = logprobs.content?.[0] ?? {};
                const alts = Array.isArray(pos.top_logprobs)
                    ? pos.top_logprobs.map((alt) => ({
                        token: String(alt.token ?? ''),
                        logprob: typeof alt.logprob === 'number' ? alt.logprob : 0,
                    }))
                    : [];
                const resolvedLetter = letter || String(pos.token ?? alts[0]?.token ?? '').trim();
                const closing = `</${tag.slice(1)}`;
                fullText = `${prefix}${resolvedLetter}${closing}`;
                tokens.push(`\n${tag}`, resolvedLetter, closing);
                positionLogprobs.push([{ token: `\n${tag}`, logprob: 0 }], alts.length > 0 ? alts : [{ token: resolvedLetter, logprob: 0 }], [{ token: closing, logprob: 0 }]);
            }
            catch (error) {
                // A server without prefill support (or a thinking-mode endpoint that
                // rejects the synthetic assistant turn, e.g. DeepSeek's
                // "reasoning_content must be passed back") returns the tag-less
                // analysis — scores fall back to point estimates below. Warn once so
                // the degradation is discoverable, not silent.
                if (!this.prefillFailureNoticed) {
                    this.prefillFailureNoticed = true;
                    console.error(`[verifier] prefill rejected by the endpoint (${error instanceof Error ? error.message : String(error)}); ` +
                        'scores fall back to point estimates');
                }
                return {
                    text: analysis,
                    ...(tokens.length > 0 ? { tokens } : {}),
                    ...(positionLogprobs.length > 0 ? { positionLogprobs } : {}),
                };
            }
        }
        return { text: fullText, tokens, positionLogprobs };
    }
    /**
     * Run one verifier call and return its text plus token-level logprobs.
     * On non-DeepSeek servers, score tags present in the prompt trigger the
     * prefill pass so the letter distribution is read at the exact tag
     * position.
     */
    async chat(prompt, opts = {}) {
        if (!this.config.baseUrl) {
            throw new MissingAPIKeyError('set baseUrl (or OPENAI_BASE_URL) to an OpenAI-compatible endpoint with logprobs ' +
                '(e.g. http://localhost:8000/v1 for vLLM, or https://api.deepseek.com for DeepSeek)');
        }
        const model = await this.resolveModel(opts.model);
        const messages = [{ role: 'user', content: prompt }];
        const { extraBody, maxTokens } = this.config.deepseek ? this.deepseekParams() : { extraBody: undefined, maxTokens: OPENAI_MAX_TOKENS };
        const params = {
            model,
            messages,
            max_tokens: maxTokens,
            temperature: 1,
            logprobs: true,
            top_logprobs: 20,
        };
        let response;
        if (this.config.deepseek) {
            response = await this.post(`${this.config.baseUrl}/chat/completions`, { ...params, extra_body: extraBody }, opts.signal);
        }
        else {
            // vLLM/SGLang: skip hybrid-thinking so score tags come fast. Servers
            // without that option reject the request; retry without it.
            try {
                response = await this.post(`${this.config.baseUrl}/chat/completions`, { ...params, extra_body: { chat_template_kwargs: { enable_thinking: false } } }, opts.signal);
            }
            catch (error) {
                response = await this.post(`${this.config.baseUrl}/chat/completions`, params, opts.signal);
            }
        }
        let { text, tokens, positionLogprobs } = this.parse(response);
        // autoDegrade: a main request without token-level logprobs means grading
        // can only be sampling-style; `false` is strict mode and refuses to
        // silently downgrade the method's granularity.
        if (this.lastGradingMode !== 'logprob') {
            if (!this.config.autoDegrade) {
                throw new VerifierError('verifier backend returned no logprobs and autoDegrade is disabled — ' +
                    'configure a logprobs-capable endpoint or enable autoDegrade');
            }
            this.lastGradingMode = 'sampling';
        }
        const tags = ['<score_A>', '<score_B>'].filter((tag) => prompt.includes(tag));
        // Only prefill when the MAIN response cannot already carry a usable score
        // (no score tag in the text / no per-position logprobs). A main reply
        // that contains the tags plus logprobs is scored directly — prefill is
        // only for open models that omit the tags. This also avoids the extra
        // multi-turn assistant call that DeepSeek-style thinking endpoints reject
        // with "reasoning_content in the thinking mode must be passed back".
        const mainScoreUsable = tags.length > 0 &&
            tokens !== undefined &&
            positionLogprobs !== undefined &&
            tokens.join('').includes('<score_A>') &&
            positionLogprobs.length > 0;
        if (tags.length > 0 && !this.config.deepseek && this.config.prefill && !mainScoreUsable) {
            const idx = Math.min(...tags.map((tag) => text.indexOf(tag)).filter((i) => i >= 0), text.length);
            const analysis = text.slice(0, idx).trimEnd();
            const prefilled = await this.prefillTags(model, messages, analysis, tags);
            text = prefilled.text;
            tokens = prefilled.tokens;
            positionLogprobs = prefilled.positionLogprobs;
        }
        return {
            text,
            ...(tokens !== undefined ? { tokens } : {}),
            ...(positionLogprobs !== undefined ? { positionLogprobs } : {}),
        };
    }
    /**
     * Run the workers with at most `maxConcurrency` in flight. The first
     * failure rejects the returned promise; the rest run to completion.
     */
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
                const worker = workers[i];
                if (!worker)
                    return;
                results[i] = await worker();
            }
        };
        await Promise.all(Array.from({ length: Math.min(this.config.maxConcurrency, workers.length) }, () => runner()));
        return results;
    }
}
//# sourceMappingURL=backend.js.map