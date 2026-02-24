/**
 * Fixed Window rate limiter state.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface FixedWindowState {
	windowStart: number;
	used: number;
	reserved: number;
}
