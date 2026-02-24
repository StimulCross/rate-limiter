/**
 * Rate limiter error codes.
 */
export enum RateLimitErrorCode {
	/**
	 * Indicates that the limit has been reached.
	 */
	LimitExceeded = 'LIMIT_EXCEEDED',

	/**
	 * Indicates that the execution queue is full.
	 */
	QueueOverflow = 'QUEUE_OVERFLOW',

	/**
	 * Indicates that the task has expired.
	 */
	Expired = 'EXPIRED',

	/**
	 * Indicates that a task was cleared before it was executed.
	 */
	Destroyed = 'DESTROYED',

	/**
	 * Indicates that a task was canceled via abort controller before it was executed.
	 */
	Cancelled = 'CANCELLED',
}
