import { setTimeout as delay } from 'node:timers/promises'
import { RateLimitError } from '@stimulcross/rate-limiter'
import { pauseMs, scaleMs } from '../pacing.js'
import { createTimeline } from '../terminal/timeline.js'

function paceTask(task) {
	return {
		...task,
		atMs: scaleMs(task.atMs),
		workMs: scaleMs(task.workMs),
		maxWaitMs: scaleMs(task.maxWaitMs),
		abortAfterMs: scaleMs(task.abortAfterMs),
	}
}

export function createFlow(limiter, { tasks = [], keys = [], queue = {}, respond }) {
	const beganAt = performance.now()
	const totals = new Map()
	const { capacity = 0, concurrency = Infinity } = queue
	let active = 0
	let waiting = 0
	let completed = 0
	let dropped = 0
	let errors = 0
	let traffic = ''
	const readFlow = () => ({
		active,
		waiting,
		capacity,
		concurrency,
		completed,
		dropped,
		errors,
		traffic,
	})
	const timeline = createTimeline(limiter, { tasks, keys, beganAt, readFlow })

	function print(event, task, detail = '', wasQueued = false) {
		if (timeline) {
			timeline.record(event, task, detail, wasQueued)

			return
		}

		const elapsed = Math.round(performance.now() - beganAt)

		console.log(`${String(elapsed).padStart(5)} ms  ${event.padEnd(5)}  ${task.id.padEnd(10)} ${task.key.padEnd(9)}  wait=${waiting}/${capacity} slots=${active}/${concurrency === Infinity
			? '∞'
			: concurrency}  ${detail}`)
	}

	function countOutcome(outcome) {
		totals.set(outcome, (totals.get(outcome) ?? 0) + 1)
	}

	async function submit(task) {
		if (task.atMs > 0)
			await delay(task.atMs)

		const arrivedAt = performance.now()
		const controller = new AbortController()
		const abortTimer = task.abortAfterMs === undefined
			? undefined
			: setTimeout(() => controller.abort(), task.abortAfterMs)
		let started = false
		let wasQueued = false
		let simulatedError
		print('IN', task, task.priorityLabel)
		waiting++

		const completion = limiter.run(async () => {
			started = true
			waiting--
			active++
			print('START', task, `waited ${Math.round(performance.now() - arrivedAt)} ms`, wasQueued)

			try {
				await delay(task.workMs)

				if (task.shouldFail) {
					simulatedError = new Error('Simulated callback failure')
					throw simulatedError
				}

				return respond?.(task)
			}
			finally {
				active--
			}
		}, {
			id: task.id,
			key: task.key,
			signal: controller.signal,
			priority: task.priority,
			limitBehavior: task.limitBehavior,
			maxWaitMs: task.maxWaitMs,
		})
		wasQueued = !started

		const waitingNotice = timeline
			? undefined
			: setTimeout(() => {
					if (!started)
						print('WAIT', task)
				}, 0)

		try {
			const response = await completion
			const outcome = response instanceof Response
				? `HTTP ${response.status}`
				: 'completed'
			countOutcome(outcome)
			completed++
			print('DONE', task, outcome)
		}
		catch (err) {
			if (!started)
				waiting--

			if (!(err instanceof RateLimitError)) {
				const isSimulatedFailure = simulatedError !== undefined && err === simulatedError
				countOutcome('ERROR')
				errors++

				print('ERROR', task, isSimulatedFailure
					? 'Simulated callback failure'
					: 'Callback or limiter failure')

				if (isSimulatedFailure)
					return

				throw err
			}

			countOutcome(err.code)
			dropped++
			const retry = err.retryAfterMs === null
				? ''
				: ` · retry in ${err.retryAfterMs} ms`
			print('DROP', task, `${err.code}${retry}`)
		}
		finally {
			clearTimeout(waitingNotice)
			clearTimeout(abortTimer)
		}
	}

	return {
		submit,
		submitLive: async task => await submit(paceTask(task)),
		setTraffic(message) {
			traffic = message

			if (!timeline)
				console.log(message)
		},
		async finish() {
			await timeline?.stop()
			console.log(Array.from(totals, ([outcome, count]) => `${outcome}=${count}`).join('  '))
		},
	}
}

export async function runFlow(Limiter, options, tasks, respond) {
	const pacedTasks = tasks.map(paceTask)
	const limiter = new Limiter(options)
	const flow = createFlow(limiter, { tasks: pacedTasks, queue: options.queue, respond })

	try {
		const results = await Promise.allSettled(pacedTasks.map(flow.submit))
		const failed = results.find(result => result.status === 'rejected')

		await flow.finish()

		if (failed)
			throw failed.reason
	}
	finally {
		await limiter.destroy()
	}

	if (pauseMs > 0)
		await delay(pauseMs)
}
