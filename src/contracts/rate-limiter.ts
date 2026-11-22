import type { RateLimiterRunOptions } from './rate-limiter-run-options.js'

/**
 * Rate limiter for callbacks that share a result type.
 *
 * @typeParam TTaskResult - Result produced by the callbacks.
 * @typeParam TStatus - Algorithm-specific quota status. Defaults to `object`.
 */
export interface FixedResultRateLimiter<TTaskResult = unknown, TStatus extends object = object> {
	/**
	 * Starts an admitted callback once and returns a promise for its result.
	 *
	 * The callback may start synchronously. Its return value, including a
	 * promise-like result, settles the returned promise. A thrown error or
	 * rejection propagates to the caller. Each start spends quota.
	 */
	run: (task: () => TTaskResult | PromiseLike<TTaskResult>, options?: RateLimiterRunOptions) => Promise<TTaskResult>

	/**
	 * Cancels this instance's pending tasks and resets quota for the key,
	 * or all its keys when omitted.
	 *
	 * Running callbacks continue and keep their concurrency places until settlement.
	 * Other instances are unaffected.
	 */
	clear: (key?: string) => Promise<void>

	/**
	 * Observes algorithm-specific status without spending or reserving quota.
	 */
	getStatus?: (key?: string) => Promise<TStatus>

	/**
	 * Closes admission, cancels local pending tasks, waits for running callbacks,
	 * and releases this instance's state, timers and listeners.
	 *
	 * Completion is not guaranteed if a running callback never settles.
	 */
	destroy?: () => Promise<void>
}

/**
 * Rate limiter that infers the result type of each callback passed to `run()`.
 */
export interface RateLimiter<TStatus extends object = object> extends FixedResultRateLimiter<unknown, TStatus> {
	/**
	 * Starts an admitted callback and returns a promise of its inferred result type.
	 *
	 * Uses the same admission and settlement rules as {@link FixedResultRateLimiter.run}.
	 */
	run: <T>(task: () => T | PromiseLike<T>, options?: RateLimiterRunOptions) => Promise<T>
}
