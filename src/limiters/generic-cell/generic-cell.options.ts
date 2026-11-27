import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * One per-key Generic Cell Rate Algorithm (GCRA) profile.
 */
export interface GenericCellLimitOptions {
	/**
	 * Nominal time between starts in milliseconds.
	 *
	 * Must be a positive safe integer.
	 *
	 * With a burst of one, this is also the minimum spacing between starts.
	 */
	readonly intervalMs: number

	/**
	 * Maximum number of starts allowed at one timestamp after full recovery.
	 *
	 * Must be a positive safe integer.
	 */
	readonly burst: number
}

/**
 * Configuration for a local Generic Cell limiter.
 */
export interface GenericCellOptions extends RateLimiterOptions {
	/**
	 * A profile or a nonempty list of profiles.
	 *
	 * Each start must pass every profile for its key.
	 */
	limitOptions: GenericCellLimitOptions | readonly GenericCellLimitOptions[]
}
