import { Priority } from '@stimulcross/ds-policy-priority-queue';
import { describe, it, expect } from 'vitest';
import { sanitizePriority } from '../../../src/utils/sanitize-priority.js';

describe('sanitizePriority (updated)', () => {
	it('should return Priority.Normal for non-finite numbers', () => {
		expect(sanitizePriority(Number.NaN)).toBe(Priority.Normal);
		expect(sanitizePriority(Number.POSITIVE_INFINITY)).toBe(Priority.Normal);
		expect(sanitizePriority(Number.NEGATIVE_INFINITY)).toBe(Priority.Normal);
	});

	it('should clamp below Priority.Lowest to Priority.Lowest (before rounding)', () => {
		expect(sanitizePriority(Priority.Lowest - 1)).toBe(Priority.Lowest);
		expect(sanitizePriority(Priority.Lowest - 0.1)).toBe(Priority.Lowest);
		expect(sanitizePriority(Priority.Lowest - 1000)).toBe(Priority.Lowest);
	});

	it('should clamp above Priority.Highest to Priority.Highest (before rounding)', () => {
		expect(sanitizePriority(Priority.Highest + 1)).toBe(Priority.Highest);
		expect(sanitizePriority(Priority.Highest + 0.1)).toBe(Priority.Highest);
		expect(sanitizePriority(Priority.Highest + 1000)).toBe(Priority.Highest);
	});

	it('should round non-integer priorities that are already within range', () => {
		expect(sanitizePriority(1.4)).toBe(1);
		expect(sanitizePriority(1.5)).toBe(2);
		expect(sanitizePriority(3.7)).toBe(4);
	});

	it('should return the same value for integers within range', () => {
		expect(sanitizePriority(Priority.Lowest)).toBe(Priority.Lowest);
		expect(sanitizePriority(Priority.Normal)).toBe(Priority.Normal);
		expect(sanitizePriority(Priority.Highest)).toBe(Priority.Highest);

		const mid = Math.trunc((Priority.Lowest + Priority.Highest) / 2);
		expect(sanitizePriority(mid)).toBe(mid);
	});

	it('should not clamp after rounding (behavior change guard)', () => {
		expect(sanitizePriority(Priority.Highest - 0.6)).toBe(Priority.Highest - 1);
		expect(sanitizePriority(Priority.Highest - 0.4)).toBe(Priority.Highest);

		expect(sanitizePriority(Priority.Lowest + 0.6)).toBe(Priority.Lowest + 1);
		expect(sanitizePriority(Priority.Lowest + 0.4)).toBe(Priority.Lowest);
	});
});
