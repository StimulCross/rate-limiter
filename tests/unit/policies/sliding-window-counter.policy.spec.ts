import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { SlidingWindowCounterPolicy } from '../../../src/limiters/sliding-window-counter/sliding-window-counter.policy.js';

describe('SlidingWindowCounterPolicy', () => {
	describe('Constructor and getters', () => {
		it('should initialize with valid parameters', () => {
			const policy = new SlidingWindowCounterPolicy(10, 1000);
			expect(policy.limit).toBe(10);
			expect(policy.windowMs).toBe(1000);
		});

		it('should throw an error for invalid limit', () => {
			expect(() => new SlidingWindowCounterPolicy(-5, 1000)).toThrow(/Invalid limit/u);
			expect(() => new SlidingWindowCounterPolicy(1.5, 1000)).toThrow(/Invalid limit/u);
			expect(() => new SlidingWindowCounterPolicy(Infinity, 1000)).toThrow(/Invalid limit/u);
		});

		it('should throw an error for invalid windowMs', () => {
			expect(() => new SlidingWindowCounterPolicy(10, 0)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowCounterPolicy(10, -100)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowCounterPolicy(10, 100.5)).toThrow(/Invalid windowMs/u);
			expect(() => new SlidingWindowCounterPolicy(10, Number.NaN)).toThrow(/Invalid windowMs/u);
		});

		it('should return correct initial state', () => {
			const policy = new SlidingWindowCounterPolicy(5, 1000);
			expect(policy.getInitialState()).toEqual({ windowStart: 0, currentCount: 0, previousCount: 0 });
		});
	});

	describe('Get Status', () => {
		const policy = new SlidingWindowCounterPolicy(10, 1000);

		it('should return correct status for empty state', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 500);

			expect(status.limit).toBe(10);
			expect(status.windowMs).toBe(1000);
			expect(status.estimatedCount).toBe(0);
			expect(status.remaining).toBe(10);
			expect(status.nextAvailableAt).toBe(500);
			expect(status.resetAt).toBe(500);
		});

		it('should correctly approximate count based on time into window', () => {
			const state = { windowStart: 0, previousCount: 10, currentCount: 2 };
			const status = policy.getStatus(state, 500);

			expect(status.estimatedCount).toBe(7);
			expect(status.remaining).toBe(3);
			expect(status.resetAt).toBe(2000);
		});

		it('should calculate correct nextAvailableAt within the current window', () => {
			const state = { windowStart: 0, previousCount: 10, currentCount: 0 };
			const status = policy.getStatus(state, 100);

			expect(status.estimatedCount).toBe(9);
			expect(status.nextAvailableAt).toBe(100);
			expect(status.resetAt).toBe(1000);
		});
	});

	describe('Evaluate', () => {
		describe('Immediate execution (Same Window)', () => {
			const policy = new SlidingWindowCounterPolicy(5, 1000);

			it('should allow request when within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ windowStart: 0, previousCount: 0, currentCount: 1 });
			});

			it('should allow request with cost > 1 if within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 3);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState.currentCount).toBe(3);
			});

			it('should deny request when limit is exceeded', () => {
				const state = { windowStart: 0, currentCount: 5, previousCount: 0 };
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1001 });
				expect(result.nextState).toEqual(state);

				const result2 = policy.evaluate(state, 1001, 1);

				expect(result2.decision).toEqual({ kind: 'allow' });
			});

			it('should deny request if cost itself exceeds limit', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 500, 6)).toThrow(InvalidCostError);
			});
		});

		describe('Window Transitions and Approximation', () => {
			const policy = new SlidingWindowCounterPolicy(10, 1000);

			it('should shift current window to previous when exactly one window passes', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 0 };
				const result = policy.evaluate(state, 1000, 1);

				expect(result.decision.kind).toBe('deny');
				expect(result.nextState).toEqual({ windowStart: 1000, currentCount: 0, previousCount: 10 });
			});

			it('should approximate weight correctly based on time into current window', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 0 };
				const allowedResult = policy.evaluate(state, 1250, 3);

				expect(allowedResult.decision.kind).toBe('allow');
				expect(allowedResult.nextState).toEqual({ windowStart: 1000, currentCount: 3, previousCount: 10 });

				const deniedResult = policy.evaluate(state, 1250, 4);
				expect(deniedResult.decision.kind).toBe('deny');
			});

			it('should clear both counters if two or more windows have passed', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 5 };

				const result = policy.evaluate(state, 2500, 5);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ windowStart: 2000, currentCount: 5, previousCount: 0 });
			});

			it('should rotate window state even when a request is denied', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 0 };
				const result = policy.evaluate(state, 1100, 2);

				expect(result.decision.kind).toBe('deny');
				expect(result.nextState).toEqual({ windowStart: 1000, currentCount: 0, previousCount: 10 });
			});

			it('should deny and calculate retryAt accurately within current window', () => {
				const state = { windowStart: 0, previousCount: 10, currentCount: 0 };
				const result = policy.evaluate(state, 100, 4);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 301 });
				expect(result.nextState).toEqual(state);
			});

			it('should deny and calculate retryAt accurately into the next window', () => {
				const state = { windowStart: 0, previousCount: 5, currentCount: 6 };
				const result = policy.evaluate(state, 500, 5);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1001 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new SlidingWindowCounterPolicy(10, 1000);

		describe('Within the same window', () => {
			it('should return unmodified state if cost is zero or negative', () => {
				const state = { windowStart: 1000, currentCount: 5, previousCount: 2 };
				const nextState = policy.revert(state, 0, 1500);

				expect(nextState.currentCount).toBe(5);
			});

			it('should revert cost from currentCount only', () => {
				const state = { windowStart: 1000, currentCount: 5, previousCount: 2 };
				const nextState = policy.revert(state, 3, 1500);

				expect(nextState).toEqual({ windowStart: 1000, currentCount: 2, previousCount: 2 });
			});

			it('should not drop currentCount below zero when reverting', () => {
				const state = { windowStart: 1000, currentCount: 2, previousCount: 5 };
				const nextState = policy.revert(state, 5, 1500);

				expect(nextState).toEqual({ windowStart: 1000, currentCount: 0, previousCount: 5 });
			});
		});

		describe('With time sync (window transitions)', () => {
			it('should sync time and shift window before reverting', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 0 };
				const nextState = policy.revert(state, 2, 1500);

				expect(nextState).toEqual({ windowStart: 1000, currentCount: 0, previousCount: 10 });
			});

			it('should sync time and clear state if multiple windows passed before reverting', () => {
				const state = { windowStart: 0, currentCount: 10, previousCount: 5 };
				const nextState = policy.revert(state, 5, 2500);

				expect(nextState).toEqual({ windowStart: 2000, currentCount: 0, previousCount: 0 });
			});

			it('should never mutate previousCount during revert even after sync', () => {
				const state = { windowStart: 0, currentCount: 5, previousCount: 10 };
				const nextState = policy.revert(state, 5, 1500);

				expect(nextState).toEqual({ windowStart: 1000, currentCount: 0, previousCount: 5 });
			});
		});
	});
});
