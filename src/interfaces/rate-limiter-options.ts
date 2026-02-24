import { type LoggerOptions } from '@stimulcross/logger';
import { type RateLimiterQueueOptions } from './rate-limiter-queue-options.js';
import { type Clock } from '../core/clock.js';
import { type StateStorage } from '../core/state-storage.js';
import { type LimitBehavior } from '../types/limit-behavior.js';

/**
 * A function that generates a unique ID for the task.
 */
export type IdGenerator = () => string;

/**
 * A function that resolves a global key for the given key.
 */
export type KeyResolver = (key?: string) => string;

/**
 * Rate limiter options.
 *
 * @template TState The type of the rate limiter state.
 */
export interface RateLimiterOptions<TState = unknown> {
	/**
	 * A custom clock implementation.
	 */
	clock?: Clock;

	/**
	 * An optional key that can be either a string or a key resolver function.
	 *
	 * If a string is provided, it will be used as a global prefix for all keys.
	 *
	 * If a function is provided, it will be called with the provided key and should return a unique global key.
	 *
	 * Useful for distributed stores.
	 *
	 * @default limiter
	 */
	key?: string | KeyResolver;

	/**
	 * A custom ID factory function.
	 *
	 * It is used to generate unique IDs for each task for logging and debugging purposes.
	 */
	idGenerator?: IdGenerator;

	/**
	 * State storage implementation for persisting rate limiter state.
	 *
	 * By default, an in-memory state store is used, which is unique to each process.
	 * This is suitable for single-instance applications or when rate limiting doesn't need
	 * to be shared across multiple processes.
	 *
	 * For distributed applications, you can implement a custom state store using Redis, Memcached,
	 * or other distributed storage systems. However, be aware that this introduces network latency
	 * due to multiple round-trips (typically 3-4 requests with lock acquire/release).
	 *
	 * For distributed rate limiting, consider using, for example, Redis with Lua scripts.
	 * This allows atomic operations and minimizes latency.
	 */
	store?: StateStorage<TState>;

	/**
	 * Defines the behavior when the limit is reached.
	 *
	 * Available options:
	 * - `reject` - rejects the task with `LIMIT_EXCEEDED` error code
	 * - `enqueue` - enqueues the task
	 *
	 * @default 'reject'
	 */
	limitBehavior?: LimitBehavior;

	/**
	 * Logger options.
	 */
	loggerOptions?: Omit<LoggerOptions, 'context'>;

	/**
	 * Queue settings.
	 */
	queue?: RateLimiterQueueOptions;
}
