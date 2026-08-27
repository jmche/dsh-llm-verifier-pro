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
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { VerifierBackend } from './backend.js';
import { extractScore } from './scoring.js';
export { extractScore };
/** Bo-N sampling knobs (the orchestration's slice of the plugin Config). */
export interface BoNConfig {
    /** How many candidates to sample per assistant turn (the paper's Bo5). */
    readonly nCandidates: number;
    /** Sampling temperature for the diversity rollouts. */
    readonly samplingTemperature: number;
    /**
     * Model mix for the non-anchor candidates. The FIRST candidate (index 0)
     * always rides the conversation's own model — the greedy anchor. Each
     * remaining slot is drawn, in order, from this list; entries beyond the
     * slot count are ignored, and slots beyond the list fall back to the
     * anchor model at the sampling temperature.
     *
     * Each entry is either:
     *   - a FULL model id string (e.g. `ollama-local/qwen3.8:27b`) — sampled
     *     with the conversation's own provider; or
     *   - `{ provider, model }` — sampled with an EXPLICIT provider route
     *     (e.g. `{ provider: 'omni-message', model: 'opencode-go/minimax-m3' }`),
     *     overriding the conversation's provider for that candidate only.
     */
    readonly mixModels?: readonly (string | {
        provider?: string;
        model: string;
    })[];
    /**
     * Wall-clock budget for the sampling phase (rollouts + verdict). Past it the
     * turn degrades to a normal answer. NOTE: the verify phase carries its own
     * INDEPENDENT budget (verifyTimeoutMs) — long answers must not starve the
     * ranking.
     */
    readonly timeoutMs: number;
    /** Independent wall-clock budget for the verify (ranking) phase, never borrowed by sampling. */
    readonly verifyTimeoutMs: number;
    /** Append a muted Best-of-N footer text block under the winning answer. */
    readonly showFooter: boolean;
    /** Extra grading criteria appended to the comparison prompt (free text). */
    readonly criteria?: readonly string[];
    /** Number of PPT pivots k (default 2). */
    readonly pivots?: number;
    /** Seed for the tournament's random ring pass (default 0: fixed, reproducible). */
    readonly seed?: number;
}
/** One sampled rollout: its raw chunks (replay material) and assembled text (verifier candidate). */
export interface Rollout {
    readonly chunks: readonly StreamChunk[];
    readonly text: string;
    readonly usable: boolean;
}
/** A structured, lossless-JSON summary of one Best-of-N turn. */
export interface BoNTurnSummary {
    /** The session's turn number this Bo-N turn served. */
    readonly turn: number;
    /** The task the candidates were ranked for (the last user message). */
    readonly task: string;
    /** Best-first verifier ranking: index into `candidates`, mean expected grade (0–20) and normalized (0–1). */
    readonly ranking: readonly {
        index: number;
        score: number;
        normalized: number;
    }[];
    /** Index into `candidates` of the winner. */
    readonly winnerIndex: number;
    /** The winner's mean expected grade. */
    readonly winnerScore: number;
    /** The runner-up's mean expected grade (the gap is the selection margin). */
    readonly runnerUpScore: number;
    /** A one-line human-readable reason. */
    readonly reason: string;
}
/** Whether one request was dispatched by the sampling fan-out. */
export declare function isInternalRequest(options: object): boolean;
/** Mark one request as dispatched by the sampling fan-out. */
export declare function markInternalRequest(options: object): void;
/** The verify task description: the last user message of the conversation. */
export declare function taskOf(options: GenerateOptions): string;
/** Collect one rollout from a chunk stream: raw chunks + assembled text. */
export declare function collectRollout(stream: AsyncIterable<StreamChunk>): Promise<Rollout | undefined>;
/**
 * Replay `chunks` (the winner's raw chunks) and, when `footer` is set, append a
 * small independent text block just before the terminal `finish` chunk.
 */
export declare function replayWithFooter(chunks: readonly StreamChunk[], footer?: string): AsyncGenerator<StreamChunk>;
/** The verifier's full ranking of the candidates: best-first, with per-candidate expected scores. */
export interface VerifyResult {
    /** Index of the winning candidate (best first). */
    readonly bestIndex: number;
    /** Best-first ranking with each candidate's mean expected score (0–20) and normalized (0–1). */
    readonly ranking: readonly {
        index: number;
        score: number;
        normalized: number;
    }[];
}
/**
 * Rank candidates with a PPT over TM-style fine-grained scores served by the
 * shared {@link VerifierBackend}. One "comparison" runs the criterion prompt
 * through {@link VerifierBackend.chat} and extracts both score tags with
 * {@link extractScore}, then aggregates soft wins (Bradley-Terry) exactly like
 * the verify_select tool — so Best-of-N selection and the tool face use the
 * identical method.
 */
export declare function verifyBest(backend: VerifierBackend, model: string, task: string, candidates: readonly string[], opts?: {
    criteria?: readonly string[];
    pivots?: number;
    seed?: number;
    nEvaluations?: number;
    signal?: AbortSignal;
}): Promise<VerifyResult & {
    callsSpent: number;
}>;
/** Dependencies of the orchestration (injected for tests). */
export interface OrchestrateDeps {
    /** Re-enter the llm seam for the diversity rollouts (the full waterfall, reentry-guarded). */
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    /** The shared verifier backend (also used by the verify_* tools). */
    backend: VerifierBackend;
    /** The resolved verifier model; overrides the plugin's model resolution when set. */
    verifierModel?: string;
    /** Called once a winner is selected, with the structured Best-of-N summary. */
    onTurnSummary?: (summary: BoNTurnSummary) => void;
}
/**
 * The Bo-N turn orchestration: sample N ways, verify, replay the winner.
 * The first rollout rides `next` (the normal waterfall, greedy anchor); the
 * rest re-enter the llm seam at the sampling temperature. Every failure path
 * is fail-open — degrade to the first usable rollout, never a dead turn.
 */
export declare function orchestrate(deps: OrchestrateDeps, config: BoNConfig, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncGenerator<StreamChunk>;
//# sourceMappingURL=bon.d.ts.map