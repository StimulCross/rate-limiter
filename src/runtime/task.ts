import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { RateLimitErrorCode } from '../enums/rate-limit-error-code.js';
import { RateLimitError } from '../errors/rate-limit.error.js';
import { promiseWithResolvers } from '../utils/promise-with-resolvers.js';

/** @internal */
export interface TaskOptions {
	id: string;
	key: string;
	priority?: Priority;
	expiresAt?: number;
	signal?: AbortSignal;
}

/** @internal */
export class Task<T = any> implements PromiseLike<T> {
	private readonly _task: () => T | Promise<T>;
	private readonly _promise: Promise<T>;
	private readonly _resolve: (v: T) => void;
	private readonly _reject: (reason?: any) => void;

	private readonly _id: string;
	private readonly _key: string;
	private readonly _priority: Priority;
	private readonly _expiresAt?: number;

	private _signal?: AbortSignal;
	private _abortListener?: () => void;
	private _abortHandler?: () => void;

	private _isActive = true;
	private _isAborted = false;

	constructor(task: () => T | Promise<T>, { id, key, priority = Priority.Normal, expiresAt, signal }: TaskOptions) {
		const { promise, resolve, reject } = promiseWithResolvers<T>();

		this._task = task;
		this._promise = promise;
		this._resolve = resolve;
		this._reject = reject;
		this._id = id;
		this._key = key;
		this._priority = priority;
		this._expiresAt = expiresAt;

		if (signal) {
			this._signal = signal;

			this._abortListener = (): void => {
				this._isActive = false;
				this._isAborted = true;

				this._abortHandler?.();
				this._reject(new RateLimitError(RateLimitErrorCode.Cancelled, undefined, 'Aborted by client'));
				this.destroy();
			};

			this._signal.addEventListener('abort', this._abortListener, { once: true });
		}
	}

	public get id(): string {
		return this._id;
	}

	public get key(): string {
		return this._key;
	}

	public get priority(): Priority {
		return this._priority;
	}

	public get expiresAt(): number | undefined {
		return this._expiresAt;
	}

	public get isActive(): boolean {
		return this._isActive;
	}

	public get isCancellable(): boolean {
		return Boolean(this._signal);
	}

	public get isAborted(): boolean {
		return this._isAborted;
	}

	public async run(): Promise<void> {
		this._isActive = false;

		try {
			const result = await this._task();
			this._resolve(result);
		} catch (e) {
			this._reject(e);
		}
	}

	public reject(reason: unknown): void {
		this._isActive = false;
		this._reject(reason);
	}

	public destroy(): void {
		this._isActive = false;

		if (this._signal && this._abortListener) {
			this._signal.removeEventListener('abort', this._abortListener);

			this._signal = undefined;
			this._abortListener = undefined;
		}

		if (this._abortHandler) {
			this._abortHandler = undefined;
		}
	}

	public onAbort(handler: () => void): void {
		this._abortHandler = handler;
	}

	public then<TResult1 = T, TResult2 = never>(
		onfulfilled?: ((value: T) => PromiseLike<TResult1> | TResult1) | null,
		onrejected?: ((reason: any) => PromiseLike<TResult2> | TResult2) | null,
	): PromiseLike<TResult1 | TResult2> {
		return this._promise.then(onfulfilled, onrejected);
	}

	public catch<TResult = never>(
		onrejected?: ((reason: any) => PromiseLike<TResult> | TResult) | null,
	): PromiseLike<T | TResult> {
		return this._promise.catch(onrejected);
	}

	public finally(onfinally?: (() => void) | null): PromiseLike<T> {
		return this._promise.finally(onfinally);
	}
}
