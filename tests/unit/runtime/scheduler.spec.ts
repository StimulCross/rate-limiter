import type { FixedWindowState } from '../../../src/limiters/fixed-window/fixed-window.state.js'
import { describe, expect, it } from 'vitest'
import { Priority } from '../../../src/index.js'
import { FixedWindowPolicy } from '../../../src/limiters/fixed-window/fixed-window.policy.js'
import { Scheduler } from '../../../src/runtime/scheduler.js'
import { ASCENDING_PRIORITIES, OneBReference } from '../../helpers/one-b-reference.js'

const UNIT_WEIGHTS = {
	[Priority.Lowest]: 1,
	[Priority.Low]: 1,
	[Priority.Normal]: 1,
	[Priority.High]: 1,
	[Priority.Highest]: 1,
}

function compareNextStart(scheduler: Scheduler<number>, reference: OneBReference, ready: ReadonlySet<string>) {
	const expected = reference.start(ready)
	const selected = scheduler.select()
	expect(selected).toBe(expected)

	if (selected !== undefined)
		expect(scheduler.start(selected)).toBe(true)

	expect(scheduler.size).toBe(reference.tasks.length)

	return selected
}

describe('Scheduler', () => {
	it('should match every start of the saturated one-key trace', () => {
		const scheduler = new Scheduler<number>(10)
		const reference = new OneBReference([1n, 2n, 4n, 8n, 16n])
		const key = 'saturated'
		const ready = new Set([key])
		let sequence = 0

		for (const priority of ASCENDING_PRIORITIES.toReversed()) {
			reference.enqueue(scheduler.enqueue(key, priority, sequence++, true))
			reference.enqueue(scheduler.enqueue(key, priority, sequence++, true))
		}

		const starts: Priority[] = []

		for (let index = 0; index < 4000; index++) {
			const { priority } = compareNextStart(scheduler, reference, ready)!
			starts.push(priority)
			reference.enqueue(scheduler.enqueue(key, priority, sequence++, true))
		}

		for (let start = 49; start + 63 <= starts.length; start += 63) {
			const period = starts.slice(start, start + 63)

			expect(ASCENDING_PRIORITIES.map(priority => period.filter(value => value === priority).length))
				.toEqual([3, 4, 8, 16, 32])
		}
	})

	it.each([false, true])('should match the periodic-key trace with protected-head removal set to %s', removeOldest => {
		const scheduler = new Scheduler<number>(6, UNIT_WEIGHTS)
		const reference = new OneBReference([1n, 1n, 1n, 1n, 1n])
		const quota = new FixedWindowPolicy([
			{ alignment: 'grid', limit: 1, windowMs: 1000 },
		])
		const quotaStates = new Map<string, FixedWindowState>()
		const usedWindow = new Map<string, number>()
		let sequence = 0

		function enqueue(key: string, priority: Priority, time: number) {
			const task = scheduler.enqueue(key, priority, sequence++, quota.check(quotaStates.get(key), time) === undefined)
			reference.enqueue(task)

			return task
		}

		function startAt(time: number) {
			const window = Math.floor(time / 1000)
			const ready = new Set<string>()

			for (const key of ['A', 'B']) {
				scheduler.setReady(key, quota.check(quotaStates.get(key), time) === undefined)

				if (usedWindow.get(key) !== window)
					ready.add(key)
			}

			const winner = compareNextStart(scheduler, reference, ready)!
			const state = quotaStates.get(winner.key)
			expect(quota.check(state, time)).toBeUndefined()
			quotaStates.set(winner.key, quota.charge(state, time))
			usedWindow.set(winner.key, window)
			scheduler.setReady(winner.key, false)

			return winner
		}

		const target = enqueue('A', Priority.Lowest, 0)
		const successor = enqueue('A', Priority.Lowest, 0)
		let high = enqueue('A', Priority.Highest, 0)
		let low = enqueue('B', Priority.Lowest, 0)

		for (let now = 0; now < 4000; now += 1000) {
			expect(startAt(now)).toBe(high)
			high = enqueue('A', Priority.Highest, now)

			const transient = enqueue('B', Priority.Highest, now + 250)
			expect(startAt(now + 500)).toBe(low)
			low = enqueue('B', Priority.Lowest, now + 500)
			expect(scheduler.remove(transient)).toBe(true)
			reference.remove(transient)

			const younger = enqueue('A', successor.priority, now + 750)
			expect(scheduler.remove(younger)).toBe(true)
			reference.remove(younger)
		}

		if (removeOldest) {
			expect(scheduler.remove(target)).toBe(true)
			reference.remove(target)
		}

		expect(startAt(4000)).toBe(removeOldest ? high : target)
	})

	it('should keep submission order across readiness changes, removals and rank relabeling', () => {
		const scheduler = new Scheduler<string>(3, UNIT_WEIGHTS)
		const first = scheduler.enqueue('A', Priority.Normal, 'first', false)
		const oldestReady = scheduler.enqueue('B', Priority.Normal, 'second', true)
		const third = scheduler.enqueue('A', Priority.Normal, 'third', false)

		for (let index = 0; index < 1000; index++) {
			const transient = scheduler.enqueue('A', Priority.Normal, 'transient', false)
			expect(transient.rank).toBeLessThan(8n)
			expect(scheduler.select()).toBe(oldestReady)
			expect(scheduler.remove(transient)).toBe(true)
			expect(scheduler.remove(transient)).toBe(false)
			expect(scheduler.size).toBe(3)
		}

		scheduler.setReady('A', true)
		expect(scheduler.start(oldestReady)).toBe(false)
		expect(scheduler.select()).toBe(first)
		expect(scheduler.start(first)).toBe(true)
		expect(scheduler.start(oldestReady)).toBe(true)
		expect(scheduler.start(third)).toBe(true)
		expect(scheduler.select()).toBeUndefined()
		expect(scheduler.size).toBe(0)
	})

	it('should retain class history when all keyed waiting records are removed', () => {
		const scheduler = new Scheduler<string>(2, UNIT_WEIGHTS)
		const high = scheduler.enqueue('A', Priority.High, 'first high', true)
		const low = scheduler.enqueue('B', Priority.Low, 'first low', true)

		expect(scheduler.start(high)).toBe(true)
		expect(scheduler.remove(low)).toBe(true)
		expect(scheduler.select()).toBeUndefined()

		const alone = scheduler.enqueue('A', Priority.Low, 'alone', true)
		expect(scheduler.start(alone)).toBe(true)
		scheduler.enqueue('B', Priority.High, 'next high', true)
		const nextLow = scheduler.enqueue('A', Priority.Low, 'next low', true)
		expect(scheduler.select()).toBe(nextLow)
	})

	it('should match the reference under interleaved keyed arrivals, blocks and cancellations', () => {
		const keys = Array.from({ length: 19 }, (_, index) => String(index))
		const scheduler = new Scheduler<number>(40)
		const reference = new OneBReference([1n, 2n, 4n, 8n, 16n])
		const handles = new Map<number, ReturnType<typeof scheduler.enqueue>>()
		const ready = new Set(keys)
		let seed = 0x77_6D_3A_F1

		function chooseIndex(max: number) {
			seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0

			return Math.floor((seed / 0x1_00_00_00_00) * max)
		}

		for (let index = 0; index < 2500; index++) {
			const key = keys[chooseIndex(keys.length)]
			const op = chooseIndex(8)

			if (op < 4 && scheduler.size < 40) {
				const priority = ASCENDING_PRIORITIES[chooseIndex(ASCENDING_PRIORITIES.length)]
				const task = scheduler.enqueue(key, priority, index, ready.has(key))
				handles.set(index, task)
				reference.enqueue(task)
			}
			else if (op === 4) {
				const available = ready.delete(key)

				if (!available)
					ready.add(key)

				scheduler.setReady(key, !available)
			}
			else if (op === 5 && reference.tasks.length > 0) {
				const task = reference.tasks[chooseIndex(reference.tasks.length)]
				const handle = handles.get(task.payload)!
				expect(scheduler.remove(handle)).toBe(true)
				reference.remove(task)
				handles.delete(task.payload)
			}
			else {
				const task = compareNextStart(scheduler, reference, ready)

				if (task !== undefined)
					handles.delete(task.payload)
			}

			expect(scheduler.size).toBe(reference.tasks.length)
		}
	})

	it('should include one immediate candidate with zero waiting capacity', () => {
		const scheduler = new Scheduler<string>(0)
		const first = scheduler.enqueue('A', Priority.Normal, 'first', true)
		expect(() => scheduler.enqueue('B', Priority.Normal, 'second', true)).toThrow(RangeError)
		expect(scheduler.select()).toBe(first)
		expect(scheduler.start(first)).toBe(true)
		expect(scheduler.size).toBe(0)
	})

	it.each([
		-1,
		0.5,
		Number.NaN,
		Infinity,
		Number.MAX_SAFE_INTEGER + 1,
	])('should reject invalid waiting capacity %s', capacity => {
		expect(() => new Scheduler(capacity)).toThrow(RangeError)
	})

	it('should ignore losing, removed and foreign handles without recording service', () => {
		const scheduler = new Scheduler<string>(2, UNIT_WEIGHTS)
		const other = new Scheduler<string>(1, UNIT_WEIGHTS)
		const high = scheduler.enqueue('A', Priority.High, 'first', true)
		const low = scheduler.enqueue('B', Priority.Low, 'low', true)
		const foreign = other.enqueue('A', Priority.High, 'foreign', true)

		expect(scheduler.select()).toBe(high)
		expect(scheduler.start(low)).toBe(false)
		expect(scheduler.start(foreign)).toBe(false)
		expect(scheduler.remove(foreign)).toBe(false)
		expect(scheduler.size).toBe(2)
		expect(other.select()).toBe(foreign)

		expect(scheduler.remove(high)).toBe(true)
		const replacement = scheduler.enqueue('A', Priority.High, 'replacement', true)
		expect(scheduler.start(high)).toBe(false)
		expect(scheduler.remove(high)).toBe(false)
		expect(scheduler.select()).toBe(replacement)
		expect(scheduler.start(replacement)).toBe(true)
		expect(scheduler.select()).toBe(low)
		expect(scheduler.size).toBe(1)
	})

	it('should let callers remove every yielded task on one key and preserve other keys', () => {
		const scheduler = new Scheduler<string>(5, UNIT_WEIGHTS)
		const first = scheduler.enqueue('A', Priority.Normal, 'first', true)
		const removed = scheduler.enqueue('A', Priority.Normal, 'middle', true)
		const tail = scheduler.enqueue('A', Priority.Normal, 'tail', true)
		const high = scheduler.enqueue('A', Priority.High, 'high', true)
		const other = scheduler.enqueue('B', Priority.Normal, 'other', true)
		expect(scheduler.remove(removed)).toBe(true)
		const visited = new Set<typeof first>()

		for (const task of scheduler.getTasks('A')) {
			visited.add(task)
			expect(scheduler.remove(task)).toBe(true)
		}

		expect(visited).toEqual(new Set([first, tail, high]))

		expect([
			...scheduler.getTasks('A'),
		]).toEqual([])

		expect(scheduler.select()).toBe(other)
		expect(scheduler.size).toBe(1)
	})
})
