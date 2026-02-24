import { LogLevel } from '@stimulcross/logger';
import { type LeakyBucketOptions } from './leaky-bucket.options.js';
import { LeakyBucketPolicy } from './leaky-bucket.policy.js';
import { type LeakyBucketState } from './leaky-bucket.state.js';
import { type LeakyBucketStatus } from './leaky-bucket.status.js';
import { type Decision } from '../../core/decision.js';
import { RateLimitErrorCode } from '../../enums/rate-limit-error-code.js';
import { RateLimitError } from '../../errors/rate-limit.error.js';
import { type LimitBehavior } from '../../types/limit-behavior.js';
import { AbstractRateLimiter, type ExecutionContext } from '../abstract-rate-limiter.js';

/**
 * Leaky Bucket rate limiter.
 *
 * Designed primarily for client-side use to respect third-party limits or protect resources.
 * While this can be used as a server-side limiter with custom distributed storage
 * (e.g., Redis), it is best-effort and not recommended due to high network round-trip latency.
 *
 * Key features:
 * - **Queueing & overflow** - optionally enqueues excess requests up to a maximum allowed overflow capacity
 * - **Concurrency** - limits how many requests can be executed simultaneously
 * - **Priority** - supports task priorities (with fairness and custom policy) to execute critical requests first
 * - **Cancellation** - supports `AbortSignal` to safely remove pending requests from the queue
 * - **Expiration** - automatically drops queued requests that wait longer than the allowed `maxWaitMs`
 * - **Auto-rollback** - reverts spent quota if an enqueued task is canceled or expired
 */
export class LeakyBucketLimiter extends AbstractRateLimiter<LeakyBucketState, LeakyBucketStatus> {
	private readonly _defaultLimitBehaviour: LimitBehavior;
	private readonly _maxWaitMs: number | undefined;

	protected override readonly _policy: LeakyBucketPolicy;

	constructor(options: LeakyBucketOptions) {
		super(options);

		this._defaultLimitBehaviour = options.limitBehavior ?? 'reject';

		if (options.queue?.maxWaitMs) {
			this._maxWaitMs = options.queue.maxWaitMs;
		}

		this._policy = new LeakyBucketPolicy(options.capacity, options.leakRate);
	}

	protected override async _runInternal<T>(fn: () => T | Promise<T>, ctx: ExecutionContext): Promise<T> {
		const now = this._clock.now();
		const baseTtlMs = Math.ceil(this._policy.capacity / (this._policy.leakRate / 1000));

		let runAt: number;
		let storeTtlMs: number;

		await this._store.acquireLock?.(ctx.key);

		try {
			const state = (await this._store.get(ctx.key)) ?? this._policy.getInitialState();
			const finalLimitBehavior = ctx.limitBehavior ?? this._defaultLimitBehaviour;

			const { decision, nextState } = this._policy.evaluate(
				state,
				now,
				ctx.cost,
				finalLimitBehavior === 'enqueue',
			);

			if (decision.kind === 'deny') {
				this._logger.debug(`[DENY] [id: ${ctx.id}, key: ${ctx.key}] - Retry: +${decision.retryAt - now}ms`);
				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, decision.retryAt);
			}

			runAt = decision.kind === 'delay' ? decision.runAt : now;
			storeTtlMs = Math.max(baseTtlMs, runAt - now + baseTtlMs);

			await this._store.set(ctx.key, nextState, storeTtlMs);

			this._printDebug(decision, nextState, now, ctx);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}

		const finalMaxWaitMs = ctx.maxWaitMs ?? this._maxWaitMs;
		const expiresAt = finalMaxWaitMs ? now + finalMaxWaitMs : undefined;

		return await this._execute(fn, runAt, storeTtlMs, ctx, expiresAt);
	}

	protected override _getDebugStateString(state: LeakyBucketState): string {
		return `lvl: ${state.level.toFixed(2)}/${this._policy.capacity}`;
	}

	private _printDebug(decision: Decision, nextState: LeakyBucketState, now: number, ctx: ExecutionContext): void {
		if (this._logger.minLevel < LogLevel.DEBUG) {
			return;
		}

		const debugStateString = `lvl: ${nextState.level.toFixed(2)}/${this._policy.capacity}`;

		if (decision.kind === 'delay') {
			this._logger.debug(
				`[DELAY] [id: ${ctx.id}, key: ${ctx.key}] +${decision.runAt - now}ms - ${debugStateString}`,
			);
		} else {
			this._logger.debug(`[ALLOW] [id: ${ctx.id}, key: ${ctx.key}] - ${debugStateString} `);
		}
	}
}
