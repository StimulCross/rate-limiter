import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { createLogger, type Logger, LogLevel } from '@stimulcross/logger';
import { type HttpLimitInfoExtractor } from './http-limit-info.extractor.js';
import { type HttpLimitInfo } from './http-limit.info.js';
import { type HttpResponseBasedLimiterOptions } from './http-response-based-limiter.options.js';
import { type HttpResponseBasedLimiterState } from './http-response-based-limiter.state.js';
import { type HttpResponseBasedLimiterStatus } from './http-response-based-limiter.status.js';
import { type Clock } from '../../core/clock.js';
import { type RateLimiter } from '../../core/rate-limiter.js';
import { type StateStorage } from '../../core/state-storage.js';
import { RateLimitErrorCode } from '../../enums/rate-limit-error-code.js';
import { RateLimitError } from '../../errors/rate-limit.error.js';
import { RateLimiterDestroyedError } from '../../errors/rate-limiter-destroyed.error.js';
import { type IdGenerator, type KeyResolver } from '../../interfaces/rate-limiter-options.js';
import { type RateLimiterRunOptions } from '../../interfaces/rate-limiter-run-options.js';
import { defaultClock } from '../../runtime/default-clock.js';
import { InMemoryStateStore } from '../../runtime/in-memory-state-store.js';
import { RateLimiterExecutor } from '../../runtime/rate-limiter.executor.js';
import { type LimitBehavior } from '../../types/limit-behavior.js';
import { generateRandomString } from '../../utils/generate-random-string.js';
import { sanitizeError } from '../../utils/sanitize-error.js';

const TOO_MANY_REQUESTS_ERROR_CODE = 429;

const enum TokenReservationAction {
	Probe = 1,
	Follow = 2,
	Wait = 3,
}

interface RequestContext {
	readonly id: string;
	readonly key: string;
	readonly signal?: AbortSignal;
	startedAt: number;
	isProbing: boolean;
}

/**
 *  The options for single request execution.
 */
export type HttpHeadersLimiterRunOptions = Omit<RateLimiterRunOptions, 'cost'>;

/**
 * HTTP Response Based rate limiter.
 *
 * Designed for outbound requests to safely respect dynamic third-party API limits.
 *
 * This limiter synchronizes its internal state by extracting rate limit headers directly from the HTTP responses.
 *
 * Key features:
 * - **Dynamic synchronization** - updates local capacity and reset schedules based on actual server responses
 * - **Probing** - prevents 429 floods by pausing queued requests while a single "probe" fetches the latest limits
 * - **Queueing & overflow** - optionally enqueues excess requests up to a maximum allowed overflow capacity
 * - **Concurrency** - limits how many requests can be executed simultaneously
 * - **Priority** - supports task priorities (with fairness and custom policy) to execute critical requests first
 * - **Cancellation** - supports `AbortSignal` to safely remove pending requests from the queue
 * - **Expiration** - automatically drops queued requests that wait longer than the allowed `maxWaitMs`
 */
export class HttpResponseBasedLimiter<TResponse> implements RateLimiter<HttpResponseBasedLimiterStatus> {
	private readonly _logger: Logger;
	private readonly _clock: Clock;
	private readonly _store: StateStorage<HttpResponseBasedLimiterState>;
	private readonly _executor: RateLimiterExecutor;

	private readonly _pendingSyncs = new Map<string, { promise: Promise<void>; resolve: () => void }>();
	private readonly _getStoreKey: KeyResolver;
	private readonly _generateId: IdGenerator;
	private readonly _extractLimitInfo: HttpLimitInfoExtractor<TResponse>;
	private readonly _defaultLimitBehavior: LimitBehavior;
	private readonly _maxWaitMs: number | undefined;
	private readonly _fallbackResetDelayMs: number;

	private _isDestroyed = false;

	constructor(options: HttpResponseBasedLimiterOptions<TResponse>) {
		this._logger = createLogger({ context: new.target.name, minLevel: 'WARNING', ...options.loggerOptions });
		this._clock = options.clock ?? defaultClock;
		this._store = options.store ?? new InMemoryStateStore<HttpResponseBasedLimiterState>(this._clock);
		this._executor = new RateLimiterExecutor(this._logger, this._clock, options.queue);

		this._getStoreKey =
			typeof options.key === 'function'
				? options.key
				: (key?: string): string => (key ? `limiter:${key}` : 'limiter');
		this._generateId = options.idGenerator ?? generateRandomString;

		this._extractLimitInfo = options.limitInfoExtractor;
		this._defaultLimitBehavior = options.limitBehavior ?? 'reject';
		this._maxWaitMs = options.queue?.maxWaitMs;
		this._fallbackResetDelayMs = options.fallbackResetDelayMs ?? 60_000;
	}

	public async getStatus(key?: string): Promise<HttpResponseBasedLimiterStatus> {
		const storeKey = this._getStoreKey(key);
		const state = await this._store.get(storeKey);

		if (state?.isUnlimited) {
			return {
				isProbing: false,
				isUnlimited: true,
				lastKnownLimit: null,
				lastKnownRemaining: null,
				lastKnownResetAt: null,
				lastSyncedAt: state.lastSyncedAt,
			};
		}

		return {
			isProbing: state?.isProbing ?? false,
			isUnlimited: false,
			lastKnownLimit: state?.lastKnownLimit ?? null,
			lastKnownRemaining: state?.lastKnownRemaining ?? null,
			lastKnownResetAt: state?.lastKnownResetAt ?? null,
			lastSyncedAt: state?.lastSyncedAt ?? null,
		};
	}

	public async run<T = TResponse>(fn: () => T | Promise<T>, options: HttpHeadersLimiterRunOptions = {}): Promise<T> {
		const ctx: RequestContext = {
			id: options.id ?? this._generateId(),
			key: this._getStoreKey(options.key),
			signal: options.signal,
			startedAt: 0,
			isProbing: false,
		};

		this._ensureCanExecute(ctx);

		const { priority, limitBehavior, maxWaitMs } = options;
		const finalLimitBehavior = limitBehavior ?? this._defaultLimitBehavior;
		const finalMaxWaitMs = maxWaitMs ?? this._maxWaitMs;
		const expiresAt = finalMaxWaitMs ? this._clock.now() + finalMaxWaitMs : undefined;

		let currentRunAt = this._clock.now();

		while (true) {
			this._ensureCanExecute(ctx, priority);

			if (ctx.signal?.aborted) {
				throw new RateLimitError(RateLimitErrorCode.Cancelled);
			}

			try {
				return await this._executor.execute<T>(() => this._executeSingleRequest<T>(fn, ctx), currentRunAt, {
					id: ctx.id,
					key: ctx.key,
					expiresAt,
					priority,
					signal: ctx.signal,
				});
			} catch (e) {
				if (e instanceof RateLimitError && e.code === RateLimitErrorCode.LimitExceeded) {
					if (finalLimitBehavior === 'reject') {
						throw e;
					}

					currentRunAt = e.retryAt ?? this._clock.now() + this._fallbackResetDelayMs;

					this._shouldLogDebug &&
						this._logger.debug(`[REQUEUE] [id: ${ctx.id}, key: ${ctx.key}] - Requeued to ${currentRunAt}`);

					continue;
				}

				throw e;
			}
		}
	}

	public async clear(key?: string): Promise<void> {
		this._executor.clear();
		const storeKey = this._getStoreKey(key);

		await this._store.acquireLock?.(storeKey);

		try {
			await this._store.delete(storeKey);
		} finally {
			await this._store.releaseLock?.(storeKey);
		}
	}

	public async destroy(): Promise<void> {
		if (this._isDestroyed) {
			return;
		}

		this._isDestroyed = true;
		this._executor.clear();

		for (const pending of this._pendingSyncs.values()) {
			pending.resolve();
		}

		this._pendingSyncs.clear();

		await this._store.destroy?.();
	}

	private get _shouldLogDebug(): boolean {
		return this._logger.minLevel >= LogLevel.DEBUG;
	}

	private async _executeSingleRequest<T>(fn: () => T | Promise<T>, ctx: RequestContext): Promise<T> {
		while (true) {
			await this._waitForSync(ctx);

			ctx.startedAt = this._clock.now();
			const action = await this._reserveLocalToken(ctx);

			if (action === TokenReservationAction.Wait) {
				continue;
			}

			ctx.isProbing = action === TokenReservationAction.Probe;
			break;
		}

		try {
			let response: TResponse | null = null;
			let responseError: Error | null = null;

			try {
				response = (await fn()) as TResponse;
			} catch (e) {
				responseError = sanitizeError(e);
			}

			const extractFinishedAt = this._clock.now();
			const limitInfo = this._extractLimitInfo(response, responseError, extractFinishedAt);

			await this._processLimitHeaders(ctx, limitInfo, responseError, extractFinishedAt);

			if (responseError) {
				throw responseError;
			}

			return response as T;
		} finally {
			if (ctx.isProbing) {
				this._resolvePendingSync(ctx);
			}
		}
	}

	private async _waitForSync(ctx: RequestContext): Promise<void> {
		while (this._pendingSyncs.has(ctx.key)) {
			if (ctx.signal?.aborted) {
				throw new RateLimitError(RateLimitErrorCode.Cancelled);
			}

			const pending = this._pendingSyncs.get(ctx.key);

			if (!pending) {
				break;
			}

			this._shouldLogDebug &&
				this._logger.debug(`[WAIT] [id: ${ctx.id}, key: ${ctx.key}] - Waiting for probe to sync state`);

			await new Promise<void>((resolve, reject) => {
				const onAbort = (): void => reject(new RateLimitError(RateLimitErrorCode.Cancelled));

				if (ctx.signal) {
					ctx.signal.addEventListener('abort', onAbort, { once: true });
				}

				void pending.promise.then(() => {
					if (ctx.signal) {
						ctx.signal.removeEventListener('abort', onAbort);
					}

					resolve();
				});
			});
		}
	}

	private async _reserveLocalToken(ctx: RequestContext): Promise<TokenReservationAction> {
		await this._store.acquireLock?.(ctx.key);

		try {
			const state = await this._store.get(ctx.key);

			if (state?.isUnlimited) {
				return TokenReservationAction.Follow;
			}

			const lastKnownRemaining = state?.lastKnownRemaining ?? null;
			const lastKnownResetAt = state?.lastKnownResetAt ?? Infinity;
			const lastKnownLimit = state?.lastKnownLimit ?? 1;

			const hasLocalProbe = this._pendingSyncs.has(ctx.key);

			if (!state || ctx.startedAt >= lastKnownResetAt) {
				this._setupLocalProbeLock(ctx.key);

				const probeState: HttpResponseBasedLimiterState = {
					isProbing: true,
					isUnlimited: false,
					lastKnownLimit,
					lastKnownRemaining: 0,
					lastKnownResetAt: ctx.startedAt + this._fallbackResetDelayMs,
					lastSyncedAt: ctx.startedAt,
				};

				await this._store.set(ctx.key, probeState, this._fallbackResetDelayMs);

				this._shouldLogDebug &&
					this._logger.debug(
						`[PROBE] [id: ${ctx.id}, key: ${ctx.key}] - Probing API for limits - ${this._getDebugStateString(probeState)}`,
					);

				return TokenReservationAction.Probe;
			}

			if (state.isProbing) {
				if (hasLocalProbe) {
					return TokenReservationAction.Wait;
				}

				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, lastKnownResetAt);
			}

			if (lastKnownRemaining !== null && lastKnownRemaining <= 0) {
				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, lastKnownResetAt);
			}

			const newState: HttpResponseBasedLimiterState = {
				isProbing: false,
				isUnlimited: state.isUnlimited,
				lastKnownLimit,
				lastKnownRemaining: (lastKnownRemaining ?? 1) - 1,
				lastKnownResetAt,
				lastSyncedAt: state.lastSyncedAt,
			};

			const ttl = Math.max(1000, lastKnownResetAt - ctx.startedAt);
			await this._store.set(ctx.key, newState, ttl);

			this._shouldLogDebug &&
				this._logger.debug(
					`[RSRV] [id: ${ctx.id}, key: ${ctx.key}] - Local state - ${this._getDebugStateString(newState)}`,
				);

			return TokenReservationAction.Follow;
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}
	}

	private _setupLocalProbeLock(key: string): void {
		if (!this._pendingSyncs.has(key)) {
			let resolveSync!: () => void;

			const promise = new Promise<void>(resolve => {
				resolveSync = resolve;
			});

			this._pendingSyncs.set(key, { promise, resolve: resolveSync });
		}
	}

	private _resolvePendingSync(ctx: RequestContext): void {
		const pending = this._pendingSyncs.get(ctx.key);

		if (pending) {
			this._shouldLogDebug && this._logger.debug(`[UNLOCK] [id: ${ctx.id}, key: ${ctx.key}] - Probing completed`);

			pending.resolve();
			this._pendingSyncs.delete(ctx.key);
		}
	}

	private async _processLimitHeaders(
		ctx: RequestContext,
		limitInfo: HttpLimitInfo | null,
		responseError: Error | null,
		extractFinishedAt: number,
	): Promise<void> {
		if (limitInfo) {
			await this._syncStateWithServer(ctx, limitInfo, extractFinishedAt);

			if (limitInfo.statusCode === TOO_MANY_REQUESTS_ERROR_CODE) {
				const resetAt = limitInfo.resetAt ?? 0;
				const retryAt = extractFinishedAt >= resetAt ? extractFinishedAt + this._fallbackResetDelayMs : resetAt;

				throw new RateLimitError(RateLimitErrorCode.LimitExceeded, retryAt);
			}
		} else if (responseError) {
			if (ctx.isProbing) {
				await this._rollbackProbingState(ctx);
			}
		} else {
			await this._setUnlimited(ctx, extractFinishedAt);
		}
	}

	private async _rollbackProbingState(ctx: RequestContext): Promise<void> {
		await this._store.acquireLock?.(ctx.key);

		try {
			const state = await this._store.get(ctx.key);

			if (state?.isProbing) {
				await this._store.delete(ctx.key);

				this._shouldLogDebug &&
					this._logger.debug(
						`[ROLLBACK] [id: ${ctx.id}, key: ${ctx.key}] - Probing failed, state cleared for next follower`,
					);
			}
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}
	}

	private async _syncStateWithServer(ctx: RequestContext, info: Partial<HttpLimitInfo>, now: number): Promise<void> {
		await this._store.acquireLock?.(ctx.key);

		try {
			const currentState = await this._store.get(ctx.key);

			if (currentState && (currentState.lastSyncedAt ?? 0) > ctx.startedAt) {
				this._shouldLogDebug &&
					this._logger.trace(
						`[SYNC SKIP] [id: ${ctx.id}, key: ${ctx.key}] - Newer request already updated state - ${this._getDebugStateString(currentState)}`,
					);
				return;
			}

			const actualResetAt =
				info.resetAt ??
				(currentState?.isProbing ? undefined : currentState?.lastKnownResetAt) ??
				now + this._fallbackResetDelayMs;
			const isExhausted = info.statusCode === TOO_MANY_REQUESTS_ERROR_CODE || info.remaining === 0;

			const newState: HttpResponseBasedLimiterState = {
				isProbing: false,
				isUnlimited: false,
				lastKnownLimit: info.limit ?? currentState?.lastKnownLimit ?? 1,
				lastKnownRemaining: isExhausted ? 0 : (info.remaining ?? currentState?.lastKnownRemaining ?? 1),
				lastKnownResetAt: actualResetAt,
				lastSyncedAt: ctx.startedAt,
			};

			const ttl = Math.max(1000, actualResetAt - now + 60_000);
			await this._store.set(ctx.key, newState, ttl);

			this._shouldLogDebug &&
				this._logger.debug(`[SYNC] [id: ${ctx.id}, key: ${ctx.key}] - ${this._getDebugStateString(newState)}`);
		} catch (e) {
			this._logger.error(`[ERR] [id: ${ctx.id}, key: ${ctx.key}] - Failed to sync state with server limits}`, e);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}
	}

	private async _setUnlimited(ctx: RequestContext, now: number): Promise<void> {
		await this._store.acquireLock?.(ctx.key);

		try {
			const currentState = await this._store.get(ctx.key);

			if (currentState && (currentState.lastSyncedAt ?? 0) > ctx.startedAt) {
				this._shouldLogDebug &&
					this._logger.debug(
						`[SYNC SKIP] [id: ${ctx.id}, key: ${ctx.key}] - Newer request already updated state - ${this._getDebugStateString(currentState)}`,
					);
				return;
			}

			const ttl = this._fallbackResetDelayMs;
			const unlimitedState: HttpResponseBasedLimiterState = {
				isProbing: false,
				isUnlimited: true,
				lastKnownLimit: null,
				lastKnownRemaining: null,
				lastKnownResetAt: now + ttl,
				lastSyncedAt: ctx.startedAt,
			};
			await this._store.set(ctx.key, unlimitedState, ttl);

			this._shouldLogDebug &&
				this._logger.debug(
					`[UNLM] [id: ${ctx.id}, key: ${ctx.key}] - Set to unlimited - ${this._getDebugStateString(unlimitedState)}`,
				);
		} finally {
			await this._store.releaseLock?.(ctx.key);
		}
	}

	private _ensureCanExecute(ctx: RequestContext, priority?: Priority): void {
		if (this._isDestroyed) {
			throw new RateLimiterDestroyedError();
		}

		if (this._executor.isQueueFull) {
			this._shouldLogDebug &&
				this._logger.debug(
					`[DROP OVERFLOW] [id: ${ctx.id}, key: ${ctx.key}] - prt: ${priority ?? Priority.Normal} | q: ${this._executor.queueSize}/${this._executor.queueCapacity}`,
				);

			throw new RateLimitError(RateLimitErrorCode.QueueOverflow);
		}
	}

	private _getDebugStateString(state: HttpResponseBasedLimiterState): string {
		return `probe: ${state.isProbing}, unl: ${state.isUnlimited}, lim: ${state.lastKnownLimit}, rem: ${state.lastKnownRemaining}, rst: ${state.lastKnownResetAt}, sync: ${state.lastSyncedAt}`;
	}
}
