/**
 * Leaky Bucket rate limiter state.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface LeakyBucketState {
	level: number;
	lastUpdate: number;
}
