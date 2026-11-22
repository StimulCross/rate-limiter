/** @internal */
export interface RateLimitPolicy<TState, TStatus> {
	/**
	 * Returns `undefined` when a start is eligible, or the earliest eligible time
	 * without intervening starts. `Infinity` represents no finite recovery time.
	 *
	 * Checking does not change subsequent admission.
	 */
	check: (state: TState | undefined, time: number) => number | undefined

	/**
	 * Records one eligible start at the checked time and returns the resulting state.
	 *
	 * The returned state may reuse the supplied state.
	 */
	charge: (state: TState | undefined, time: number) => TState

	/**
	 * Projects algorithm-specific status without changing subsequent admission.
	 */
	getStatus: (state: TState | undefined, time: number) => TStatus
}
