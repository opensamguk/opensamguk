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
  '/node:*',
  ...builtinModules.filter((name) => !name.startsWith('_')).flatMap((name) => [`/${name}`, `/${name}/*`]),
];

function importRule(allowed, { banBuiltins = false, typeOnly = [] } = {}) {
  const banned = PACKAGES.filter((p) => !allowed.includes(p) && !typeOnly.includes(p));
  const patterns = [{ group: banned.flatMap((p) => [p, `${p}/*`]), message: BOUNDARY_MESSAGE }];
  if (typeOnly.length > 0) {
    patterns.push({
      group: typeOnly.flatMap((p) => [p, `${p}/*`]),
      allowTypeImports: true,
      message: `${typeOnly.join(', ')}에서는 타입만 import할 수 있습니다.`,
    });
  }
  if (banBuiltins) {
    patterns.push({
      group: [...NODE_BUILTINS, '/@opensamguk/shared/node'],
      message: 'rules는 파일·네트워크·프로세스를 쓰지 않습니다.',
    });
  }
  return ['error', { patterns }];
}

const E3_PATTERNS = [
  {
    group: ['@opensamguk/db', '@opensamguk/db/*', '@opensamguk/engine', '@opensamguk/engine/*'],
    message: BOUNDARY_MESSAGE,
  },
  {
    group: ['@opensamguk/server', '@opensamguk/server/*'],
    allowTypeImports: true,
    message: BOUNDARY_MESSAGE,
  },
  { regex: '^@opensamguk/rules(?:$|/(?!(?:resource-validation|resources)$))', message: BOUNDARY_MESSAGE },
  { regex: '^@opensamguk/shared/node(?:$|/)', message: BOUNDARY_MESSAGE },
];

const RESOURCE_EDITOR_PATTERNS = E3_PATTERNS.map((pattern) =>
  pattern.regex?.startsWith('^@opensamguk/rules')
    ? { ...pattern, regex: '^@opensamguk/rules(?:$|/(?!resources$))' }
    : pattern,
);

const NO_MATH_RANDOM = {
  object: 'Math',
  property: 'random',
  message: '게임 난수는 @opensamguk/shared의 시드 RNG만 씁니다 (FR-ENG-06).',
};

export default defineConfig([
  globalIgnores(['**/node_modules/', '**/dist/', 'packages/db/src/generated/', 'playwright-report/', 'test-results/']),
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
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'rules는 현재 시각을 읽지 않습니다. 시각은 인자로 받습니다.',
        },
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
      'no-restricted-imports': importRule([
        '@opensamguk/shared',
        '@opensamguk/rules',
        '@opensamguk/db',
        '@opensamguk/server',
      ]),
    },
  },
  {
    files: ['apps/engine/**'],
    rules: {
      'no-restricted-imports': importRule([
        '@opensamguk/shared',
        '@opensamguk/rules',
        '@opensamguk/db',
        '@opensamguk/engine',
      ]),
      'no-restricted-properties': ['error', NO_MATH_RANDOM],
    },
  },
  {
    files: ['apps/web/**'],
    languageOptions: { globals: globals.browser },
    rules: {
      'no-restricted-imports': importRule(['@opensamguk/shared', '@opensamguk/web'], {
        typeOnly: ['@opensamguk/server'],
      }),
    },
  },
  // 예외 E1 (T4-34): 전투 시뮬레이터 Worker의 계산 파일만 rules의 정해진 값과 타입을 import한다.
  // shared/node·engine·db·server 값은 계속 막는다.
  {
    files: ['apps/web/src/battleSim/compute.ts', 'apps/web/src/battleSim/compute.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@opensamguk/db', '@opensamguk/engine', '@opensamguk/db/*', '@opensamguk/engine/*'],
              message: BOUNDARY_MESSAGE,
            },
            {
              group: ['@opensamguk/server', '@opensamguk/server/*'],
              allowTypeImports: true,
              message: '@opensamguk/server에서는 타입만 import할 수 있습니다.',
            },
            { group: ['@opensamguk/rules/*'], message: BOUNDARY_MESSAGE },
            {
              group: ['@opensamguk/rules'],
              allowImportNames: ['simulateBattle', 'unitSetSchema', 'BALANCE'],
              allowTypeImports: true,
              message: 'battleSim은 rules에서 simulateBattle·unitSetSchema·BALANCE와 타입만 import합니다 (E1).',
            },
            { group: ['/@opensamguk/shared/node', ...NODE_BUILTINS], message: BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },
  // 예외 E2 (T4-34): 공개 병종표 resources/unitset/basic.json 하나만 상대 경로로 읽는다.
  {
    files: ['apps/web/src/battleSim/publicUnitSet.ts'],
    rules: {
      'opensamguk/no-cross-package-relative': 'off',
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['@opensamguk/*', ...NODE_BUILTINS], message: BOUNDARY_MESSAGE },
            {
              regex: '^(?!\\.\\./\\.\\./\\.\\./\\.\\./resources/unitset/basic\\.json$)\\.',
              message: 'publicUnitSet.ts는 resources/unitset/basic.json만 상대 경로로 읽습니다 (E2).',
            },
          ],
        },
      ],
    },
  },
  // 예외 E3 (T4-76): 지도 편집기는 순수 자원 검증 하위 경로 하나만 읽는다.
  {
    files: ['apps/web/src/mapEditor/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [...E3_PATTERNS, { group: NODE_BUILTINS, message: BOUNDARY_MESSAGE }],
        },
      ],
    },
  },
  // E3 시험은 기존 Node 허용을 유지하고 나머지 경계는 제품과 같이 지킨다.
  {
    files: ['apps/web/src/mapEditor/**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', { patterns: E3_PATTERNS }],
    },
  },
  {
    files: ['apps/web/src/admin/maps/**', 'apps/web/src/admin/resources/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [...RESOURCE_EDITOR_PATTERNS, { group: NODE_BUILTINS, message: BOUNDARY_MESSAGE }] },
      ],
    },
  },
  {
    files: [
      'apps/web/src/admin/maps/contract.test.ts',
      'apps/web/src/admin/maps/validate.test.ts',
      'apps/web/src/admin/maps/sketch.test.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...RESOURCE_EDITOR_PATTERNS,
            { group: NODE_BUILTINS.filter((pattern) => pattern !== '/node:*'), message: BOUNDARY_MESSAGE },
            { regex: '^node:(?!(?:fs|zlib)$)', message: BOUNDARY_MESSAGE },
          ],
        },
      ],
    },
  },
  {
    files: [
      'packages/rules/src/world/resourceEditor/map/**/*.ts',
      'packages/rules/src/world/resourceEditor/validate/**/*.ts',
    ],
    ignores: ['**/*.test.ts', '**/fixtures.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex:
                '^(?!zod$|\\.\\./resources$|\\./(?:format|geometry|issues|map|scenario|unitSet|statRules|portraitMap)$|\\.\\./map/(?:format|geometry)$)',
              message: '자원 공개 모듈은 zod·자원 형식·검증 내부 모듈만 읽습니다 (E3).',
            },
          ],
        },
      ],
    },
  },
]);
