import type { FixedResultRateLimiter, RateLimiterOptions } from '../../../src/index.js'
import type { HttpFeedback, HttpResponseBasedOptions, HttpResponseBasedStatus } from '../../../src/limiters/http-response-based/index.js'
import { LogLevel } from '@stimulcross/logger'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Priority, RateLimitErrorCode } from '../../../src/index.js'
import { HttpResponseBasedLimiter } from '../../../src/limiters/http-response-based/index.js'

function quota(remaining: number, resetAt = 1000): HttpFeedback {
	return { kind: 'quota', remaining, resetAt }
}

function rateLimited(retryAt?: number): HttpFeedback {
	return { kind: 'rate-limited', retryAt }
}

function createLimiter(options?: Partial<HttpResponseBasedOptions>) {
	return new HttpResponseBasedLimiter({
		extractFeedback: response => response as HttpFeedback | null,
		loggerOptions: { minLevel: 'error' },
		...options,
	})
}

describe('HTTP Response Based', () => {
	beforeEach(() => {
		vi.useFakeTimers({
			now: 100,
			toFake: [
				'Date',
				'performance',
				'setTimeout',
				'clearTimeout',
			],
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it('should pass unwrapped responses from different clients to the same extractor', async () => {
		interface ClientResponse {
			remaining: number
		}

		const extractFeedback = vi.fn((response: Response | ClientResponse | null): HttpFeedback | null => {
			if (response instanceof Response)
				return quota(Number(response.headers.get('Remaining')))

			return response === null
				? null
				: quota(response.remaining)
		})
		const limiter = new HttpResponseBasedLimiter({ extractFeedback })
		const shared: FixedResultRateLimiter<Response | ClientResponse, HttpResponseBasedStatus> = limiter
		const fetchResponse = new Response(null, {
			headers: { Remaining: '2' },
		})
		const clientResponse: ClientResponse = { remaining: 3 }
		const fetchResult = shared.run(async () => fetchResponse, { key: 'fetch' })
		const clientResult = limiter.run(() => clientResponse, { key: 'client' })

		expectTypeOf(fetchResult).toEqualTypeOf<Promise<Response | ClientResponse>>()
		expectTypeOf(clientResult).toEqualTypeOf<Promise<Response | ClientResponse>>()
		await expect(fetchResult).resolves.toBe(fetchResponse)
		await expect(clientResult).resolves.toBe(clientResponse)
		await expect(limiter.getStatus('fetch')).resolves.toEqual({ status: 'known', remaining: 2, resetAt: 1000 })
		await expect(limiter.getStatus('client')).resolves.toEqual({ status: 'known', remaining: 3, resetAt: 1000 })
		const received = extractFeedback.mock.calls.map(([response]) => response)
		expect(received).toHaveLength(2)
		expect(received.some(response => response === fetchResponse)).toBe(true)
		expect(received.some(response => response === clientResponse)).toBe(true)
	})

	it('should pass null when a callback yields no response and preserve its outcome', async () => {
		const extractFeedback = vi.fn(() => null)
		const limiter = new HttpResponseBasedLimiter({ extractFeedback })
		const failure = new Error('connection closed')

		await expect(limiter.run(() => null)).resolves.toBeNull()
		await expect(limiter.run(() => undefined)).resolves.toBeUndefined()

		await expect(limiter.run(() => {
			throw failure
		})).rejects.toBe(failure)

		expect(extractFeedback.mock.calls).toEqual([
			[null, 100],
			[null, 100],
			[null, 100],
		])

		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })
	})

	it.each([
		null,
		undefined,
		quota(-1),
		quota(1.5),
		quota(Number.MAX_SAFE_INTEGER + 1),
		quota(1, Infinity),
		quota(2, 99),
		quota(2, 100),
	])('should keep quota unknown after unusable probe feedback %j', async feedback => {
		const limiter = createLimiter()

		await expect(limiter.run(() => feedback)).resolves.toBe(feedback)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })
		await limiter.run(() => quota(2))
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 2, resetAt: 1000 })
	})

	it('should wake a new probe at the exact reset of an exhausted budget', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1 },
		})
		await limiter.run(() => quota(0))

		const callback = vi.fn(() => quota(1, 2000))
		const pending = limiter.run(callback)
		await vi.advanceTimersByTimeAsync(899)
		expect(callback).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(callback).toHaveBeenCalledOnce()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 2000 })
	})

	it('should select a single replacement probe by priority after a response-less failure', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})
		const initial = Promise.withResolvers<HttpFeedback>()
		const replacement = Promise.withResolvers<HttpFeedback>()
		const failure = new Error('connection closed')
		const probe = limiter.run(async () => await initial.promise)
		const nextProbe = vi.fn(async () => await replacement.promise)
		const follower = vi.fn(() => null)
		const waiting = limiter.run(follower)
		const next = limiter.run(nextProbe, { priority: Priority.Highest })
		const settled = Promise.allSettled([probe, waiting, next])

		try {
			expect(nextProbe).not.toHaveBeenCalled()
			expect(follower).not.toHaveBeenCalled()

			initial.reject(failure)
			await expect(probe).rejects.toBe(failure)
			expect(nextProbe).toHaveBeenCalledOnce()
			expect(follower).not.toHaveBeenCalled()
			await expect(limiter.getStatus()).resolves.toEqual({ status: 'probing' })

			const snapshot = quota(1)
			replacement.resolve(snapshot)
			await expect(next).resolves.toBe(snapshot)
			await expect(waiting).resolves.toBeNull()
			expect(follower).toHaveBeenCalledOnce()
			await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 0, resetAt: 1000 })
		}
		finally {
			initial.resolve(quota(1))
			replacement.resolve(quota(1))
			await limiter.destroy()
			await settled
		}
	})

	it('should discard unused budget at reset and let only a new probe fund the next window', async () => {
		const limiter = createLimiter()
		await limiter.run(() => quota(3))

		vi.setSystemTime(999)
		await limiter.run(() => {})
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 2, resetAt: 1000 })

		vi.setSystemTime(1000)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })

		const probe = Promise.withResolvers<HttpFeedback>()
		const pending = limiter.run(async () => await probe.promise)

		try {
			await expect(limiter.getStatus()).resolves.toEqual({ status: 'probing' })
			const follower = vi.fn()
			await expect(limiter.run(follower)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
			expect(follower).not.toHaveBeenCalled()
		}
		finally {
			probe.resolve(quota(1, 2000))
			await pending
		}

		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 2000 })
	})

	it.each([undefined, Infinity, NaN, 100, 99])('should use the fallback cooldown for retryAt %s', async retryAt => {
		const limiter = createLimiter({ fallbackResetDelayMs: 500 })
		const feedback = rateLimited(retryAt)
		await expect(limiter.run(() => feedback)).resolves.toBe(feedback)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'cooling-down', retryAt: 600 })

		const callback = vi.fn()
		vi.setSystemTime(599)
		await expect(limiter.run(callback)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded, retryAfterMs: 1 })
		expect(callback).not.toHaveBeenCalled()

		vi.setSystemTime(600)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })
		await limiter.run(callback)
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should default to 60000 ms and round a sub-ULP cooldown up to the next timestamp', async () => {
		const defaults = createLimiter()
		await defaults.run(() => rateLimited())
		await expect(defaults.getStatus()).resolves.toEqual({ status: 'cooling-down', retryAt: 60_100 })

		const now = 2 ** 53
		vi.spyOn(Date, 'now').mockReturnValue(now)
		const rounded = createLimiter({
			fallbackResetDelayMs: 1,
		})
		await rounded.run(() => rateLimited())
		await expect(rounded.getStatus()).resolves.toEqual({ status: 'cooling-down', retryAt: now + 2 })
	})

	it.each([0, -1, NaN, Infinity])('should reject an invalid fallback delay of %s', fallbackResetDelayMs => {
		expect(() => createLimiter({ fallbackResetDelayMs })).toThrow(RangeError)
	})

	it('should keep the latest cooldown and return a 429 rejection without replay', async () => {
		const httpError = new Error('Too Many Requests')
		const limiter = createLimiter({
			extractResponseFromError: error => error === httpError
				? rateLimited(2000)
				: null,
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 2 },
		})
		await limiter.run(() => quota(2, 150))
		const slow = Promise.withResolvers<HttpFeedback>()
		const first = limiter.run(async () => await slow.promise)

		// The second request must have been charged before rollover.
		vi.setSystemTime(149)
		const tooMany = vi.fn(() => {
			throw httpError
		})
		const rejected = limiter.run(tooMany)
		vi.setSystemTime(150)
		await expect(rejected).rejects.toBe(httpError)

		const nextProbe = vi.fn(() => quota(1, 3000))
		const pending = limiter.run(nextProbe)
		slow.resolve(rateLimited(1500))
		await first
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'cooling-down', retryAt: 2000 })

		await vi.advanceTimersByTimeAsync(1849)
		expect(nextProbe).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		await pending
		expect(tooMany).toHaveBeenCalledOnce()
		expect(nextProbe).toHaveBeenCalledOnce()
	})

	it('should serialize probes behind bounded waiting while an independent key can start', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 2 },
		})
		const first = Promise.withResolvers<undefined>()
		const running = limiter.run(async () => await first.promise, { key: 'A' })
		await expect(limiter.getStatus('A')).resolves.toEqual({ status: 'probing' })

		const callback = vi.fn()
		const waiting = limiter.run(callback, { key: 'A', maxWaitMs: 10 })
		const expired = expect(waiting).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
		await expect(limiter.run(callback, { key: 'A' })).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow })

		await expect(limiter.run(callback, { key: 'A', limitBehavior: 'reject' })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
			retryAfterMs: null,
		})

		await expect(limiter.run(() => 'independent', { key: 'B' })).resolves.toBe('independent')
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(10)
		await expired

		const controller = new AbortController()
		const cancelled = limiter.run(callback, { key: 'A', signal: controller.signal })
		controller.abort()
		await expect(cancelled).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })

		const second = Promise.withResolvers<undefined>()
		const replacement = vi.fn(async () => await second.promise)
		const result = limiter.run(replacement, { key: 'A' })
		first.resolve(undefined)
		await running
		expect(replacement).toHaveBeenCalledOnce()

		const follower = limiter.run(callback, { key: 'A' })
		expect(callback).not.toHaveBeenCalled()
		second.resolve(undefined)
		await Promise.all([result, follower])
		expect(callback).toHaveBeenCalledOnce()
	})

	it('should give the unit reported by a probe to the oldest live follower after cancellation', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 2 },
		})
		const feedback = quota(1, 200)
		const hold = Promise.withResolvers<HttpFeedback>()
		const probe = limiter.run(async () => await hold.promise)
		const controller = new AbortController()
		const abortedCallback = vi.fn()
		const survivorCallback = vi.fn()
		const replacementCallback = vi.fn()
		const aborted = limiter.run(abortedCallback, { signal: controller.signal })
		const survivor = limiter.run(survivorCallback)
		controller.abort()
		const replacement = limiter.run(replacementCallback)
		const settled = Promise.allSettled([probe, aborted, survivor, replacement])

		try {
			await expect(aborted).rejects.toMatchObject({ code: RateLimitErrorCode.Cancelled })
			expect(survivorCallback).not.toHaveBeenCalled()
			expect(replacementCallback).not.toHaveBeenCalled()
			hold.resolve(feedback)
			await expect(probe).resolves.toBe(feedback)
			expect(survivorCallback).toHaveBeenCalledOnce()
			await survivor
			await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 0, resetAt: 200 })

			await vi.advanceTimersByTimeAsync(99)
			expect(replacementCallback).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(1)
			expect(replacementCallback).toHaveBeenCalledOnce()
			await replacement
			expect(abortedCallback).not.toHaveBeenCalled()
		}
		finally {
			hold.resolve(feedback)
			await limiter.destroy()
			await settled
		}
	})

	it('should wait for an ordinary request that outlives a 429 cooldown before probing', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 2 },
		})
		await limiter.run(() => quota(2))
		const hold = Promise.withResolvers<undefined>()
		const ordinary = limiter.run(async () => await hold.promise)
		await limiter.run(() => rateLimited(150))

		const callback = vi.fn(() => quota(1))
		const waiting = limiter.run(callback)
		expect(vi.getTimerCount()).toBe(1)
		await vi.advanceTimersByTimeAsync(50)
		expect(vi.getTimerCount()).toBe(0)
		expect(callback).not.toHaveBeenCalled()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })

		hold.resolve(undefined)
		await Promise.all([ordinary, waiting])
		expect(callback).toHaveBeenCalledOnce()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 1000 })
	})

	it('should let a winning arrival use a free slot with zero waiting capacity', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 0, concurrency: 2 },
		})
		const hold = Promise.withResolvers<undefined>()
		const first = limiter.run(async () => await hold.promise, { key: 'A' })
		const independent = vi.fn()

		const result = limiter.run(independent, { key: 'B', maxWaitMs: 0 })
		expect(independent).toHaveBeenCalledOnce()
		await expect(limiter.run(independent, { key: 'A' })).rejects.toMatchObject({ code: RateLimitErrorCode.QueueOverflow })
		expect(independent).toHaveBeenCalledOnce()

		hold.resolve(undefined)
		await Promise.all([first, result])
	})

	it('should use global priority selection between eligible heads on slot release', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 2, concurrency: 1 },
		})
		const hold = Promise.withResolvers<undefined>()
		const first = limiter.run(async () => await hold.promise)
		const order: string[] = []
		const low = limiter.run(() => order.push('low'), { key: 'low', priority: Priority.Low })
		const high = limiter.run(() => order.push('high'), { key: 'high', priority: Priority.High })

		hold.resolve(undefined)
		await Promise.all([first, low, high])
		expect(order).toEqual(['high', 'low'])
	})

	it('should consider a due queued head against a new arrival before the alarm fires', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		await limiter.run(() => quota(0), { key: 'A' })
		const older = vi.fn()
		const waiting = limiter.run(older, { key: 'A' })
		vi.setSystemTime(1000)

		const arrival = vi.fn()
		const rejected = limiter.run(arrival, { key: 'B', maxWaitMs: 0 })
		expect(older).toHaveBeenCalledOnce()
		await expect(rejected).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
		expect(arrival).not.toHaveBeenCalled()
		await waiting
	})

	it('should debit before invocation and only tighten the budget when responses arrive in reverse order', async () => {
		const limiter = createLimiter({
			queue: { concurrency: 3 },
		})
		await limiter.run(() => quota(3))
		const older = Promise.withResolvers<HttpFeedback>()
		const newer = Promise.withResolvers<HttpFeedback>()
		const beforeFirst = vi.fn(async () => await older.promise)
		const first = limiter.run(beforeFirst)
		const beforeSecond = vi.fn(async () => await newer.promise)
		const second = limiter.run(beforeSecond)

		expect(beforeFirst).toHaveBeenCalledOnce()
		expect(beforeSecond).toHaveBeenCalledOnce()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 1000 })

		newer.resolve(quota(0))
		await second
		older.resolve(quota(2))
		await first
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 0, resetAt: 1000 })
		await expect(limiter.run(beforeFirst)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
		expect(beforeFirst).toHaveBeenCalledOnce()
	})

	it('should expose each debit at callback entry and block the next start with both units spent', async () => {
		const limiter = createLimiter({
			queue: { concurrency: 3 },
		})
		await limiter.run(() => quota(2))
		const hold = Promise.withResolvers<undefined>()
		const statuses: Promise<unknown>[] = []
		const ordinary = vi.fn(async () => {
			statuses.push(limiter.getStatus())

			return await hold.promise
		})
		const first = limiter.run(ordinary)
		const second = limiter.run(ordinary)

		await expect(limiter.run(ordinary)).rejects.toMatchObject({ code: RateLimitErrorCode.LimitExceeded })
		expect(ordinary).toHaveBeenCalledTimes(2)

		expect(await Promise.all(statuses)).toEqual([
			{ status: 'known', remaining: 1, resetAt: 1000 },
			{ status: 'known', remaining: 0, resetAt: 1000 },
		])

		hold.resolve(undefined)
		await Promise.all([first, second])
	})

	it('should ignore feedback for a different window and wait for all ordinary callbacks at expiry', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 3 },
		})
		await limiter.run(() => quota(3))
		const slow = Promise.withResolvers<HttpFeedback>()
		const running = limiter.run(async () => await slow.promise)
		await limiter.run(() => quota(0, 2000))
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 1000 })

		vi.setSystemTime(1000)
		const probe = vi.fn(() => quota(1, 3000))
		const nextWindow = limiter.run(probe)
		expect(probe).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })

		slow.resolve(quota(100, 2000))
		await running
		await nextWindow
		expect(probe).toHaveBeenCalledOnce()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 3000 })
	})

	it.each([
		{
			key: 'A',
			late: quota(0),
		},
		{
			key: 'A',
			late: rateLimited(2000),
		},
		{
			key: undefined,
			late: quota(0),
		},
		{
			key: undefined,
			late: rateLimited(2000),
		},
	])('should isolate stale feedback after clear($key) with feedback $late.kind', async ({ key, late }) => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 1 },
		})
		await limiter.run(() => quota(4), { key: 'B' })
		const hold = Promise.withResolvers<HttpFeedback>()
		const old = limiter.run(async () => await hold.promise, { key: 'A' })
		const callback = vi.fn(() => quota(3))
		const pending = limiter.run(callback, { key: 'A' })
		const cleared = expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Cleared })

		await limiter.clear(key)
		await cleared
		await expect(limiter.getStatus('A')).resolves.toEqual({ status: 'unknown' })

		await expect(limiter.getStatus('B')).resolves.toMatchObject({
			status: key === undefined
				? 'unknown'
				: 'known',
		})

		await expect(limiter.run(callback, { key: 'A', maxWaitMs: 0 })).rejects.toMatchObject({
			code: RateLimitErrorCode.LimitExceeded,
		})

		const replacement = limiter.run(callback, { key: 'A' })
		expect(callback).not.toHaveBeenCalled()

		hold.resolve(late)
		await expect(old).resolves.toBe(late)
		await replacement
		expect(callback).toHaveBeenCalledOnce()
		await expect(limiter.getStatus('A')).resolves.toEqual({ status: 'known', remaining: 3, resetAt: 1000 })
	})

	it('should recheck generation after extraction clears and repopulates the same key', async () => {
		const replacement = Promise.withResolvers<HttpFeedback>()
		const started = vi.fn(async () => await replacement.promise)
		let replacementResult: Promise<unknown> | undefined
		const limiter = createLimiter({
			extractFeedback: response => {
				if (response === 'old') {
					void limiter.clear()
					replacementResult = limiter.run(started)

					return rateLimited(5000)
				}

				return quota(3)
			},
		})
		await expect(limiter.run(() => 'old')).resolves.toBe('old')
		expect(started).toHaveBeenCalledOnce()
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'probing' })
		replacement.resolve(quota(3))
		await replacementResult
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 3, resetAt: 1000 })
	})

	it('should recheck the effective epoch after reentrant extraction and preserve the watermark across rollback', async () => {
		vi.setSystemTime(100)
		const times: number[] = []
		const limiter = createLimiter({
			extractFeedback: (_response, time) => {
				times.push(time)
				vi.setSystemTime(300)

				return quota(2, 200)
			},
		})
		await limiter.run(() => undefined)
		vi.setSystemTime(120)
		await limiter.run(() => undefined)
		expect(times).toEqual([100, 300])
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })
	})

	it('should keep status observational across clock rollback', async () => {
		const limiter = createLimiter()
		await limiter.run(() => quota(2))
		vi.setSystemTime(1000)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'unknown' })
		vi.setSystemTime(101)
		await limiter.run(() => undefined)
		await expect(limiter.getStatus()).resolves.toEqual({ status: 'known', remaining: 1, resetAt: 1000 })
	})

	it('should close admission and ignore both old snapshots and 429s during destruction', async () => {
		const extractor = vi.fn()
		const limiter = createLimiter({
			extractFeedback: extractor,
			limitBehavior: 'enqueue',
			queue: { capacity: 1, concurrency: 2 },
		})
		const snapshot = Promise.withResolvers<HttpFeedback>()
		const cooldown = Promise.withResolvers<HttpFeedback>()
		const a = limiter.run(async () => await snapshot.promise, { key: 'A' })
		const b = limiter.run(async () => await cooldown.promise, { key: 'B' })
		const callback = vi.fn()
		const pending = limiter.run(callback, { key: 'A' })
		const rejected = expect(pending).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
		const done = vi.fn()
		const shutdown = limiter.destroy()
		void shutdown.then(done)

		expect(limiter.destroy()).toBe(shutdown)
		await rejected
		await expect(limiter.run(callback)).rejects.toMatchObject({ code: RateLimitErrorCode.Destroyed })
		snapshot.resolve(quota(2))
		await a
		expect(done).not.toHaveBeenCalled()
		cooldown.resolve(rateLimited(2000))
		await expect(b).resolves.toEqual(rateLimited(2000))
		await shutdown

		expect(done).toHaveBeenCalledOnce()
		expect(callback).not.toHaveBeenCalled()
		expect(extractor).not.toHaveBeenCalled()
		await expect(limiter.getStatus('A')).resolves.toEqual({ status: 'unknown' })
		await expect(limiter.getStatus('B')).resolves.toEqual({ status: 'unknown' })
	})

	it('should reuse bounded waiting storage after abort and expiry behind an event-blocked key', async () => {
		const limiter = createLimiter({
			limitBehavior: 'enqueue',
			queue: { capacity: 2 },
		})
		const hold = Promise.withResolvers<undefined>()
		const running = limiter.run(async () => await hold.promise)
		const head = limiter.run(() => 'head', { maxWaitMs: 1000 })
		const callback = vi.fn()
		// eslint-disable-next-line ts/dot-notation -- Verify retained waiting storage under churn.
		const coordinator = limiter['_coordinator']

		for (let index = 0; index < 100; index++) {
			const controller = new AbortController()
			const pending = limiter.run(callback, { maxWaitMs: 1, signal: controller.signal })
			const aborted = index % 2 === 0
			const rejected = expect(pending).rejects.toMatchObject({
				code: aborted ? RateLimitErrorCode.Cancelled : RateLimitErrorCode.Expired,
			})

			if (aborted)
				controller.abort()
			else
				await vi.advanceTimersByTimeAsync(1)

			await rejected
			/* eslint-disable ts/dot-notation -- Verify retained waiting storage under churn. */
			expect(coordinator['_scheduler'].size).toBe(1)
			expect(coordinator['_deadlines']['_data']).toHaveLength(1)
			expect(coordinator['_wakeups']['_data']).toHaveLength(0)
			expect(coordinator['_abortGroups'].size).toBe(0)
			/* eslint-enable ts/dot-notation */
			expect(vi.getTimerCount()).toBe(1)
		}

		hold.resolve(undefined)
		await running
		await expect(head).resolves.toBe('head')
		expect(callback).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should emit warning for malformed feedback and extractor failure without leaking outcomes or identifiers', async () => {
		const output = vi.fn()
		const privateError = new Error('private extractor details')
		const privateResponse = { body: 'private HTTP response' }
		const limiter = createLimiter({
			loggerOptions: { custom: output },
			extractFeedback: response => {
				if (response !== null)
					return quota(-1)

				throw privateError
			},
		})
		await expect(limiter.run(() => privateResponse, { key: 'secret', id: 'probe' })).resolves.toBe(privateResponse)
		const failure = new Error('private callback error')

		await expect(limiter.run(() => {
			throw failure
		}, { key: 'secret' })).rejects.toBe(failure)

		await expect(limiter.getStatus('secret')).resolves.toEqual({ status: 'unknown' })

		expect(output.mock.calls).toEqual([
			[LogLevel.WARNING, '[HTTP FEEDBACK INVALID]'],
			[LogLevel.WARNING, '[HTTP EXTRACTOR FAILED]'],
		])
	})

	it('should log committed feedback and common task events with escaped opted-in identifiers', async () => {
		const output = vi.fn()
		const limiter = createLimiter({
			loggerOptions: { custom: output, minLevel: 'verbose', includeIdentifiers: true },
			limitBehavior: 'enqueue',
			queue: { capacity: 1 },
		})
		const key = 'orders\n"online"'
		const hold = Promise.withResolvers<HttpFeedback>()
		const probe = limiter.run(async () => await hold.promise, { id: 'probe', key })
		const pending = limiter.run(() => rateLimited(500), { id: 'next', key })

		hold.resolve(quota(1))
		await Promise.all([probe, pending])
		await limiter.destroy()
		const quotedKey = String.raw`key="orders\n\"online\""`

		expect(output.mock.calls.filter(([level]) => level === LogLevel.DEBUG)).toEqual([
			[LogLevel.DEBUG, `[TASK STARTED] id="probe" ${quotedKey} | source=immediate priority=Normal waiting=0 active=1`],
			[LogLevel.DEBUG, `[TASK QUEUED] id="next" ${quotedKey} | priority=Normal waiting=1 capacity=1`],
			[LogLevel.DEBUG, `[HTTP BUDGET INSTALLED] id="probe" ${quotedKey} | remaining=1 resetAt=1000`],
			[LogLevel.DEBUG, `[TASK STARTED] id="next" ${quotedKey} | source=queue priority=Normal waiting=0 active=1`],
			[LogLevel.DEBUG, `[HTTP COOLDOWN STARTED] id="next" ${quotedKey} | retryAfterMs=400`],
		])

		expect(output).toHaveBeenCalledWith(LogLevel.INFO, '[LIMITER DESTROYED]')
	})

	describe('admission and waiting', () => {
		function createTimestampLimiter(options: RateLimiterOptions) {
			return createLimiter({
				...options,
				extractFeedback: response => typeof response === 'number'
					? quota(0, response + 100)
					: null,
			})
		}

		beforeEach(() => {
			vi.setSystemTime(0)
		})

		it('should honor a per-task admission mode without changing the instance default', async () => {
			const limiter = createTimestampLimiter({
				queue: { capacity: 1 },
			})
			const rejected = vi.fn()
			const queued = vi.fn(Date.now)

			await limiter.run(Date.now)

			await expect(limiter.run(rejected)).rejects.toMatchObject({
				code: RateLimitErrorCode.LimitExceeded,
				retryAfterMs: 100,
			})

			const pending = limiter.run(queued, { limitBehavior: 'enqueue' })
			const settled = Promise.allSettled([pending])

			try {
				await expect(limiter.run(rejected)).rejects.toMatchObject({
					code: RateLimitErrorCode.LimitExceeded,
					retryAfterMs: 100,
				})

				await vi.advanceTimersByTimeAsync(99)
				expect(queued).not.toHaveBeenCalled()
				await vi.advanceTimersByTimeAsync(1)
				await expect(pending).resolves.toBe(100)
				expect(queued).toHaveBeenCalledOnce()
				expect(rejected).not.toHaveBeenCalled()
			}
			finally {
				await limiter.destroy()
				await settled
			}
		})

		it('should reject a pre-aborted submission and leave its key ready for the next run', async () => {
			const limiter = createTimestampLimiter({})
			const callback = vi.fn(Date.now)

			await expect(limiter.run(callback, {
				signal: AbortSignal.abort(),
			})).rejects.toMatchObject({
				code: RateLimitErrorCode.Cancelled,
			})

			expect(callback).not.toHaveBeenCalled()
			await expect(limiter.run(callback)).resolves.toBe(0)
			expect(callback).toHaveBeenCalledOnce()
		})

		it('should apply the default deadline and let a per-task override wait for quota', async () => {
			const limiter = createTimestampLimiter({
				limitBehavior: 'enqueue',
				queue: { capacity: 2, maxWaitMs: 50 },
			})
			await limiter.run(Date.now)
			const shortCallback = vi.fn(Date.now)
			const longCallback = vi.fn(Date.now)
			const short = limiter.run(shortCallback)
			const long = limiter.run(longCallback, { maxWaitMs: 125 })
			const settled = Promise.allSettled([short, long])

			try {
				const shortRejected = vi.fn()
				void short.catch(shortRejected)

				await expect(limiter.run(shortCallback, { maxWaitMs: 200 })).rejects.toMatchObject({
					code: RateLimitErrorCode.QueueOverflow,
				})

				await vi.advanceTimersByTimeAsync(49)
				expect(shortRejected).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(1)
				await expect(short).rejects.toMatchObject({ code: RateLimitErrorCode.Expired })
				expect(shortCallback).not.toHaveBeenCalled()
				expect(longCallback).not.toHaveBeenCalled()

				await vi.advanceTimersByTimeAsync(50)
				await expect(long).resolves.toBe(100)
				expect(longCallback).toHaveBeenCalledOnce()
			}
			finally {
				await limiter.destroy()
				await settled
			}
		})
	})
})
