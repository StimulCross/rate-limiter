import { LeakyBucketLimiter } from '@stimulcross/rate-limiter/leaky-bucket'
import { scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: {
		intervalMs: scaleMs(350),
	},
	limitBehavior: 'enqueue',
	queue: {
		capacity: 6,
		concurrency: 3,
		maxWaitMs: scaleMs(5000),
	},
}
const tasks = repeatFlow(createBurst('upload', 8, 100, 500), [0, 3300])

printScenario('1/2', 'Paced starts with overlapping execution', 'Starts stay at least 350 ms apart. Each upload takes 500 ms, so running tasks can overlap.')
await runFlow(LeakyBucketLimiter, options, tasks)

printScenario('2/2', 'Independent pacing across keys', 'Each key starts at most once every 300 ms. Four staggered waves let each key drain and refill its queue while the other continues.')

await runFlow(LeakyBucketLimiter, {
	limitOptions: {
		intervalMs: scaleMs(300),
	},
	limitBehavior: 'enqueue',
	queue: { capacity: 6, concurrency: 3 },
}, [
	...repeatFlow(createBurst('alpha', 4, 85, 230), [0, 1600, 3200, 4800]),
	...repeatFlow(createBurst('beta', 4, 120, 230), [620, 2200, 3820, 5420]),
])
