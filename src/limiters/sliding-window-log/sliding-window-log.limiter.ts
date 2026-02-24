import { type SlidingWindowLogOptions } from './sliding-window-log.options.js';
import { SlidingWindowLogPolicy } from './sliding-window-log.policy.js';
import { type SlidingWindowLogState } from './sliding-window-log.state.js';
import { type SlidingWindowLogStatus } from './sliding-window-log.status.js';
import { RateLimitErrorCode } from '../../enums/rate-limit-error-code.js';
import { RateLimitError } from '../../errors/rate-limit.error.js';
import { type RateLimiterRunOptions } from '../../interfaces/rate-limiter-run-options.js';
import { AbstractRateLimiter, type ExecutionContext } from '../abstract-rate-limiter.js';

/**
 * The options for running a task in the Sliding Window Log rate limiter.
 */
export type SlidingWindowLogLimiterRunOptions = Omit<RateLimiterRunOptions, 'limitBehavior' | 'priority'>;

/**
 * Sliding Window Log rate limiter.
 *
 * Designed primarily for client-side use to respect third-party limits or protect resources.
 * While this can be used as a server-side limiter with custom distributed storage
 * (e.g., Redis), it is best-effort and not recommended due to high network round-trip latency.
 *
 * Note: Unlike queue-based limiters, this implementation operates in strict immediate mode.
 * It does not support request queueing, delays, priorities, or task cancellation.
 */
export class SlidingWindowLogLimiter extends AbstractRateLimiter<SlidingWindowLogState, SlidingWindowLogStatus> {
	protected override readonly _policy: SlidingWindowLogPolicy;

	constructor(options: SlidingWindowLogOptions) {
		super(options);

		this._policy = new SlidingWindowLogPolicy(options.limit, options.windowMs);
	}

	protected override async _runInternal<T>(fn: () => T | Promise<T>, ctx: ExecutionContext): Promise<T> {
		const now = this._clock.now();
		const storeTtlMs = this._policy.windowMs;

		await this._store.acquireLock?.(ctx.key);

		try {
			const state = (await this._store.get(ctx.key)) ?? this._policy.getInitialState();

			const { decision, nextState } = this._policy.evaluate(state, now, ctx.cost);

			if (decision.kind === 'deny') {
				this._logger.debug(`[DENY] [id: ${ctx.id}, key: ${ctx.key}] - Retry: +${decision.retryAt - now}ms`);
				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, decision.retryAt);
			}

			await this._store.set(ctx.key, nextState, storeTtlMs);

			this._logger.debug(
				`[ALLOW] [id: ${ctx.id}, key: ${ctx.key}] - used/lim: ${nextState.totalUsed}/${this._policy.limit} logs: ${nextState.logs.size}`,
			);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}

		return await this._execute<T>(fn, now, storeTtlMs, ctx);
	}

	protected override _getDebugStateString(state: SlidingWindowLogState): string {
		return `used/lim: ${state.totalUsed}/${this._policy.limit} logs: ${state.logs.size}`;
	}
}
