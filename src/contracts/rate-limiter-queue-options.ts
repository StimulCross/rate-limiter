/**
 * Local waiting and execution limits, shared across keys of one limiter instance.
 */
export interface RateLimiterQueueOptions {
	/**
	 * Maximum simultaneously running callbacks, until their results settle.
	 *
	 * Shared across all keys of this instance. Waiting tasks occupy no execution place.
	 *
	 * @default Infinity
	 */
	concurrency?: number

	/**
	 * Default maximum time from run to callback start in milliseconds.
	 *
	 * Includes waiting for quota, concurrency and HTTP probe/cooldown.
	 *
	 * @default Infinity
	 */
	maxWaitMs?: number

	/**
	 * Maximum accepted tasks that have not started.
	 *
	 * Running callbacks are excluded. Each pending task counts once.
	 *
	 * Enqueue requires an explicitly configured finite capacity.
	 */
	capacity?: number
}
