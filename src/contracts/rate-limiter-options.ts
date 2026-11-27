import type { LoggerOptions } from '@stimulcross/logger'
import type { IdGenerator } from './id-generator.js'
import type { LimitBehavior } from './limit-behavior.js'
import type { PriorityMode } from './priority-mode.js'
import type { PriorityWeights } from './priority-weights.js'
import type { RateLimiterQueueOptions } from './rate-limiter-queue-options.js'

/**
 * Instance diagnostic configuration.
 *
 * The default threshold is `warning`.
 */
export interface RateLimiterLoggerOptions extends Partial<LoggerOptions> {
	/**
	 * Includes quoted task IDs and quota keys in messages. Enable only for identifiers safe to disclose.
	 *
	 * @default false
	 */
	includeIdentifiers?: boolean
}

/**
 * Shared RateLimiter options.
 *
 * Algorithm settings belong to concrete implementations.
 */
export interface RateLimiterOptions {
	/**
	 * Generates identifiers for tasks without an explicit id.
	 */
	idGenerator?: IdGenerator

	/**
	 * Default behavior when quota or concurrency is unavailable.
	 *
	 * - `reject` forbids waiting for quota or concurrency.
	 * - `enqueue` permits bounded waiting. A finite capacity must be configured.
	 *
	 * @default `reject`
	 */
	limitBehavior?: LimitBehavior

	/**
	 * Local waiting and execution settings.
	 */
	queue?: RateLimiterQueueOptions

	/**
	 * Selects the instance-wide {@link PriorityMode} for tasks with available quota.
	 *
	 * @default 'weighted'
	 */
	priorityMode?: PriorityMode

	/**
	 * Positive finite weights for all five priority classes in weighted mode.
	 *
	 * Defaults to `1`, `2`, `4`, `8`, and `16` from lowest to highest priority.
	 * A defined value with `priorityMode: 'strict'` throws a `RangeError` at construction.
	 */
	weights?: PriorityWeights

	/**
	 * Configures diagnostic output for this limiter instance.
	 */
	loggerOptions?: RateLimiterLoggerOptions
}
