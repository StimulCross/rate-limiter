export const STATE_MARKERS = {
	'.': { label: 'idle', style: 'dim' },
	'Q': { label: 'quota', style: 'yellow' },
	'W': { label: 'queue', style: 'cyan' },
	'R': { label: 'run', style: 'green' },
	'B': {
		label: 'run+Q',
		style: ['bold', 'yellow'],
	},
	'*': {
		label: 'run+W',
		style: ['bold', 'cyan'],
	},
	'>': {
		label: 'resumed',
		style: ['bold', 'magenta'],
	},
}

export const EVENT_MARKERS = {
	'R': { legend: 'reject', style: 'red' },
	'F': { legend: 'full', style: 'magenta' },
	'C': { legend: 'cancel', style: 'cyan' },
	'X': { legend: 'expiry', style: 'yellow' },
	'H': { legend: '429', style: 'blueBright' },
	'E': {
		legend: 'error',
		style: ['white', 'bgRed'],
	},
	'L': { legend: 'clear', style: 'gray' },
	'D': { legend: 'stop', style: 'white' },
	'+': {
		legend: 'mix',
		style: ['bold', 'green'],
	},
}
