import type { PriorityWeights } from '../../contracts/priority-weights.js'
import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * One per-key Token Bucket profile.
 */
export interface TokenBucketLimitOptions {
	/**
	 * Maximum token balance.
	 *
	 * Must be a positive safe integer.
	 */
	readonly capacity: number

	/**
	 * Tokens refilled per second.
	 *
	 * Must be positive and finite.
	 */
	readonly refillRate: number
}

/**
 * Configuration for a local Token Bucket limiter.
 */
export interface TokenBucketOptions extends RateLimiterOptions {
	/**
	 * A profile or a nonempty list of profiles.
	 *
	 * Each start spends one token from every profile for its key.
	 */
	limitOptions: TokenBucketLimitOptions | readonly TokenBucketLimitOptions[]

	/**
	 * Weights for global scheduling across keys.
	 *
	 * Defaults to `1`, `2`, `4`, `8`, and `16` from lowest to highest priority.
	 */
	weights?: PriorityWeights
}
