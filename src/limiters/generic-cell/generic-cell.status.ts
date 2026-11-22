import type { GenericCellLimitOptions } from './generic-cell.options.js'

/**
 * An observational snapshot of one Generic Cell profile.
 */
export interface GenericCellProfileStatus extends GenericCellLimitOptions {
	/**
	 * Theoretical arrival time of the profile in Unix epoch milliseconds, rounded up to
	 * a representable timestamp.
	 *
	 * The profile has fully recovered at this time.
	 *
	 * `null` indicates that no callback has started for this key since initialization or clear.
	 */
	readonly tat: number | null

	/**
	 * Number of starts the profile can allow at the observed time.
	 */
	readonly remaining: number
}

/**
 * An observational snapshot of one key's Generic Cell quotas.
 */
export interface GenericCellStatus {
	/**
	 * Earliest quota-eligible timestamp in Unix epoch milliseconds with no intervening starts.
	 *
	 * A free execution slot and winning selection are also required for an actual start.
	 *
	 * `Infinity` indicates that the quota cannot recover within the clock's finite range.
	 */
	readonly nextAvailableAt: number

	/**
	 * Per-profile quota snapshots in configuration order.
	 */
	readonly profiles: readonly GenericCellProfileStatus[]
}
