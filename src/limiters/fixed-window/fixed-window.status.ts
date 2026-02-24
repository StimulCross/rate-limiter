import { type RateLimiterStatus } from '../../core/rate-limiter-status.js';

/**
 * The status of the Fixed Window Limiter.
 */
export interface FixedWindowStatus extends RateLimiterStatus {
	/**
	 * The start of the current window.
	 */
	readonly windowStart: number;

	/**
	 * The end of the current window.
	 */
	readonly windowEnd: number;

	/**
	 * The maximum number of tokens can be used in the window.
	 */
	readonly limit: number;

	/**
	 * The number of tokens that have been used in the current window.
	 */
	readonly used: number;

	/**
	 * The number of tokens that are reserved for future windows.
	 */
	readonly reserved: number;

	/**
	 * The number of tokens that can be used in the current window.
	 */
	readonly remaining: number;

	/**
	 * The timestamp (in milliseconds) when the next token will be available for use.
	 */
	readonly nextAvailableAt: number;

	/**
	 * The timestamp (in milliseconds) when the limit will be reset (all tokens will be available for use again).
	 */
	readonly resetAt: number;
}
