import { describe, it, expect } from 'vitest';
import { InvalidCostError } from '../../../src/errors/invalid-cost.error.js';
import { validateCost } from '../../../src/utils/validate-cost.js';

describe('validateCost', () => {
	it('should not throw for a non-negative safe integer', () => {
		expect(() => validateCost(0)).not.toThrow();
		expect(() => validateCost(1)).not.toThrow();
		expect(() => validateCost(123_456)).not.toThrow();
	});

	it('should throw InvalidCostError for negative numbers', () => {
		expect(() => validateCost(-1)).toThrow(InvalidCostError);
	});

	it('should throw InvalidCostError for non-integers', () => {
		expect(() => validateCost(1.1)).toThrow(InvalidCostError);
	});

	it('should throw InvalidCostError for NaN', () => {
		expect(() => validateCost(Number.NaN)).toThrow(InvalidCostError);
	});

	it('should throw InvalidCostError for Infinity', () => {
		expect(() => validateCost(Number.POSITIVE_INFINITY)).toThrow(InvalidCostError);
		expect(() => validateCost(Number.NEGATIVE_INFINITY)).toThrow(InvalidCostError);
	});

	it('should throw InvalidCostError for non-safe integers', () => {
		expect(() => validateCost(Number.MAX_SAFE_INTEGER + 1)).toThrow(InvalidCostError);
	});

	it('should respect max when provided', () => {
		expect(() => validateCost(10, 10)).not.toThrow();
		expect(() => validateCost(11, 10)).toThrow(InvalidCostError);
	});

	it('should respect min when provided', () => {
		expect(() => validateCost(10, undefined, 10)).not.toThrow();
		expect(() => validateCost(9, undefined, 10)).toThrow(InvalidCostError);
	});

	it('should respect both min and max when provided', () => {
		expect(() => validateCost(5, 10, 0)).not.toThrow();
		expect(() => validateCost(11, 10, 0)).toThrow(InvalidCostError);
		expect(() => validateCost(-1, 10, 0)).toThrow(InvalidCostError);
	});
});
