export function createBurst(key, count, spacingMs, workMs) {
	return Array.from({ length: count }, (_, index) => ({
		id: `${key}-${index + 1}`,
		key,
		atMs: index * spacingMs,
		workMs,
	}))
}

export function repeatFlow(tasks, waveStarts) {
	return waveStarts.flatMap((startAtMs, wave) => tasks.map(task => ({
		...task,
		id: wave === 0
			? task.id
			: `${task.id}.${wave + 1}`,
		atMs: startAtMs + task.atMs,
	})))
}
