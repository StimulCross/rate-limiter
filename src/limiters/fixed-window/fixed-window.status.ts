/**
 * Bounds of a half-open Fixed Window in Unix epoch milliseconds.
 */
export interface FixedWindowBounds {
	/**
	 * Inclusive start of the window.
	 */
	readonly start: number

	/**
	 * Exclusive end of the window.
	 */
	readonly end: number
}

/**
 * An observational snapshot of one quota profile.
 */
export interface FixedWindowProfileStatus {
	/**
	 * Current window boundaries. An unopened or elapsed first-start window is `null`.
	 */
	readonly window: FixedWindowBounds | null

	/**
	 * Configured maximum starts per window.
	 */
	readonly limit: number

	/**
	 * Callback starts charged to the current window.
	 */
	readonly used: number

	/**
	 * Starts still available in the current or next unopened window.
	 */
	readonly remaining: number
}

/**
 * An observational snapshot of one key's Fixed Window quotas.
 */
export interface FixedWindowStatus {
	/**
	 * Earliest quota-eligible start in Unix epoch milliseconds, assuming no intervening starts.
	 *
	 * A free execution slot and winning selection are also required for an actual start.
	 */
	readonly nextAvailableAt: number

	/**
	 * Per-profile quota snapshots in configuration order.
	 */
	readonly profiles: readonly FixedWindowProfileStatus[]
}
