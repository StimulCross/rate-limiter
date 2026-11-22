import { LoggerRuntime, LogLevel } from '@stimulcross/logger'
import { describe, expect, it, vi } from 'vitest'
import { createLimiterLogger } from '../../../src/utils/limiter-logging.js'

describe('createLimiterLogger', () => {
	it('should filter locally and globally before assembling arguments', async () => {
		const output = vi.fn()
		const getFields = vi.fn(() => ({ id: 'private-task', key: 'private-key', waiting: 1 }))
		const log = createLimiterLogger('LimiterTest', { custom: output })
		const globalMinLevel = LoggerRuntime.globalMinLevel

		try {
			LoggerRuntime.setGlobalMinLevel(null)
			log(LogLevel.DEBUG, 'TASK QUEUED', getFields)
			await Promise.resolve()
			expect(getFields).not.toHaveBeenCalled()

			LoggerRuntime.setGlobalMinLevel('error')
			log(LogLevel.WARNING, 'LIMITER WARNING', getFields)
			await Promise.resolve()
			expect(getFields).not.toHaveBeenCalled()
			expect(output).not.toHaveBeenCalled()

			log(LogLevel.ERROR, 'LIMITER FAILED', getFields)
			await Promise.resolve()
			expect(getFields).toHaveBeenCalledTimes(1)
			expect(output).toHaveBeenCalledExactlyOnceWith(LogLevel.ERROR, '[LIMITER FAILED] | waiting=1')
		}
		finally {
			LoggerRuntime.setGlobalMinLevel(globalMinLevel)
		}
	})

	it('should defer formatting and escape opted-in identifiers while preserving zero-valued fields', async () => {
		const output = vi.fn()
		const getFields = vi.fn(() => ({
			id: '',
			key: 'key\u0085\u2028\u202E\u2069',
			waiting: 0,
			active: undefined,
		}))
		const log = createLimiterLogger('LimiterTest', { custom: output, includeIdentifiers: true })

		log(LogLevel.ERROR, 'TASK FAILED', getFields)
		expect(getFields).not.toHaveBeenCalled()
		expect(output).not.toHaveBeenCalled()

		await Promise.resolve()
		expect(getFields).toHaveBeenCalledOnce()

		expect(output).toHaveBeenCalledExactlyOnceWith(
			LogLevel.ERROR,
			String.raw`[TASK FAILED] id="" key="key\u0085\u2028\u202e\u2069" | waiting=0`,
		)
	})

	it('should forward Error instances and omit other rejection values', async () => {
		const output = vi.fn()
		const log = createLimiterLogger('LimiterTest', { custom: output })
		const error = new Error('callback failed')

		log(LogLevel.ERROR, 'CALLBACK FAILED', undefined, error)
		log(LogLevel.ERROR, 'CALLBACK REJECTED', undefined, 'sensitive value')

		await Promise.resolve()

		expect(output.mock.calls).toEqual([
			[LogLevel.ERROR, '[CALLBACK FAILED]', error],
			[LogLevel.ERROR, '[CALLBACK REJECTED]'],
		])
	})
})
