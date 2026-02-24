import { type FixedWindowState } from './fixed-window.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Fixed Window limit options.
 */
export interface FixedWindowLimitOptions {
	/**
	 * Maximum number of requests allowed within the time window.
	 */
	limit: number;

	/**
	 * Duration of the time window in milliseconds.
	 */
	windowMs: number;
}

/**
 * Options for the Fixed Window rate limiter.
 */
export interface FixedWindowOptions extends RateLimiterOptions<FixedWindowState[]> {
	/**
	 * Options time window.
	 *
	 * Can be a single object or an array of objects for composite time windows.
	 */
	limitOptions: FixedWindowLimitOptions | FixedWindowLimitOptions[];
}
