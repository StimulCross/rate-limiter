/**
 * Token Bucket rate limiter state.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface TokenBucketState {
	tokens: number;
	debt: number;
	lastRefill: number;
}
