import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js';

describe('FixedWindowPolicy', () => {
	describe('Constructor', () => {
		it('should initialize with valid parameters', () => {
			const policy = new FixedWindowPolicy(10, 1000);
			expect(policy.limit).toBe(10);
			expect(policy.windowMs).toBe(1000);
		});

		it('should throw an error for invalid limit', () => {
			expect(() => new FixedWindowPolicy(0, 1000)).toThrow(/Invalid limit/u);
			expect(() => new FixedWindowPolicy(-5, 1000)).toThrow(/Invalid limit/u);
			expect(() => new FixedWindowPolicy(1.5, 1000)).toThrow(/Invalid limit/u);
		});

		it('should throw an error for invalid windowMs', () => {
			expect(() => new FixedWindowPolicy(10, 0)).toThrow(/Invalid windowMs/u);
			expect(() => new FixedWindowPolicy(10, -100)).toThrow(/Invalid windowMs/u);
			expect(() => new FixedWindowPolicy(10, 100.5)).toThrow(/Invalid windowMs/u);
		});

		it('should throw an error for invalid maxReserved', () => {
			expect(() => new FixedWindowPolicy(10, 1000, -5)).toThrow(/Invalid maxReserved/u);
			expect(() => new FixedWindowPolicy(10, 1000, 2.5)).toThrow(/Invalid maxReserved/u);
		});

		it('should return correct initial state', () => {
			const policy = new FixedWindowPolicy(5, 1000);
			expect(policy.getInitialState()).toEqual({ windowStart: 0, used: 0, reserved: 0 });
		});
	});

	describe('Get Status', () => {
		const policy = new FixedWindowPolicy(10, 1000);

		it('should return correct info for empty state', () => {
			const state = policy.getInitialState();
			const status = policy.getStatus(state, 500);

			expect(status.windowStart).toBe(0);
			expect(status.windowEnd).toBe(1000);
			expect(status.used).toBe(0);
			expect(status.reserved).toBe(0);
			expect(status.remaining).toBe(10);
			expect(status.nextAvailableAt).toBe(0);
			expect(status.resetAt).toBe(1000);
		});

		it('should return correct timing when queue is partially filled', () => {
			const state = { windowStart: 0, used: 10, reserved: 5 };
			const info = policy.getStatus(state, 500);

			expect(info.nextAvailableAt).toBe(1000);
			expect(info.resetAt).toBe(2000);
		});

		it('should return correct timing when multiple windows are blocked', () => {
			const state = { windowStart: 0, used: 10, reserved: 25 };
			const info = policy.getStatus(state, 500);

			expect(info.nextAvailableAt).toBe(3000);
			expect(info.resetAt).toBe(4000);
		});
	});

	describe('Evaluate', () => {
		describe('Validation and Edge Cases', () => {
			const policy = new FixedWindowPolicy(10, 1000);

			it('should throw if cost exceeds the policy limit', () => {
				const state = policy.getInitialState();
				expect(() => policy.evaluate(state, 500, 15)).toThrow(InvalidCostError);
			});

			it('should allow zero cost without consuming tokens (status check)', () => {
				const state = { windowStart: 0, used: 5, reserved: 0 };
				const result = policy.evaluate(state, 500, 0);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.used).toBe(5);
			});

			it('should handle time jumping backwards gracefully', () => {
				const state = { windowStart: 5000, used: 5, reserved: 0 };
				const result = policy.evaluate(state, 4000, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState.windowStart).toBe(5000);
				expect(result.nextState.used).toBe(6);
			});
		});

		describe('Immediate execution', () => {
			const policy = new FixedWindowPolicy(2, 1000);

			it('should allow request when within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ windowStart: 0, used: 1, reserved: 0 });
			});

			it('should allow request with multi-token cost if within limit', () => {
				const state = policy.getInitialState();
				const result = policy.evaluate(state, 500, 2);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState).toEqual({ windowStart: 0, used: 2, reserved: 0 });
			});

			it('should deny request and return correct retryAt when limit is exceeded', () => {
				const state = { windowStart: 0, used: 2, reserved: 0 };
				const result = policy.evaluate(state, 500, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1000 });
				expect(result.nextState).toEqual(state);
			});
		});

		describe('Reservation and Delay', () => {
			const policy = new FixedWindowPolicy(2, 1000, 5);

			it('should delay request when limit is exceeded and reservation is requested', () => {
				const state = { windowStart: 0, used: 2, reserved: 0 };
				const result = policy.evaluate(state, 500, 1, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 1000 });
				expect(result.nextState).toEqual({ windowStart: 0, used: 2, reserved: 1 });
			});

			it('should calculate correct runAt for delayed requests across multiple future windows', () => {
				const state = { windowStart: 0, used: 2, reserved: 1 };
				const result1 = policy.evaluate(state, 500, 1, true);
				const result2 = policy.evaluate(result1.nextState, 500, 1, true);

				expect(result1.decision).toEqual({ kind: 'delay', runAt: 1000 });
				expect(result2.decision).toEqual({ kind: 'delay', runAt: 2000 });
				expect(result2.nextState.reserved).toBe(3);
			});

			it('should deny reservation if maxReserved is exceeded', () => {
				const state = { windowStart: 0, used: 2, reserved: 4 };
				const result = policy.evaluate(state, 500, 2, true);

				expect(result.decision.kind).toBe('deny');
				expect(result.nextState).toEqual(state);
			});

			it('should exactly calculate retryAt when maxReserved is exceeded (deficit logic)', () => {
				const fixedWindowPolicy = new FixedWindowPolicy(10, 1000, 20);
				const state = { windowStart: 0, used: 10, reserved: 20 };
				const result = fixedWindowPolicy.evaluate(state, 500, 5, true);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 1000 });
			});
		});

		describe('Window Transitions and State Sync', () => {
			const policy = new FixedWindowPolicy(10, 1000);

			it('should completely reset used count when moving to a new window without debt', () => {
				const state = { windowStart: 0, used: 10, reserved: 0 };
				const result = policy.evaluate(state, 1500, 1);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ windowStart: 1000, used: 1, reserved: 0 });
			});

			it('should carry over reserved requests into used count of the next window', () => {
				const state = { windowStart: 0, used: 10, reserved: 5 };
				const result = policy.evaluate(state, 1500, 1, true);

				expect(result.decision.kind).toBe('allow');
				expect(result.nextState).toEqual({ windowStart: 1000, used: 6, reserved: 0 });
			});

			it('should burn passed windows and correctly allocate remaining debt into current window', () => {
				const state = { windowStart: 0, used: 10, reserved: 25 };
				const result = policy.evaluate(state, 2500, 1, true);

				expect(result.nextState).toEqual({ windowStart: 2000, used: 10, reserved: 6 });
			});
		});
	});

	describe('Revert', () => {
		const policy = new FixedWindowPolicy(10, 1000);

		describe('Within the same window', () => {
			it('should revert only used when reserved is empty', () => {
				const state = { windowStart: 1000, used: 5, reserved: 0 };
				const nextState = policy.revert(state, 2, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 3, reserved: 0 });
			});

			it('should revert from reserved first', () => {
				const state = { windowStart: 1000, used: 10, reserved: 5 };
				const nextState = policy.revert(state, 3, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 10, reserved: 2 });
			});

			it('should revert from both reserved and used if cost spans across both', () => {
				const state = { windowStart: 1000, used: 10, reserved: 2 };
				const nextState = policy.revert(state, 5, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 7, reserved: 0 });
			});

			it('should not drop used or reserved below zero', () => {
				const state = { windowStart: 1000, used: 2, reserved: 0 };
				const nextState = policy.revert(state, 10, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 0, reserved: 0 });
			});
		});

		describe('With time sync (window transitions)', () => {
			it('should sync state and clear used capacity when moving to an empty new window before reverting', () => {
				const state = { windowStart: 0, used: 10, reserved: 0 };
				const nextState = policy.revert(state, 2, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 0, reserved: 0 });
			});

			it('should sync state, carry over reserved to used, and then apply revert', () => {
				const state = { windowStart: 0, used: 10, reserved: 5 };
				const nextState = policy.revert(state, 2, 1500);

				expect(nextState).toEqual({ windowStart: 1000, used: 3, reserved: 0 });
			});

			it('should burn passed windows, correctly allocate remaining debt, and then apply revert', () => {
				const state = { windowStart: 0, used: 10, reserved: 25 };
				const nextState = policy.revert(state, 7, 2500);

				expect(nextState).toEqual({ windowStart: 2000, used: 8, reserved: 0 });
			});

			it('should handle exact window boundary sync before reverting', () => {
				const state = { windowStart: 0, used: 10, reserved: 15 };
				const nextState = policy.revert(state, 5, 1000);

				expect(nextState).toEqual({ windowStart: 1000, used: 10, reserved: 0 });
			});

			it('should gracefully handle time jumping backwards during revert', () => {
				const state = { windowStart: 5000, used: 5, reserved: 0 };
				const nextState = policy.revert(state, 2, 4000);

				expect(nextState).toEqual({ windowStart: 5000, used: 3, reserved: 0 });
			});
		});
	});
});
