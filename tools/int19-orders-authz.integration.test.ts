import { defineInt19OrdersSuite } from './int19-orders.suite';

// AC-INT-19B: campaign.orders·campaign.order 권한 사례는 전역 대조를 실행하는 API 묶음에 남긴다.
defineInt19OrdersSuite('authz');
