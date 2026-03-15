import { type Priority } from '@stimulcross/ds-policy-priority-queue';
import { type LimitBehavior } from '../types/limit-behavior.js';

/**
 * Options for running a single task.
 */
export interface RateLimiterRunOptions {
	/**
	 * A unique identifier for the task for logging and debugging.
	 *
	 * If not provided, the library will generate a unique ID.
	 */
	id?: string;

	/**
	 * A storage key for the task.
	 */
	key?: string;

	/**
	 * The cost to consume the limit.
	 *
	 * @default 1
	 */
	cost?: number;

	/**
	 * Defines the behavior when the limit is reached for the current task. Overrides the global limit behavior
	 * set in {@link RateLimiterOptions.limitBehavior}.
	 *
	 * - `reject` - rejects the task with `LIMIT_EXCEEDED` error code
	 * - `enqueue` - enqueues the task if possible
	 *
	 * Defaults to global {@link RateLimiterOptions.limitBehavior}
	 */
	limitBehavior?: LimitBehavior;

	/**
	 * Task priority.
	 *
	 * @default Priority.Normal (3)
	 */
	priority?: Priority;

	/**
	 * An abort signal to abort the task execution.
	 */
	signal?: AbortSignal;

	/**
	 * Maximum wait time in milliseconds for the task in the queue.
	 *
	 * This does not affect execution time.
	 *
	 * @default Infinity
	 */
	maxWaitMs?: number;

	/**
	 * Forces the task to be enqueued even if the queue has reached maximum capacity.
	 *
	 * @default false
	 */
	shouldForceEnqueue?: boolean;
}
