/**
 * An observational snapshot of one key's Sliding Window Counter quota.
 */
export interface SlidingWindowCounterStatus {
	/**
	 * Configured limit on estimated usage after a start.
	 */
	readonly limit: number

	/**
	 * Duration of each grid window in milliseconds.
	 */
	readonly windowMs: number

	/**
	 * Start of the current grid window in Unix epoch milliseconds, rounded to a `Number`.
	 */
	readonly windowStart: number

	/**
	 * Starts in the current grid window.
	 */
	readonly currentCount: number

	/**
	 * Starts in the preceding grid window.
	 */
	readonly previousCount: number

	/**
	 * Current count plus the previous count weighted by the fraction of the window left.
	 */
	readonly estimatedCount: number

	/**
	 * Whole starts available immediately, computed before rounding the displayed estimate.
	 */
	readonly remaining: number

	/**
	 * Earliest quota-eligible start in Unix epoch milliseconds, assuming no intervening starts.
	 *
	 * A free execution slot and winning selection are also required for an actual start.
	 *
	 * `Infinity` indicates that the quota cannot recover within the clock's finite range.
	 */
	readonly nextAvailableAt: number
}
