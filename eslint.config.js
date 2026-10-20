import { builtinModules } from 'node:module';
import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import opensamguk from './tools/eslint/no-cross-package-relative.js';

// 패키지 의존 방향: docs/architecture/package-boundaries.md
const PACKAGES = [
  '@opensamguk/shared',
  '@opensamguk/rules',
  '@opensamguk/db',
  '@opensamguk/server',
  '@opensamguk/engine',
  '@opensamguk/web',
];

const BOUNDARY_MESSAGE = '패키지 의존 방향 위반입니다. docs/architecture/package-boundaries.md를 보세요.';

// Node 내장 모듈 전체 (접두사 없는 이름, 하위 경로, node: 접두사). 목록을 손으로 관리하지 않는다.
const NODE_BUILTINS = [
  'node:*',
  ...builtinModules.filter((name) => !name.startsWith('_')).flatMap((name) => [name, `${name}/*`]),
];

function importRule(allowed, { banBuiltins = false, typeOnly = [] } = {}) {
  const banned = PACKAGES.filter((p) => !allowed.includes(p) && !typeOnly.includes(p));
  const patterns = [
    { group: banned.flatMap((p) => [p, `${p}/*`]), message: BOUNDARY_MESSAGE },
  ];
  if (typeOnly.length > 0) {
    patterns.push({
      group: typeOnly.flatMap((p) => [p, `${p}/*`]),
      allowTypeImports: true,
      message: `${typeOnly.join(', ')}에서는 타입만 import할 수 있습니다.`,
    });
  }
  if (banBuiltins) {
    patterns.push({ group: NODE_BUILTINS, message: 'rules는 파일·네트워크·프로세스를 쓰지 않습니다.' });
  }
  return ['error', { patterns }];
}

const NO_MATH_RANDOM = {
  object: 'Math',
  property: 'random',
  message: '게임 난수는 @opensamguk/shared의 시드 RNG만 씁니다 (FR-ENG-06).',
};

export default defineConfig([
  globalIgnores([
    '**/node_modules/',
    '**/dist/',
    'packages/db/src/generated/',
    'playwright-report/',
    'test-results/',
  ]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    plugins: { opensamguk },
    rules: { 'opensamguk/no-cross-package-relative': 'error' },
  },
  {
    files: ['packages/shared/**'],
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared']),
      'no-restricted-properties': ['error', NO_MATH_RANDOM],
    },
  },
  {
    files: ['packages/rules/**'],
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/rules'], { banBuiltins: true }),
      'no-restricted-properties': [
        'error',
        NO_MATH_RANDOM,
        { object: 'Date', property: 'now', message: 'rules는 현재 시각을 읽지 않습니다. 시각은 인자로 받습니다.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date']", message: 'rules는 현재 시각을 읽지 않습니다. 시각은 인자로 받습니다.' },
      ],
      'no-restricted-globals': ['error', { name: 'fetch', message: 'rules는 네트워크를 쓰지 않습니다.' }],
    },
  },
  {
    files: ['packages/db/**'],
    rules: { 'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/db']) },
  },
  {
    files: ['apps/server/**'],
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/rules', '@opensamguk/db', '@opensamguk/server']),
    },
  },
  {
    files: ['apps/engine/**'],
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/rules', '@opensamguk/db', '@opensamguk/engine']),
      'no-restricted-properties': ['error', NO_MATH_RANDOM],
    },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/web'], { typeOnly: ['@opensamguk/server'] }),
    },
  },
]);
