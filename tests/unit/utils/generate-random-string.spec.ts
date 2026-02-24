import { describe, it, expect } from 'vitest';
import { generateRandomString } from '../../../src/utils/generate-random-string.js';

describe('generateRandomString', () => {
	const ALPHANUMERIC_REGEX = /^[A-Za-z\d]*$/u;

	describe('length and boundary conditions', () => {
		it('should return a string of length 7 by default', () => {
			expect(generateRandomString()).toHaveLength(7);
		});

		it('should return a string of the exact specified length', () => {
			expect(generateRandomString(5)).toHaveLength(5);
			expect(generateRandomString(100)).toHaveLength(100);
		});

		it('should return an empty string when length is 0', () => {
			expect(generateRandomString(0)).toBe('');
		});
	});

	describe('validation', () => {
		it('should throw a RangeError for negative lengths', () => {
			expect(() => generateRandomString(-1)).toThrow(RangeError);
			expect(() => generateRandomString(-5)).toThrow(/Invalid length/u);
		});

		it('should throw a RangeError for non-integer lengths', () => {
			expect(() => generateRandomString(5.5)).toThrow(RangeError);
		});

		it('should throw a RangeError for unsafe integers and non-numbers', () => {
			expect(() => generateRandomString(Number.NaN)).toThrow(RangeError);
			expect(() => generateRandomString(Infinity)).toThrow(RangeError);
			expect(() => generateRandomString(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
		});
	});

	describe('content and semantics', () => {
		it('should contain only allowed alphanumeric characters', () => {
			const result = generateRandomString(50);
			expect(ALPHANUMERIC_REGEX.test(result)).toBe(true);
		});

		it('should generate different strings on subsequent calls', () => {
			const string1 = generateRandomString(20);
			const string2 = generateRandomString(20);
			expect(string1).not.toBe(string2);
		});
	});
});
