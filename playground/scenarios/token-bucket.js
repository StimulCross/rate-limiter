import { TokenBucketLimiter } from '@stimulcross/rate-limiter/token-bucket'
import { getSlowdown, scaleMs } from '../pacing.js'
import { runFlow } from '../runtime/flow.js'
import { printScenario } from '../terminal/presentation.js'
import { createBurst, repeatFlow } from './workload.js'

const options = {
	limitOptions: { capacity: 3, refillRate: 2.5 / getSlowdown() },
	limitBehavior: 'enqueue',
	queue: {
		capacity: 8,
		concurrency: 3,
		maxWaitMs: scaleMs(5000),
	},
}
const tasks = createBurst('upload', 9, 100, 230)
const secondWave = createBurst('upload', 4, 80, 230).map((task, index) => ({
	...task,
	id: `upload-${tasks.length + index + 1}`,
	atMs: task.atMs + 4000,
}))

printScenario('1/2', 'Burst, drain and refill during a pause', 'A burst drains three tokens. Refill supplies one token every 400 ms. Two smaller waves arrive after the bucket has had time to refill.')

await runFlow(TokenBucketLimiter, options, [
	...tasks,
	...repeatFlow(secondWave, [0, 2300]),
])

printScenario('2/2', 'Two refill profiles', 'The fast bucket can hold three tokens. The slower bucket allows one start about every 333 ms and determines the pace.')

await runFlow(TokenBucketLimiter, {
	limitOptions: [
		{ capacity: 3, refillRate: 12 / getSlowdown() },
		{ capacity: 1, refillRate: 3 / getSlowdown() },
	],
	limitBehavior: 'enqueue',
	queue: { capacity: 5 },
}, repeatFlow(createBurst('export', 6, 90, 120), [0, 2250, 4500]))
