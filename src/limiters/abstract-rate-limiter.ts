import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { createLogger, type Logger, LogLevel } from '@stimulcross/logger';
import { type Clock } from '../core/clock.js';
import { type RateLimitPolicy } from '../core/rate-limit-policy.js';
import { type RateLimiterStatus } from '../core/rate-limiter-status.js';
import { type RateLimiter } from '../core/rate-limiter.js';
import { type StateStorage } from '../core/state-storage.js';
import { RateLimitErrorCode } from '../enums/rate-limit-error-code.js';
import { RateLimitError } from '../errors/rate-limit.error.js';
import { RateLimiterDestroyedError } from '../errors/rate-limiter-destroyed.error.js';
import { type IdGenerator, type KeyResolver, type RateLimiterOptions } from '../interfaces/rate-limiter-options.js';
import { type RateLimiterRunOptions } from '../interfaces/rate-limiter-run-options.js';
import { defaultClock } from '../runtime/default-clock.js';
import { InMemoryStateStore } from '../runtime/in-memory-state-store.js';
import { RateLimiterExecutor } from '../runtime/rate-limiter.executor.js';
import { type LimitBehavior } from '../types/limit-behavior.js';
import { generateRandomString } from '../utils/generate-random-string.js';

const DEFAULT_KEY_PREFIX = 'limiter';

/** @internal */
export interface ExecutionContext {
	readonly id: string;
	readonly key: string;
	readonly cost: number;
	readonly limitBehavior?: LimitBehavior;
	readonly priority?: Priority;
	readonly signal?: AbortSignal;
	readonly maxWaitMs?: number;
	readonly shouldForceEnqueue?: boolean;
}

/** @internal */
export abstract class AbstractRateLimiter<
	TState extends object,
	TStatus extends RateLimiterStatus | RateLimiterStatus[],
	TResult = unknown,
> implements RateLimiter<TStatus> {
	protected readonly _logger: Logger;
	protected readonly _clock: Clock;
	protected readonly _store: StateStorage<TState>;
	protected readonly _executor: RateLimiterExecutor;
	protected readonly _getStoreKey: KeyResolver;
	protected readonly _generateId: IdGenerator;

	private _isDestroyed = false;

	protected abstract readonly _policy: RateLimitPolicy<TState, TStatus>;

	protected constructor(options?: RateLimiterOptions<TState>) {
		this._logger = createLogger({ context: new.target.name, minLevel: 'WARNING', ...options?.loggerOptions });
		this._clock = options?.clock ?? defaultClock;
		this._store = options?.store ?? new InMemoryStateStore<TState>(this._clock);
		this._executor = new RateLimiterExecutor(this._logger, this._clock, options?.queue);

		this._getStoreKey =
			options?.key && typeof options.key === 'function'
				? options.key
				: (key?: string): string => (key ? `${DEFAULT_KEY_PREFIX}:${key}` : DEFAULT_KEY_PREFIX);

		this._generateId = options?.idGenerator ?? generateRandomString;
	}

	public async run<T = TResult>(fn: () => T | Promise<T>, options: RateLimiterRunOptions = {}): Promise<T> {
		const ctx: ExecutionContext = {
			id: options.id ?? this._generateId(),
			key: this._getStoreKey(options.key),
			cost: options.cost ?? 1,
			limitBehavior: options.limitBehavior,
			priority: options.priority,
			signal: options.signal,
			maxWaitMs: options.maxWaitMs,
			shouldForceEnqueue: options.shouldForceEnqueue,
		};

		await this._ensureCanExecute(ctx);

		return await this._runInternal<T>(fn, ctx);
	}

	public async getStatus(key?: string): Promise<TStatus> {
		const now = this._clock.now();
		const state = await this._store.get(this._getStoreKey(key));

		return this._policy.getStatus(state ?? this._policy.getInitialState(now), now);
	}

	public async clear(key?: string): Promise<void> {
		this._executor.clear();
		const storeKey = this._getStoreKey(key);

		this._shouldPrintDebug && this._logger.debug(`[CLR] [key: ${storeKey}]`);

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

		this._shouldPrintDebug && this._logger.debug('[KILL] Destroying limiter');

		this._isDestroyed = true;

		this._executor.clear();
		await this._store.destroy?.();
	}

	protected get _shouldPrintDebug(): boolean {
		return this._logger.minLevel >= LogLevel.DEBUG;
	}

	protected abstract _runInternal<T = TResult>(fn: () => T | Promise<T>, ctx: ExecutionContext): Promise<T>;

	protected async _execute<T = TResult>(
		fn: () => T | Promise<T>,
		runAt: number,
		storeTtlMs: number,
		ctx: ExecutionContext,
		expiresAt?: number,
	): Promise<T> {
		try {
			await this._ensureCanExecute(ctx);

			return await this._executor.execute<T>(fn, runAt, {
				id: ctx.id,
				key: ctx.key,
				priority: ctx.priority,
				signal: ctx.signal,
				expiresAt,
				shouldForceEnqueue: ctx.shouldForceEnqueue,
			});
		} catch (e) {
			if (this._shouldRevert(e)) {
				await this._store.acquireLock?.(ctx.key);

				try {
					const currentState = await this._store.get(ctx.key);

					if (currentState) {
						const revertedState = this._policy.revert(currentState, ctx.cost, this._clock.now());
						await this._store.set(ctx.key, revertedState, storeTtlMs);

						this._shouldPrintDebug &&
							this._logger.debug(
								`[RVRT] [id: ${ctx.id}, key: ${ctx.key}, cost: ${ctx.cost}] - ${this._getDebugStateString(revertedState)}`,
							);
					}
				} catch (e_) {
					this._logger.error(`[ERR] [id: ${ctx.id}, key: ${ctx.key}, cost: ${ctx.cost}] - Revert failed`, e_);
				} finally {
					await this._store.releaseLock?.(ctx.key);
				}
			}

			throw e;
		}
	}

	protected abstract _getDebugStateString(state: TState): string;

	protected _shouldRevert(e: unknown): boolean {
		return e instanceof RateLimitError && e.code !== RateLimitErrorCode.LimitExceeded;
	}

	private async _ensureCanExecute(ctx: ExecutionContext): Promise<void> {
		if (this._executor.isQueueFull && !ctx.shouldForceEnqueue) {
			this._shouldPrintDebug &&
				this._logger.debug(
					`[DROP OVERFLOW] [id: ${ctx.id}, key: ${ctx.key}] - prt: ${ctx.priority ?? Priority.Normal} | q: ${this._executor.queueSize}/${this._executor.queueCapacity}`,
				);

			let retryAt: number | undefined;
			const state = await this._store.get(this._getStoreKey());

			if (state) {
				const status = this._policy.getStatus(state, this._clock.now());
				retryAt = Array.isArray(status)
					? Math.min(...status.map(s => s.nextAvailableAt))
					: status.nextAvailableAt;
			}

			throw new RateLimitError(RateLimitErrorCode.QueueOverflow, retryAt);
		}

		if (ctx.signal?.aborted) {
			this._logger.debug(
				`[DROP CANCELLED] [id: ${ctx.id}, key: ${ctx.key}] - prt: ${ctx.priority} | q: ${this._executor.queueSize}/${this._executor.queueCapacity}`,
			);

			throw new RateLimitError(RateLimitErrorCode.Cancelled);
		}

		if (this._isDestroyed) {
			this._logger.debug(
				`[DROP DESTROYED] [id: ${ctx.id}, key: ${ctx.key}] - prt: ${ctx.priority ?? Priority.Normal} | q: ${this._executor.queueSize}/${this._executor.queueCapacity}}`,
			);

			throw new RateLimiterDestroyedError();
		}
	}
}
