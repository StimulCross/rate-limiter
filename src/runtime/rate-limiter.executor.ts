import { BinaryHeap } from '@stimulcross/ds-binary-heap';
import { PolicyPriorityQueue, type Priority, type SelectionPolicy } from '@stimulcross/ds-policy-priority-queue';
import { type Logger, LogLevel } from '@stimulcross/logger';
import { ExecutionTickets } from './execution-tickets.js';
import { Semaphore } from './semaphore.js';
import { Task } from './task.js';
import { type Clock } from '../core/clock.js';
import { RateLimitErrorCode } from '../enums/rate-limit-error-code.js';
import { RateLimitError } from '../errors/rate-limit.error.js';

/** @internal */
export interface RateLimiterExecutionOptions {
	id: string;
	key: string;
	expiresAt?: number;
	priority?: number;
	signal?: AbortSignal;
	shouldForceEnqueue?: boolean;
}

/** @internal */
export interface RateLimiterExecutorQueueOptions {
	concurrency?: number;
	capacity?: number;
	selectionPolicy?: SelectionPolicy;
	signal?: AbortSignal;
}

/** @internal */
export class RateLimiterExecutor {
	private readonly _clock: Clock;
	private readonly _tickets = new ExecutionTickets();
	private readonly _semaphore: Semaphore;
	private readonly _queue: PolicyPriorityQueue<Task>;
	private readonly _expiryHeap = new BinaryHeap<Task>((a: Task, b: Task): number => a.expiresAt! - b.expiresAt!);

	private _drainTimer: ReturnType<typeof setTimeout> | null = null;
	private _expiryTimer: ReturnType<typeof setTimeout> | null = null;
	private _nextExpiryScheduledAt: number | null = null;

	constructor(
		private readonly _logger: Logger,
		clock: Clock,
		{ concurrency, capacity, selectionPolicy }: RateLimiterExecutorQueueOptions = {},
	) {
		this._clock = clock;
		this._semaphore = new Semaphore(concurrency ?? null);
		this._queue = new PolicyPriorityQueue<Task>({
			capacity,
			selectionPolicy: selectionPolicy as SelectionPolicy<Task> | undefined,
		});
	}

	public get isQueueFull(): boolean {
		return this._queue.isFull;
	}

	public get queueSize(): number {
		return this._queue.size;
	}

	public get queueCapacity(): number {
		return this._queue.capacity;
	}

	public async execute<T>(fn: () => T | Promise<T>, runAt: number, options: RateLimiterExecutionOptions): Promise<T> {
		const task = new Task<T>(fn, options);

		task.isCancellable &&
			task.onAbort(() => {
				this._shouldPrintDebug &&
					this._logger.debug(
						`[DROP CANCELLED] [id: ${options.id}, key: ${options.key}] - ${this._getStateDebugString(task.priority)}`,
					);

				this._tickets.dropLast();

				const priorityQueue = this._queue.getQueue(task.priority);
				priorityQueue.remove(task);

				this._drain();
			});

		const isEnqueued = this._queue.enqueue(task, task.priority, options.shouldForceEnqueue);

		if (!isEnqueued) {
			this._shouldPrintDebug &&
				this._logger.debug(
					`[DROP OVERFLOW] [id: ${options.id}, key: ${options.key}] - ${this._getStateDebugString(task.priority)}`,
				);

			throw new RateLimitError(RateLimitErrorCode.QueueOverflow);
		}

		this._tickets.add(runAt);

		if (task.expiresAt !== undefined) {
			this._expiryHeap.push(task);
		}

		this._shouldPrintDebug &&
			this._logger.debug(
				`↓ [ENQ] [id: ${options.id}, key: ${options.key}] - ${this._getStateDebugString(task.priority)}`,
			);

		this._drain();

		return await task;
	}

	public clear(): void {
		this._clearDrainTimer();
		this._clearExpiryTimer();
		this._tickets.clear();
		this._expiryHeap.clear();

		const pendingTasks = this._drainRemainingTasks();

		if (pendingTasks.length === 0) {
			return;
		}

		for (const task of pendingTasks) {
			this._shouldPrintDebug &&
				this._logger.debug(
					`[DROP CLEAR] [id: ${task.id}, key: ${task.key}] - Destroy due to clear() - ${this._getStateDebugString(task.priority)}`,
				);

			task.destroy();
			task.reject(new RateLimitError(RateLimitErrorCode.Destroyed));
		}
	}

	private get _shouldPrintDebug(): boolean {
		return this._logger.minLevel >= LogLevel.DEBUG;
	}

	private _drain(): void {
		const now = this._clock.now();
		const expiredTasks = this._extractExpiredTasks(now);

		for (const task of expiredTasks) {
			this._shouldPrintDebug &&
				this._logger.debug(
					`[DROP EXPIRED] [id: ${task.id}, key: ${task.key}] - ${this._getStateDebugString(task.priority)}`,
				);

			this._tickets.dropLast();
			task.destroy();
			task.reject(new RateLimitError(RateLimitErrorCode.Expired));
		}

		this._recalibrateExpiryTimer(now);

		while (!this._queue.isEmpty) {
			const nextTicketAt = this._tickets.peek();

			if (nextTicketAt !== undefined && nextTicketAt > now) {
				this._scheduleDrainTimer(nextTicketAt - now);
				return;
			}

			const isAcquired = this._semaphore.acquire();

			if (!isAcquired) {
				return;
			}

			const task = this._queue.dequeue();

			if (!task) {
				this._semaphore.release();
				return;
			}

			task.destroy();
			this._tickets.consume();

			this._shouldPrintDebug &&
				this._logger.debug(
					`↑ [DEQ] [id: ${task.id}, key: ${task.key}] - ${this._getStateDebugString(task.priority)}`,
				);

			void task.run().finally(() => {
				this._semaphore.release();
				queueMicrotask(() => this._drain());
			});
		}
	}

	private _getNextExpiryTimestamp(): number | null {
		while (!this._expiryHeap.isEmpty) {
			const task = this._expiryHeap.peek()!;

			if (!task.isActive) {
				this._expiryHeap.pop();
				continue;
			}

			return task.expiresAt!;
		}

		return null;
	}

	private _extractExpiredTasks(now: number): Task[] {
		const result: Task[] = [];

		while (!this._expiryHeap.isEmpty) {
			const task = this._expiryHeap.peek()!;

			if (!task.isActive) {
				this._expiryHeap.pop();
				continue;
			}

			if (task.expiresAt! > now) {
				break;
			}

			this._expiryHeap.pop();

			const priorityQueue = this._queue.getQueue(task.priority);
			priorityQueue.remove(task);
			result.push(task);
		}

		return result;
	}

	private _drainRemainingTasks(): Task[] {
		const remaining: Task[] = [];

		for (const queue of this._queue.queues()) {
			while (!queue.isEmpty) {
				const task = queue.dequeue()!;
				remaining.push(task);
			}
		}

		return remaining;
	}

	private _scheduleDrainTimer(delayMs: number): void {
		if (this._drainTimer) {
			return;
		}

		this._drainTimer = setTimeout(() => {
			this._clearDrainTimer();
			this._drain();
		}, delayMs);
	}

	private _recalibrateExpiryTimer(now: number): void {
		const nextExpiry = this._getNextExpiryTimestamp();

		if (nextExpiry === null) {
			this._clearExpiryTimer();
			this._nextExpiryScheduledAt = null;

			return;
		}

		if (this._nextExpiryScheduledAt === nextExpiry) {
			return;
		}

		this._clearExpiryTimer();

		const delay = Math.max(0, nextExpiry - now);

		this._nextExpiryScheduledAt = nextExpiry;
		this._expiryTimer = setTimeout(() => {
			this._clearExpiryTimer();
			this._drain();
		}, delay);
	}

	private _clearDrainTimer(): void {
		if (this._drainTimer) {
			clearTimeout(this._drainTimer);
			this._drainTimer = null;
		}
	}

	private _clearExpiryTimer(): void {
		if (this._expiryTimer) {
			clearTimeout(this._expiryTimer);
			this._expiryTimer = null;
		}
	}

	private _getStateDebugString(priority: Priority): string {
		return `prt: ${priority} | q: ${this._queue.size}/${this._queue.capacity}`;
	}
}
