/**
 * Defines the behavior when the limit is reached.
 *
 * Available options:
 * - `reject` - rejects the task with `LIMIT_EXCEEDED` error code
 * - `enqueue` - enqueues the task
 */
export type LimitBehavior = 'enqueue' | 'reject';
