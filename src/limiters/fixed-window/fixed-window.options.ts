import type { PriorityWeights } from '../../contracts/priority-weights.js'
import type { RateLimiterOptions } from '../../contracts/rate-limiter-options.js'

/**
 * One per-key quota profile.
 */
export type FixedWindowLimitOptions = Readonly<{
	/**
	 * Maximum number of callback starts per window.
	 *
	 * Must be a positive safe integer.
	 */
	limit: number

	/**
	 * Window duration in milliseconds.
	 *
	 * Must be positive and finite.
	 */
	windowMs: number
} & (
	| {
		/**
		 * Opens each window at the first admitted start after initialization or expiry.
		 *
		 * @default 'first-start'
		 */
		alignment?: 'first-start'
	}
	| {
		/**
		 * Uses fixed boundaries measured from the grid origin.
		 */
		alignment: 'grid'

		/**
		 * Grid origin in Unix epoch milliseconds. Must be finite.
		 *
		 * @default 0
		 */
		offsetMs?: number
	}
)>

/**
 * Configuration for a local Fixed Window limiter.
 */
export interface FixedWindowOptions extends RateLimiterOptions {
	/**
	 * A profile or a nonempty list of profiles.
	 *
	 * Each start must pass every profile for its key.
	 */
	limitOptions: FixedWindowLimitOptions | readonly FixedWindowLimitOptions[]

	/**
	 * Weights for global scheduling across keys.
	 *
	 * Defaults to `1`, `2`, `4`, `8`, and `16` from lowest to highest priority.
	 */
	weights?: PriorityWeights
}
