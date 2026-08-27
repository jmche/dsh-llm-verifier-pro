/**
 * Progress tracking: fine-grained reward over trajectory prefixes.
 * Ported from llm-as-a-verifier
 * (https://github.com/llm-as-a-verifier/llm-as-a-verifier, MIT).
 *
 * The verifier is shown the task, the numbered agent steps, and a list of
 * checkpoints, and asked per checkpoint whether the agent's CURRENT state
 * would already satisfy the task. Each answer letter (A = 0% ... T = 100%)
 * is decoded as the expectation over the top-20 logprobs at the answer
 * position, giving a continuous progress curve.
 *
 * @module dsh-llm-as-a-verifier/progress
 */
import type { LogprobToken } from './scoring.js';
/** Letter scale — A = 0% progress, T = 100% progress (inverted relative to the pairwise reward scale). */
export declare const GRANULARITY = 20;
export declare const LETTER_TO_VALUE: Record<string, number>;
/** Number the agent steps the way the checkpoint prompt refers to them. */
export declare function formatSteps(steps: string[]): string;
/**
 * Neutral progress-scoring prompt. It never reveals whether the trajectory
 * eventually succeeded — successes and failures see the same template.
 */
export declare function buildProgressPrompt(problem: string, trajectoryText: string, nSteps: number, checkpointSteps: number[]): string;
/** Default checkpoint steps: the interior steps 2..T-1 (every step when T < 3). */
export declare function defaultCheckpoints(totalSteps: number): number[];
/** Validate 1-indexed checkpoint steps against a trajectory length. */
export declare function validateCheckpoints(checkpoints: number[], totalSteps: number): number[];
/**
 * Decode the n checkpoint scores from one verifier response: logprob
 * expectation at the answer position after each `<c{i}>` tag, with a
 * text-parsing fallback. Unreadable checkpoints are null.
 */
export declare function extractProgressScores(text: string, tokens: string[] | undefined, positionLogprobs: LogprobToken[][] | undefined, n: number): Array<number | null>;
/**
 * Average per-checkpoint scores across repeats; a checkpoint that is
 * unreadable in every repeat defaults to 0.5.
 */
export declare function meanScores(perRep: Array<Array<number | null>>): number[];
//# sourceMappingURL=progress.d.ts.map