/**
 * The status of the HTTP Response Based rate limiter.
 *
 * This interface represents rate limit information extracted from HTTP response headers,
 * such as RateLimit headers (RFC 6585) or custom headers provided by APIs (X-RateLimit-*).
 *
 * @remarks
 * The status is updated after each API response and reflects the server-side rate limit state.
 * Can be useful to check how many requests remain before hitting the rate limit.
 */
export interface HttpResponseBasedLimiterStatus {
	/**
	 * Indicates whether the rate limiter is currently probing for the server's limit state.
	 *
	 * This is `true` when the rate limiter is waiting for the first response from the server
	 * to extract rate limit headers.
	 */
	isProbing: boolean;

	/**
	 * Indicates whether the rate limiter is in unlimited mode.
	 *
	 * This is `true` if a server did not send any rate limit headers.
	 *
	 * If this is `true`, the `lastKnownLimit`, `lastKnownRemaining`, and `lastKnownResetAt` values are `null`.
	 */
	isUnlimited: boolean;

	/**
	 * The number of requests remaining in the current rate limit window.
	 *
	 * @remarks
	 * This value is extracted from response headers such as `X-RateLimit-Remaining`
	 * or `RateLimit-Remaining`. It decrements with each request and resets when
	 * the time window expires.
	 *
	 * When this reaches 0, later requests may be delayed or rejected until the reset time.
	 */
	lastKnownRemaining: number | null;

	/**
	 * The maximum number of requests allowed in the current rate limit window.
	 *
	 * @remarks
	 * This value is extracted from response headers such as `X-RateLimit-Limit`
	 * or `RateLimit-Limit`. It represents the total quota allocated by the API
	 * and typically remains constant across requests within the same window.
	 */
	lastKnownLimit: number | null;

	/**
	 * The timestamp (in milliseconds since Unix epoch) when the rate limit window resets.
	 *
	 * `null` if the reset time is not known or not applicable.
	 *
	 * @remarks
	 * This value is extracted from response headers such as `X-RateLimit-Reset`
	 * or `RateLimit-Reset`. The exact semantics depend on the API specification:
	 *
	 * - **Full window reset**: When the entire rate limit quota is restored
	 * - **Next request availability**: When the next single request slot becomes available
	 * - **Sliding window**: When the oldest request in the window expires
	 *
	 * Always refer to your API's documentation to understand the reset behavior.
	 */
	lastKnownResetAt: number | null;

	/**
	 * The timestamp (in milliseconds since Unix epoch) when the status was last synced with the server.
	 *
	 * `null` if the status has never been synced.
	 */
	lastSyncedAt: number | null;
}
