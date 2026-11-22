import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScheduledAlarm } from '../../../src/utils/scheduled-alarm.js'

describe('ScheduledAlarm', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it.each([
		{ at: 102.25, now: 100, delay: 3 },
		{ at: 100, now: 100, delay: 1 },
		{ at: 99, now: 100, delay: 1 },
		{ at: 2_147_483_700, now: 0, delay: 2_147_483_647 },
	])('should wake once after $delay ms for an alarm at $at from $now', ({ at, now, delay }) => {
		const wake = vi.fn()
		const alarm = new ScheduledAlarm(wake)
		alarm.schedule(at, now)

		vi.advanceTimersByTime(delay - 1)
		expect(wake).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(wake).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('should keep a pending timer for the same target when the supplied clock rolls back', () => {
		const wake = vi.fn()
		const alarm = new ScheduledAlarm(wake)
		alarm.schedule(100, 0)
		vi.advanceTimersByTime(40)
		alarm.schedule(100, 0)

		vi.advanceTimersByTime(59)
		expect(wake).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(wake).toHaveBeenCalledOnce()
	})

	it('should ignore a replaced callback even if the host delivers it', () => {
		const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
		const wake = vi.fn()
		const alarm = new ScheduledAlarm(wake)
		alarm.schedule(10, 0)
		const staleCallback = setTimeoutSpy.mock.calls[0]?.[0]

		alarm.schedule(20, 0)
		expect(staleCallback).toBeTypeOf('function')

		if (typeof staleCallback === 'function')
			staleCallback()

		vi.advanceTimersByTime(19)
		expect(wake).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(wake).toHaveBeenCalledOnce()
	})

	it.each(['cancel', 'clear target'])('should release a pending timer via %s', method => {
		const wake = vi.fn()
		const alarm = new ScheduledAlarm(wake)
		alarm.schedule(10, 0)

		if (method === 'cancel')
			alarm.cancel()
		else
			alarm.schedule(undefined, 0)

		expect(vi.getTimerCount()).toBe(0)
		vi.advanceTimersByTime(10)
		expect(wake).not.toHaveBeenCalled()
		alarm.schedule(10, 10)
		vi.advanceTimersByTime(1)
		expect(wake).toHaveBeenCalledOnce()
	})

	it('should let a wake callback rearm the same target', () => {
		const wake = vi.fn()
		const alarm = new ScheduledAlarm(wake)
		wake.mockImplementationOnce(() => alarm.schedule(10, 10))
		alarm.schedule(10, 0)

		vi.advanceTimersByTime(10)
		expect(wake).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(1)
		vi.advanceTimersByTime(1)
		expect(wake).toHaveBeenCalledTimes(2)
		expect(vi.getTimerCount()).toBe(0)
	})
})
