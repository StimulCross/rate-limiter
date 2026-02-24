import { type GenericCellState } from './generic-cell.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the Generic Cell Rate Algorithm (GCRA) limiter.
 */
export interface GenericCellOptions extends RateLimiterOptions<GenericCellState> {
	/**
	 * The minimum interval between requests (in milliseconds).
	 *
	 * This defines the emission interval.
	 * For example, if you want to allow 10 requests per second, set this to 100ms (1000ms / 10).
	 */
	intervalMs: number;

	/**
	 * The maximum burst size.
	 *
	 * This defines how many requests can be made immediately in quick succession before rate limiting kicks in.
	 * The burst capacity allows temporary spikes in traffic.
	 */
	burst: number;
}
