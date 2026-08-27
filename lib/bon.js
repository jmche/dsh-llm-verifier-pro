/**
 * The Best-of-N conversation mode — unified from @aispin/plugin-verifier
 * (Aispin, MIT) and re-armed on the dsh-llm-as-a-verifier backend
 * (TaurenMountain, MIT).
 *
 * Every assistant turn of a Best-of-N session is sampled N ways and only the
 * winning response is replayed. Fine-grained scores come from the same
 * logprob-expectation method as the verify_* tools — the graded comparison is
 * served by {@link VerifierBackend}, so the prefill path, concurrency budget,
 * per-request timeout, cancellation signal and token accounting all apply.
 *
 * Pure orchestration over injected dependencies; `llm/stream` interception
 * and the three-state gating (settings global → session preset → off) live in
 * index.ts.
 *
 * @module dsh-llm-verifier-pro/bon
 */
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { extractScore } from './scoring.js';
import { bradleyTerry, ringCycle, pivotRoundPairs, selectPivots, createRng, accumulate } from './tournament.js';
export { extractScore };
/** Requests dispatched by this plugin's own sampling fan-out (reentry guard). */
const internalRequests = new WeakSet();
/** Whether one request was dispatched by the sampling fan-out. */
export function isInternalRequest(options) {
    return internalRequests.has(options);
}
/** Mark one request as dispatched by the sampling fan-out. */
export function markInternalRequest(options) {
    internalRequests.add(options);
}
/** Extract the best-effort text of a message (string content or text blocks). */
function messageText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content
            .map(block => typeof block === 'object' && block !== null && 'text' in block && typeof block.text === 'string' ? block.text : '')
            .join('');
    }
    return '';
}
/** The verify task description: the last user message of the conversation. */
export function taskOf(options) {
    for (let i = options.messages.length - 1; i >= 0; i -= 1) {
        const message = options.messages[i];
        if (message !== undefined && message.role === 'user') {
            const text = messageText(message.content).trim();
            if (text.length > 0)
                return text;
        }
    }
    return 'Answer the user\'s request well.';
}
/** Collect one rollout from a chunk stream: raw chunks + assembled text. */
export async function collectRollout(stream) {
    const chunks = [];
    const assembler = new BlockAssembler();
    try {
        for await (const chunk of stream) {
            chunks.push(chunk);
            assembler.push(chunk);
        }
    }
    catch {
        return undefined; // a failed rollout is dropped, never fatal
    }
    const blocks = assembler.blocks();
    const text = blocks
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim();
    const hasToolCall = blocks.some(block => block.type === 'tool-call');
    const finishedWell = assembler.finish.kind === 'stop';
    return { chunks, text, usable: text.length > 0 && !hasToolCall && finishedWell };
}
/**
 * Replay `chunks` (the winner's raw chunks) and, when `footer` is set, append a
 * small independent text block just before the terminal `finish` chunk.
 */
export async function* replayWithFooter(chunks, footer) {
    for (const chunk of chunks) {
        if (footer && chunk.type === 'finish' && chunk.reason?.kind === 'stop') {
            yield { type: 'block-start', index: 1, blockType: 'text' };
            yield { type: 'text-delta', index: 1, text: footer };
            yield { type: 'block-end', index: 1, block: { type: 'text', text: footer } };
        }
        yield chunk;
    }
}
/**
 * Rank candidates with a PPT over TM-style fine-grained scores served by the
 * shared {@link VerifierBackend}. One "comparison" runs the criterion prompt
 * through {@link VerifierBackend.chat} and extracts both score tags with
 * {@link extractScore}, then aggregates soft wins (Bradley-Terry) exactly like
 * the verify_select tool — so Best-of-N selection and the tool face use the
 * identical method.
 */
export async function verifyBest(backend, model, task, candidates, opts = {}) {
    const criteria = opts.criteria?.length ? opts.criteria : ['correctness'];
    const pivots = Math.max(1, opts.pivots ?? 2);
    const seed = opts.seed ?? 0;
    const nEvaluations = Math.max(1, opts.nEvaluations ?? 1);
    const n = candidates.length;
    if (n < 2)
        throw new Error('bo-n: at least 2 candidates are required');
    const cache = new Map();
    const cacheKey = (criterion, a, b, rep) => `${criterion}|${a},${b}|${rep}`;
    // One directed comparison of (a, b) under one criterion: swaps the prompt
    // slots on odd reps and records scores back in candidate order. Uses the
    // same pairwise scoring as the tool face.
    const scorePairCriterion = async (a, b, criterion, swap) => {
        const traceA = swap ? candidates[b] : candidates[a];
        const traceB = swap ? candidates[a] : candidates[b];
        const prompt = 'You are an expert evaluator of AI coding agents. You will see a task description and two agent trajectories, then evaluate them on ONE specific criterion, stated at the end.\n\n'
            + `**Task:**\n${task}\n\n`
            + `**Trajectory A:**\n${traceA}\n\n`
            + `**Trajectory B:**\n${traceB}\n\n`
            + '**Rating Scale:**\nRate how likely the agent correctly solved the task on a 20-point scale using letters A through T:\n'
            + '  A = clearly and completely succeeded with verified output (best)\n'
            + '  B-D = succeeded with only minor issues\n'
            + '  E-G = above average, mostly correct with some issues\n'
            + '  H-J = uncertain, leans toward success\n'
            + '  K-M = uncertain, leans toward failure\n'
            + '  N-P = below average, significant issues remain\n'
            + '  Q-S = failed with some partial progress\n'
            + '  T = clearly and completely failed (worst)\n\n'
            + `**Evaluation Guideline — ${criterion}:**\n`
            + `${criterion}\n\n`
            + 'Score each trajectory ONLY on this specific criterion. Ignore other aspects of the trajectory that are not relevant to it.\n\n'
            + 'Reason it through first, then END your reply with exactly these two lines and nothing after them. Replace each placeholder with a single letter A-T, keeping the spaces around the letter exactly as shown:\n'
            + '<score_A> LETTER_A_TO_T </score_A>\n'
            + '<score_B> LETTER_A_TO_T </score_B>\n\n'
            + 'Begin your analysis now.';
        const out = await backend.chat(prompt, { model });
        const ra = extractScore(out.text, out.tokens, out.positionLogprobs, '<score_A>');
        const rb = extractScore(out.text, out.tokens, out.positionLogprobs, '<score_B>');
        return swap ? [rb, ra] : [ra, rb];
    };
    // Directed score fn with a per-(criterion, pair, rep) cache and mid-flight
    // scoring through the backend's concurrency pool.
    const count = n * criteria.length * nEvaluations;
    const scorePairs = async (pairs) => {
        const jobs = [];
        for (const [a, b] of pairs) {
            for (const criterion of criteria) {
                for (let rep = 0; rep < nEvaluations; rep++) {
                    const key = cacheKey(criterion, a, b, rep);
                    if (cache.has(key))
                        continue;
                    jobs.push({ key, a, b, criterion, swap: rep % 2 === 1 });
                }
            }
        }
        const results = await backend.runAll(jobs.map(job => () => scorePairCriterion(job.a, job.b, job.criterion, job.swap)));
        jobs.forEach((job, i) => {
            const [ra, rb] = results[i] ?? [0.5, 0.5];
            cache.set(job.key, { score_A: ra, score_B: rb });
        });
    };
    const directedScore = (a, b) => {
        let sa = 0;
        let sb = 0;
        let observed = 0;
        for (const criterion of criteria) {
            for (let rep = 0; rep < nEvaluations; rep++) {
                const entry = cache.get(cacheKey(criterion, a, b, rep));
                sa += entry?.score_A ?? 0.5;
                sb += entry?.score_B ?? 0.5;
                observed++;
            }
        }
        return observed > 0 ? [sa / observed, sb / observed] : [0.5, 0.5];
    };
    const exhaustive = n <= 3; // tiny N: exact beats the ring's variance
    let pairs;
    if (exhaustive) {
        pairs = [];
        for (let a = 0; a < n; a++)
            for (let b = a + 1; b < n; b++)
                pairs.push([a, b]);
        await scorePairs(pairs);
    }
    else {
        // Phase 1 — the ring pass.
        const ring = ringCycle(n, createRng(seed));
        await scorePairs(ring);
        const w = new Array(n).fill(0);
        const c = new Array(n).fill(0);
        accumulate(ring, directedScore, w, c);
        const pivotSet = selectPivots(w, c, pivots);
        // Phase 2 — pivot rounds.
        const prPairs = pivotRoundPairs(n, pivotSet);
        await scorePairs(prPairs);
        pairs = [...ring, ...prPairs];
    }
    if (!exhaustive) {
        // Re-aggregate ring + pivot with the cache warmed (scorePairs above did the
        // cache for both phases; this second accumulate is over the full pair list).
    }
    const wFinal = new Array(n).fill(0);
    const cFinal = new Array(n).fill(0);
    for (const [a, b] of exhaustive ? pairs : pairs) {
        const [ra, rb] = directedScore(a, b);
        const p = bradleyTerry(ra, rb);
        wFinal[a] += p;
        cFinal[a] += 1;
        wFinal[b] += 1 - p;
        cFinal[b] += 1;
    }
    let best = 0;
    let bestPref = -Infinity;
    const scores = new Array(n);
    for (let i = 0; i < n; i++) {
        const pref = cFinal[i] > 0 ? wFinal[i] / cFinal[i] : 0;
        scores[i] = pref;
        if (pref > bestPref) {
            bestPref = pref;
            best = i;
        }
    }
    const ranking = Array.from({ length: n }, (_, i) => i).sort((a, b) => scores[b] - scores[a] || a - b);
    return {
        bestIndex: best,
        ranking: ranking.map(index => ({ index, score: scores[index] * 20, normalized: scores[index] })),
        callsSpent: count,
    };
}
/**
 * The Bo-N turn orchestration: sample N ways, verify, replay the winner.
 * The first rollout rides `next` (the normal waterfall, greedy anchor); the
 * rest re-enter the llm seam at the sampling temperature. Every failure path
 * is fail-open — degrade to the first usable rollout, never a dead turn.
 */
export async function* orchestrate(deps, config, options, next) {
    // The diversity rollouts: same request, raised temperature, reentry-guarded.
    // Candidate 0 is the greedy anchor (next() — the conversation's own model);
    // each later slot draws from config.mixModels when configured, else falls
    // back to the anchor model at the sampling temperature.
    const extra = Math.max(0, config.nCandidates - 1);
    const mixed = config.mixModels ?? [];
    const sampled = Array.from({ length: extra }, (_slot, i) => {
        const entry = mixed[i];
        const request = {
            ...options,
            temperature: config.samplingTemperature,
            ...(typeof entry === 'string' || typeof entry === 'undefined'
                ? (entry !== undefined && entry.length > 0 ? { model: entry } : {})
                : (entry.model.length > 0
                    ? { model: entry.model, ...(entry.provider && entry.provider.length > 0 ? { provider: entry.provider } : {}) }
                    : {})),
        };
        markInternalRequest(request);
        return request;
    });
    // Rollout 0 rides next() lazily — sampled only when the turn actually runs,
    // so a rejected pre-flight leaves the normal path untouched.
    let fallbackStream;
    const lazyNext = () => {
        fallbackStream ??= next();
        return fallbackStream;
    };
    const startedAt = Date.now();
    /** Sum the usage chunks carried by one rollout's stream (the honest sampling cost). */
    const rolloutTokens = (rollouts) => rollouts.reduce((sum, rollout) => {
        return sum + (rollout?.chunks ?? []).reduce((inner, chunk) => {
            if (chunk.type !== 'usage')
                return inner;
            const usage = chunk.usage;
            return inner + (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
        }, 0);
    }, 0);
    const formatTokens = (tokens) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K tok` : `${String(tokens)} tok`;
    const formatElapsed = (ms) => ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${String(Math.round(ms))}ms`;
    let collected = [];
    try {
        // Per-rollout wall-clock cap: a rollout that overruns the sampling budget
        // is abandoned, not waited for — the survivors continue the turn as a
        // smaller Bo-K (degrade chain: Bo5 with 2 overruns → Bo3; below 2
        // survivors the turn fails open).
        const collectCapped = (stream) => Promise.race([
            collectRollout(stream),
            new Promise(resolve => {
                setTimeout(() => resolve(undefined), config.timeoutMs).unref?.();
            }),
        ]);
        // One broken candidate must never sink the whole turn: a synchronous
        // throw while constructing the stream (e.g. an llm route resolution
        // failure) is absorbed here and the slot counts as failed, not fatal.
        const start = (label, make) => {
            try {
                return collectCapped(make());
            }
            catch (error) {
                console.error(`[bo-n] ${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
                return Promise.resolve(undefined);
            }
        };
        // Sampling schedule: parallel (default) fires every rollout at once;
        // serial waits for each to settle first — safer for slow local models.
        if (config.samplingMode === 'serial') {
            const serial = [];
            serial.push(await start('anchor rollout', lazyNext));
            for (const request of sampled) {
                if (!request)
                    continue;
                serial.push(await start('slot rollout', () => deps.stream(request)));
            }
            collected = serial;
        }
        else {
            const inflight = [];
            inflight.push(start('anchor rollout', lazyNext));
            for (const request of sampled) {
                if (!request)
                    continue;
                inflight.push(start('slot rollout', () => deps.stream(request)));
            }
            collected = await Promise.all(inflight);
        }
        const usable = collected.filter((rollout) => rollout !== undefined && rollout.usable);
        const dropped = collected.length - usable.length;
        console.error(`[bo-n] turn: ${String(collected.length)} rollouts, ${String(usable.length)} usable`);
        // Not enough usable candidates to rank — degrade to the first finished one.
        if (usable.length < 2) {
            const firstFinished = collected.find((rollout) => rollout !== undefined);
            if (firstFinished === undefined)
                throw new Error('bo-n: every rollout failed');
            const footer = config.showFooter
                ? `⚡ Best-of-N skipped · ${String(collected.length)} sampled, only ${String(usable.length)} usable · returned as a plain answer · ${formatElapsed(Date.now() - startedAt)}`
                : undefined;
            yield* replayWithFooter(firstFinished.chunks, footer);
            return;
        }
        // Verify (INDEPENDENT wall-clock budget) and replay the winner's raw chunks.
        const verifyDeadline = Math.max(1, config.verifyTimeoutMs);
        const verifierModel = deps.verifierModel?.trim() || options.model;
        const verifyResult = await Promise.race([
            verifyBest(deps.backend, verifierModel, taskOf(options), usable.map(rollout => rollout.text), {
                criteria: config.criteria,
                pivots: config.pivots,
                seed: config.seed,
            }),
            new Promise((_, reject) => { setTimeout(() => reject(new Error('bo-n: verify deadline exceeded')), verifyDeadline).unref?.(); }),
        ]);
        const winner = usable[verifyResult.bestIndex] ?? usable[0];
        if (winner !== undefined) {
            // Emit a per-candidate diagnostic (the paper's audit trail) and the winner.
            const ranking = verifyResult.ranking;
            const byIndex = new Map(ranking.map(entry => [entry.index, entry]));
            const rankedCandidates = [...ranking]
                .map(entry => ({ index: entry.index, score: entry.score, normalized: entry.normalized, snippet: (usable[entry.index]?.text ?? '').slice(0, 80) }));
            console.error(`[bo-n] winner: rollout ${String(verifyResult.bestIndex)} of ${String(usable.length)} usable`);
            for (const entry of rankedCandidates) {
                console.error(`[bo-n]   #${String(entry.index)} score=${entry.score.toFixed(2)}/20 (${(entry.normalized * 100).toFixed(0)}%) — ${entry.snippet}${entry.index === verifyResult.bestIndex ? '  ◀ winner' : ''}`);
            }
            const winnerScore = byIndex.get(verifyResult.bestIndex)?.score ?? 0;
            const runnerUp = ranking.find(entry => entry.index !== verifyResult.bestIndex);
            const runnerUpScore = runnerUp?.score ?? winnerScore;
            const reason = `highest mean expected grade (${winnerScore.toFixed(2)}/20), ${(winnerScore - runnerUpScore).toFixed(2)} pts ahead of the runner-up`;
            console.error(`[bo-n]   why: ${reason}`);
            deps.onTurnSummary?.({
                turn: -1, // the apply-side recorder fills in the session's current turn
                task: taskOf(options),
                ranking,
                winnerIndex: verifyResult.bestIndex,
                winnerScore,
                runnerUpScore,
                reason,
            });
            // Replay the winner verbatim, optionally with a muted Best-of-N footer.
            const gap = winnerScore - runnerUpScore;
            const verifierTokens = deps.backend.usage.snapshot().inputTokens + deps.backend.usage.snapshot().outputTokens;
            const totalTokens = rolloutTokens(collected) + verifierTokens;
            const degradeTag = dropped > 0 ? ` · ${String(collected.length)} sampled, ${String(dropped)} incomplete` : '';
            const scoringNote = deps.backend.lastGradingMode === 'sampling' ? ' · sampling scoring' : '';
            const footer = config.showFooter
                ? `⚡ Best-of-N${degradeTag}${scoringNote} · ${String(usable.length)}-choose-1 → candidate #${String(verifyResult.bestIndex)} · ${winnerScore.toFixed(1)}/20 · ${gap.toFixed(2)} pts above runner-up · ${formatElapsed(Date.now() - startedAt)} · ${formatTokens(totalTokens)}`
                : undefined;
            yield* replayWithFooter(winner.chunks, footer);
            return;
        }
        throw new Error('bo-n: winner resolution failed');
    }
    catch (error) {
        // Fail-open: replay the first finished rollout collected so far — never
        // re-await lazyNext() (its stream may already be consumed).
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`[bo-n] verify degraded to first rollout: ${reason}`);
        const firstFinished = collected.find((rollout) => rollout !== undefined);
        if (firstFinished === undefined)
            throw new Error('bo-n: turn failed with no fallback rollout');
        const shortReason = reason.replace(/^verifier:\s*/, '').split('—')[0]?.trim().slice(0, 80) ?? reason.slice(0, 80);
        const footer = config.showFooter
            ? `⚡ Best-of-N skipped · ${shortReason} · returned as a plain answer · ${formatElapsed(Date.now() - startedAt)}`
            : undefined;
        yield* replayWithFooter(firstFinished.chunks, footer);
    }
}
//# sourceMappingURL=bon.js.map