/**
 * Reasons a limiter rejects a task before invoking its callback.
 */
export enum RateLimitErrorCode {
	/**
	 * The callback could not start immediately.
	 */
	LimitExceeded = 'LIMIT_EXCEEDED',
	/**
	 * No waiting place was available for the task.
	 */
	QueueOverflow = 'QUEUE_OVERFLOW',
	/**
	 * The waiting deadline elapsed.
	 */
	Expired = 'EXPIRED',
	/**
	 * The signal aborted before the callback started.
	 */
	Cancelled = 'CANCELLED',
	/**
	 * The task was waiting when its key was cleared.
	 */
	Cleared = 'CLEARED',
	/**
	 * The limiter is shutting down or has shut down.
	 */
	Destroyed = 'DESTROYED',
}
