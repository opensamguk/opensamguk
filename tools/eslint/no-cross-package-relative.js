import path from 'node:path';

// apps/* 또는 packages/* 안의 파일이 상대 경로로 자기 패키지 밖을 import하면 막는다.
// 문자열 패턴이 아니라 실제로 풀린 경로로 판단해야 '../../db/src' 같은 형제 경로도 잡힌다.
const PACKAGE_ROOT = /^(.*[\\/](?:apps|packages)[\\/][^\\/]+)[\\/]/;

function packageRootOf(filename) {
  return PACKAGE_ROOT.exec(filename)?.[1] ?? null;
}

export const noCrossPackageRelative = {
  meta: {
    type: 'problem',
    docs: { description: '다른 패키지를 상대 경로로 import하지 못하게 한다' },
    messages: {
      crossPackage: '다른 패키지는 상대 경로가 아니라 패키지 이름으로 import합니다 ("{{source}}").',
    },
    schema: [],
  },
  create(context) {
    const filename = context.filename;
    const root = packageRootOf(filename);
    if (!root) return {};

    function check(node, source) {
      if (typeof source !== 'string' || !source.startsWith('.')) return;
      const resolved = path.resolve(path.dirname(filename), source);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        context.report({ node, messageId: 'crossPackage', data: { source } });
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node.source, node.source.value),
      ExportAllDeclaration: (node) => check(node.source, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node.source, node.source.value),
    };
  },
};

export default {
  meta: { name: 'opensamguk' },
  rules: { 'no-cross-package-relative': noCrossPackageRelative },
};
