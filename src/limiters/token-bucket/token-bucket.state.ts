/** @internal */
export interface TokenBalance {
	tokens: number
	// Keep sub-token refill separate so it does not round against the whole-token count.
	milliTokens: number
}

/** @internal */
export interface TokenBucketState {
	chargedAt: number
	readonly balances: readonly TokenBalance[]
}
