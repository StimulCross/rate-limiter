import { HttpResponseBasedLimiter } from '@stimulcross/rate-limiter/http-response-based'
import { getSlowdown, scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

function extractFeedback(response, settledAt) {
	if (response === null)
		return null

	if (response.status === 429)
		return { kind: 'rate-limited', retryAt: settledAt + Number(response.headers.get('Retry-After')) * 1000 }

	if (!response.headers.has('X-Quota-Remaining'))
		return null

	return {
		kind: 'quota',
		remaining: Number(response.headers.get('X-Quota-Remaining')),
		resetAt: Number(response.headers.get('X-Quota-Reset-Ms')),
	}
}

const options = {
	limitBehavior: 'enqueue',
	queue: {
		capacity: 8,
		concurrency: 1,
		maxWaitMs: scaleMs(5000),
	},
	extractFeedback,
}

let requests = 0
let resetAt = 0
let remaining = 0

function respond() {
	requests++

	if (requests === 2) {
		return new Response(null, {
			status: 429,
			headers: {
				'Retry-After': String(getSlowdown()),
			},
		})
	}

	if (Date.now() >= resetAt) {
		resetAt = Date.now() + scaleMs(2200)
		remaining = 4
	}

	remaining--

	return new Response(null, {
		headers: {
			'X-Quota-Remaining': String(remaining),
			'X-Quota-Reset-Ms': String(resetAt),
		},
	})
}

printScenario('1/2', 'Probe, HTTP 429 and recovery', 'A simulated API reports quota from the first response. Its second response is HTTP 429 with Retry-After of one second.')
await runFlow(HttpResponseBasedLimiter, options, repeatFlow(createBurst('request', 7, 160, 240), [0, 3500]), respond)

printScenario('2/2', 'A probe without feedback', 'Alpha’s first response has no quota headers, so its next request probes again. Staggered waves show how Alpha and Beta probe and exhaust their own budgets.')

const independentOptions = {
	extractFeedback,
	limitBehavior: 'enqueue',
	queue: { capacity: 10, concurrency: 2 },
}
const windows = new Map()

function respondIndependently(task) {
	if (task.id === 'alpha-1')
		return new Response()

	const now = Date.now()
	let window = windows.get(task.key)

	if (window === undefined || window.resetAt <= now) {
		window = { remaining: 3, resetAt: now + scaleMs(1700) }
		windows.set(task.key, window)
	}

	window.remaining--

	return new Response(null, {
		headers: {
			'X-Quota-Remaining': String(window.remaining),
			'X-Quota-Reset-Ms': String(window.resetAt),
		},
	})
}

await runFlow(HttpResponseBasedLimiter, independentOptions, [
	...repeatFlow(createBurst('alpha', 4, 85, 220), [0, 1750, 3500, 5250]),
	...repeatFlow(createBurst('beta', 3, 105, 160), [450, 2150, 3900, 5700]),
], respondIndependently)
