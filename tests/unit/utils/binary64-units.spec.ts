import { describe, expect, it } from 'vitest'
import { fromBinary64Units, toBinary64Units } from '../../../src/utils/binary64-units.js'

const UNITS_PER_ONE = 1n << 1074n
const UNITS_PER_ULP_AT_ONE = 1n << 1022n
const MAX_FINITE_UNITS = ((1n << 53n) - 1n) << 2045n

describe('binary64 units', () => {
	it.each([
		{ value: 0, units: 0n },
		{ value: -2, units: -2n * UNITS_PER_ONE },
		{ value: 0.75, units: 3n * UNITS_PER_ONE / 4n },
		{ value: -0.75, units: -3n * UNITS_PER_ONE / 4n },
		{ value: -Number.MIN_VALUE, units: -1n },
		{ value: 2 ** -1022 - Number.MIN_VALUE, units: (1n << 52n) - 1n },
		{ value: 2 ** -1022, units: 1n << 52n },
		{ value: Number.MAX_VALUE, units: MAX_FINITE_UNITS },
	])('should represent $value exactly in both directions', ({ value, units }) => {
		expect(toBinary64Units(value)).toBe(units)
		expect(fromBinary64Units(units, 1n, 'nearest')).toBe(value)
		expect(fromBinary64Units(units, 1n, 'up')).toBe(value)
	})

	it('should round halfway values to the nearest even significand', () => {
		const halfwayFromEven = 2n * UNITS_PER_ONE + UNITS_PER_ULP_AT_ONE
		const halfwayFromOdd = 2n * UNITS_PER_ONE + 3n * UNITS_PER_ULP_AT_ONE

		expect(fromBinary64Units(halfwayFromEven, 2n, 'nearest')).toBe(1)
		expect(fromBinary64Units(halfwayFromOdd, 2n, 'nearest')).toBe(1 + 2 * Number.EPSILON)
		expect(fromBinary64Units(-halfwayFromOdd, 2n, 'nearest')).toBe(-1 - 2 * Number.EPSILON)
	})

	it('should round a normal ratio upward for both signs', () => {
		const halfwayAboveOne = 2n * UNITS_PER_ONE + UNITS_PER_ULP_AT_ONE

		expect(fromBinary64Units(halfwayAboveOne, 2n, 'up')).toBe(1 + Number.EPSILON)
		expect(fromBinary64Units(-halfwayAboveOne, 2n, 'up')).toBe(-1)
	})

	it('should round fractional subnormal units down to zero or up to the smallest positive Number', () => {
		expect(fromBinary64Units(1n, 2n, 'nearest')).toBe(0)
		expect(fromBinary64Units(1n, 2n, 'up')).toBe(Number.MIN_VALUE)
		expect(fromBinary64Units(3n, 2n, 'nearest')).toBe(2 * Number.MIN_VALUE)
	})

	it('should distinguish overflow from rounding to the largest finite Number', () => {
		expect(fromBinary64Units(MAX_FINITE_UNITS + 1n, 1n, 'nearest')).toBe(Number.MAX_VALUE)
		expect(fromBinary64Units(MAX_FINITE_UNITS + 1n, 1n, 'up')).toBe(Infinity)
		expect(fromBinary64Units(MAX_FINITE_UNITS + (1n << 2044n), 1n, 'nearest')).toBe(Infinity)
	})
})
