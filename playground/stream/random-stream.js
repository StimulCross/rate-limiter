import process from 'node:process'
import { Priority } from '@stimulcross/rate-limiter'
import { createFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createStreamControls } from './stream-controls.js'
import { createStreamLimiter } from './stream-limiters.js'

const KEYS = ['alpha', 'beta', 'gamma']
const PRIORITIES = [Priority.Low, Priority.Normal, Priority.High]
const UINT32_SIZE = 2 ** 32

function createRandom(seed) {
	let state = seed

	return () => {
		state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0

		return state / UINT32_SIZE
	}
}

async function* generateTraffic(random, failures, controls, signal) {
	const choose = (min, max) => min + Math.floor(random() * (max - min + 1))
	let nextId = 0

	for (let wave = 1; !signal.aborted; wave++) {
		const count = choose(14, 24)
		yield { traffic: `Wave ${wave} · ${count} arrivals` }

		for (let index = 0; index < count && !signal.aborted; index++) {
			await controls.wait(choose(28, 105))
			const priority = PRIORITIES[choose(0, PRIORITIES.length - 1)]
			const key = KEYS[choose(0, KEYS.length - 1)]
			const rejects = random() < 0.22
			const hasDeadline = random() < 0.32
			const canCancel = random() < 0.3

			yield {
				id: `job-${++nextId}`,
				key,
				priority,
				priorityLabel: Priority[priority],
				shouldFail: failures() < 0.08,
				workMs: random() < 0.32
					? choose(850, 1550)
					: choose(200, 650),
				limitBehavior: rejects ? 'reject' : 'enqueue',
				maxWaitMs: hasDeadline
					? choose(110, 620)
					: undefined,
				abortAfterMs: canCancel
					? choose(140, 850)
					: undefined,
			}
		}

		const quietMs = wave % 3 === 0
			? choose(4600, 5200)
			: choose(1300, 3300)
		yield { traffic: 'Quiet · no new arrivals' }
		await controls.wait(quietMs)
	}
}

export async function runRandomStream(name) {
	const rawSeed = process.env.PLAYGROUND_SEED
	const seed = rawSeed === undefined
		? Math.floor(Math.random() * UINT32_SIZE)
		: Number(rawSeed)

	if (!Number.isInteger(seed) || seed < 0 || seed >= UINT32_SIZE)
		throw new RangeError('PLAYGROUND_SEED must be a 32-bit unsigned integer')

	const random = createRandom(seed)
	const upstreamRandom = createRandom((seed + 1) % UINT32_SIZE)
	const failures = createRandom((seed + 2) % UINT32_SIZE)
	const { limiter, queue, respond } = createStreamLimiter(name, upstreamRandom)

	printScenario('LIVE', `${name} · seed ${seed}`, 'Random arrivals compete for quota and two shared execution slots. Watch the queue fill during bursts and drain in quiet periods. Press + or - to change how fast new tasks arrive, Space to pause or resume arrivals, and Ctrl+C to stop.')

	let phase = ''
	const stop = new AbortController()
	const requestStop = () => stop.abort()
	const flow = createFlow(limiter, { keys: KEYS, queue, respond })
	const controls = createStreamControls({
		signal: stop.signal,
		requestStop,
		onChange: pace => flow.setTraffic(`${pace} · ${phase}`),
	})
	const pending = new Set()
	let failure

	process.on('SIGINT', requestStop)

	try {
		for await (const item of generateTraffic(random, failures, controls, stop.signal)) {
			if (stop.signal.aborted)
				break

			if ('traffic' in item) {
				phase = item.traffic

				flow.setTraffic(controls.interactive
					? `${controls.describe()} · ${phase}`
					: phase)

				continue
			}

			const submission = flow.submitLive(item).catch(err => {
				failure ??= err
				requestStop()
			}).finally(() => pending.delete(submission))
			pending.add(submission)
		}
	}
	catch (err) {
		if (!(stop.signal.aborted && err.name === 'AbortError'))
			throw err
	}
	finally {
		controls.dispose()
		flow.setTraffic('Stopping · draining running tasks')

		try {
			await limiter.destroy()
			await Promise.all(pending)
			await flow.finish()
		}
		finally {
			process.off('SIGINT', requestStop)
		}
	}

	if (failure)
		throw failure
}
