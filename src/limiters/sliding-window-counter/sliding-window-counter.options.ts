import type { PriorityWeights } from '../../contracts/priority-weights.js'
import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * Configuration of the single Sliding Window Counter horizon.
 */
export interface SlidingWindowCounterLimitOptions {
	/**
	 * Maximum estimated usage after a start.
	 *
	 * Must be a positive safe integer.
	 */
	readonly limit: number

	/**
	 * Duration of each grid window in milliseconds.
	 *
	 * Must be positive and finite.
	 */
	readonly windowMs: number

	/**
	 * Grid origin in milliseconds relative to the Unix epoch.
	 *
	 * Must be a safe integer.
	 *
	 * @default 0
	 */
	readonly offsetMs?: number
}

/**
 * Configuration for a local Sliding Window Counter limiter.
 */
export interface SlidingWindowCounterOptions extends RateLimiterOptions {
	/**
	 * The horizon applied independently to each key.
	 */
	limitOptions: SlidingWindowCounterLimitOptions

	/**
	 * Weights for global scheduling across keys.
	 *
	 * Defaults to `1`, `2`, `4`, `8`, and `16` from lowest to highest priority.
	 */
	weights?: PriorityWeights
}
