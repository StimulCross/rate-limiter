import { type HttpLimitInfoExtractor } from './http-limit-info.extractor.js';
import { type HttpResponseBasedLimiterState } from './http-response-based-limiter.state.js';
import { type RateLimiterOptions } from '../../interfaces/rate-limiter-options.js';

/**
 * Options for the HTTP Response Based rate limiter.
 */
export interface HttpResponseBasedLimiterOptions<TResponse> extends RateLimiterOptions<HttpResponseBasedLimiterState> {
	/**
	 * Function that extracts limit information from the HTTP response.
	 */
	limitInfoExtractor: HttpLimitInfoExtractor<TResponse>;

	/**
	 * The fallback reset delay in milliseconds.
	 */
	fallbackResetDelayMs?: number;
}
