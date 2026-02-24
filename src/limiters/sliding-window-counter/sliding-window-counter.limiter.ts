import { type SlidingWindowCounterOptions } from './sliding-window-counter.options.js';
import { SlidingWindowCounterPolicy } from './sliding-window-counter.policy.js';
import { type SlidingWindowCounterState } from './sliding-window-counter.state.js';
import { type SlidingWindowCounterStatus } from './sliding-window-counter.status.js';
import { RateLimitErrorCode } from '../../enums/rate-limit-error-code.js';
import { RateLimitError } from '../../errors/rate-limit.error.js';
import { type RateLimiterRunOptions } from '../../interfaces/rate-limiter-run-options.js';
import { AbstractRateLimiter, type ExecutionContext } from '../abstract-rate-limiter.js';

/**
 * The options for running a task in the Sliding Window Counter rate limiter.
 */
export type SlidingWindowCounterLimiterRunOptions = Omit<
	RateLimiterRunOptions,
	'limitBehavior' | 'priority' | 'maxWaitMs'
>;

/**
 * Sliding Window Counter rate limiter.
 *
 * Designed primarily for client-side use to respect third-party limits or protect resources.
 * While this can be used as a server-side limiter with custom distributed storage
 * (e.g., Redis), it is best-effort and not recommended due to high network round-trip latency.
 *
 * Note: Unlike queue-based limiters, this implementation operates in strict immediate mode.
 * It does not support request queueing, delays, priorities, or task cancellation.
 */
export class SlidingWindowCounterLimiter extends AbstractRateLimiter<
	SlidingWindowCounterState,
	SlidingWindowCounterStatus
> {
	protected override readonly _policy: SlidingWindowCounterPolicy;

	private readonly _storeTtl: number;

	constructor(options: SlidingWindowCounterOptions) {
		super(options);

		this._policy = new SlidingWindowCounterPolicy(options.limit, options.windowMs);
		this._storeTtl = options.windowMs * 2;
	}

	protected override async _runInternal<T>(fn: () => T | Promise<T>, ctx: ExecutionContext): Promise<T> {
		const now = this._clock.now();

		await this._store.acquireLock?.(ctx.key);

		try {
			const state = (await this._store.get(ctx.key)) ?? this._policy.getInitialState();

			const { decision, nextState } = this._policy.evaluate(state, now, ctx.cost);

			if (decision.kind === 'deny') {
				this._shouldPrintDebug &&
					this._logger.debug(`[DENY] [id: ${ctx.id}, key: ${ctx.key}] - Retry: +${decision.retryAt - now}ms`);

				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, decision.retryAt);
			}

			await this._store.set(ctx.key, nextState, this._storeTtl);

			this._shouldPrintDebug &&
				this._logger.debug(
					`[ALLOW] [id: ${ctx.id}, key: ${ctx.key}] - ${this._getDebugStateString(nextState)}`,
				);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}

		return await this._execute(fn, now, this._storeTtl, ctx);
	}

	protected override _getDebugStateString(state: SlidingWindowCounterState): string {
		return `lim: ${this._policy.limit}; c/p: ${state.currentCount}/${state.previousCount}`;
	}
}
