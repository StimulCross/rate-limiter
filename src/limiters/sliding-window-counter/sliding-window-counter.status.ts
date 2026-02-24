import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Sliding Window Counter rate limiter.
 */
export interface SlidingWindowCounterStatus extends RateLimiterStatus {
	/**
	 * Maximum number of requests allowed within the time window.
	 */
	limit: number;

	/**
	 * Duration of the time window in milliseconds.
	 */
	windowMs: number;

	/**
	 * Timestamp (in milliseconds) when the current window started.
	 */
	windowStart: number;

	/**
	 * Number of requests made in the current window.
	 */
	currentCount: number;

	/**
	 * Number of requests made in the previous window.
	 */
	previousCount: number;

	/**
	 * Estimated request count based on the sliding window algorithm.
	 *
	 * Calculated by combining current and previous window counts proportionally.
	 */
	estimatedCount: number;

	/**
	 * Number of requests remaining before hitting the limit.
	 */
	remaining: number;

	/**
	 * Timestamp (in milliseconds) when the next request slot becomes available.
	 */
	nextAvailableAt: number;

	/**
	 * Timestamp (in milliseconds) when the current window resets.
	 */
	resetAt: number;
}
