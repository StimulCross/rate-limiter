/**
 * The status of the rate limiter.
 */
export interface RateLimiterStatus {
	/**
	 * The timestamp (in milliseconds) when a rate limiter will allow a single request.
	 */
	readonly nextAvailableAt: number;

	/**
	 * The timestamp (in milliseconds) when the rate limiter will reset.
	 */
	readonly resetAt: number;
}
