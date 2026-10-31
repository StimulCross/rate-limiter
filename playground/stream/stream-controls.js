import { stdin } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import { getSlowdown } from '../pacing.js'
import { isDashboardEnabled } from '../terminal/presentation.js'

const MAX_TIMER_MS = 2_147_483_647

export function createStreamControls({ signal, requestStop, onChange }) {
	let slowdown = getSlowdown()
	let paused = false
	let wake

	function interruptWait() {
		wake?.()
	}

	function describe() {
		return paused
			? `PAUSED · arrivals ${slowdown}×`
			: `Arrivals ${slowdown}×`
	}

	function onKeypress(text, key) {
		if (key?.ctrl && key.name === 'c') {
			requestStop()

			return
		}

		switch (text) {
			case '+':
			case '=':
				slowdown = Math.max(1, slowdown - 1)

				break
			case '-':
			case '−':
				slowdown++

				break
			case ' ':
				paused = !paused

				break
			default:
				return
		}

		interruptWait()
		onChange(describe())
	}

	const interactive = stdin.isTTY && isDashboardEnabled()
	const wasRaw = stdin.isRaw
	const wasFlowing = stdin.readableFlowing

	if (interactive) {
		emitKeypressEvents(stdin)
		stdin.setRawMode(true)
		stdin.on('keypress', onKeypress)
		stdin.resume()
	}

	signal.addEventListener('abort', interruptWait)

	return {
		interactive,
		describe,
		async wait(duration) {
			let remaining = duration

			while (remaining > 0) {
				signal.throwIfAborted()
				const startedAt = performance.now()
				const isPaused = paused
				const factor = slowdown

				await new Promise(resolve => {
					const timer = isPaused
						? undefined
						: setTimeout(resolve, Math.min(MAX_TIMER_MS, Math.ceil(remaining * factor)))

					wake = () => {
						clearTimeout(timer)
						resolve()
					}
				})

				wake = undefined

				if (!isPaused)
					remaining -= (performance.now() - startedAt) / factor
			}

			signal.throwIfAborted()
		},
		dispose() {
			signal.removeEventListener('abort', interruptWait)

			if (interactive) {
				stdin.off('keypress', onKeypress)
				stdin.setRawMode(wasRaw)

				if (wasFlowing !== true)
					stdin.pause()
			}
		},
	}
}
