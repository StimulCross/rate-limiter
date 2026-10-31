import { Priority } from '@stimulcross/rate-limiter'
import { FixedWindowLimiter } from '@stimulcross/rate-limiter/fixed-window'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: {
		limit: 10,
		windowMs: scaleMs(1000),
	},
	limitBehavior: 'enqueue',
	queue: { concurrency: 1, capacity: 10 },
	weights: {
		[Priority.Lowest]: 1,
		[Priority.Low]: 1,
		[Priority.Normal]: 1,
		[Priority.High]: 3,
		[Priority.Highest]: 1,
	},
}
const reports = createBurst('report', 3, 140, 170).map(task => ({
	...task,
	atMs: task.atMs + 100,
	priority: Priority.Low,
	priorityLabel: 'Low',
}))
const exports = createBurst('export', 7, 85, 170).map(task => ({
	...task,
	atMs: task.atMs + 130,
	priority: Priority.High,
	priorityLabel: 'High',
}))

printScenario('1/1', 'Weighted dispatch across keys', 'A setup task holds the slot while Low reports and High exports arrive. Compare the dispatch order across three waves with weights 1:3.')

await runFlow(FixedWindowLimiter, options, repeatFlow([
	{
		id: 'setup',
		key: 'setup',
		atMs: 0,
		workMs: 850,
	},
	...reports,
	...exports,
], [0, 3200, 6400]))
