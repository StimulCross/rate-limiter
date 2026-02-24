import { type RateLimiterRunOptions } from '../interfaces/rate-limiter-run-options.js';

/**
 * Rate limiter interface.
 *
 * @template TStatus The type of the rate limiter status returned by {@link getStatus} method.
 */
export interface RateLimiter<TStatus extends object = object> {
	/**
	 * Runs the given task.
	 *
	 * @param task The task to run.
	 * @param options Options for running the task.
	 */
	run<T>(task: () => T | Promise<T>, options?: RateLimiterRunOptions): Promise<T>;

	/**
	 * Clears the rate limiter state.
	 *
	 * @param key The optional key to clear the state for.
	 */
	clear(key?: string): Promise<void>;

	/**
	 * Gets the rate limiter's status.
	 *
	 * @param key The optional key to get the status for.
	 */
	getStatus?(key?: string): Promise<TStatus>;

	/**
	 * Destroys the rate limiter.
	 *
	 * The limiter cannot be used after it has been destroyed. It should be used only for graceful shutdown.
	 */
	destroy?(): Promise<void>;
}
