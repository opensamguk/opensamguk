import { Link } from '@tanstack/react-router';
import { AdminEntry } from '../auth/AdminEntry';
import { LogoutButton } from '../auth/LogoutButton';

// 관리자·내 계정·알림 설정(·로그아웃). 넓은 화면은 위 띠, 좁은 화면은 게임 메뉴의 `전체`나 메인 `메뉴` 패널 한 곳에만 그린다.
// 한 곳에만 그려 운영 입구 확인(AC-INT-20)을 두 번 만들지 않는다. CSS module의 클래스 값은 string | undefined다.
export function AccountLinks({ className, logout }: { className: string | undefined; logout: boolean }) {
  return (
    <>
      <AdminEntry className={className} />
      <Link to="/account" className={className}>
        내 계정
      </Link>
      <Link to="/settings/notifications" className={className}>
        알림 설정
      </Link>
      {logout ? <LogoutButton className={className} /> : null}
    </>
  );
}
