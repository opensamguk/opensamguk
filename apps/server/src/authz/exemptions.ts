import type { AuthzExemption } from './coverage';

// 타인 ID를 받지 않는 절차는 타인 소유 자원 거부를 정의하지 않는다.
// 별도 실제 HTTP 시험은 각 절차의 actor ID 주입 거부와 DB 불변을 확인한다.
export const exemptions: AuthzExemption[] = [
  {
    path: 'lobby.notices',
    category: 'otherUser',
    reason: '무인증 공통 로비 공지이며 계정이나 타인 소유 자원을 지정하지 않는다. ID 주입은 거부한다.',
  },
  {
    path: 'world.publicMaps',
    category: 'otherUser',
    reason: '무인증 공통 지연 지도이며 타인 소유 자원을 지정하지 않는다. ID 주입은 거부한다.',
  },
  { path: 'health', category: 'otherUser', reason: '공개 상태 확인이며 계정·장수 대상이 없다.' },
  {
    path: 'health',
    category: 'invalidInput',
    reason: '입력 파서가 없는 공개 상태 확인이다. 임의 입력은 상태 응답에 영향을 주지 않는지 따로 확인한다.',
  },
  {
    path: 'auth.signup',
    category: 'otherUser',
    reason: '공개 신규 계정 생성이며 타인 ID를 받지 않는다. ID 주입은 BAD_REQUEST로 거부한다.',
  },
  {
    path: 'auth.signup',
    category: 'sanctioned',
    reason:
      '무인증 가입은 기존 계정의 제재 신원을 판정하지 않는다. 기존 이메일 재가입과 제재 세션 승격은 허용하지 않는다.',
  },
  {
    path: 'auth.login',
    category: 'otherUser',
    reason: '공개 자격 증명 교환이다. 다른 계정 ID 지정은 입력 계약에 없고 BAD_REQUEST로 거부한다.',
  },
  {
    path: 'auth.logout',
    category: 'otherUser',
    reason: '세션 자신만 지우는 무입력 절차다. 타인 세션 불변을 별도 실제 시험으로 확인한다.',
  },
  {
    path: 'auth.me',
    category: 'otherUser',
    reason: '세션 자신만 조회하는 무입력 절차다. 두 세션의 결과 분리를 별도로 확인한다.',
  },
  { path: 'world.list', category: 'otherUser', reason: '인증 사용자 공통 월드 목록이며 타인 소유 자원이 없다.' },
  { path: 'world.summary', category: 'otherUser', reason: '인증 사용자 공통 월드 시계이며 타인 소유 자원이 없다.' },
  {
    path: 'world.map',
    category: 'otherUser',
    reason: '인증 사용자 공통 공개 지도다. 비공개 장수 자원은 반환하지 않는다.',
  },
  {
    path: 'general.create',
    category: 'otherUser',
    reason: '서버 세션의 장수만 생성한다. 입력에 타인 userId·generalId를 더하면 BAD_REQUEST로 거부한다.',
  },
  {
    path: 'general.mine',
    category: 'otherUser',
    reason: '서버 세션의 장수만 조회한다. 타인 generalId 지정은 입력 계약에 없다.',
  },

  { path: 'commands.list', category: 'otherUser', reason: '인증 사용자 공통 명령 정의이며 타인 소유 자원이 없다.' },

  {
    path: 'city.get',
    category: 'otherUser',
    reason: '타인 도시 조회 자체는 허용한다. 실제 조회 시험이 적국·동국별 비공개 필드 제거를 검증한다.',
  },
  {
    path: 'nation.get',
    category: 'otherUser',
    reason: '타국 조회 자체는 허용한다. 실제 조회 시험이 국가별 비공개 필드 제거를 검증한다.',
  },

  { path: 'records.world', category: 'otherUser', reason: '공통 공개 연감이며 타인 소유 자원이 없다.' },
  {
    path: 'timelapse.frames',
    category: 'otherUser',
    reason:
      '공통 공개 영토 기록이며 타인 소유 자원이 없다. 다른 계정의 같은 응답은 timelapse 실제 HTTP 시험이 확인한다.',
  },
  {
    path: 'ranking.generals',
    category: 'otherUser',
    reason: '순위는 공통 공개 정보이고 me만 세션 장수로 정한다. 임의 generalId 지정은 BAD_REQUEST다.',
  },
  { path: 'ranking.nations', category: 'otherUser', reason: '공통 공개 국가 순위이며 타인 소유 자원이 없다.' },
];
