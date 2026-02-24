/**
 * Sliding Window Counter rate limiter state.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface SlidingWindowCounterState {
	windowStart: number;
	currentCount: number;
	previousCount: number;
}
