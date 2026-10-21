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

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

// URL을 같은 길이의 공백으로 가린다. 마크다운과 코드 문자열이 함께 쓴다.
function maskUrls(text: string): string {
  return text.replace(/\b(?:https?|ftp):\/\/[^\s)>\]]+/g, blank).replace(/\bwww\.[^\s)>\]]+/g, blank);
}

// ---- 마크다운: 코드·URL·경로를 가린다 ----

// 인라인 코드는 CommonMark처럼 읽는다. 백틱 묶음은 길이가 같은 묶음과만 짝을 짓고, 짝이 없으면 글자로 남는다.
// 코드 밖에서 역슬래시 뒤의 문장 부호는 글자라서, 역슬래시 바로 뒤의 백틱은 여는 표지가 아니다(\\ 뒤의 백틱은 연다).
// 코드 안에서는 이스케이프가 없으므로 닫는 표지는 역슬래시와 상관없이 찾는다.
// text는 인라인 묶음 하나(여러 줄 문단이면 줄바꿈으로 이은 것)라서 코드가 줄을 넘어도 된다. 묶음 밖으로는 넘지 않는다.
// 닫는 표지를 찾을 때는 GitHub(cmark-gfm)과 markdown-it처럼 길이마다 마지막으로 본 묶음 위치를 적어 둔다.
// 한 번 끝까지 훑은 뒤에는 그 위치가 여는 표지보다 앞이면 닫는 표지가 없다고 본다. 두 구현이 같게 읽는 결과를 따른다.
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

function backtickRunEnd(text: string, start: number): number {
  let end = start;
  while (text[end] === '`') end += 1;
  return end;
}

function maskInlineCode(text: string): string {
  const lastRun = new Map<number, number>();
  let scannedToEnd = false;
  const closingRun = (open: number, from: number, length: number): number => {
    if (scannedToEnd && (lastRun.get(length) ?? 0) <= open) return -1;
    let i = text.indexOf('`', from);
    while (i !== -1) {
      const end = backtickRunEnd(text, i);
      lastRun.set(end - i, i);
      if (end - i === length) return i;
      i = text.indexOf('`', end);
    }
    scannedToEnd = true;
    return -1;
  };

  let out = '';
  let i = 0;
  while (i < text.length) {
    const char = text[i]!;
    if (char === '\\' && ASCII_PUNCTUATION.test(text[i + 1] ?? '')) {
      out += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (char !== '`') {
      out += char;
      i += 1;
      continue;
    }
    const runEnd = backtickRunEnd(text, i);
    const close = closingRun(i, runEnd, runEnd - i);
    if (close === -1) {
      out += text.slice(i, runEnd);
      i = runEnd;
      continue;
    }
    const end = close + (runEnd - i);
    out += blank(text.slice(i, end));
    i = end;
  }
  return out;
}

// 표의 행은 GFM처럼 | 로 칸을 먼저 나눈 뒤 칸마다 인라인 코드를 찾는다. 역슬래시 바로 뒤의 | 는 칸을 나누지 않는다.
// cmark-gfm은 역슬래시가 몇 개든 바로 뒤의 | 를 글자로 본다.
function splitTableRow(row: string): string[] {
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (row[i] === '|' && row[i - 1] !== '\\') {
      cells.push(row.slice(start, i));
      start = i + 1;
    }
  }
  cells.push(row.slice(start));
  return cells;
}

function tableCellCount(text: string): number {
  const cells = splitTableRow(text.trim());
  if (cells.length > 1 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 1 && cells.at(-1)!.trim() === '') cells.pop();
  return cells.length;
}

const TABLE_DELIMITER_CELL = /^[ \t]*:?-+:?[ \t]*$/;

function isTableDelimiter(text: string): boolean {
  if (!text.includes('|')) return false;
  const cells = splitTableRow(text.trim());
  if (cells[0]!.trim() === '') cells.shift();
  if (cells.length > 0 && cells.at(-1)!.trim() === '') cells.pop();
  return cells.length > 0 && cells.every((cell) => TABLE_DELIMITER_CELL.test(cell));
}

function maskTablePathCells(line: string): string {
  if (!/^\s*\|/.test(line)) return line;
  return line.replace(/(?<=\|)([^|]*)(?=\|)/g, (cell) => {
    const value = cell.trim();
    const isPath = /^[^\s]*[/\\][^\s]*$/.test(value) || /^[\w.-]+\.[a-z]{1,5}$/i.test(value);
    return isPath ? blank(cell) : cell;
  });
}

// 블록 구조는 CommonMark를 줄여서 따른다. 줄마다 열린 컨테이너(인용, 목록 항목)를 바깥부터 맞춰 보고,
// 남은 자리에서 새 컨테이너를 여는 대로 모두 연 뒤, 가장 안쪽의 첫 내용이 코드인지 판정한다.
// 그래서 한 줄에 인용과 목록 표지가 몇 겹이든, 표지 바로 뒤가 펜스나 들여쓴 코드여도 같은 경로를 탄다.
// 칸은 탭을 4칸 정지로 펼쳐서 센다. 코드로 판정한 줄은 통째로 가린다(남는 것은 컨테이너 표지뿐이다).
const FENCE_OPEN = /^(`{3,})[^`]*$|^(~{3,})/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t]*$/;
const LIST_MARKER = /^(?:[-+*]|(\d{1,9})[.)])(?= |$)/;
const THEMATIC_BREAK = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_HEADING = /^#{1,6}(?: |$)/;

interface ListItem {
  kind: 'list';
  /** 바깥 컨테이너의 내용 시작점에서 항목 내용까지의 칸. 인용 표지 앞 공백은 줄마다 달라서 절대 칸으로 두지 않는다. */
  width: number;
  /** 내용이나 하위 컨테이너가 생겼는가. 빈 채로 열린 항목은 빈 줄에서 끝난다. */
  filled: boolean;
}
type Container = { kind: 'quote' } | ListItem;
type Leaf =
  /** lines는 이 문단의 인라인 묶음이다. last는 마지막 줄의 내용(표 머리줄인지 볼 때 쓴다). */
  | { kind: 'paragraph'; lines: number[]; last: string }
  | { kind: 'table' }
  | { kind: 'indented' }
  | { kind: 'fence'; marker: string }
  | null;

function expandTabs(line: string): string {
  let out = '';
  for (const char of line) out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char;
  return out;
}

function spacesAt(line: string, pos: number): number {
  let end = pos;
  while (line[end] === ' ') end += 1;
  return end - pos;
}

// 목록 표지로 시작하면 표지 앞에서 항목 내용까지의 칸 수를 돌려준다. 표지 뒤가 1~4칸이면 거기서 내용이
// 시작한다. 5칸 이상이거나 비었으면 1칸 뒤에서 시작하고, 나머지 칸은 내용의 들여쓰기(들여쓴 코드)다.
// 문단을 끊을 때는 빈 항목과 1이 아닌 번호 목록이 항목을 열지 못한다.
function listItemWidth(text: string, interruptsParagraph: boolean): number | null {
  const marker = text.match(LIST_MARKER);
  if (!marker) return null;
  const markerEnd = marker[0].length;
  const gap = spacesAt(text, markerEnd);
  const empty = markerEnd + gap === text.length;
  if (interruptsParagraph && (empty || (marker[1] !== undefined && marker[1] !== '1'))) return null;
  return markerEnd + (empty || gap > 4 ? 1 : gap);
}

// 컨테이너 표지가 빠진 줄이 앞 문단에 이어지는가(게으른 이어쓰기). 새 블록을 여는 줄이면 이어지지 않는다.
// 이때는 바깥 컨테이너에서 새 블록을 여는 것이라 빈 항목이나 1이 아닌 번호 목록도 항목을 연다.
function continuesParagraph(line: string, pos: number): boolean {
  const indent = spacesAt(line, pos);
  const text = line.slice(pos + indent);
  if (text === '') return false;
  if (indent >= 4) return true;
  return !(
    text[0] === '>' ||
    FENCE_OPEN.test(text) ||
    ATX_HEADING.test(text) ||
    THEMATIC_BREAK.test(text) ||
    listItemWidth(text, false) !== null
  );
}

// 인라인 글의 묶음. 문단은 이어지는 줄을 한 묶음으로 모으고, 제목과 표의 행은 한 줄이 한 묶음이다.
// 인라인 코드는 묶음 안에서만 짝을 짓는다. 빈 줄, 새 블록, 컨테이너가 끝난 뒤의 줄은 다른 묶음이다.
interface InlineGroup {
  lines: number[];
  tableRow: boolean;
}

export function maskMarkdown(source: string, { keepIgnoreComments = false } = {}): string {
  const lines = source.split('\n');
  const out = [...lines];
  const groups: InlineGroup[] = [];
  let containers: Container[] = [];
  let leaf: Leaf = null;

  const single = (n: number, tableRow = false) => groups.push({ lines: [n], tableRow });

  const blockLine = (raw: string, n: number): void => {
    const line = expandTabs(raw);
    let pos = 0;

    // 1. 열린 컨테이너를 바깥부터 맞춰 본다. 빈 줄은 인용을 끝내고, 내용 없이 열린 목록 항목도 끝낸다.
    let matched = 0;
    for (const container of containers) {
      const indent = spacesAt(line, pos);
      if (container.kind === 'quote') {
        // 이미 열린 인용은 표지 앞이 4칸 이상 들여써져도 이어 본다. markdown-it과 같고,
        // 코드로 보고 가리는 쪽보다 글로 보고 검사하는 쪽을 고른 것이다.
        if (line[pos + indent] !== '>') break;
        pos += indent + 1;
        if (line[pos] === ' ') pos += 1;
      } else if (pos + indent === line.length) {
        if (!container.filled) break;
        pos = line.length;
      } else {
        if (indent < container.width) break;
        pos += container.width;
      }
      matched += 1;
    }

    // 2. 컨테이너가 모두 이어지면 열린 코드 블록도 이어진다. 하나라도 끝나면 그 안의 블록도 끝난다.
    if (matched === containers.length) {
      if (leaf?.kind === 'fence') {
        const indent = spacesAt(line, pos);
        const close = line.slice(pos + indent).match(FENCE_CLOSE)?.[1];
        if (indent <= 3 && close && close[0] === leaf.marker[0] && close.length >= leaf.marker.length) leaf = null;
        out[n] = blank(raw);
        return;
      }
      if (leaf?.kind === 'indented') {
        const indent = spacesAt(line, pos);
        if (indent >= 4 || pos + indent === line.length) {
          out[n] = blank(raw);
          return;
        }
        leaf = null;
      }
    } else if (leaf?.kind === 'paragraph' && continuesParagraph(line, pos)) {
      // 게으른 이어쓰기 줄은 같은 문단이라 앞 줄과 한 묶음이다.
      leaf.lines.push(n);
      leaf.last = line.slice(pos).trim();
      return;
    } else {
      containers = containers.slice(0, matched);
      leaf = null;
    }

    // 3. 남은 자리에서 새 컨테이너를 모두 연다. 한 줄에 인용과 목록 표지가 겹쳐도 차례로 연다.
    for (;;) {
      const indent = spacesAt(line, pos);
      if (indent >= 4) break;
      const start = pos + indent;
      const text = line.slice(start);
      if (text[0] === '>') {
        containers.push({ kind: 'quote' });
        pos = start + 1;
        if (line[pos] === ' ') pos += 1;
        leaf = null;
        continue;
      }
      // 문단 바로 아래의 - 줄은 제목 밑줄이다.
      if (THEMATIC_BREAK.test(text) || (leaf?.kind === 'paragraph' && /^-+[ \t]*$/.test(text))) break;
      const width = listItemWidth(text, leaf?.kind === 'paragraph');
      if (width === null) break;
      containers.push({ kind: 'list', width: indent + width, filled: false });
      pos = Math.min(start + width, line.length);
      leaf = null;
    }

    // 4. 가장 안쪽 컨테이너의 첫 내용을 판정한다. 문단 중간이 아니면 4칸 이상 들여쓴 줄은 코드다.
    const indent = spacesAt(line, pos);
    const text = line.slice(pos + indent);
    for (const [i, container] of containers.entries()) {
      if (container.kind === 'list' && (text !== '' || i < containers.length - 1)) container.filled = true;
    }
    if (text === '') {
      leaf = null;
      return;
    }
    // 표는 빈 줄이나 새 블록이 나올 때까지 줄마다 한 행이다.
    if (leaf?.kind === 'table') {
      if (indent >= 4 || !(FENCE_OPEN.test(text) || ATX_HEADING.test(text) || THEMATIC_BREAK.test(text))) {
        single(n, true);
        return;
      }
      leaf = null;
    }
    if (indent >= 4) {
      if (leaf?.kind === 'paragraph') {
        leaf.lines.push(n);
        leaf.last = text;
        return;
      }
      leaf = { kind: 'indented' };
      out[n] = blank(raw);
      return;
    }
    const fence = text.match(FENCE_OPEN);
    if (fence) {
      leaf = { kind: 'fence', marker: fence[1] ?? fence[2]! };
      out[n] = blank(raw);
      return;
    }
    // GFM 표: 문단의 마지막 줄과 칸 수가 같은 구분 줄이 오면 그 줄부터 표다. 앞 줄들은 문단으로 남는다.
    if (leaf?.kind === 'paragraph' && isTableDelimiter(text) && tableCellCount(leaf.last) === tableCellCount(text)) {
      single(leaf.lines.pop()!, true);
      single(n, true);
      leaf = { kind: 'table' };
      return;
    }
    const ends =
      ATX_HEADING.test(text) ||
      THEMATIC_BREAK.test(text) ||
      (leaf?.kind === 'paragraph' && /^(?:=+|-+)[ \t]*$/.test(text));
    if (ends) {
      single(n);
      leaf = null;
    } else if (leaf?.kind === 'paragraph') {
      leaf.lines.push(n);
      leaf.last = text;
    } else {
      const paragraph: InlineGroup = { lines: [n], tableRow: false };
      groups.push(paragraph);
      leaf = { kind: 'paragraph', lines: paragraph.lines, last: text };
    }
  };

  lines.forEach(blockLine);

  // 인라인 코드를 묶음 단위로 가린 뒤, 나머지(URL, 링크 주소, 표의 경로 칸, 예외 주석)는 줄마다 가린다.
  const inline = new Set<number>();
  for (const { lines: group, tableRow } of groups) {
    if (group.length === 0) continue;
    const joined = group.map((n) => lines[n]!).join('\n');
    const masked = tableRow ? splitTableRow(joined).map(maskInlineCode).join('|') : maskInlineCode(joined);
    masked.split('\n').forEach((line, i) => {
      out[group[i]!] = line;
      inline.add(group[i]!);
    });
  }
  return out.map((line, n) => (inline.has(n) ? maskInlineRest(line, keepIgnoreComments) : line)).join('\n');
}

function maskInlineRest(line: string, keepIgnoreComments: boolean): string {
  line = line.replace(/<(?:https?|ftp|mailto):[^>\s]*>/g, blank);
  line = line.replace(/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, (link) => '](' + blank(link.slice(2, -1)) + ')');
  line = line.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)/, (_all, label: string, url: string) => label + blank(url));
  line = maskUrls(line);
  line = maskTablePathCells(line);
  if (!keepIgnoreComments) line = line.replace(MARKDOWN_IGNORE_COMMENT, blank);
  return line;
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

function parseCode(path: string, source: string): ts.SourceFile {
  const scriptKind = path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, scriptKind);
}

export function codeSegments(path: string, source: string, { koreanOnly }: { koreanOnly: boolean }): Segment[] {
  const file = parseCode(path, source);
  const segments: Segment[] = [];
  const add = (start: number, raw: string) => {
    const text = maskUrls(raw);
    if (koreanOnly && !HANGUL.test(text)) return;
    segments.push({ text, offset: start });
  };
  // 템플릿은 ${...} 자리를 공백 없는 글자로 메운 뒤 URL을 가린다. 주소 가운데에 값이 들어가도 한 URL로 본다.
  const addTemplate = (node: ts.TemplateExpression | ts.TemplateLiteralTypeNode) => {
    const parts = [node.head, ...node.templateSpans.map((span) => span.literal)].map((part) => {
      const start = part.getStart(file) + 1;
      const tail = ts.isTemplateTail(part) ? 1 : 2;
      return { start, end: part.getEnd() - tail };
    });
    const from = parts[0]!.start;
    let joined = '';
    for (const [i, part] of parts.entries()) {
      if (i > 0) joined += source.slice(parts[i - 1]!.end, part.start).replace(/[^\n]/g, 'x');
      joined += source.slice(part.start, part.end);
    }
    const masked = maskUrls(joined);
    for (const part of parts) {
      const text = masked.slice(part.start - from, part.end - from);
      if (!(koreanOnly && !HANGUL.test(text))) segments.push({ text, offset: part.start });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isTemplateExpression(node) || ts.isTemplateLiteralTypeNode(node)) {
      addTemplate(node);
      for (const span of node.templateSpans) {
        ts.forEachChild(span, (child) => {
          if (child !== span.literal) visit(child);
        });
      }
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (!isModuleSpecifier(node)) add(node.getStart(file) + 1, node.getText(file).slice(1, -1));
    } else if (ts.isJsxText(node)) {
      add(node.getStart(file), node.getText(file));
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return segments;
}

// 코드의 예외 표시는 실제 주석에서만 읽는다. 문자열이나 JSX 텍스트에 같은 글자가 있어도 예외가 아니다.
// 토큰 사이의 공백과 주석(trivia)만 훑는다. JSX 텍스트는 글이라서 건너뛴다.
function codeIgnores(path: string, source: string, starts: number[]): Map<number, Set<string>> {
  const file = parseCode(path, source);
  const byLine = new Map<number, Set<string>>();
  const seen = new Set<number>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) || (node.kind >= ts.SyntaxKind.FirstJSDocNode && node.kind <= ts.SyntaxKind.LastJSDocNode)) {
      return;
    }
    const children = node.getChildren(file);
    if (children.length > 0) {
      children.forEach(visit);
      return;
    }
    const ranges = [
      ...(ts.getTrailingCommentRanges(source, node.pos) ?? []),
      ...(ts.getLeadingCommentRanges(source, node.pos) ?? []),
    ];
    for (const range of ranges) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      const comment = source.slice(range.pos, range.end);
      for (const match of comment.matchAll(new RegExp(IGNORE_DIRECTIVE, 'g'))) {
        const line = lineOf(starts, range.pos + match.index);
        const ids = byLine.get(line) ?? new Set<string>();
        for (const id of ignoredIds(match[0])) ids.add(id);
        byLine.set(line, ids);
      }
    }
  };
  visit(file);
  return byLine;
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
  // 마크다운의 예외 표시는 코드 밖의 HTML 주석만 인정한다. 코드는 실제 주석에 적힌 것만 인정한다.
  const ignores =
    kind === 'markdown'
      ? new Map(
          maskMarkdown(text, { keepIgnoreComments: true })
            .split('\n')
            .map((line, i) => [i + 1, ignoredIds(line.match(MARKDOWN_IGNORE_COMMENT)?.join(' ') ?? '')] as const),
        )
      : codeIgnores(path, text, starts);
  const isIgnored = (line: number, id: RuleId) => ignores.get(line)?.has(id) ?? false;

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
