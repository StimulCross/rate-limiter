/** @internal */
export interface WindowCounts {
	readonly index: bigint
	readonly windowStart: bigint
	readonly currentCount: number
	readonly previousCount: number
}

/** @internal */
export interface SlidingWindowCounterState extends WindowCounts {
	readonly nextAvailableAt: number
}
