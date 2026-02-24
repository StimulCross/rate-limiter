import { describe, expect, it } from 'vitest';
import { InvalidCostError } from '../../../src/index.js';
import { CompositePolicy } from '../../../src/limiters/composite.policy.js';
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js';
import { type FixedWindowState, type FixedWindowStatus } from '../../../src/limiters/fixed-window/index.js';

const createFixedWindowCompositePolicy = (
	policies: FixedWindowPolicy[],
): CompositePolicy<FixedWindowState, FixedWindowStatus, FixedWindowPolicy> =>
	new CompositePolicy<FixedWindowState, FixedWindowStatus, FixedWindowPolicy>(policies);

describe('CompositePolicy', () => {
	describe('Initialization', () => {
		it('should initialize with provided policies and expose them', () => {
			const policies = [new FixedWindowPolicy(10, 1000), new FixedWindowPolicy(5, 5000)];
			const composite = createFixedWindowCompositePolicy(policies);

			expect(composite.policies).toHaveLength(2);
			expect(composite.policies).toStrictEqual(policies);
		});

		it('should aggregate initial states from all underlying policies', () => {
			const composite = createFixedWindowCompositePolicy([
				new FixedWindowPolicy(10, 1000),
				new FixedWindowPolicy(5, 5000),
			]);

			const states = composite.getInitialState(0);

			expect(states).toHaveLength(2);
			expect(states[0]).toEqual({ windowStart: 0, used: 0, reserved: 0 });
			expect(states[1]).toEqual({ windowStart: 0, used: 0, reserved: 0 });
		});
	});

	describe('Get Status', () => {
		const policies = [new FixedWindowPolicy(10, 1000), new FixedWindowPolicy(5, 5000)];
		const composite = createFixedWindowCompositePolicy(policies);

		it('should return correct status for empty state', () => {
			const state = composite.getInitialState(1000);
			const status = composite.getStatus(state, 500);

			expect(status.map(inf => inf.windowStart)).toEqual([0, 0]);
			expect(status.map(inf => inf.windowEnd)).toEqual([1000, 5000]);
			expect(status.map(inf => inf.used)).toEqual([0, 0]);
			expect(status.map(inf => inf.reserved)).toEqual([0, 0]);
			expect(status.map(inf => inf.remaining)).toEqual([10, 5]);
			expect(status.map(inf => inf.nextAvailableAt)).toEqual([0, 0]);
			expect(status.map(inf => inf.resetAt)).toEqual([1000, 5000]);
		});

		it('should return correct timing when queue is partially filled', () => {
			const state = [
				{ windowStart: 0, used: 10, reserved: 5 },
				{ windowStart: 0, used: 5, reserved: 3 },
			];
			const status = composite.getStatus(state, 500);

			expect(status.map(i => i.nextAvailableAt)).toEqual([1000, 5000]);
			expect(status.map(i => i.resetAt)).toEqual([2000, 10_000]);
		});

		it('should return correct timing when multiple windows are blocked', () => {
			const state = [
				{ windowStart: 0, used: 10, reserved: 25 },
				{ windowStart: 0, used: 5, reserved: 13 },
			];
			const status = composite.getStatus(state, 500);

			expect(status.map(i => i.nextAvailableAt)).toEqual([3000, 15_000]);
			expect(status.map(i => i.resetAt)).toEqual([4000, 20_000]);
		});
	});

	describe('Evaluation', () => {
		describe('Allow', () => {
			it('should allow and update states when all policies allow', () => {
				const composite = createFixedWindowCompositePolicy([
					new FixedWindowPolicy(10, 1000),
					new FixedWindowPolicy(5, 5000),
				]);
				const states = composite.getInitialState(0);

				const result = composite.evaluate(states, 500, 1);

				expect(result.decision).toEqual({ kind: 'allow' });
				expect(result.nextState[0].used).toBe(1);
				expect(result.nextState[1].used).toBe(1);
			});
		});

		describe('Deny and Revert', () => {
			it('should deny and return maximum retryAt when all policies deny', () => {
				const composite = createFixedWindowCompositePolicy([
					new FixedWindowPolicy(1, 1000),
					new FixedWindowPolicy(1, 5000),
				]);
				const states = [
					{ windowStart: 0, used: 1, reserved: 0 },
					{ windowStart: 0, used: 1, reserved: 0 },
				];

				const result = composite.evaluate(states, 500, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 5000 });
			});

			it('should deny, return maximum retryAt, and revert states for policies that allowed', () => {
				const composite = createFixedWindowCompositePolicy([
					new FixedWindowPolicy(10, 1000),
					new FixedWindowPolicy(1, 5000),
				]);
				const states = [
					{ windowStart: 0, used: 0, reserved: 0 },
					{ windowStart: 0, used: 1, reserved: 0 },
				];

				const result = composite.evaluate(states, 500, 1);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 5000 });
				expect(result.nextState[0].used).toBe(0);
				expect(result.nextState[1].used).toBe(1);
			});
		});

		describe('Delay and Mixed Decisions', () => {
			it('should delay and return maximum runAt when policies delay and none deny', () => {
				const composite = createFixedWindowCompositePolicy([
					new FixedWindowPolicy(1, 1000, 5),
					new FixedWindowPolicy(1, 2000, 5),
				]);
				const states = [
					{ windowStart: 0, used: 1, reserved: 0 },
					{ windowStart: 0, used: 1, reserved: 0 },
				];

				const result = composite.evaluate(states, 500, 1, true);

				expect(result.decision).toEqual({ kind: 'delay', runAt: 2000 });
				expect(result.nextState[0].reserved).toBe(1);
				expect(result.nextState[1].reserved).toBe(1);
			});

			it('should prioritize deny over delay and revert both delayed and allowed policies', () => {
				const composite = createFixedWindowCompositePolicy([
					new FixedWindowPolicy(10, 1000),
					new FixedWindowPolicy(1, 2000, 5),
					new FixedWindowPolicy(1, 5000, 0),
				]);
				const states = [
					{ windowStart: 0, used: 0, reserved: 0 },
					{ windowStart: 0, used: 1, reserved: 0 },
					{ windowStart: 0, used: 1, reserved: 0 },
				];

				const result = composite.evaluate(states, 500, 1, true);

				expect(result.decision).toEqual({ kind: 'deny', retryAt: 5000 });
				expect(result.nextState[0].used).toBe(0);
				expect(result.nextState[1].reserved).toBe(0);
				expect(result.nextState[2].used).toBe(1);
			});
		});

		describe('Edge Cases', () => {
			it('should default cost to 1 if omitted', () => {
				const composite = createFixedWindowCompositePolicy([new FixedWindowPolicy(10, 1000)]);
				const states = composite.getInitialState(0);

				const result = composite.evaluate(states, 500);

				expect(result.nextState[0].used).toBe(1);
			});

			it('should throw when evaluate cost validation fails', () => {
				const composite = createFixedWindowCompositePolicy([new FixedWindowPolicy(10, 1000)]);
				const states = composite.getInitialState(0);

				expect(() => composite.evaluate(states, 500, -5)).toThrow(InvalidCostError);
				expect(() => composite.evaluate(states, 500, 1.5)).toThrow(InvalidCostError);
			});
		});
	});

	describe('Revert', () => {
		it('should correctly proxy revert calls to all underlying policies within the same window', () => {
			const composite = createFixedWindowCompositePolicy([
				new FixedWindowPolicy(10, 1000),
				new FixedWindowPolicy(5, 5000),
			]);
			const states = [
				{ windowStart: 0, used: 5, reserved: 0 },
				{ windowStart: 0, used: 3, reserved: 0 },
			];

			const revertedStates = composite.revert(states, 2, 500);

			expect(revertedStates[0]).toEqual({ windowStart: 0, used: 3, reserved: 0 });
			expect(revertedStates[1]).toEqual({ windowStart: 0, used: 1, reserved: 0 });
		});

		it('should correctly revert single unit cost', () => {
			const composite = createFixedWindowCompositePolicy([new FixedWindowPolicy(10, 1000)]);
			const states = [{ windowStart: 0, used: 5, reserved: 0 }];

			const revertedStates = composite.revert(states, 1, 500);

			expect(revertedStates[0]).toEqual({ windowStart: 0, used: 4, reserved: 0 });
		});

		it('should sync state for each policy independently based on their window sizes before reverting', () => {
			const composite = createFixedWindowCompositePolicy([
				new FixedWindowPolicy(10, 1000),
				new FixedWindowPolicy(5, 5000),
			]);
			const states = [
				{ windowStart: 0, used: 10, reserved: 5 },
				{ windowStart: 0, used: 5, reserved: 3 },
			];

			const revertedStates = composite.revert(states, 2, 1500);

			expect(revertedStates[0]).toEqual({ windowStart: 1000, used: 3, reserved: 0 });
			expect(revertedStates[1]).toEqual({ windowStart: 0, used: 5, reserved: 1 });
		});

		it('should handle revert when time jumps past multiple windows differently for each policy', () => {
			const composite = createFixedWindowCompositePolicy([
				new FixedWindowPolicy(10, 1000),
				new FixedWindowPolicy(5, 5000),
			]);
			const states = [
				{ windowStart: 0, used: 10, reserved: 5 },
				{ windowStart: 0, used: 5, reserved: 5 },
			];

			const revertedStates = composite.revert(states, 2, 6000);

			expect(revertedStates[0]).toEqual({ windowStart: 6000, used: 0, reserved: 0 });
			expect(revertedStates[1]).toEqual({ windowStart: 5000, used: 3, reserved: 0 });
		});
	});
});
