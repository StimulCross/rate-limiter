/**
 * An observational snapshot of one Token Bucket profile.
 */
export interface TokenBucketProfileStatus {
	/**
	 * Maximum token balance.
	 */
	readonly capacity: number

	/**
	 * Tokens refilled per second.
	 */
	readonly refillRate: number

	/**
	 * Available tokens, including fractional refill up to capacity.
	 */
	readonly tokens: number
}

/**
 * An observational snapshot of one key's Token Bucket quotas.
 */
export interface TokenBucketStatus {
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
	readonly profiles: readonly TokenBucketProfileStatus[]
}
