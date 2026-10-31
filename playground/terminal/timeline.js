import { stdout } from 'node:process'
import { scaleMs } from '../pacing.js'
import { isDashboardEnabled } from './presentation.js'
import { renderTimeline } from './render-timeline.js'
import { createTimelineState } from './timeline-state.js'

const REFRESH_MS = 100
const HISTORY_STEPS = 45

export function createTimeline(limiter, { tasks, keys, beganAt, readFlow }) {
	if (!isDashboardEnabled())
		return

	const stepMs = scaleMs(REFRESH_MS)
	const state = createTimelineState(tasks, keys, stepMs, HISTORY_STEPS)
	const { lanes } = state

	if (stdout.rows > 0 && stdout.rows < 2 * lanes.size + 8)
		return

	function elapsed() {
		return Math.round(performance.now() - beganAt)
	}

	function record(event, task, detail, wasQueued) {
		state.record(event, task, detail, wasQueued, elapsed())
	}

	let previousLines = 0
	let frame
	let frameError
	let timer
	let stopped = false

	async function render(isFinal = false) {
		const statuses = await Promise.all(Array.from(lanes.keys(), async key => await limiter.getStatus(key)))
		const now = elapsed()
		const step = Math.floor(now / stepMs)
		state.sample(statuses, Date.now(), step)
		const lines = renderTimeline({
			state,
			flow: readFlow(),
			now,
			step,
			stepMs,
			historySteps: HISTORY_STEPS,
			columns: stdout.columns || 80,
			rows: stdout.rows || Infinity,
			isFinal,
		})

		const cursor = previousLines > 0
			? `\x1B[${previousLines}F\x1B[J`
			: ''
		stdout.write(`${cursor + lines.join('\n')}\n`)
		previousLines = lines.length
	}

	function refresh() {
		frame = render().then(() => {
			if (!stopped)
				timer = setTimeout(refresh, REFRESH_MS)
		}, err => {
			frameError = err
		})
	}

	refresh()

	return {
		record,
		async stop() {
			stopped = true
			clearTimeout(timer)
			await frame

			if (frameError)
				throw frameError

			await render(true)
		},
	}
}
