import { FixedWindowLimiter } from '@stimulcross/rate-limiter/fixed-window'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: [
		{
			limit: 2,
			windowMs: scaleMs(650),
		},
		{
			limit: 4,
			windowMs: scaleMs(1600),
		},
	],
	limitBehavior: 'enqueue',
	queue: {
		capacity: 8,
		concurrency: 3,
		maxWaitMs: scaleMs(5000),
	},
}
const tasks = [
	...repeatFlow(createBurst('orders', 7, 110, 180), [0, 2600, 5200]),
	...repeatFlow(createBurst('invoices', 3, 270, 220), [500, 2000, 3600, 5100, 6750]),
]

printScenario('1/2', 'Independent keys and two quota profiles', 'Orders and invoices arrive in staggered waves. Each key gets two starts per 650 ms and four per 1600 ms.')
await runFlow(FixedWindowLimiter, options, tasks)

printScenario('2/2', 'Starts around a grid boundary', 'Two starts fit before the boundary. A third is rejected, then a fresh quota opens on the 600 ms grid. The same pattern repeats across three boundaries.')

await runFlow(FixedWindowLimiter, {
	limitOptions: {
		alignment: 'grid',
		limit: 2,
		windowMs: scaleMs(600),
		offsetMs: Date.now() % scaleMs(600),
	},
}, repeatFlow([410, 470, 530, 660, 710].map((atMs, index) => ({
	id: `grid-${index + 1}`,
	key: 'grid',
	atMs,
	workMs: 90,
})), [0, 1800, 3600]))
