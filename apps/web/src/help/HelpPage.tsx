import { Link, useRouterState } from '@tanstack/react-router';
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import diplomacyIcon from '../art/icons/diplomacy.png';
import domesticIcon from '../art/icons/domestic.png';
import helpIcon from '../art/icons/help.png';
import mainIcon from '../art/icons/main.png';
import mapIcon from '../art/icons/map.png';
import militaryIcon from '../art/icons/military.png';
import nationIcon from '../art/icons/nation.png';
import personnelIcon from '../art/icons/personnel.png';
import recordsIcon from '../art/icons/records.png';
import strategyIcon from '../art/icons/strategy.png';
import turnsIcon from '../art/icons/turns.png';
import { lastWorld, resetGuide } from '../onboarding/guideStorage';
import { EmptyState } from '../ui/States';
import { CATALOG_DOC, GUIDE_ORDER, GUIDES } from './guides';
import { guideTarget, parseMarkdown, type Block, type Inline } from './markdown';
import styles from './HelpPage.module.css';

// 차례의 도트 아이콘 (INT-20). 꾸밈이라 대체 글은 비운다. 모르는 문서는 도움말 아이콘을 쓴다.
const GUIDE_ICON: Record<string, string> = {
  index: helpIcon,
  'integration-v01': personnelIcon,
  'general-and-city': mainIcon,
  'time-and-turns': turnsIcon,
  'war-and-orders': militaryIcon,
  'map-and-supply': mapIcon,
  'economy-and-diplomacy': diplomacyIcon,
  'nation-and-features': nationIcon,
  glossary: recordsIcon,
  'commands-and-timing': domesticIcon,
  [CATALOG_DOC]: strategyIcon,
};

function GuideIcon({ doc }: { doc: string }) {
  return <img className={styles.icon} src={GUIDE_ICON[doc] ?? helpIcon} alt="" width={32} height={32} />;
}

// /help, /help/:doc. 플레이어 가이드 9개와 생성 명령 목록을 게임 화면 안에서 연다 (T2-17).
// 로그인하지 않아도 열린다. 처음 온 사람이 가입 전에 읽을 수 있어야 하기 때문이다.
export function HelpPage({ doc }: { doc: string }) {
  const source = GUIDES[doc];
  const blocks = useMemo(() => (source === undefined ? null : visibleBlocks(parseMarkdown(source))), [source]);
  const hash = useRouterState({ select: (state) => state.location.hash });
  // 이 탭에서 연 월드가 있으면 그 월드의 첫 턴 안내를 다시 띄운다. 모르면 링크를 숨긴다.
  const [world] = useState(() => lastWorld());

  // 절 링크로 오면 그 제목으로, 문서만 바뀌면 맨 위로 간다.
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash)) : null;
    if (target) target.scrollIntoView();
    else window.scrollTo?.(0, 0);
  }, [doc, hash, blocks]);

  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <Link to="/help/$doc" params={{ doc: 'index' }} className={styles.brand}>
          <img className={styles.icon} src={helpIcon} alt="" width={32} height={32} />
          <span className={styles.brandName}>오픈삼국</span> 도움말
        </Link>
        {world ? (
          <Link
            to="/w/$worldId"
            params={{ worldId: world }}
            className={`${styles.back} ${styles.again}`}
            onClick={() => resetGuide(world)}
          >
            첫 턴 안내 다시 보기
          </Link>
        ) : null}
        <Link to="/" className={styles.back}>
          게임으로 돌아가기
        </Link>
      </header>
      <div className={styles.layout}>
        <nav className={styles.nav} aria-label="가이드 목록">
          <ol>
            {GUIDE_ORDER.map((guide) => (
              <li key={guide.doc}>
                <Link
                  to="/help/$doc"
                  params={{ doc: guide.doc }}
                  activeOptions={{ includeHash: false }}
                  activeProps={{ 'aria-current': 'page', className: styles.current }}
                >
                  <GuideIcon doc={guide.doc} />
                  {guide.title}
                </Link>
              </li>
            ))}
            <li>
              <Link
                to="/help/$doc"
                params={{ doc: CATALOG_DOC }}
                activeOptions={{ includeHash: false }}
                activeProps={{ 'aria-current': 'page', className: styles.current }}
              >
                <GuideIcon doc={CATALOG_DOC} />
                명령 목록
              </Link>
            </li>
          </ol>
        </nav>
        <article className={styles.article} data-testid="help-article" data-doc={doc}>
          {blocks ? (
            <BlockList blocks={blocks} />
          ) : doc === CATALOG_DOC ? (
            <EmptyState title="명령 목록은 준비 중입니다">
              명령 정의에서 자동으로 만드는 목록입니다. 그동안은 예턴 편집기의 명령 찾기와 사전 검사 열로 조건을
              확인하세요.
            </EmptyState>
          ) : (
            <EmptyState title="없는 도움말입니다">
              <Link to="/help/$doc" params={{ doc: 'index' }}>
                시작하기로 가기
              </Link>
            </EmptyState>
          )}
        </article>
      </div>
    </div>
  );
}

// 문서 머리의 상태·근거 안내(> 상태: …)는 작성자용이라 화면에서는 뺀다.
function visibleBlocks(blocks: Block[]): Block[] {
  return blocks.filter((block) => {
    if (block.kind !== 'quote') return true;
    const first = block.blocks[0];
    return !(first?.kind === 'paragraph' && first.lines[0]?.[0]?.text.startsWith('상태:'));
  });
}

function BlockList({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => <BlockView key={i} block={block} />);
}

function BlockView({ block }: { block: Block }): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const Tag = `h${Math.min(block.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
      return (
        <Tag id={block.id}>
          <Inlines inlines={block.text} />
        </Tag>
      );
    }
    case 'paragraph':
      return (
        <p>
          {block.lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 ? ' ' : null}
              <Inlines inlines={line} />
            </Fragment>
          ))}
        </p>
      );
    case 'list': {
      const List = block.ordered ? 'ol' : 'ul';
      return (
        <List>
          {block.items.map((item, i) => (
            <li key={i}>
              <Inlines inlines={item} />
            </li>
          ))}
        </List>
      );
    }
    case 'table':
      return (
        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} scope="col">
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c}>
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'quote':
      return (
        <aside className={styles.note}>
          <BlockList blocks={block.blocks} />
        </aside>
      );
    case 'code':
      return (
        <pre>
          <code>{block.text}</code>
        </pre>
      );
  }
}

function Inlines({ inlines }: { inlines: Inline[] }) {
  return inlines.map((inline, i) => {
    if (inline.kind === 'code') return <code key={i}>{inline.text}</code>;
    if (inline.kind === 'strong') return <strong key={i}>{inline.text}</strong>;
    if (inline.kind === 'link') {
      const target = guideTarget(inline.href);
      if (target)
        return (
          <Link key={i} to="/help/$doc" params={{ doc: target.doc }} {...(target.hash ? { hash: target.hash } : {})}>
            {inline.text}
          </Link>
        );
      if (/^https?:\/\//.test(inline.href))
        return (
          <a key={i} href={inline.href} target="_blank" rel="noreferrer">
            {inline.text}
          </a>
        );
      return <Fragment key={i}>{inline.text}</Fragment>;
    }
    return <Fragment key={i}>{inline.text}</Fragment>;
  });
}
