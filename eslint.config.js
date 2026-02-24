import { resolveFlatConfig } from '@leancodepl/resolve-eslint-flat-config';
import typescript from '@stimulcross/eslint-config-typescript';
import typescriptStyle from '@stimulcross/eslint-config-typescript/style';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';

export const globs = {
	js: ['**/*.js', '**/*.cjs', '**/*.mjs'],
	ts: ['**/*.ts', '**/*.cts', '**/*.mts'],
	jsSpec: ['**/*.spec.js', '**/*.spec.cjs', '**/*.spec.mjs'],
	tsSpec: ['**/*.spec.ts', '**/*.spec.cts', '**/*.spec.mts'],
	lib: '**/dist',
	nodeModules: '**/node_modules',
	coverage: '**/coverage',
	dts: '**/*.d.ts',
};

/** @type {import("eslint").Linter.Config[]} */
export const config = resolveFlatConfig(
	defineConfig(
		globalIgnores([globs.lib, globs.nodeModules, globs.dts, globs.coverage]),
		{
			files: [...globs.js, ...globs.ts, ...globs.jsSpec, ...globs.tsSpec],
			languageOptions: {
				globals: {
					...globals.node,
					...globals.es2022,
				},
			},
		},
		{
			files: [...globs.js, ...globs.ts, ...globs.tsSpec],
			extends: [typescript, typescriptStyle],
		},
		{
			files: [...globs.ts, ...globs.tsSpec],
			rules: {
				'id-length': 'off',
				'no-await-in-loop': 'off',
				'unicorn/no-new-array': 'off',
				'unicorn/no-thenable': 'off',
				'unicorn/no-useless-undefined': 'error',
				'@typescript-eslint/no-explicit-any': 'off',
				'@typescript-eslint/no-non-null-assertion': 'off',
				'@typescript-eslint/no-unnecessary-condition': ['warn', { allowConstantLoopConditions: true }],
			},
		},
		{
			files: [...globs.jsSpec, ...globs.tsSpec],
			rules: {
				'id-length': 'off',
				'max-nested-callbacks': 'off',
				'unicorn/consistent-function-scoping': 'off',
				'unicorn/no-array-push-push': 'off',
				'@typescript-eslint/naming-convention': 'off',
				'@typescript-eslint/no-empty-function': 'off',
				'@typescript-eslint/no-unsafe-member-access': 'off',
				'@typescript-eslint/no-unsafe-return': 'off',
				'@typescript-eslint/unbound-method': 'off',
			},
		},
	),
);

export default config;
