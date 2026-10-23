// 플레이어 가이드(docs/user/*.md)를 화면에 그리려고 쓰는 작은 마크다운 해석기 (T2-17).
// 가이드가 쓰는 문법만 다룬다: 제목, 문단, 글머리·번호 목록, 표, 인용, 코드 블록, 인라인 코드·굵게·링크.
// 새 의존성을 들이지 않으려고 직접 쓴다. 가이드에 다른 문법을 쓰면 이 파일과 시험을 함께 고친다.

export type Inline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block =
  | { kind: 'heading'; level: number; id: string; text: Inline[] }
  | { kind: 'paragraph'; lines: Inline[][] }
  | { kind: 'list'; ordered: boolean; items: Inline[][] }
  | { kind: 'table'; head: Inline[][]; rows: Inline[][][] }
  | { kind: 'quote'; blocks: Block[] }
  | { kind: 'code'; text: string };

// GitHub과 같은 방식의 제목 앵커. 소문자로 바꾸고 글자·숫자·공백·하이픈만 남긴 뒤 공백을 하이픈으로 바꾼다.
export function slug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

const plain = (inlines: Inline[]) => inlines.map((inline) => inline.text).join('');

export function parseInline(source: string): Inline[] {
  const result: Inline[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) result.push({ kind: 'text', text: source.slice(last, match.index) });
    if (match[1] !== undefined) result.push({ kind: 'code', text: match[1] });
    else if (match[2] !== undefined) result.push({ kind: 'strong', text: match[2] });
    else result.push({ kind: 'link', text: match[3]!, href: match[4]! });
    last = match.index + match[0].length;
  }
  if (last < source.length) result.push({ kind: 'text', text: source.slice(last) });
  return result;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => parseInline(cell.trim().replace(/\\\|/g, '|')));
const isTableRule = (line: string) => /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
const listItem = /^\s*(?:([-*])|(\d+)\.)\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  // HTML 주석(문구 검사 예외 표시 등)은 화면에 보이지 않게 지운다.
  const lines = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      blocks.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = parseInline(heading[2]!);
      blocks.push({ kind: 'heading', level: heading[1]!.length, id: slug(plain(text)), text });
      i++;
      continue;
    }
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) body.push(lines[i++]!.replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }
    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = cells(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      blocks.push({ kind: 'table', head, rows });
      continue;
    }
    const item = listItem.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== '') {
        const next = listItem.exec(lines[i]!);
        if (next && (next[2] !== undefined) === ordered) items.push(next[3]!.trim());
        else if (next || items.length === 0) break;
        // 들여 쓴 다음 줄은 앞 항목에 잇는다.
        else items[items.length - 1] += ` ${lines[i]!.trim()}`;
        i++;
      }
      blocks.push({ kind: 'list', ordered, items: items.map(parseInline) });
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^(#{1,6}\s|>|```)/.test(lines[i]!) &&
      !listItem.test(lines[i]!) &&
      !lines[i]!.trim().startsWith('|')
    )
      paragraph.push(lines[i++]!.trim());
    // 어느 규칙에도 맞지 않는 줄(규칙 줄 없는 표 줄 등)은 문단 한 줄로 두고 넘어간다.
    if (paragraph.length === 0) paragraph.push(lines[i++]!.trim());
    blocks.push({ kind: 'paragraph', lines: paragraph.map(parseInline) });
  }
  return blocks;
}

// 문서 안 링크를 도움말 화면 주소로 바꾼다. ./time-and-turns.md#국가-예턴 → { doc: 'time-and-turns', hash: '국가-예턴' }
// 같은 폴더의 .md만 바꾸고 나머지(바깥 주소, 다른 폴더)는 null이다.
export function guideTarget(href: string): { doc: string; hash: string | undefined } | null {
  const match = /^(?:\.\/)?([\w.-]+)\.md(?:#(.+))?$/.exec(href);
  if (!match) return null;
  return { doc: match[1]!, hash: match[2] ? decodeURIComponent(match[2]) : undefined };
}

export function headingIds(blocks: Block[]): Set<string> {
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.kind === 'heading') ids.add(block.id);
    if (block.kind === 'quote') for (const id of headingIds(block.blocks)) ids.add(id);
  }
  return ids;
}

export function links(blocks: Block[]): string[] {
  const hrefs: string[] = [];
  const visit = (inlines: Inline[]) => {
    for (const inline of inlines) if (inline.kind === 'link') hrefs.push(inline.href);
  };
  for (const block of blocks) {
    if (block.kind === 'heading') visit(block.text);
    if (block.kind === 'paragraph') block.lines.forEach(visit);
    if (block.kind === 'list') block.items.forEach(visit);
    if (block.kind === 'table') [block.head, ...block.rows].forEach((row) => row.forEach(visit));
    if (block.kind === 'quote') hrefs.push(...links(block.blocks));
  }
  return hrefs;
}
