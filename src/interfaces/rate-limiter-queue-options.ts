import { type SelectionPolicy } from '@stimulcross/ds-policy-priority-queue';

/**
 * Queue options for rate limiter.
 *
 * These options are applied to limiters that support delayed execution.
 */
export interface RateLimiterQueueOptions {
	/**
	 * Defines the maximum number of tasks that can be executed concurrently.
	 *
	 * @default Infinity
	 */
	concurrency?: number;

	/**
	 * Maximum time to wait in the queue (in milliseconds).
	 *
	 * If a task is not started within this time, it will be rejected with `EXPIRED` error code.
	 *
	 * @default Infinity
	 */
	maxWaitMs?: number;

	/**
	 * Maximum queue size.
	 *
	 * When overflowed, new tasks will be rejected immediately.
	 *
	 * @default Infinity
	 */
	capacity?: number;

	/**
	 * Selection policy for the priority queue.
	 *
	 * Defaults to Weighted round-robin (WRR) with the following weights:
	 * - `Priority.Lowest` - 1
	 * - `Priority.Low` - 2
	 * - `Priority.Normal` - 4
	 * - `Priority.High` - 8
	 * - `Priority.Highest` - 16
	 */
	selectionPolicy?: SelectionPolicy;
}
