import { SlidingWindowCounterLimiter } from '@stimulcross/rate-limiter/sliding-window-counter'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: {
		limit: 3,
		windowMs: scaleMs(1000),
	},
	limitBehavior: 'enqueue',
	queue: {
		capacity: 7,
		concurrency: 3,
		maxWaitMs: scaleMs(5000),
	},
}
const tasks = repeatFlow(createBurst('search', 9, 150, 180), [0, 3400])

printScenario('1/2', 'Capacity returns as the previous window loses weight', 'The same search traffic as Sliding Window Log. The weighted previous window gradually makes room.')
await runFlow(SlidingWindowCounterLimiter, options, tasks)

printScenario('2/2', 'Backlog crossing a grid boundary', 'The first three starts fill the current window. At the boundary, their count still contributes to the estimate.')

await runFlow(SlidingWindowCounterLimiter, {
	limitOptions: {
		limit: 3,
		windowMs: scaleMs(600),
		offsetMs: Date.now() % scaleMs(600),
	},
	limitBehavior: 'enqueue',
	queue: { capacity: 4 },
}, repeatFlow([230, 300, 390, 490, 650].map((atMs, index) => ({
	id: `grid-${index + 1}`,
	key: 'grid',
	atMs,
	workMs: 120,
})), [0, 1800, 3600]))
