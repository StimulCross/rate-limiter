import type { LeakyBucketLimitOptions } from './leaky-bucket-options.js'

/**
 * An observational snapshot of one key's Leaky Bucket pacing history.
 */
export interface LeakyBucketStatus extends LeakyBucketLimitOptions {
	/**
	 * Effective quota time of the last actual start in Unix epoch milliseconds.
	 *
	 * `null` if the key has no start history.
	 */
	readonly lastStartedAt: number | null

	/**
	 * Earliest quota-eligible timestamp in Unix epoch milliseconds.
	 *
	 * For a ready key, this is the effective observation time.
	 *
	 * `Infinity` indicates that the key stays blocked until cleared.
	 *
	 * An actual start also requires a free execution slot and winning selection.
	 */
	readonly nextAvailableAt: number
}
