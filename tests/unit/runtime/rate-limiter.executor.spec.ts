import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { createLogger } from '@stimulcross/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Clock, RateLimitError, RateLimitErrorCode } from '../../../src/index.js';
import { RateLimiterExecutor } from '../../../src/runtime/rate-limiter.executor.js';

const defaultOpts = { id: 'task-1', key: 'key-1' };

describe('RateLimiterExecutor', () => {
	const logger = createLogger('test');
	let clock: Clock;
	let executor: RateLimiterExecutor;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1000);

		clock = { now: () => Date.now() };
		executor = new RateLimiterExecutor(logger, clock);
	});

	afterEach(() => {
		executor.clear();
		vi.useRealTimers();
	});

	describe('Properties & State', () => {
		it('should expose correct queue state and capacity', () => {
			executor = new RateLimiterExecutor(logger, clock, { capacity: 10 });

			expect(executor.queueSize).toBe(0);
			expect(executor.queueCapacity).toBe(10);
			expect(executor.isQueueFull).toBe(false);
		});
	});

	describe('Execution & Delay', () => {
		it('should execute a task successfully', async () => {
			const task = vi.fn().mockResolvedValue('result');
			const promise = executor.execute(task, clock.now(), defaultOpts);

			await vi.runAllTimersAsync();

			await expect(promise).resolves.toBe('result');
			expect(task).toHaveBeenCalledOnce();
		});

		it('should reject if the task throws an error', async () => {
			const error = new Error('Task failed');
			const task = vi.fn().mockRejectedValue(error);

			const promise = executor.execute(task, clock.now(), defaultOpts);
			promise.catch(() => {});

			await vi.runAllTimersAsync();

			await expect(promise).rejects.toThrow(error);
		});

		it('should delay task execution until the specified runAt timestamp', async () => {
			const task = vi.fn().mockResolvedValue('result');
			const runAt = clock.now() + 500;

			const promise = executor.execute(task, runAt, defaultOpts);

			await vi.advanceTimersByTimeAsync(499);
			expect(task).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1);
			await expect(promise).resolves.toBe('result');
			expect(task).toHaveBeenCalledOnce();
		});

		it('should execute tasks in order of their priority', async () => {
			executor = new RateLimiterExecutor(logger, clock, { concurrency: 1 });

			const executionOrder: number[] = [];
			let resolveBlocker: () => void;
			const blocker = vi.fn(
				() =>
					new Promise<void>(res => {
						resolveBlocker = res;
					}),
			);

			executor.execute(blocker, clock.now(), { id: 'blocker', key: 'blocker-key' }).catch(() => {});

			executor
				.execute(
					async () => {
						executionOrder.push(1);
					},
					clock.now(),
					{ id: 'task-low', key: 'key-low', priority: Priority.Low },
				)
				.catch(() => {});
			executor
				.execute(
					async () => {
						executionOrder.push(2);
					},
					clock.now(),
					{ id: 'task-high', key: 'key-high', priority: Priority.High },
				)
				.catch(() => {});
			executor
				.execute(
					async () => {
						executionOrder.push(3);
					},
					clock.now(),
					{ id: 'task-normal', key: 'key-normal', priority: Priority.Normal },
				)
				.catch(() => {});

			await vi.advanceTimersByTimeAsync(0);

			resolveBlocker!();
			await vi.runAllTimersAsync();

			expect(executionOrder).toEqual([2, 3, 1]);
		});
	});

	describe('Concurrency', () => {
		it('should limit the number of concurrent executions', async () => {
			executor = new RateLimiterExecutor(logger, clock, { concurrency: 1 });

			let resolveTask1: () => void;
			const task1 = vi.fn(
				() =>
					new Promise<void>(res => {
						resolveTask1 = res;
					}),
			);
			const task2 = vi.fn().mockResolvedValue('task2');

			const promise1 = executor.execute(task1, clock.now(), { id: 't1', key: 'k1' });
			const promise2 = executor.execute(task2, clock.now(), { id: 't2', key: 'k2' });

			await vi.advanceTimersByTimeAsync(0);

			expect(task1).toHaveBeenCalledOnce();
			expect(task2).not.toHaveBeenCalled();

			resolveTask1!();
			await vi.advanceTimersByTimeAsync(0);

			await promise1;
			await expect(promise2).resolves.toBe('task2');
			expect(task2).toHaveBeenCalledOnce();
		});
	});

	describe('Cancellation', () => {
		it('should abort a queued task and remove it from execution queue', async () => {
			const task = vi.fn();
			const controller = new AbortController();

			const promise = executor.execute(task, clock.now() + 1000, {
				...defaultOpts,
				signal: controller.signal,
			});

			controller.abort();

			await expect(promise).rejects.toThrow(RateLimitError);
			await expect(promise).rejects.toMatchObject({
				code: RateLimitErrorCode.Cancelled,
			});

			expect(task).not.toHaveBeenCalled();
		});
	});

	describe('Expiration', () => {
		it('should reject tasks that expire before they can be executed', async () => {
			const task = vi.fn();
			const runAt = clock.now() + 1000;
			const expiresAt = clock.now() + 500;

			const promise = executor.execute(task, runAt, { ...defaultOpts, expiresAt });
			promise.catch(() => {});

			await vi.advanceTimersByTimeAsync(500);

			await expect(promise).rejects.toMatchObject({
				code: RateLimitErrorCode.Expired,
			});

			expect(task).not.toHaveBeenCalled();
		});

		it('should expire tasks waiting in queue due to concurrency limits', async () => {
			executor = new RateLimiterExecutor(logger, clock, { concurrency: 1 });

			let resolveTask1: () => void;
			const task1 = vi.fn(
				() =>
					new Promise<void>(res => {
						resolveTask1 = res;
					}),
			);
			const task2 = vi.fn();

			const promise1 = executor.execute(task1, clock.now(), { id: 't1', key: 'k1' });
			const promise2 = executor.execute(task2, clock.now(), {
				id: 't2',
				key: 'k2',
				expiresAt: clock.now() + 500,
			});
			promise2.catch(() => {});

			await vi.advanceTimersByTimeAsync(500);

			await expect(promise2).rejects.toMatchObject({
				code: RateLimitErrorCode.Expired,
			});

			expect(task2).not.toHaveBeenCalled();

			resolveTask1!();
			await promise1;
		});

		it('should handle multiple tasks with different expiration times', async () => {
			const runAt = clock.now() + 5000;
			const taskLong = vi.fn();
			const taskShort = vi.fn();

			const promiseLong = executor.execute(taskLong, runAt, {
				id: 't-long',
				key: 'k-long',
				expiresAt: clock.now() + 2000,
			});
			promiseLong.catch(() => {});

			const promiseShort = executor.execute(taskShort, runAt, {
				id: 't-short',
				key: 'k-short',
				expiresAt: clock.now() + 1000,
			});
			promiseShort.catch(() => {});

			await vi.advanceTimersByTimeAsync(1000);
			await expect(promiseShort).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });
			expect(taskLong).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(1000);
			await expect(promiseLong).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });
		});
	});

	describe('Tickets Shifting', () => {
		it('should shift the execution ticket when a queued task is cancelled', async () => {
			executor = new RateLimiterExecutor(logger, clock, { concurrency: 1 });
			const executionTimes: Record<string, number> = {};

			const task1 = vi.fn().mockImplementation(() => {
				executionTimes.task1 = clock.now();
			});
			const task2 = vi.fn().mockImplementation(() => {
				executionTimes.task2 = clock.now();
			});
			const task3 = vi.fn().mockImplementation(() => {
				executionTimes.task3 = clock.now();
			});

			const controller2 = new AbortController();

			executor.execute(task1, clock.now() + 100, { id: 't1', key: 'k1' }).catch(() => {});
			const promise2 = executor.execute(task2, clock.now() + 200, {
				id: 't2',
				key: 'k2',
				signal: controller2.signal,
			});
			promise2.catch(() => {});
			executor.execute(task3, clock.now() + 300, { id: 't3', key: 'k3' }).catch(() => {});

			controller2.abort();

			await vi.advanceTimersByTimeAsync(100);
			expect(task1).toHaveBeenCalledOnce();
			expect(executionTimes.task1).toBe(1100);
			await expect(promise2).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled });

			await vi.advanceTimersByTimeAsync(100);

			expect(task2).not.toHaveBeenCalled();
			expect(task3).toHaveBeenCalledOnce();
			// task3 took task2 200ms ticket
			expect(executionTimes.task3).toBe(1200);
		});

		it('should shift the execution ticket when a queued task expires', async () => {
			executor = new RateLimiterExecutor(logger, clock, { concurrency: 1 });
			const executionTimes: Record<string, number> = {};

			const task1 = vi.fn().mockImplementation(() => {
				executionTimes.task1 = clock.now();
			});
			const task2 = vi.fn().mockImplementation(() => {
				executionTimes.task2 = clock.now();
			});
			const task3 = vi.fn().mockImplementation(() => {
				executionTimes.task3 = clock.now();
			});

			executor.execute(task1, clock.now() + 100, { id: 't1', key: 'k1' }).catch(() => {});
			const promise2 = executor.execute(task2, clock.now() + 200, {
				id: 't2',
				key: 'k2',
				expiresAt: clock.now() + 50,
			});
			promise2.catch(() => {});
			executor.execute(task3, clock.now() + 300, { id: 't3', key: 'k3' }).catch(() => {});

			await vi.advanceTimersByTimeAsync(50);
			expect(task1).not.toHaveBeenCalled();
			await expect(promise2).rejects.toMatchObject({ code: RateLimitErrorCode.Expired });

			await vi.advanceTimersByTimeAsync(50);
			expect(task1).toHaveBeenCalledOnce();
			expect(executionTimes.task1).toBe(1100);

			await vi.advanceTimersByTimeAsync(100);

			expect(task2).not.toHaveBeenCalled();
			expect(task3).toHaveBeenCalledOnce();
			// task3 took task2 200ms ticket
			expect(executionTimes.task3).toBe(1200);
		});
	});

	describe('Clear & Teardown', () => {
		it('should reject all pending tasks with Destroyed error when cleared', async () => {
			const task = vi.fn();
			const promise = executor.execute(task, clock.now() + 1000, defaultOpts);

			executor.clear();

			await expect(promise).rejects.toMatchObject({
				code: RateLimitErrorCode.Destroyed,
			});

			expect(task).not.toHaveBeenCalled();
		});

		it('should handle clearing an empty queue gracefully', () => {
			expect(() => executor.clear()).not.toThrow();
		});
	});
});
