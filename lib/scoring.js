/**
 * Fine-grained reward scoring, ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * Instead of collapsing the verifier's judgement into one discrete label, we
 * read its probability distribution over an ordered set of score tokens and
 * take the expectation:
 *
 *     R(t, tau) = (1 / C K) sum_c sum_k sum_g p_theta(v_g | t, c, tau) * phi(v_g)
 *
 * with C criteria, K repeated verifications, and G score tokens (granularity);
 * phi maps each score token to its scalar value.
 *
 * @module dsh-llm-as-a-verifier/scoring
 */
/** Number of score tokens on the letter scale (A..T). */
export const GRANULARITY = 20;
/**
 * The granularity-20 rating scale: A = clearly succeeded (best) down to
 * T = clearly failed (worst). Uppercase and lowercase letters are both
 * accepted because some tokenizers emit the letter differently.
 */
export const SCALE = {
    scale_description: [
        'Rate how likely the agent correctly solved the task on a ',
        '20-point scale using letters A through T:\n',
        '  A = clearly and completely succeeded with verified output (best)\n',
        '  B-D = succeeded with only minor issues\n',
        '  E-G = above average, mostly correct with some issues\n',
        '  H-J = uncertain, leans toward success\n',
        '  K-M = uncertain, leans toward failure\n',
        '  N-P = below average, significant issues remain\n',
        '  Q-S = failed with some partial progress\n',
        '  T = clearly and completely failed (worst)',
    ].join(''),
    score_format: 'LETTER_A_TO_T',
    valid_tokens: Object.fromEntries([
        ...Array.from({ length: GRANULARITY }, (_, i) => [String.fromCharCode(65 + i), GRANULARITY - i]),
        ...Array.from({ length: GRANULARITY }, (_, i) => [String.fromCharCode(97 + i), GRANULARITY - i]),
    ]),
};
function slugify(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
function toCriterion(raw) {
    if (typeof raw === 'string') {
        return { id: slugify(raw), name: raw, description: raw };
    }
    const name = (raw.name ?? raw.id ?? '').trim();
    const description = (raw.description ?? name).trim();
    if (name.length === 0)
        throw new Error('criteria entries must declare a name or id');
    return { id: raw.id ?? slugify(name), name, description };
}
/**
 * Normalize any accepted criteria form into criterion dicts with unique ids.
 *
 * @param input - a `{name: description}` mapping, or a list of strings or
 *   `{id, name, description}` objects.
 */
export function normalizeCriteria(input) {
    const criteria = Array.isArray(input)
        ? input.map(toCriterion)
        : Object.entries(input).map(([name, description]) => ({
            id: slugify(name),
            name,
            description,
        }));
    if (criteria.length === 0)
        throw new Error('criteria must contain at least one criterion');
    return criteria;
}
/**
 * Locate the top-logprob alternatives at the position right after `tag`.
 * Some tokenizers fuse the closing `>` with the score letter (`>A`), so the
 * exact tag is tried first, then the tag without its trailing `>`. The LAST
 * match wins: the verdict is the score block at the end of the reply, not
 * the model quoting the format mid-analysis.
 */
function findTagLogprobs(tokens, positionLogprobs, tag) {
    if (!tokens || !positionLogprobs || tokens.length === 0 || positionLogprobs.length === 0)
        return undefined;
    for (const suffix of [tag, tag.slice(0, -1)]) {
        let found;
        let textSoFar = '';
        for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            textSoFar += tok;
            // An empty or whitespace-only token leaves the stripped text
            // unchanged, so the tag would match a SECOND time and shadow the
            // distribution captured at the previous position.
            if (!tok.trim())
                continue;
            if (textSoFar.trimEnd().endsWith(suffix) && i + 1 < positionLogprobs.length) {
                found = positionLogprobs[i + 1];
            }
        }
        if (found)
            return found;
    }
    return undefined;
}
/** Normalize an expected score to [0, 1] on the granularity scale. */
function normalizeValue(value) {
    const min = 1;
    const max = GRANULARITY;
    return (value - min) / (max - min);
}
function valueFromToken(token) {
    let tok = token.trim();
    if (tok.startsWith('>'))
        tok = tok.slice(1).trim(); // fused '>A' tokens
    return SCALE.valid_tokens[tok];
}
/**
 * Expected score over the verifier's token distribution at `tag`, normalized
 * to [0, 1]. Falls back to parsing the literal text token; unreadable scores
 * default to 0.5.
 */
export function extractScore(text, tokens, positionLogprobs, tag) {
    const tagLp = findTagLogprobs(tokens, positionLogprobs, tag);
    const probs = new Map();
    if (tagLp) {
        for (const { token, logprob } of tagLp) {
            const value = valueFromToken(token);
            if (value !== undefined) {
                const p = Math.exp(logprob);
                probs.set(value, Math.max(probs.get(value) ?? 0, p));
            }
        }
    }
    if (probs.size > 0) {
        const totalP = [...probs.values()].reduce((sum, p) => sum + p, 0);
        const expected = [...probs.entries()].reduce((sum, [v, p]) => sum + v * p, 0) / totalP;
        return normalizeValue(expected);
    }
    // Fallback: literal tag in the text, last match again.
    const tagName = tag.slice(1, -1);
    const pattern = new RegExp(`<${tagName}>\\s*(.+?)\\s*</${tagName}>`, 'gi');
    const matches = [...(text ?? '').matchAll(pattern)];
    const match = matches.at(-1);
    if (match?.[1]) {
        let value = valueFromToken(match[1]);
        if (value === undefined) {
            for (const [token, v] of Object.entries(SCALE.valid_tokens)) {
                if (token.toLowerCase() === match[1].trim().toLowerCase()) {
                    value = v;
                    break;
                }
            }
        }
        if (value !== undefined)
            return normalizeValue(value);
    }
    return 0.5;
}
/**
 * One pairwise prompt focused on a single evaluation criterion. Everything
 * not specific to the criterion (task, both trajectories, rating scale)
 * comes first; only the criterion varies at the tail. This maximizes the
 * shared prompt prefix across criteria, so a prefix-caching backend serves
 * the trace-heavy body from cache.
 */
export function buildPairwisePrompt(problem, traceA, traceB, criterion, groundTruthNote) {
    return ('You are an expert evaluator of AI coding agents. ' +
        'You will see a task description and two agent trajectories, then ' +
        'evaluate them on ONE specific criterion, stated at the end.\n\n' +
        `${groundTruthNote}\n\n` +
        `**Task:**\n${problem}\n\n` +
        `**Trajectory A:**\n${traceA}\n\n` +
        `**Trajectory B:**\n${traceB}\n\n` +
        `**Rating Scale:**\n${SCALE.scale_description}\n\n` +
        `**Evaluation Guideline — ${criterion.name}:**\n` +
        `${criterion.description}\n\n` +
        `Score each trajectory ONLY on this specific criterion ` +
        `("${criterion.name}"). Ignore other aspects of the trajectory ` +
        'that are not relevant to it.\n\n' +
        'Reason it through first, then END your reply with exactly these two ' +
        'lines and nothing after them. Replace each placeholder with a single ' +
        'letter A-T, keeping the spaces around the letter exactly as shown:\n' +
        `<score_A> ${SCALE.score_format} </score_A>\n` +
        `<score_B> ${SCALE.score_format} </score_B>\n\n` +
        'Begin your analysis now.');
}
//# sourceMappingURL=scoring.js.map