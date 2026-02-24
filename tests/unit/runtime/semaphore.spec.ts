import { describe, it, expect } from 'vitest';
import { Semaphore } from '../../../src/runtime/semaphore.js';

describe('Semaphore', () => {
	describe('should support unlimited mode', () => {
		it('should always acquire successfully when maxPermits is null', () => {
			const s = new Semaphore(null);

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(true);
		});

		it('should ignore release when maxPermits is null', () => {
			const s = new Semaphore(null);

			s.release();
			s.release();

			expect(s.acquire()).toBe(true);
		});
	});

	describe('should validate constructor argument', () => {
		it('should accept null (unlimited mode)', () => {
			expect(() => new Semaphore(null)).not.toThrow();
		});

		it('should throw for 0', () => {
			expect(() => new Semaphore(0)).toThrow();
		});

		it('should accept positive safe integers', () => {
			expect(() => new Semaphore(1)).not.toThrow();
			expect(() => new Semaphore(10)).not.toThrow();
			expect(() => new Semaphore(Number.MAX_SAFE_INTEGER)).not.toThrow();
		});

		it('should throw for negative integers', () => {
			expect(() => new Semaphore(-1)).toThrow(/non-negative integer or null/iu);
			expect(() => new Semaphore(-10)).toThrow(/non-negative integer or null/iu);
		});

		it('should throw for non-integers (floats)', () => {
			expect(() => new Semaphore(0.1)).toThrow(/non-negative integer or null/iu);
			expect(() => new Semaphore(1.5)).toThrow(/non-negative integer or null/iu);
		});

		it('should throw for NaN', () => {
			expect(() => new Semaphore(Number.NaN)).toThrow(/non-negative integer or null/iu);
		});

		it('should throw for Infinity and -Infinity', () => {
			expect(() => new Semaphore(Number.POSITIVE_INFINITY)).toThrow(/non-negative integer or null/iu);
			expect(() => new Semaphore(Number.NEGATIVE_INFINITY)).toThrow(/non-negative integer or null/iu);
		});

		it('should throw for unsafe integers', () => {
			expect(() => new Semaphore(Number.MAX_SAFE_INTEGER + 1)).toThrow(/non-negative integer or null/iu);
		});
	});

	describe('should enforce finite capacity', () => {
		it('should start full when maxPermits is provided', () => {
			const s = new Semaphore(2);

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(false);
		});

		it('should allow acquiring again after release, up to the maximum', () => {
			const s = new Semaphore(1);

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(false);

			s.release();

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(false);
		});

		it('should cap permits at maxPermits after extra releases', () => {
			const s = new Semaphore(1);

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(false);

			s.release();
			s.release();
			s.release();

			expect(s.acquire()).toBe(true);
			expect(s.acquire()).toBe(false);
		});
	});
});
