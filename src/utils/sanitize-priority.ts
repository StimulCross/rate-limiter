import { Priority } from '@stimulcross/ds-policy-priority-queue';

/** @internal */
export function sanitizePriority(priority: number): Priority {
	if (!Number.isFinite(priority)) {
		return Priority.Normal;
	}

	if (priority < Priority.Lowest) {
		return Priority.Lowest;
	}

	if (priority > Priority.Highest) {
		return Priority.Highest;
	}

	if (!Number.isInteger(priority)) {
		priority = Math.round(priority);
	}

	return priority;
}
