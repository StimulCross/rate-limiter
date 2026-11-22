/** @internal */
export interface LeakyBucketState {
	readonly lastStartedAt: number
	readonly readyAt: number
}
