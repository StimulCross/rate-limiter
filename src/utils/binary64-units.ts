const FRACTION_BITS = 52n
const IMPLICIT_BIT = 1n << FRACTION_BITS
const UNIT_EXPONENT = 1074
const FLOAT_BITS = new DataView(new ArrayBuffer(8))

/** @internal */
export function toBinary64Units(value: number): bigint {
	if (Number.isInteger(value))
		return BigInt(value) << BigInt(UNIT_EXPONENT)

	FLOAT_BITS.setFloat64(0, value)
	const magnitude = FLOAT_BITS.getBigUint64(0) & ((1n << 63n) - 1n)
	const exponent = magnitude >> FRACTION_BITS
	const fraction = magnitude & (IMPLICIT_BIT - 1n)
	const units = exponent === 0n
		? fraction
		: (IMPLICIT_BIT + fraction) << (exponent - 1n)

	return value < 0
		? -units
		: units
}

/** @internal */
export function fromBinary64Units(
	numerator: bigint,
	denominator: bigint,
	rounding: 'nearest' | 'up',
): number {
	const isNegative = numerator < 0n
	const magnitude = isNegative ? -numerator : numerator
	const integer = magnitude / denominator
	// A normal Number holds 53 significant bits. Below that range, the unit stays fixed.
	const shift = Math.max(0, integer.toString(2).length - 53)
	const step = denominator << BigInt(shift)
	const remainder = magnitude % step
	const midpointComparison = 2n * remainder - step
	let significand = magnitude / step

	const shouldRoundUp = rounding === 'up'
		? !isNegative && remainder !== 0n
		: midpointComparison > 0n || (midpointComparison === 0n && significand % 2n !== 0n)

	if (shouldRoundUp)
		significand++

	const value = Number(significand) * 2 ** (shift - UNIT_EXPONENT)

	return isNegative ? -value : value
}
