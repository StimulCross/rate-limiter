import { describe, expect, it } from 'vitest'
import { Priority } from '../../../src/index.js'
import { PrioritySelector } from '../../../src/runtime/priority-selector.js'
import { ASCENDING_PRIORITIES, chooseReference, compareFractions, ZERO } from '../../helpers/one-b-reference.js'

describe('PrioritySelector', () => {
	it('should break a tie by higher priority and freeze balances while a class is absent', () => {
		const selector = new PrioritySelector({
			[Priority.Lowest]: 1,
			[Priority.Low]: 1,
			[Priority.Normal]: 1,
			[Priority.High]: 1,
			[Priority.Highest]: 1,
		})
		const pair = 0b0_1010

		expect(selector.select(0)).toBeUndefined()
		expect(selector.select(pair)).toBe(Priority.High)
		expect(selector.select(pair)).toBe(Priority.High)
		selector.recordStart(pair, Priority.High)

		for (let start = 0; start < 16; start++) {
			expect(selector.select(0b0_0010)).toBe(Priority.Low)
			selector.recordStart(0b0_0010, Priority.Low)
		}

		expect(selector.select(pair)).toBe(Priority.Low)
	})

	it('should reproduce the stable 3:1 starting sequence', () => {
		const selector = new PrioritySelector({
			[Priority.Lowest]: 1,
			[Priority.Low]: 1,
			[Priority.Normal]: 1,
			[Priority.High]: 3,
			[Priority.Highest]: 1,
		})
		const period = [
			Priority.High,
			Priority.High,
			Priority.Low,
			Priority.High,
		]

		for (const expected of [
			...period,
			...period,
			...period,
			...period,
			...period,
		]) {
			const mask = 0b0_1010
			expect(selector.select(mask)).toBe(expected)
			selector.recordStart(mask, expected)
		}
	})

	it('should derive the default protection thresholds from all five weights', () => {
		const selector = new PrioritySelector()

		expect(ASCENDING_PRIORITIES.map(priority => selector.getBypassLimit(priority))).toEqual([30n, 15n, 7n, 3n, 1n])
	})

	it.each([
		{ label: 'adjacent normal weights', high: 1, low: 1 + Number.EPSILON },
		{ label: 'adjacent weights whose sum overflows', high: Number.MAX_VALUE - 2 ** 971, low: Number.MAX_VALUE },
	])('should resolve near ties exactly for $label', ({ high, low }) => {
		const selector = new PrioritySelector({
			[Priority.Lowest]: 1,
			[Priority.Low]: low,
			[Priority.Normal]: 1,
			[Priority.High]: high,
			[Priority.Highest]: 1,
		})
		const pair = 0b0_1010

		for (const priority of [
			Priority.Low,
			Priority.High,
			Priority.Low,
			Priority.High,
		]) {
			expect(selector.select(pair)).toBe(priority)
			selector.recordStart(pair, priority)
		}
	})

	it('should match the rational reference and stay within the discrepancy bounds across all masks', () => {
		const selector = new PrioritySelector({
			[Priority.Lowest]: 3,
			[Priority.Low]: 9,
			[Priority.Normal]: 1,
			[Priority.High]: 2,
			[Priority.Highest]: 16,
		})
		const weights = [3n, 9n, 1n, 2n, 16n]
		let balances = ASCENDING_PRIORITIES.map(() => ZERO)
		const min = balances.slice()
		const max = balances.slice()

		for (let index = 0; index < 31 * 60; index++) {
			const mask = (index * 23 + Math.floor(index / 31) * 11) % 31 + 1
			const offered = new Set(ASCENDING_PRIORITIES.filter(priority => mask & (1 << (priority - 1))))
			const expected = chooseReference(weights, balances, offered)!
			const winner = selector.select(mask)!
			expect(winner).toBe(expected.winner)
			selector.recordStart(mask, winner)
			balances = expected.balances

			for (const [classIndex, balance] of balances.entries()) {
				expect(compareFractions(balance, [-2n, 1n])).toBeGreaterThanOrEqual(0n)
				expect(compareFractions(balance, [2n, 1n])).toBeLessThanOrEqual(0n)

				if (compareFractions(balance, min[classIndex]) < 0n)
					min[classIndex] = balance

				if (compareFractions(balance, max[classIndex]) > 0n)
					max[classIndex] = balance

				const [high, highDenominator] = max[classIndex]
				const [low, lowDenominator] = min[classIndex]

				expect(high * lowDenominator - low * highDenominator)
					.toBeLessThanOrEqual(4n * highDenominator * lowDenominator)
			}
		}
	})

	it('should preserve exact shares and bypass thresholds from subnormal to maximum weights', () => {
		const selector = new PrioritySelector({
			[Priority.Lowest]: 2 * Number.MIN_VALUE,
			[Priority.Low]: Number.MIN_VALUE,
			[Priority.Normal]: 0.25,
			[Priority.High]: Number.MAX_VALUE,
			[Priority.Highest]: 0.75,
		})
		const largestWeight = BigInt(Number.MAX_VALUE) << 1074n
		const quarter = 1n << 1072n
		const weights = [
			2n,
			1n,
			quarter,
			largestWeight,
			3n * quarter,
		]
		const total = weights.reduce((sum, weight) => sum + weight, 0n)

		for (const priority of ASCENDING_PRIORITIES) {
			const weight = weights[priority - 1]
			const limit = selector.getBypassLimit(priority)
			expect(limit * weight).toBeLessThan(total)
			expect((limit + 1n) * weight).toBeGreaterThanOrEqual(total)
		}

		expect(selector.select(0b0_0011)).toBe(Priority.Lowest)
		let balances = ASCENDING_PRIORITIES.map(() => ZERO)

		for (const mask of [
			3,
			3,
			3,
			20,
			20,
			31,
			14,
			29,
			31,
			3,
			14,
			1,
		]) {
			const classes = new Set(ASCENDING_PRIORITIES.filter(priority => mask & (1 << (priority - 1))))
			const expected = chooseReference(weights, balances, classes)!
			const winner = selector.select(mask)!
			expect(winner).toBe(expected.winner)
			selector.recordStart(mask, winner)
			balances = expected.balances
		}
	})

	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])('should reject invalid weight %s', weight => {
		expect(() => new PrioritySelector({
			[Priority.Lowest]: 1,
			[Priority.Low]: 1,
			[Priority.Normal]: weight,
			[Priority.High]: 1,
			[Priority.Highest]: 1,
		})).toThrow(RangeError)
	})
})
