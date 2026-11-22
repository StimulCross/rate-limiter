import { describe, expect, it } from 'vitest'
import { addTimestampDelay, getNextTimestamp } from '../../../src/utils/next-timestamp.js'

describe('getNextTimestamp', () => {
	it.each([
		[0, Number.MIN_VALUE],
		[-0, Number.MIN_VALUE],
		[-Number.MIN_VALUE, -0],
		[Number.MIN_VALUE, 2 * Number.MIN_VALUE],
		[1, 1 + Number.EPSILON],
		[-1, -1 + Number.EPSILON / 2],
		[2 ** 53, 2 ** 53 + 2],
		[Number.MAX_VALUE, Infinity],
	])('should return the next representable timestamp after %s', (time, successor) => {
		expect(getNextTimestamp(time)).toBe(successor)
	})
})

describe('addTimestampDelay', () => {
	it.each([
		{ time: -0.25, delay: 0.5, expected: 0.25 },
		{ time: -1, delay: 1, expected: 0 },
		{ time: 1, delay: Number.EPSILON / 2, expected: 1 + Number.EPSILON },
		{ time: 1, delay: 3 * Number.EPSILON / 4, expected: 1 + Number.EPSILON },
		{ time: Number.MIN_VALUE, delay: 1, expected: 1 + Number.EPSILON },
		{ time: -1, delay: Number.MIN_VALUE, expected: -1 + Number.EPSILON / 2 },
		{ time: Number.MAX_VALUE, delay: Number.MIN_VALUE, expected: Infinity },
		{ time: Number.MAX_VALUE, delay: Number.MAX_VALUE, expected: Infinity },
	])('should round $time + $delay up to $expected', ({ time, delay, expected }) => {
		expect(addTimestampDelay(time, delay)).toBe(expected)
	})
})
