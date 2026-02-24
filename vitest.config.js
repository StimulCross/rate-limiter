import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		environment: 'node',
		include: ['tests/**/*.spec.ts'],
		coverage: {
			provider: 'v8',
			reportsDirectory: './coverage',
			include: ['src/limiters', 'src/runtime', 'src/utils'],
			exclude: [
				'src/**/index.ts',
				'src/**/*.info.ts',
				'src/**/*.state.ts',
				'src/**/*.status.ts',
				'src/**/*.options.ts',
				'src/runtime/queue/queue*.ts',
				'src/**/http-limit-info.extractor',
			],
		},
	},
});
