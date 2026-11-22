const FLOAT_BITS = new DataView(new ArrayBuffer(8))

/** @internal */
export function getNextTimestamp(time: number): number {
	if (time === 0)
		return Number.MIN_VALUE

	FLOAT_BITS.setFloat64(0, time)
	const bits = FLOAT_BITS.getBigUint64(0)

	FLOAT_BITS.setBigUint64(0, bits + (time > 0 ? 1n : -1n))

	return FLOAT_BITS.getFloat64(0)
}

/** @internal */
export function addTimestampDelay(time: number, delayMs: number): number {
	const sum = time + delayMs

	if (!Number.isFinite(sum))
		return sum

	const error = Math.abs(time) >= delayMs
		? delayMs - (sum - time)
		: time - (sum - delayMs)

	return error > 0 ? getNextTimestamp(sum) : sum
}
