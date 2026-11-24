import { LoggerRuntime, LogLevel } from '@stimulcross/logger'
import { describe, expect, it, vi } from 'vitest'
import { RateLimitError, RateLimitErrorCode } from '../../src/index.js'
import { FixedWindowLimiter } from '../../src/limiters/fixed-window/index.js'

describe('limiter diagnostics', () => {
	it.each([
		{ context: 'OrdersLimiter', expectedContext: 'OrdersLimiter' },
		{ context: undefined, expectedContext: 'FixedWindowLimiter' },
		{ context: '', expectedContext: 'FixedWindowLimiter' },
	])('should log with context $expectedContext when configured with "$context"', async ({ context, expectedContext }) => {
		const limiter = new FixedWindowLimiter({
			limitOptions: { limit: 1, windowMs: 1000 },
			loggerOptions: { context, minLevel: 'info', colors: false, pid: false, timestamps: false },
		})
		const observe = vi.fn()
		const unsubscribe = LoggerRuntime.subscribe(observe)

		try {
			await limiter.destroy()

			expect(observe).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
				context: expectedContext,
				args: ['[LIMITER DESTROYED]'],
			}))
		}
		finally {
			unsubscribe()
		}
	})

	it('should record committed task events in order and escape opted-in identifiers', async () => {
		const output = vi.fn()
		const limiter = new FixedWindowLimiter({
			limitOptions: { limit: 10, windowMs: 1000 },
			queue: { capacity: 1, concurrency: 1 },
			limitBehavior: 'enqueue',
			loggerOptions: { minLevel: 'verbose', includeIdentifiers: true, custom: output },
		})
		const hold = Promise.withResolvers<undefined>()
		const key = 'orders\n"online"'
		const first = limiter.run(async () => await hold.promise, { id: 'first', key })
		const second = limiter.run(() => 'second result', { id: 'second', key })

		try {
			await expect(limiter.run(() => undefined, { id: 'third', key })).rejects.toMatchObject({
				code: RateLimitErrorCode.QueueOverflow,
			})

			hold.resolve(undefined)
			await Promise.all([first, second])

			const callbackError = new RateLimitError(RateLimitErrorCode.Cancelled)

			await expect(limiter.run(() => {
				throw callbackError
			}, { id: 'fourth', key })).rejects.toBe(callbackError)

			const debugMessages = output.mock.calls.flatMap(([level, message]) => level === LogLevel.DEBUG
				? [message]
				: [])
			const quotedKey = String.raw`key="orders\n\"online\""`

			expect(debugMessages).toEqual([
				`[TASK STARTED] id="first" ${quotedKey} | source=immediate priority=Normal waiting=0 active=1`,
				`[TASK QUEUED] id="second" ${quotedKey} | priority=Normal waiting=1 capacity=1`,
				`[TASK REJECTED] id="third" ${quotedKey} | code=QUEUE_OVERFLOW`,
				`[TASK STARTED] id="second" ${quotedKey} | source=queue priority=Normal waiting=0 active=1`,
				`[TASK STARTED] id="fourth" ${quotedKey} | source=immediate priority=Normal waiting=0 active=1`,
			])

			expect(output).toHaveBeenCalledWith(LogLevel.VERBOSE, `[TASK SETTLED] id="fourth" ${quotedKey} | outcome=rejected active=0`)
		}
		finally {
			hold.resolve(undefined)
			await limiter.destroy()
		}

		expect(output).toHaveBeenCalledWith(LogLevel.INFO, '[LIMITER DESTROYED]')
	})

	it('should dispatch outside the start transition and isolate a throwing sink', async () => {
		const callback = vi.fn(() => 'result')
		const beforeClear = vi.fn()
		const limiter = new FixedWindowLimiter({
			limitOptions: { limit: 1, windowMs: 1000 },
			loggerOptions: {
				minLevel: 'debug',
				custom: (_level, message) => {
					if (typeof message === 'string' && message.startsWith('[TASK STARTED]')) {
						beforeClear(callback.mock.calls.length)
						void limiter.clear()
						throw new Error('diagnostic sink failed')
					}
				},
			},
		})

		try {
			const result = limiter.run(callback)
			expect(callback).toHaveBeenCalledTimes(1)
			expect(beforeClear).not.toHaveBeenCalled()
			await expect(result).resolves.toBe('result')
			expect(beforeClear).toHaveBeenCalledExactlyOnceWith(1)
		}
		finally {
			await limiter.destroy()
		}
	})
})
