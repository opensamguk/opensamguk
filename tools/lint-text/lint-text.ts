// 문구 자동 검사 (T1-25, AC-M1-22). 글쓰기 규칙의 S1 패턴을 기계로 찾는다.
// 기준: docs/writing-style.md, 원본 epoko77-ai/im-not-ai b37e020의
// skills/humanize-korean/references/ai-tell-taxonomy.md (MIT). 패턴 목록만 참고해 새로 썼다.
import ts from 'typescript';

export type SourceKind = 'markdown' | 'code';

export interface Finding {
  path: string;
  line: number;
  id: RuleId;
  text: string;
}

export const RULE_IDS = ['A-7', 'A-8', 'C-5', 'C-10', 'C-11', 'D-1', 'D-2', 'D-3', 'J-2'] as const;
export type RuleId = (typeof RULE_IDS)[number];

interface Segment {
  /** 검사할 글. 건너뛸 부분은 같은 길이의 공백으로 가렸다. */
  text: string;
  /** 원문에서 이 글이 시작하는 위치 */
  offset: number;
}

interface Hit {
  index: number;
  length: number;
}

interface Rule {
  id: RuleId;
  kinds: readonly SourceKind[];
  /** 문서(파일) 하나에서 이 횟수를 넘어야 걸린다. 없으면 한 번만 나와도 걸린다. */
  allowedPerDocument?: number;
  find(text: string): Hit[];
}

const HANGUL = /[가-힣]/;

function hits(pattern: RegExp, text: string, accept: (match: RegExpExecArray) => Hit | null = defaultHit): Hit[] {
  const found: Hit[] = [];
  for (const match of text.matchAll(pattern)) {
    const hit = accept(match as RegExpExecArray);
    if (hit) found.push(hit);
  }
  return found;
}

function defaultHit(match: RegExpExecArray): Hit {
  return { index: match.index, length: match[0].length };
}

// C-11: 연결어미 뒤 쉼표. 같은 글자로 끝나는 명사(광고, 문서 목록 등)는 연결어미가 아니다.
const CONNECTIVE_ENDINGS = ['지만', '면서', '아서', '어서', '고', '며'];
const NOUNS_ENDING_LIKE_CONNECTIVE = new Set([
  '참고',
  '최고',
  '국고',
  '금고',
  '광고',
  '보고',
  '재고',
  '창고',
  '사고',
  '경고',
  '원고',
  '공고',
  '신고',
  '수고',
  '잔고',
  '제고',
  '선고',
  '기고',
  '투고',
  '회고',
  '예고',
  '부고',
  '숙고',
  '고고',
  '포고',
  '선전포고',
  '탈고',
  '장고',
]);

// D-1: 결산어. "~에 따라서"의 "따라서"는 결산어가 아니다.
const SUMMARY_WORDS = /(?<![가-힣])(?:결론적으로|(?<!에\s?)따라서|이를\s*통해|그러므로|요약하면|정리하자면|종합하면)/g;

// D-2: 의의 과장. 활용형을 함께 잡으려고 어간까지만 적는다.
const SIGNIFICANCE =
  /시사하는\s*바가\s*크|주목할\s*만하|매우\s*중요하|간과할\s*수\s*없|무시할\s*수\s*없|지평을\s*(?:연|열)|방점을\s*찍|의미가\s*적지\s*않|의미심장|반드시\s*기억해야/g;

// D-3: 열거 도입
const LIST_INTRO = /크게\s*(?:두|세|네|다섯|여섯|일곱|[0-9]+)\s*가지로\s*나눌\s*수\s*있|다음과\s*같/g;

// C-5: 이모지. 기본이 그림 글자인 것과, 글자 기호 뒤에 그림 선택자(U+FE0F)가 붙은 것. ↔ ▶ © 같은 글자 기호는 뺀다.
const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/gu;

// J-2: 따옴표 강조. 한글이 든 짧은 따옴표 구간. 발화 표지(말했다·밝혔다·따르면)가 붙은 직접 인용은 뺀다.
const QUOTED = /"([^"\n]{1,40})"|“([^”\n]{1,40})”|(?<![\p{L}\p{N}])'([^'\n]{1,40})'(?![\p{L}\p{N}])|‘([^’\n]{1,40})’/gu;
const SPEECH_AFTER = /^[^.?!\n]{0,12}?(?:말했|말한|밝혔|밝힌|전했|물었|답했|덧붙였|외쳤)/;
const SPEECH_BEFORE = /따르면[^.?!\n]{0,6}$/;

// C-10: 콜론 부제 헤딩. 번호 절(1., Ⅱ., (3), 제2장으로 시작)과 콜론 앞이 ID뿐인 제목(D-017: ...)은
// 실제 절 제목이라 뺀다. "T1-05 규칙 코어: ..."처럼 ID 뒤에 라벨이 붙으면 본다.
const HEADING = /^ {0,3}#{1,6}[ \t]+(.*)$/gm;
const SECTION_PREFIX = /^(?:\d+(?:\.\d+)*\.|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+\.|\(\d+\)|제\s*\d+\s*[장절편부])(?:\s|$)/;
const ID_ONLY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;

export const RULES: readonly Rule[] = [
  {
    id: 'A-7',
    kinds: ['markdown', 'code'],
    find: (text) => hits(/가지고\s*있/g, text),
  },
  {
    id: 'A-8',
    kinds: ['markdown', 'code'],
    find: (text) => hits(/되어(?:지|진|질|져|짐)/g, text),
  },
  {
    id: 'C-5',
    kinds: ['markdown', 'code'],
    find: (text) => hits(EMOJI, text),
  },
  {
    id: 'C-10',
    kinds: ['markdown'],
    allowedPerDocument: 1,
    find: (text) =>
      hits(HEADING, text, (match) => {
        const title = match[1]!;
        const plain = title.replace(/[*_]/g, '').trim();
        const colon = plain.match(/^(.+?):\s+\S/);
        if (!colon || SECTION_PREFIX.test(plain) || ID_ONLY.test(colon[1]!.trim())) return null;
        return { index: match.index + match[0].length - title.length, length: title.trimEnd().length };
      }),
  },
  {
    id: 'C-11',
    kinds: ['markdown', 'code'],
    find: (text) =>
      hits(/([가-힣]+)\s*,/g, text, (match) => {
        const word = match[1]!;
        if (word.length < 2 || NOUNS_ENDING_LIKE_CONNECTIVE.has(word)) return null;
        if (!CONNECTIVE_ENDINGS.some((ending) => word.endsWith(ending) && word.length > ending.length)) return null;
        return defaultHit(match);
      }),
  },
  {
    id: 'D-1',
    kinds: ['markdown', 'code'],
    allowedPerDocument: 3,
    find: (text) => hits(SUMMARY_WORDS, text),
  },
  {
    id: 'D-2',
    kinds: ['markdown', 'code'],
    find: (text) => hits(SIGNIFICANCE, text),
  },
  {
    id: 'D-3',
    kinds: ['markdown', 'code'],
    find: (text) => hits(LIST_INTRO, text),
  },
  {
    id: 'J-2',
    kinds: ['markdown', 'code'],
    allowedPerDocument: 4,
    find: (text) =>
      hits(QUOTED, text, (match) => {
        const inner = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
        if (!HANGUL.test(inner)) return null;
        const after = text.slice(match.index + match[0].length, match.index + match[0].length + 20);
        const before = text.slice(Math.max(0, match.index - 12), match.index);
        if (SPEECH_AFTER.test(after) || SPEECH_BEFORE.test(before)) return null;
        return defaultHit(match);
      }),
  },
];

// ---- 예외 표시 ----

const IGNORE_DIRECTIVE = /lint-text-ignore((?:[\s,]+[A-Z]-\d{1,2})+)/;
const MARKDOWN_IGNORE_COMMENT = /<!--\s*lint-text-ignore\b[^>]*?-->/g;

function ignoredIds(line: string): Set<string> {
  const match = line.match(IGNORE_DIRECTIVE);
  if (!match) return new Set();
  return new Set(match[1]!.split(/[\s,]+/).filter(Boolean));
}

// ---- 마크다운: 코드·URL·경로를 가린다 ----

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

function maskInlineCode(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      out += line[i];
      i += 1;
      continue;
    }
    let run = 1;
    while (line[i + run] === '`') run += 1;
    const fence = '`'.repeat(run);
    let close = line.indexOf(fence, i + run);
    while (close !== -1 && line[close + run] === '`') {
      let next = close;
      while (line[next] === '`') next += 1;
      close = line.indexOf(fence, next);
    }
    if (close === -1) {
      out += fence;
      i += run;
      continue;
    }
    out += blank(line.slice(i, close + run));
    i = close + run;
  }
  return out;
}

function maskTablePathCells(line: string): string {
  if (!/^\s*\|/.test(line)) return line;
  return line.replace(/(?<=\|)([^|]*)(?=\|)/g, (cell) => {
    const value = cell.trim();
    const isPath = /^[^\s]*[/\\][^\s]*$/.test(value) || /^[\w.-]+\.[a-z]{1,5}$/i.test(value);
    return isPath ? blank(cell) : cell;
  });
}

export function maskMarkdown(source: string, { keepIgnoreComments = false } = {}): string {
  const lines = source.split('\n');
  let fence: string | null = null;
  return lines
    .map((raw) => {
      const fenceMatch = raw.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        if (fenceMatch && fenceMatch[1]![0] === fence[0] && fenceMatch[1]!.length >= fence.length) fence = null;
        return blank(raw);
      }
      if (fenceMatch) {
        fence = fenceMatch[1]!;
        return blank(raw);
      }
      let line = maskInlineCode(raw);
      line = line.replace(/<(?:https?|ftp|mailto):[^>\s]*>/g, blank);
      line = line.replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, (link) => '](' + blank(link.slice(2, -1)) + ')');
      line = line.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (_all, label: string, url: string) => label + blank(url));
      line = line.replace(/\b(?:https?|ftp):\/\/[^\s)>\]]+/g, blank);
      line = line.replace(/\bwww\.[^\s)>\]]+/g, blank);
      line = maskTablePathCells(line);
      if (!keepIgnoreComments) line = line.replace(MARKDOWN_IGNORE_COMMENT, blank);
      return line;
    })
    .join('\n');
}

// ---- 코드: 문자열과 JSX 텍스트만 꺼낸다 ----

function isModuleSpecifier(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isExternalModuleReference(parent)) {
    return true;
  }
  if (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent)) return true;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'require');
  }
  return false;
}

export function codeSegments(path: string, source: string, { koreanOnly }: { koreanOnly: boolean }): Segment[] {
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
  const segments: Segment[] = [];
  const add = (start: number, text: string) => {
    if (koreanOnly && !HANGUL.test(text)) return;
    segments.push({ text, offset: start });
  };
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateTail(node)) {
      if (!isModuleSpecifier(node)) add(node.getStart(file) + 1, node.getText(file).slice(1, -1));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node)) {
      add(node.getStart(file) + 1, node.getText(file).slice(1, -2));
    } else if (ts.isJsxText(node)) {
      add(node.getStart(file), node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return segments;
}

// ---- 검사 ----

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

export interface LintInput {
  path: string;
  source: string;
  kind: SourceKind;
  /** code일 때만: 한글이 든 문자열만 본다 */
  koreanOnly?: boolean;
}

export function lintSource({ path, source, kind, koreanOnly = false }: LintInput): Finding[] {
  const text = source.replace(/\r\n?/g, '\n');
  const segments =
    kind === 'markdown' ? [{ text: maskMarkdown(text), offset: 0 }] : codeSegments(path, text, { koreanOnly });
  const starts = lineStarts(text);
  // 마크다운의 예외 표시는 코드 밖의 HTML 주석만 인정한다. 코드는 그 줄의 주석에서 찾는다.
  const lines = (kind === 'markdown' ? maskMarkdown(text, { keepIgnoreComments: true }) : text).split('\n');
  const ignoreCache = new Map<number, Set<string>>();
  const isIgnored = (line: number, id: RuleId) => {
    if (!ignoreCache.has(line)) {
      const raw = lines[line - 1] ?? '';
      const directive = kind === 'markdown' ? (raw.match(MARKDOWN_IGNORE_COMMENT)?.join(' ') ?? '') : raw;
      ignoreCache.set(line, ignoredIds(directive));
    }
    return ignoreCache.get(line)!.has(id);
  };

  const findings: Finding[] = [];
  for (const rule of RULES) {
    if (!rule.kinds.includes(kind)) continue;
    const found: Finding[] = [];
    for (const segment of segments) {
      for (const hit of rule.find(segment.text)) {
        const start = segment.offset + hit.index;
        const line = lineOf(starts, start);
        // 가린 글이 아니라 원문을 보여 준다. 가린 부분은 길이가 같아서 위치가 그대로다.
        const shown = text
          .slice(start, start + hit.length)
          .replace(/\s+/g, ' ')
          .trim();
        if (!isIgnored(line, rule.id)) found.push({ path, line, id: rule.id, text: shown });
      }
    }
    const allowed = rule.allowedPerDocument;
    if (allowed === undefined) findings.push(...found);
    else if (found.length > allowed) {
      const note = ` (문서에 ${found.length}회, ${allowed}회까지 허용)`;
      findings.push(...found.map((finding) => ({ ...finding, text: finding.text + note })));
    }
  }
  return findings.sort((a, b) => a.line - b.line || RULE_IDS.indexOf(a.id) - RULE_IDS.indexOf(b.id));
}

export function formatFinding(finding: Finding): string {
  return `${finding.path}:${finding.line} [${finding.id}] ${finding.text}`;
}
