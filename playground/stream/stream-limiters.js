import { FixedWindowLimiter } from '@stimulcross/rate-limiter/fixed-window'
import { GenericCellLimiter } from '@stimulcross/rate-limiter/generic-cell'
import { HttpResponseBasedLimiter } from '@stimulcross/rate-limiter/http-response-based'
import { LeakyBucketLimiter } from '@stimulcross/rate-limiter/leaky-bucket'
import { SlidingWindowCounterLimiter } from '@stimulcross/rate-limiter/sliding-window-counter'
import { SlidingWindowLogLimiter } from '@stimulcross/rate-limiter/sliding-window-log'
import { TokenBucketLimiter } from '@stimulcross/rate-limiter/token-bucket'
import { getSlowdown, scaleMs } from '../pacing.js'

const factories = {
	'fixed-window': () => ({
		Limiter: FixedWindowLimiter,
		limitOptions: {
			limit: 2,
			windowMs: scaleMs(950),
		},
	}),
	'token-bucket': () => ({
		Limiter: TokenBucketLimiter,
		limitOptions: { capacity: 2, refillRate: 2.5 / getSlowdown() },
	}),
	'sliding-window-log': () => ({
		Limiter: SlidingWindowLogLimiter,
		limitOptions: {
			limit: 2,
			windowMs: scaleMs(950),
		},
	}),
	'sliding-window-counter': () => ({
		Limiter: SlidingWindowCounterLimiter,
		limitOptions: {
			limit: 2,
			windowMs: scaleMs(950),
		},
	}),
	'generic-cell': () => ({
		Limiter: GenericCellLimiter,
		limitOptions: {
			burst: 2,
			intervalMs: scaleMs(400),
		},
	}),
	'leaky-bucket': () => ({
		Limiter: LeakyBucketLimiter,
		limitOptions: {
			intervalMs: scaleMs(460),
		},
	}),
	'http-response-based': createHttpStream,
}

export const streamNames = Object.keys(factories)

export function createStreamLimiter(name, random) {
	const { Limiter, respond, ...options } = factories[name](random)
	const queue = {
		capacity: 5,
		concurrency: 2,
		maxWaitMs: scaleMs(3000),
	}

	return {
		limiter: new Limiter({ ...options, limitBehavior: 'enqueue', queue }),
		queue,
		respond,
	}
}

function createHttpStream(random) {
	const windows = new Map()

	function respond({ key }) {
		const now = Date.now()
		let window = windows.get(key)

		if (window === undefined || now >= window.resetAt) {
			window = { remaining: 3, resetAt: now + scaleMs(1500) }
			windows.set(key, window)
		}

		if (window.remaining === 0 || random() < 0.12) {
			return new Response(null, {
				status: 429,
				headers: {
					'Retry-After': String(getSlowdown()),
				},
			})
		}

		window.remaining--

		return new Response(null, {
			headers: {
				'X-Remaining': String(window.remaining),
				'X-Reset-Ms': String(window.resetAt),
			},
		})
	}

	return { Limiter: HttpResponseBasedLimiter, extractFeedback, respond }
}

function extractFeedback(response, settledAt) {
	if (response === null)
		return null

	if (response.status === 429)
		return { kind: 'rate-limited', retryAt: settledAt + Number(response.headers.get('Retry-After')) * 1000 }

	return {
		kind: 'quota',
		remaining: Number(response.headers.get('X-Remaining')),
		resetAt: Number(response.headers.get('X-Reset-Ms')),
	}
}
