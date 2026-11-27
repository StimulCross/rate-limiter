import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * One per-key Sliding Window Log profile.
 */
export interface SlidingWindowLogLimitOptions {
	/**
	 * Maximum callback starts within the sliding window.
	 *
	 * Must be a positive safe integer.
	 */
	readonly limit: number

	/**
	 * Time in milliseconds for which a start counts against quota.
	 *
	 * Must be positive and finite.
	 */
	readonly windowMs: number
}

/**
 * Configuration for a local Sliding Window Log limiter.
 */
export interface SlidingWindowLogOptions extends RateLimiterOptions {
	/**
	 * A profile or a nonempty list of profiles.
	 *
	 * Each start must pass every profile for its key.
	 */
	limitOptions: SlidingWindowLogLimitOptions | readonly SlidingWindowLogLimitOptions[]
}
