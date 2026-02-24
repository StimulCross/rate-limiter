import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Generic Cell rate limiter.
 */
export interface GenericCellStatus extends RateLimiterStatus {
	/**
	 * The minimum interval between tokens (in milliseconds).
	 *
	 * It represents the emission interval - the time period between
	 * successive token emissions at the steady-state rate.
	 */
	readonly intervalMs: number;

	/**
	 * The maximum burst size (maximum number of tokens that can be accumulated).
	 *
	 * It represents the burst capacity - the maximum number of requests
	 * that can be made instantaneously when the bucket is full.
	 */
	readonly burst: number;

	/**
	 * Theoretical Arrival Time (TAT) - the virtual time when the bucket will be empty.
	 *
	 * TAT represents the earliest time at which a future request could be allowed.
	 *
	 * Value is in milliseconds.
	 */
	readonly tat: number;

	/**
	 * The number of tokens that can be used immediately.
	 *
	 * Calculated as the time allowance available between now and TAT, divided by
	 * the emission interval.
	 */
	readonly remaining: number;

	/**
	 * The timestamp (in milliseconds) when the next token will be available for use.
	 *
	 * This is the earliest time when a request can be accepted if no tokens are currently available.
	 */
	readonly nextAvailableAt: number;

	/**
	 * The timestamp when all tokens will be available for use again.
	 *
	 * It is when the TAT returns to the current time, meaning the bucket has fully recovered to its
	 * maximum burst capacity.
	 */
	readonly resetAt: number;
}
