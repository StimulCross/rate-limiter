import type { RateLimitPolicy } from '../../contracts/rate-limit-policy.js'
import type { TokenBucketLimitOptions } from './token-bucket.options.js'
import type { TokenBucketState } from './token-bucket.state.js'
import type { TokenBucketStatus } from './token-bucket.status.js'
import { fromBinary64Units, toBinary64Units } from '../../utils/binary64-units.js'
import { getNextTimestamp } from '../../utils/next-timestamp.js'

const MILLI_TOKENS_PER_TOKEN = 1000
const BINARY64_SCALE = toBinary64Units(1)
const UNITS_PER_TOKEN = toBinary64Units(MILLI_TOKENS_PER_TOKEN)

/** @internal */
export class TokenBucketPolicy implements RateLimitPolicy<TokenBucketState, TokenBucketStatus> {
	private readonly _profiles: readonly TokenBucketLimitOptions[]

	constructor(profiles: readonly TokenBucketLimitOptions[]) {
		if (profiles.length === 0)
			throw new RangeError('Token Bucket requires at least one profile')

		this._profiles = profiles.map(({ capacity, refillRate }) => {
			if (!Number.isSafeInteger(capacity) || capacity <= 0)
				throw new RangeError('Token Bucket capacity must be a positive safe integer')

			if (!Number.isFinite(refillRate) || refillRate <= 0)
				throw new RangeError('Token Bucket refill rate must be positive and finite')

			return { capacity, refillRate }
		})
	}

	public check(state: TokenBucketState | undefined, time: number): number | undefined {
		if (state === undefined)
			return undefined

		let nextAvailableAt: number | undefined

		for (const [index, profile] of this._profiles.entries()) {
			const { tokens, milliTokens } = state.balances[index]

			if (tokens !== 0)
				continue

			const blockedUntil = this._getBlockedUntil(profile, milliTokens, state.chargedAt, time)

			if (blockedUntil !== undefined)
				nextAvailableAt = Math.max(nextAvailableAt ?? blockedUntil, blockedUntil)
		}

		return nextAvailableAt
	}

	public charge(state: TokenBucketState | undefined, time: number): TokenBucketState {
		if (state === undefined) {
			return {
				chargedAt: time,
				balances: this._profiles.map(profile => ({
					tokens: profile.capacity - 1,
					milliTokens: 0,
				})),
			}
		}

		for (const [index, profile] of this._profiles.entries()) {
			const balance = state.balances[index]
			const refill = this._getRefill(profile, balance.milliTokens, state.chargedAt, time)
			const wholeTokens = Math.floor(refill / MILLI_TOKENS_PER_TOKEN)

			if (wholeTokens >= profile.capacity - balance.tokens) {
				balance.tokens = profile.capacity - 1
				balance.milliTokens = 0
			}
			else {
				balance.tokens += wholeTokens - 1
				balance.milliTokens = refill % MILLI_TOKENS_PER_TOKEN
			}
		}

		state.chargedAt = time

		return state
	}

	public getStatus(state: TokenBucketState | undefined, time: number): TokenBucketStatus {
		const chargedAt = state?.chargedAt ?? time
		const nextAvailableAt = this.check(state, time) ?? time
		const profiles = this._profiles.map((profile, index) => {
			const balance = state?.balances[index]
			const wholeTokens = balance?.tokens ?? profile.capacity
			const milliTokens = balance?.milliTokens ?? 0
			const refill = this._getRefill(profile, milliTokens, chargedAt, time)

			const tokens = Math.min(profile.capacity, wholeTokens + refill / MILLI_TOKENS_PER_TOKEN)

			return { ...profile, tokens }
		})

		return { nextAvailableAt, profiles }
	}

	private _getRefill(profile: TokenBucketLimitOptions, milliTokens: number, chargedAt: number, time: number): number {
		const elapsedMs = time - chargedAt

		if (Number.isFinite(elapsedMs))
			return milliTokens + elapsedMs * profile.refillRate

		const elapsed = toBinary64Units(time) - toBinary64Units(chargedAt)
		const generated = elapsed * toBinary64Units(profile.refillRate)
		const refill = generated + toBinary64Units(milliTokens) * BINARY64_SCALE

		return fromBinary64Units(refill, BINARY64_SCALE, 'nearest')
	}

	private _getBlockedUntil(
		profile: TokenBucketLimitOptions,
		milliTokens: number,
		chargedAt: number,
		time: number,
	): number | undefined {
		const deficit = MILLI_TOKENS_PER_TOKEN - milliTokens
		const estimate = chargedAt + deficit / profile.refillRate
		const elapsedMs = time - chargedAt

		if (!Number.isFinite(elapsedMs) || !Number.isFinite(estimate - chargedAt)) {
			const rate = toBinary64Units(profile.refillRate)
			const deficitUnits = UNITS_PER_TOKEN - toBinary64Units(milliTokens)
			const numerator = toBinary64Units(chargedAt) * rate + deficitUnits * BINARY64_SCALE
			const availableAt = fromBinary64Units(numerator, rate, 'up')

			return availableAt > time ? availableAt : undefined
		}

		if (milliTokens + elapsedMs * profile.refillRate >= MILLI_TOKENS_PER_TOKEN)
			return undefined

		const candidate = estimate > time ? estimate : getNextTimestamp(time)

		if (candidate === Infinity || this._getRefill(profile, milliTokens, chargedAt, candidate) >= MILLI_TOKENS_PER_TOKEN)
			return candidate

		return getNextTimestamp(candidate)
	}
}
