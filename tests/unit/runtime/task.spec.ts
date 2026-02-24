import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { describe, expect, it, vi } from 'vitest';
import { RateLimitError, RateLimitErrorCode } from '../../../src/index.js';
import { Task } from '../../../src/runtime/task.js';

const defaultOpts = { id: 'task-1', key: 'key-1' };

describe('Task', () => {
	describe('Initialization', () => {
		it('should initialize with default values', () => {
			const task = new Task(() => 'test', defaultOpts);

			expect(task.id).toBe('task-1');
			expect(task.key).toBe('key-1');
			expect(task.priority).toBe(Priority.Normal);
			expect(task.expiresAt).toBeUndefined();
			expect(task.isActive).toBe(true);
			expect(task.isAborted).toBe(false);
			expect(task.isCancellable).toBe(false);
		});

		it('should initialize with provided options', () => {
			const task = new Task(() => 'test', {
				...defaultOpts,
				priority: Priority.High,
				expiresAt: 1000,
			});

			expect(task.priority).toBe(Priority.High);
			expect(task.expiresAt).toBe(1000);
		});

		it('should be cancellable when initialized with an abort signal', () => {
			const controller = new AbortController();
			const task = new Task(() => 'test', { ...defaultOpts, signal: controller.signal });

			expect(task.isCancellable).toBe(true);
		});
	});

	describe('Execution', () => {
		it('should resolve the promise when the task completes successfully', async () => {
			const taskFn = vi.fn().mockResolvedValue('success');
			const task = new Task(taskFn, defaultOpts);

			await task.run();

			await expect(task).resolves.toBe('success');
			expect(task.isActive).toBe(false);
		});

		it('should reject the promise when the task throws an error', async () => {
			const error = new Error('Task failed');
			const taskFn = vi.fn().mockRejectedValue(error);
			const task = new Task(taskFn, defaultOpts);

			await task.run();

			await expect(task).rejects.toThrow(error);
			expect(task.isActive).toBe(false);
		});

		it('should mark task as inactive immediately when run starts', () => {
			const task = new Task(async () => 'test', defaultOpts);

			void task.run();

			expect(task.isActive).toBe(false);
		});
	});

	describe('Promise API (PromiseLike)', () => {
		it('should support .then() chaining', async () => {
			const task = new Task(() => 'chaining', defaultOpts);

			const promise = task.then(val => `${val}-success`);

			await task.run();

			await expect(promise).resolves.toBe('chaining-success');
		});

		it('should support .catch() chaining', async () => {
			const error = new Error('Fail');
			const task = new Task(() => Promise.reject(error), defaultOpts);

			const promise = task.catch(e => e.message);

			await task.run();

			await expect(promise).resolves.toBe('Fail');
		});

		it('should support .finally() execution', async () => {
			const finallyFn = vi.fn();
			const task = new Task(() => 'test', defaultOpts);

			const promise = task.finally(finallyFn);

			await task.run();
			await promise;

			expect(finallyFn).toHaveBeenCalledOnce();
		});
	});

	describe('State Management', () => {
		it('should allow manual rejection', async () => {
			const task = new Task(() => 'test', defaultOpts);
			const reason = new Error('Manual rejection');

			task.reject(reason);

			expect(task.isActive).toBe(false);
			await expect(task).rejects.toThrow(reason);
		});

		it('should mark task as inactive when destroyed', () => {
			const task = new Task(() => 'test', defaultOpts);

			task.destroy();

			expect(task.isActive).toBe(false);
		});
	});

	describe('Abort Signal Handling', () => {
		it('should abort task, call handler, and reject with RateLimitError when signal triggers', async () => {
			const controller = new AbortController();
			const task = new Task(() => 'test', { ...defaultOpts, signal: controller.signal });
			const abortHandler = vi.fn();

			task.onAbort(abortHandler);
			controller.abort();
			// second call should not trigger handler
			controller.abort();

			expect(task.isAborted).toBe(true);
			expect(task.isActive).toBe(false);
			expect(abortHandler).toHaveBeenCalledOnce();

			await expect(task).rejects.toThrow(RateLimitError);
			await expect(task).rejects.toMatchObject({
				code: RateLimitErrorCode.Cancelled,
				message: 'Aborted by client',
			});
		});

		it('should clean up signal references and event listeners when destroyed', () => {
			const controller = new AbortController();
			const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener');
			const task = new Task(() => 'test', { ...defaultOpts, signal: controller.signal });

			task.destroy();

			expect(task.isCancellable).toBe(false);
			expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function));
		});

		it('should safely destroy even if no abort handler is registered', () => {
			const controller = new AbortController();
			const task = new Task(() => 'test', { ...defaultOpts, signal: controller.signal });

			expect(() => {
				task.destroy();
			}).not.toThrow();
		});

		it('should not call abort handler if destroyed before signal aborts', () => {
			const controller = new AbortController();
			const task = new Task(() => 'test', { ...defaultOpts, signal: controller.signal });
			const abortHandler = vi.fn();

			task.onAbort(abortHandler);
			task.destroy();
			controller.abort();

			expect(abortHandler).not.toHaveBeenCalled();
			expect(task.isAborted).toBe(false);
		});
	});
});
