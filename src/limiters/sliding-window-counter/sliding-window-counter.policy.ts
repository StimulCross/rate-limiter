import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { SlidingWindowCounterLimitOptions } from './sliding-window-counter.options.js'
import type { SlidingWindowCounterState, WindowCounts } from './sliding-window-counter.state.js'
import type { SlidingWindowCounterStatus } from './sliding-window-counter.status.js'
import { fromBinary64Units, toBinary64Units } from '../../utils/binary64-units.js'

const UNITS_PER_MILLISECOND = toBinary64Units(1)

/** @internal */
export class SlidingWindowCounterPolicy implements RateLimitPolicy<SlidingWindowCounterState, SlidingWindowCounterStatus> {
	private readonly _limit: number
	private readonly _windowMs: number
	private readonly _duration: bigint
	private readonly _offset: bigint

	constructor({ limit, windowMs, offsetMs = 0 }: SlidingWindowCounterLimitOptions) {
		if (!Number.isSafeInteger(limit) || limit <= 0)
			throw new RangeError('Sliding Window Counter limit must be a positive safe integer')

		if (!Number.isFinite(windowMs) || windowMs <= 0)
			throw new RangeError('Sliding Window Counter duration must be positive and finite')

		if (!Number.isSafeInteger(offsetMs))
			throw new RangeError('Sliding Window Counter grid offset must be a safe integer')

		this._limit = limit
		this._windowMs = windowMs
		this._duration = toBinary64Units(windowMs)
		this._offset = toBinary64Units(offsetMs)
	}

	public check(state: SlidingWindowCounterState | undefined, time: number): number | undefined {
		return state !== undefined && state.nextAvailableAt > time ? state.nextAvailableAt : undefined
	}

	public charge(state: SlidingWindowCounterState | undefined, time: number): SlidingWindowCounterState {
		const units = toBinary64Units(time)
		const window = this._project(state, units)
		const charged = { ...window, currentCount: window.currentCount + 1, nextAvailableAt: time }
		charged.nextAvailableAt = this._getNextAvailableAt(charged, units) ?? time

		return charged
	}

	public getStatus(state: SlidingWindowCounterState | undefined, time: number): SlidingWindowCounterStatus {
		const units = toBinary64Units(time)
		const { windowStart, currentCount, previousCount } = this._project(state, units)
		const estimate = BigInt(currentCount) * this._duration + BigInt(previousCount) * (this._duration - (units - windowStart))
		const capacity = BigInt(this._limit) * this._duration

		return {
			limit: this._limit,
			windowMs: this._windowMs,
			windowStart: fromBinary64Units(windowStart, 1n, 'nearest'),
			currentCount,
			previousCount,
			estimatedCount: fromBinary64Units(estimate * UNITS_PER_MILLISECOND, this._duration, 'nearest'),
			remaining: Math.max(0, Number((capacity - estimate) / this._duration)),
			nextAvailableAt: this.check(state, time) ?? time,
		}
	}

	private _project(state: SlidingWindowCounterState | undefined, units: bigint): WindowCounts {
		if (state !== undefined && units < state.windowStart + this._duration)
			return state

		const relative = units - this._offset
		const index = relative < 0n
			? (relative - this._duration + 1n) / this._duration
			: relative / this._duration

		return {
			index,
			windowStart: this._offset + index * this._duration,
			currentCount: 0,
			previousCount: state !== undefined && index === state.index + 1n
				? state.currentCount
				: 0,
		}
	}

	private _getNextAvailableAt({ windowStart, currentCount, previousCount }: WindowCounts, units: bigint): number | undefined {
		const deficit = previousCount - (this._limit - currentCount - 1)

		if (deficit <= 0)
			return undefined

		if (currentCount === this._limit) {
			const count = BigInt(currentCount)

			return fromBinary64Units((windowStart + this._duration) * count + this._duration, count, 'up')
		}

		const count = BigInt(previousCount)
		const numerator = windowStart * count + this._duration * BigInt(deficit)

		return numerator > units * count ? fromBinary64Units(numerator, count, 'up') : undefined
	}
}
