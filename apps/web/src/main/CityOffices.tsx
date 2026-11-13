import { useId } from 'react';
import { displayName } from '../game/names';
import type { CityView } from '../game/types';
import { Portrait } from '../portrait/Portrait';
import { Tag } from '../ui/Tag';
import styles from './CityOffices.module.css';

type Officer = NonNullable<CityView['officers']>[number];

// 원작 도시 카드의 태수·군사·종사 줄 (INT-26 W2). 종사는 월드 설정(secretaryEnabled)이 켜졌을 때만 자리가 있다.
const LOCAL_OFFICES = [
  { level: 4, title: '태수' },
  { level: 3, title: '군사' },
  { level: 2, title: '종사' },
] as const;

export interface OfficeSeat {
  title: string;
  holder: Officer | undefined;
}

// 도시 관직 자리. 빈 자리도 `없음`으로 보이도록 자리마다 한 줄을 만든다. 수뇌·참모는 이 도시에 머무는 사람만 덧붙인다.
export function cityOfficeSeats(officers: readonly Officer[], secretaryEnabled: boolean): OfficeSeat[] {
  const local = LOCAL_OFFICES.filter(({ level }) => level !== 2 || secretaryEnabled).map(({ level, title }) => ({
    title,
    holder: officers.find((officer) => officer.officerLevel === level),
  }));
  const heads = officers
    .filter(({ officerLevel }) => officerLevel >= 5 && officerLevel <= 11)
    .map((officer) => ({ title: officer.officerLevel === 11 ? '참모' : '수뇌', holder: officer }));
  return [...local, ...heads];
}

// 도시 카드의 관직 칸. 얼굴(원형 icon)·이름·NPC 딱지·주재 여부를 글자로 쓴다. 빈 자리는 `없음`이다.
export function CityOffices({
  officers,
  secretaryEnabled = false,
}: {
  officers: readonly Officer[];
  secretaryEnabled?: boolean;
}) {
  const titleId = useId();
  const seats = cityOfficeSeats(officers, secretaryEnabled);
  return (
    <section className={styles.offices} aria-labelledby={titleId} data-testid="city-offices">
      <h3 id={titleId} className={styles.heading}>
        도시 관직
      </h3>
      <ul className={styles.list}>
        {seats.map(({ title, holder }) => {
          const name = holder ? displayName(holder.name) : null;
          return (
            <li key={holder ? `${title}-${holder.generalId}` : title} className={styles.seat} data-office={title}>
              <span className={styles.title}>{title}</span>
              {holder && name ? (
                <span className={styles.holder}>
                  <Portrait id={holder.portraitId} name={name} variant="icon" shape="round" size={24} decorative />
                  <span data-general-name="">{name}</span>
                  {holder.isHuman ? null : (
                    <Tag tone="muted" title="사람이 맡지 않은 장수입니다">
                      NPC
                    </Tag>
                  )}
                  <span className={styles.presence}>{holder.resident ? '주재' : '부재'}</span>
                </span>
              ) : (
                <span className={styles.empty}>없음</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
