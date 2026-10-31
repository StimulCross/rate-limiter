import { env, stdout } from 'node:process'

const MAX_TIMEOUT_MS = 2_147_483_647

export const DEFAULT_STREAM_SLOWDOWN = 4

function readInteger(name, input, minimum) {
	const value = Number(input)

	if (!Number.isSafeInteger(value) || value < minimum || value > MAX_TIMEOUT_MS)
		throw new RangeError(`${name} must be an integer between ${minimum} and ${MAX_TIMEOUT_MS}`)

	return value
}

let slowdown

export function getSlowdown() {
	slowdown ??= readInteger('PLAYGROUND_SLOWDOWN', env.PLAYGROUND_SLOWDOWN ?? (stdout.isTTY ? 2 : 1), 1)

	return slowdown
}

export function configureStreamSlowdown(value) {
	slowdown = value === undefined
		? readInteger('PLAYGROUND_SLOWDOWN', env.PLAYGROUND_SLOWDOWN ?? DEFAULT_STREAM_SLOWDOWN, 1)
		: readInteger('--slowdown', value, 1)
}

export const pauseMs = readInteger('PLAYGROUND_PAUSE_MS', env.PLAYGROUND_PAUSE_MS ?? (stdout.isTTY ? 1500 : 0), 0)

export function scaleMs(duration) {
	if (duration === undefined)
		return

	const scaled = duration * getSlowdown()

	if (scaled > MAX_TIMEOUT_MS)
		throw new RangeError('The slowdown exceeds the timer range for this scenario')

	return scaled
}
