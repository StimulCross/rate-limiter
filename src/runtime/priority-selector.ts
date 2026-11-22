import type { PriorityWeights } from '../contracts/priority-weights.js'
import { Priority } from '../contracts/priority.js'
import { toBinary64Units } from '../utils/binary64-units.js'

const DEFAULT_WEIGHTS: PriorityWeights = {
	[Priority.Highest]: 16,
	[Priority.High]: 8,
	[Priority.Normal]: 4,
	[Priority.Low]: 2,
	[Priority.Lowest]: 1,
}

/** @internal */
export const PRIORITIES = [Priority.Highest, Priority.High, Priority.Normal, Priority.Low, Priority.Lowest] as const
const FULL_MASK = (1 << PRIORITIES.length) - 1

/** @internal */
export function getPriorityBit(priority: Priority): number {
	return 1 << (priority - 1)
}

function decodeWeight(weight: number): bigint {
	if (!Number.isFinite(weight) || weight <= 0)
		throw new RangeError('Priority weights must be positive finite numbers')

	return toBinary64Units(weight)
}

function getGcd(left: bigint, right: bigint): bigint {
	while (right !== 0n) {
		const remainder = left % right
		left = right
		right = remainder
	}

	return left
}

/** @internal */
export class PrioritySelector {
	private readonly _increments: ReadonlyArray<readonly bigint[]>
	private readonly _bypassLimits: readonly bigint[]
	private readonly _balances = [0n, 0n, 0n, 0n, 0n]
	private readonly _service: bigint

	constructor(weights: PriorityWeights = DEFAULT_WEIGHTS) {
		const integers = PRIORITIES.map(priority => decodeWeight(weights[priority])).reverse()
		const divisor = integers.reduce(getGcd)
		const units = integers.map(weight => weight / divisor)
		const sums = [0n]
		let service = 1n

		for (let mask = 1; mask <= FULL_MASK; mask++) {
			let total = 0n

			for (const priority of PRIORITIES) {
				if (mask & getPriorityBit(priority))
					total += units[priority - 1]
			}

			sums.push(total)
			service = (service / getGcd(service, total)) * total
		}

		this._service = service
		this._bypassLimits = units.map(weight => (sums[FULL_MASK] - 1n) / weight)

		this._increments = sums.map((sum, mask) => {
			const scale = sum === 0n ? 0n : service / sum

			return units.map((weight, index) => mask & (1 << index) ? scale * weight : 0n)
		})
	}

	public getBypassLimit(priority: Priority): bigint {
		return this._bypassLimits[priority - 1]
	}

	/**
	 * Previews one choice without recording service.
	 */
	public select(mask: number): Priority | undefined {
		const increments = this._increments[mask]
		let winner: Priority | undefined
		let highest = 0n

		for (const priority of PRIORITIES) {
			if (mask & getPriorityBit(priority)) {
				const index = priority - 1
				const preview = this._balances[index] + increments[index]

				if (winner === undefined || preview > highest) {
					winner = priority
					highest = preview
				}
			}
		}

		return winner
	}

	/**
	 * Records the selected class with the same offered mask used for selection.
	 */
	public recordStart(mask: number, winner: Priority): void {
		if (mask === getPriorityBit(winner))
			return

		const increments = this._increments[mask]

		for (const priority of PRIORITIES) {
			if (mask & getPriorityBit(priority)) {
				const index = priority - 1
				this._balances[index] += increments[index]
			}
		}

		this._balances[winner - 1] -= this._service
	}
}
