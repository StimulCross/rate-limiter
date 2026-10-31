import { defineConfig, globs } from '@stimulcross/eslint-config'
import format from 'eslint-plugin-format'

const config = defineConfig(
	{
		rootDir: import.meta.dirname,
		languageOptions: { ecmaVersion: 2023 },
		globalIgnores: [
			'tmp/**',
			'openspec/**',
			'research/**',
			'playground/**/*',
			'!playground/*.js',
			'coverage/**',
			'**/lib/**',
		],
		typeAware: { files: globs.typescript },
		integrations: {
			pnpm: true,
			markdown: false,
			jsdoc: true,
			stylistic: {
				overrides: {
					'style/operator-linebreak': [
						'error',
						'before',
						{
							overrides: { '=': 'after' },
						},
					],
				},
			},
		},
		scopes: [
			{
				files: ['playground/*.js'],
				rules: {
					'antfu/no-top-level-await': 'off',
					'no-console': 'off',
				},
			},
			{
				files: globs.tests,
				rules: {
					'max-classes-per-file': 'off',
					'max-nested-callbacks': 'off',
					'no-console': 'off',
					'no-empty-function': 'off',
					'unused-imports/no-unused-vars': 'off',
					'unicorn/consistent-function-scoping': 'off',
					'unicorn/no-useless-undefined': 'off',
					'ts/class-literal-property-style': 'off',
					'ts/consistent-type-assertions': 'off',
					'ts/explicit-member-accessibility': 'off',
					'ts/explicit-function-return-type': 'off',
					'ts/naming-convention': 'off',
					'ts/no-empty-function': 'off',
					'ts/no-floating-promises': 'off',
					'ts/no-explicit-any': 'off',
					'ts/no-extraneous-class': 'off',
					'ts/no-loop-func': 'off',
					'ts/no-non-null-assertion': 'off',
					'ts/no-unsafe-argument': 'off',
					'ts/no-unsafe-assignment': 'off',
					'ts/no-unsafe-call': 'off',
					'ts/no-unsafe-member-access': 'off',
					'ts/no-unsafe-return': 'off',
					'ts/no-unused-vars': 'off',
					'ts/unbound-method': 'off',
					'test/prefer-lowercase-title': 'off',
				},
			},
		],
	},
	{
		files: ['**/*.md'],
		plugins: { format },
		languageOptions: { parser: format.parserPlain },
		rules: {
			'format/prettier': [
				'error',
				{
					parser: 'markdown',
					endOfLine: 'auto',
					semi: false,
					singleQuote: true,
					tabWidth: 2,
					printWidth: 120,
					useTabs: true,
					trailingComma: 'all',
					embeddedLanguageFormatting: 'off',
				},
			],
		},
	},
)

export default config
