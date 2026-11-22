import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { GenericCellLimitOptions } from './generic-cell.options.js'
import type { GenericCellState } from './generic-cell.state.js'
import type { GenericCellStatus } from './generic-cell.status.js'
import { getNextTimestamp } from '../../utils/next-timestamp.js'

interface GenericCellProfile extends GenericCellLimitOptions {
	readonly interval: bigint
	readonly tolerance: bigint
}

/** @internal */
export class GenericCellPolicy implements RateLimitPolicy<GenericCellState, GenericCellStatus> {
	private readonly _profiles: readonly GenericCellProfile[]

	constructor(profiles: readonly GenericCellLimitOptions[]) {
		if (profiles.length === 0)
			throw new RangeError('Generic Cell requires at least one profile')

		this._profiles = profiles.map(({ intervalMs, burst }) => {
			if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
				throw new RangeError('Generic Cell interval must be a positive safe integer')

			if (!Number.isSafeInteger(burst) || burst <= 0)
				throw new RangeError('Generic Cell burst must be a positive safe integer')

			const interval = BigInt(intervalMs)

			return {
				intervalMs,
				burst,
				interval,
				tolerance: BigInt(burst - 1) * interval,
			}
		})
	}

	public check(state: GenericCellState | undefined, time: number): number | undefined {
		const nextAvailableAt = state?.nextAvailableAt

		return nextAvailableAt !== undefined && nextAvailableAt > time
			? nextAvailableAt
			: undefined
	}

	public charge(state: GenericCellState | undefined, time: number): GenericCellState {
		const current = state ?? { arrivals: [], nextAvailableAt: time }
		const rounded = Math.round(time)
		const whole = BigInt(rounded)
		const fraction = time - rounded
		let nextAvailableAt = time

		for (const [index, { interval, tolerance }] of this._profiles.entries()) {
			const arrival = current.arrivals[index] ?? { whole, fraction }

			if (arrival.whole < whole || (arrival.whole === whole && arrival.fraction < fraction)) {
				arrival.whole = whole
				arrival.fraction = fraction
			}

			arrival.whole += interval
			current.arrivals[index] = arrival
			const availableAt = this._roundUpTimestamp(arrival.whole - tolerance, arrival.fraction)
			nextAvailableAt = Math.max(nextAvailableAt, availableAt)
		}

		current.nextAvailableAt = nextAvailableAt

		return current
	}

	public getStatus(state: GenericCellState | undefined, time: number): GenericCellStatus {
		const rounded = Math.round(time)
		const whole = BigInt(rounded)
		const fraction = time - rounded
		const profiles = this._profiles.map(({ intervalMs, burst, interval }, index) => {
			const arrival = state?.arrivals[index]

			if (arrival === undefined) {
				return {
					intervalMs,
					burst,
					tat: null,
					remaining: burst,
				}
			}

			const debt = arrival.whole - whole
			const adjustment = arrival.fraction > fraction ? interval : interval - 1n
			const consumed = debt < 0n ? 0n : (debt + adjustment) / interval

			return {
				intervalMs,
				burst,
				tat: this._roundUpTimestamp(arrival.whole, arrival.fraction),
				remaining: burst - Number(consumed),
			}
		})

		return { nextAvailableAt: this.check(state, time) ?? time, profiles }
	}

	private _roundUpTimestamp(whole: bigint, fraction: number): number {
		const rounded = Number(whole)

		if (!Number.isFinite(rounded))
			return rounded

		const roundedWhole = BigInt(rounded)

		if (roundedWhole !== whole)
			return roundedWhole < whole ? getNextTimestamp(rounded) : rounded

		const timestamp = rounded + fraction

		return timestamp - rounded < fraction ? getNextTimestamp(timestamp) : timestamp
	}
}
