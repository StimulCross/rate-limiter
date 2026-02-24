import { LogLevel } from '@stimulcross/logger';
import { type FixedWindowOptions } from './fixed-window.options.js';
import { FixedWindowPolicy } from './fixed-window.policy.js';
import { type FixedWindowState } from './fixed-window.state.js';
import { type FixedWindowStatus } from './fixed-window.status.js';
import { type Decision } from '../../core/decision.js';
import { RateLimitErrorCode } from '../../enums/rate-limit-error-code.js';
import { RateLimitError } from '../../errors/rate-limit.error.js';
import { type LimitBehavior } from '../../types/limit-behavior.js';
import { AbstractRateLimiter, type ExecutionContext } from '../abstract-rate-limiter.js';
import { CompositePolicy } from '../composite.policy.js';

/**
 * Fixed Window rate limiter.
 *
 * Designed primarily for client-side use to respect third-party limits or protect resources.
 * While this can be used as a server-side limiter with custom distributed storage
 * (e.g., Redis), it is best-effort and not recommended due to high network round-trip latency.
 *
 * Key features:
 * - **Composite limits** - supports multiple windows simultaneously (e.g., 10 per second AND 1000 per hour)
 * - **Queueing & overflow** - optionally enqueues excess requests up to a maximum allowed overflow capacity
 * - **Concurrency** - limits how many requests can be executed simultaneously
 * - **Priority** - supports task priorities (with fairness and custom policy) to execute critical requests first
 * - **Cancellation** - supports `AbortSignal` to safely remove pending requests from the queue
 * - **Expiration** - automatically drops queued requests that wait longer than the allowed `maxWaitMs`
 * - **Auto-rollback** - reverts spent quota if an enqueued task is canceled or expired
 */
export class FixedWindowLimiter extends AbstractRateLimiter<FixedWindowState[], FixedWindowStatus[]> {
	private readonly _defaultLimitBehaviour: LimitBehavior;
	private readonly _defaultMaxWaitMs: number | undefined;
	private readonly _maxWindowSizeMs: number;

	protected override readonly _policy: CompositePolicy<FixedWindowState, FixedWindowStatus, FixedWindowPolicy>;

	constructor(options: FixedWindowOptions) {
		super(options);

		this._defaultLimitBehaviour = options.limitBehavior ?? 'reject';

		if (options.queue?.maxWaitMs) {
			this._defaultMaxWaitMs = options.queue.maxWaitMs;
		}

		this._policy = new CompositePolicy(
			Array.isArray(options.limitOptions)
				? options.limitOptions.map(({ limit, windowMs }) => new FixedWindowPolicy(limit, windowMs))
				: [new FixedWindowPolicy(options.limitOptions.limit, options.limitOptions.windowMs)],
		);

		this._maxWindowSizeMs = Math.max(...this._policy.policies.map(policy => policy.windowMs));
	}

	protected override async _runInternal<T>(fn: () => T | Promise<T>, ctx: ExecutionContext): Promise<T> {
		const now = this._clock.now();

		let runAt: number;
		let storeTtlMs: number;

		await this._store.acquireLock?.(ctx.key);

		try {
			const state = (await this._store.get(ctx.key)) ?? this._policy.getInitialState(this._clock.now());
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
			storeTtlMs = Math.max(this._maxWindowSizeMs, runAt - now + this._maxWindowSizeMs);

			await this._store.set(ctx.key, nextState, storeTtlMs);

			this._printDebug(decision, nextState, now, ctx);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}

		const finalMaxWaitMs = ctx.maxWaitMs ?? this._defaultMaxWaitMs;
		const expiresAt = finalMaxWaitMs ? now + finalMaxWaitMs : undefined;

		return await this._execute(fn, runAt, storeTtlMs, ctx, expiresAt);
	}

	protected override _getDebugStateString(state: FixedWindowState[]): string {
		const result: string[] = [];

		for (const [i, { used, reserved }] of state.entries()) {
			const { windowMs, limit } = this._policy.policies[i];

			result.push(`w/l: ${windowMs}/${limit}; u/r: ${used}/${reserved}`);
		}

		return result.join(', ');
	}

	private _printDebug(decision: Decision, nextState: FixedWindowState[], now: number, ctx: ExecutionContext): void {
		if (this._logger.minLevel < LogLevel.DEBUG) {
			return;
		}

		const debugStateString = this._getDebugStateString(nextState);

		if (decision.kind === 'delay') {
			this._logger.debug(
				`[DELAY] [id: ${ctx.id}, key: ${ctx.key}] +${decision.runAt - now}ms - ${debugStateString}`,
			);
		} else {
			this._logger.debug(`[ALLOW] [id: ${ctx.id}, key: ${ctx.key}] - ${debugStateString}`);
		}
	}
}
