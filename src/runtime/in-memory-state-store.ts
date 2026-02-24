import { Deque } from '@stimulcross/ds-deque';
import { type Clock } from '../core/clock.js';
import { type StateStorage } from '../core/state-storage.js';
import { RateLimitErrorCode } from '../enums/rate-limit-error-code.js';
import { RateLimitError } from '../errors/rate-limit.error.js';
import { promiseWithResolvers } from '../utils/promise-with-resolvers.js';

interface StateEntry<V> {
	value: V;
	expiresAt?: number;
}

interface Waiter {
	resolve: () => void;
	reject: (err: Error) => void;
}

const CLEANUP_INTERVAL_MS = 60_000;

/** @internal */
export class InMemoryStateStore<V> implements StateStorage<V> {
	private readonly _state = new Map<string, StateEntry<V>>();
	private readonly _activeLocks = new Set<string>();
	private readonly _waitingResolvers = new Map<string, Deque<Waiter>>();

	private readonly _cleanupTimer: ReturnType<typeof setTimeout>;

	constructor(private readonly _clock: Clock) {
		this._cleanupTimer = setInterval(() => {
			const now = this._clock.now();

			for (const [key, entry] of this._state.entries()) {
				if (entry.expiresAt && entry.expiresAt <= now) {
					this._state.delete(key);
				}
			}
		}, CLEANUP_INTERVAL_MS);

		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		if (this._cleanupTimer.unref) {
			this._cleanupTimer.unref();
		}
	}

	public async get(key: string): Promise<V | null> {
		const entry = this._state.get(key);

		if (entry?.expiresAt && entry.expiresAt <= this._clock.now()) {
			this._state.delete(key);
			return null;
		}

		return entry?.value ?? null;
	}

	public async set(key: string, value: V, ttlMs?: number): Promise<void> {
		const entry: StateEntry<V> = { value };

		if (typeof ttlMs === 'number') {
			if (ttlMs <= 0) {
				this._state.delete(key);
				return;
			}

			entry.expiresAt = this._clock.now() + ttlMs;
		}

		this._state.set(key, entry);
	}

	public async delete(key: string): Promise<void> {
		this._state.delete(key);
	}

	public async clear(): Promise<void> {
		this._state.clear();

		const error = new RateLimitError(
			RateLimitErrorCode.Destroyed,
			undefined,
			'Store was cleared or destroyed while waiting for lock',
		);

		for (const queue of this._waitingResolvers.values()) {
			while (queue.size > 0) {
				const waiter = queue.shift();

				if (waiter) {
					waiter.reject(error);
				}
			}
		}

		this._waitingResolvers.clear();
		this._activeLocks.clear();
	}

	public async destroy(): Promise<void> {
		clearInterval(this._cleanupTimer);
		await this.clear();
	}

	public async acquireLock(key: string): Promise<void> {
		if (this._activeLocks.has(key)) {
			const { promise, resolve, reject } = promiseWithResolvers();

			const queue = this._waitingResolvers.get(key) ?? new Deque();
			queue.push({ resolve, reject });
			this._waitingResolvers.set(key, queue);

			await promise;
		} else {
			this._activeLocks.add(key);
		}
	}

	public async releaseLock(key: string): Promise<void> {
		const queue = this._waitingResolvers.get(key);

		if (queue && queue.size > 0) {
			const nextWaiter = queue.shift();

			if (nextWaiter) {
				nextWaiter.resolve();
			}

			if (queue.size === 0) {
				this._waitingResolvers.delete(key);
			}
		} else {
			this._activeLocks.delete(key);
			this._waitingResolvers.delete(key);
		}
	}
}
