import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * The pacing interval applied independently to each key.
 */
export interface LeakyBucketLimitOptions {
	/**
	 * Minimum time in milliseconds between actual callback starts for a key.
	 *
	 * Must be positive and finite. Fractional values are supported.
	 */
	readonly intervalMs: number
}

/**
 * Configuration for a local Leaky Bucket shaper.
 */
export interface LeakyBucketOptions extends RateLimiterOptions {
	/**
	 * A single pacing interval shared by all keys.
	 */
	limitOptions: LeakyBucketLimitOptions
}
