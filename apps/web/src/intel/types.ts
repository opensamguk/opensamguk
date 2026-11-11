import type { AppRouter } from '@opensamguk/server/router';
import type { inferRouterOutputs } from '@trpc/server';

// 첩보 화면이 쓰는 응답 모양. AppRouter 타입에서만 꺼낸다(패키지 경계, T4-12 §2.2, T4-38 §3.3).
// 서버가 이미 공개 정책으로 투영한 값이다. 병력은 구간뿐이고 정확한 값은 응답에 없다(IC-7).
type Outputs = inferRouterOutputs<AppRouter>;

export type IntelRecordsResponse = Outputs['intel']['records'];
export type IntelRecordView = IntelRecordsResponse['items'][number];
export type IntelLevel = IntelRecordView['level'];
export type IntelTech = NonNullable<IntelRecordView['tech']>;
export type IntelCrewBand = IntelRecordView['crew'];
export type IntelCrewTypes = NonNullable<IntelRecordView['crewTypes']>;
