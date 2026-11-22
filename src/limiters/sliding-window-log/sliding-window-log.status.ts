/**
 * An observational snapshot of one Sliding Window Log profile.
 */
export interface SlidingWindowLogProfileStatus {
	/**
	 * Configured maximum starts within the window.
	 */
	readonly limit: number

	/**
	 * Duration of the sliding window in milliseconds.
	 */
	readonly windowMs: number

	/**
	 * Number of starts whose quota has yet to expire.
	 */
	readonly used: number

	/**
	 * Starts available immediately under this profile.
	 */
	readonly remaining: number
}

/**
 * An observational snapshot of one key's Sliding Window Log quotas.
 */
export interface SlidingWindowLogStatus {
	/**
	 * Earliest quota-eligible start in Unix epoch milliseconds, assuming no intervening starts.
	 *
	 * A free execution slot and winning selection are also required for an actual start.
	 *
	 * Infinity indicates that the quota cannot recover within the clock's finite range.
	 */
	readonly nextAvailableAt: number

	/**
	 * Per-profile quota snapshots in configuration order.
	 */
	readonly profiles: readonly SlidingWindowLogProfileStatus[]
}
