import { SlidingWindowLogLimiter } from '@stimulcross/rate-limiter/sliding-window-log'
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

printScenario('1/2', 'Staggered expiration in a rolling window', 'Three starts fit in any rolling second. Watch space return in steps as old starts expire.')
await runFlow(SlidingWindowLogLimiter, options, tasks)

printScenario('2/2', 'Short and long rolling limits', 'One start fits every 250 ms, but a fourth must wait for the oldest start to leave the 1100 ms window.')

await runFlow(SlidingWindowLogLimiter, {
	limitOptions: [
		{
			limit: 1,
			windowMs: scaleMs(250),
		},
		{
			limit: 3,
			windowMs: scaleMs(1100),
		},
	],
	limitBehavior: 'enqueue',
	queue: { capacity: 5 },
}, repeatFlow(createBurst('index', 6, 90, 150), [0, 2400, 4800]))
