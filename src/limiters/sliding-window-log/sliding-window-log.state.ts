import { type Deque } from '@stimulcross/ds-deque';

/**
 * A log entry in the sliding window log rate limiter.
 */
export interface SlidingWindowLogEntry {
	ts: number;
	count: number;
}

/**
 * The state of the sliding window log rate limiter.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface SlidingWindowLogState {
	logs: Deque<SlidingWindowLogEntry>;
	totalUsed: number;
}
