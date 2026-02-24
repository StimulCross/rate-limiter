import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Sliding Window Log rate limiter.
 */
export interface SlidingWindowLogStatus extends RateLimiterStatus {
	/**
	 * Maximum number of requests allowed within the time window.
	 */
	limit: number;

	/**
	 * The sliding time window duration in milliseconds.
	 */
	windowMs: number;

	/**
	 * Total number of requests consumed within the current sliding window.
	 *
	 * This count includes all requests that fall within the window period.
	 */
	totalUsed: number;

	/**
	 * Number of remaining requests available before hitting the limit.
	 */
	remaining: number;

	/**
	 * The timestamp (in milliseconds) when the next request slot will become available.
	 *
	 * This is based on when the oldest request in the window will expire.
	 */
	nextAvailableAt: number;

	/**
	 * The timestamp (in milliseconds) when the current window will fully reset.
	 *
	 * Represents when the last (most recent) request in the log will expire.
	 *
	 * After this time, all requests will have aged out of the sliding window.
	 */
	resetAt: number;
}
