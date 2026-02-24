/**
 * The state of the HTTP Response Based rate limiter.
 *
 * When using a distributed state store, make sure it properly serializes and deserializes the state.
 */
export interface HttpResponseBasedLimiterState {
	isProbing: boolean;
	isUnlimited: boolean;
	lastKnownLimit: number | null;
	lastKnownRemaining: number | null;
	lastKnownResetAt: number | null;
	lastSyncedAt: number | null;
}
