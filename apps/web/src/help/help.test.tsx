// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CATALOG_DOC, GUIDE_ORDER, GUIDES } from './guides';
import { HelpPage } from './HelpPage';
import { guideTarget, headingIds, links, parseInline, parseMarkdown, slug } from './markdown';

afterEach(cleanup);

describe('가이드 마크다운', () => {
  it('제목 앵커는 GitHub 방식이다', () => {
    expect(slug('5. 기본 방침')).toBe('5-기본-방침');
    expect(slug('3. 선전포고·교전·종전·불가침')).toBe('3-선전포고교전종전불가침');
    expect(slug('국가 예턴')).toBe('국가-예턴');
  });

  it('인라인 코드·굵게·링크를 가른다', () => {
    expect(parseInline('`턴 N분`과 **경고**, [시간](./time-and-turns.md#국가-예턴)')).toEqual([
      { kind: 'code', text: '턴 N분' },
      { kind: 'text', text: '과 ' },
      { kind: 'strong', text: '경고' },
      { kind: 'text', text: ', ' },
      { kind: 'link', text: '시간', href: './time-and-turns.md#국가-예턴' },
    ]);
  });

  it('제목·표·인용·번호 목록과 이어진 줄을 읽고 주석은 지운다', () => {
    const blocks = parseMarkdown(
      [
        '# 제목',
        '',
        '> 원작과 다른 점',
        '>',
        '> 본문',
        '',
        '| 가 | 나 |',
        '| -- | -- |',
        '| 1 | 2 \\| 3 |',
        '',
        '1. 첫째',
        '   이어진 줄',
        '2. 둘째 <!-- lint-text-ignore J-2 -->',
      ].join('\n'),
    );
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'quote', 'table', 'list']);
    expect(blocks[2]).toMatchObject({ rows: [[[{ text: '1' }], [{ text: '2 | 3' }]]] });
    expect(blocks[3]).toMatchObject({
      ordered: true,
      items: [[{ text: '첫째 이어진 줄' }], [{ text: '둘째' }]],
    });
  });

  it('같은 폴더의 .md 링크만 도움말 주소로 바꾼다', () => {
    expect(guideTarget('./glossary.md')).toEqual({ doc: 'glossary', hash: undefined });
    expect(guideTarget('./command-catalog.generated.md#내정')).toEqual({ doc: CATALOG_DOC, hash: '내정' });
    expect(guideTarget('../plans/T2-17.md')).toBeNull();
    expect(guideTarget('https://example.com')).toBeNull();
  });
});

describe('가이드 9개', () => {
  it('읽는 순서의 9개가 모두 묶여 있다', () => {
    expect(GUIDE_ORDER).toHaveLength(9);
    for (const guide of GUIDE_ORDER) expect(GUIDES[guide.doc], guide.doc).toBeTypeOf('string');
  });

  it('문서 사이 링크와 절 앵커가 모두 있다. 생성 목록은 T2-16 계획의 분류 소제목만 쓴다', () => {
    // T2-16 계획(docs/plans/T2-16.md 생성 규칙)의 절과 소제목. 생성 문서가 생기면 실제 제목으로 확인한다.
    const plannedCatalog = new Set(['장수-명령', '국가-명령', '내정', '군사', '인사', '개인', '국가']);
    const broken: string[] = [];
    for (const [doc, source] of Object.entries(GUIDES)) {
      for (const href of links(parseMarkdown(source))) {
        const target = guideTarget(href);
        if (!target) {
          if (!/^https?:\/\//.test(href)) broken.push(`${doc}: ${href} (도움말 밖 주소)`);
          continue;
        }
        const text = GUIDES[target.doc];
        const ids =
          text !== undefined ? headingIds(parseMarkdown(text)) : target.doc === CATALOG_DOC ? plannedCatalog : null;
        if (!ids) broken.push(`${doc}: ${href} (문서 없음)`);
        else if (target.hash && !ids.has(target.hash)) broken.push(`${doc}: ${href} (절 없음)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('각 가이드는 다음 문서 링크와 근거 줄로 끝난다', () => {
    for (const guide of GUIDE_ORDER) {
      const source = GUIDES[guide.doc]!;
      expect(source, guide.doc).toMatch(/\n근거: .+\n$/);
      expect(source, guide.doc).toMatch(/(다음은|처음으로 돌아가려면) \[/);
    }
  });
});

async function renderHelp(path: string) {
  const root = createRootRoute();
  const doc = createRoute({
    getParentRoute: () => root,
    path: 'help/$doc',
    component: function Doc() {
      return <HelpPage doc={doc.useParams().doc} />;
    },
  });
  const home = createRoute({ getParentRoute: () => root, path: '/' });
  const router = createRouter({
    routeTree: root.addChildren([doc, home]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
}

describe('도움말 화면', () => {
  it('가이드를 그리고 작성자용 상태 안내는 빼며 문서 안 링크는 도움말 주소로 간다', async () => {
    await renderHelp('/help/index');
    expect(await screen.findByRole('heading', { level: 1, name: '시작하기' })).toBeTruthy();
    expect(screen.queryByText(/사실 기준/)).toBeNull();
    const link = screen.getAllByRole('link', { name: '시간과 턴' })[0]!;
    expect(link.getAttribute('href')).toBe('/help/time-and-turns');
    expect(screen.getByRole('navigation', { name: '가이드 목록' }).querySelectorAll('li')).toHaveLength(10);
  });

  it('절 링크는 같은 화면 안 앵커로 바뀐다', async () => {
    await renderHelp('/help/commands-and-timing');
    const link = (await screen.findAllByRole('link', { name: '내정' }))[0]!;
    expect(decodeURIComponent(link.getAttribute('href')!)).toBe('/help/command-catalog.generated#내정');
    expect(document.getElementById('3-실패-이유와-대처')).not.toBeNull();
  });

  it('생성 목록이 아직 없으면 준비 중으로 보인다', async () => {
    await renderHelp(`/help/${CATALOG_DOC}`);
    if (GUIDES[CATALOG_DOC] === undefined) expect(await screen.findByText('명령 목록은 준비 중입니다')).toBeTruthy();
    else expect(await screen.findByTestId('help-article')).toBeTruthy();
  });

  it('없는 문서는 없다고 보인다', async () => {
    await renderHelp('/help/nope');
    expect(await screen.findByText('없는 도움말입니다')).toBeTruthy();
  });
});
