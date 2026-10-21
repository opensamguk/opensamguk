// CI에서 forbidOnly가 막는지 확인하려고 일부러 test.only를 둔 격리 시험이다. e2e/에는 test.only를 두지 않는다.
import { test } from '@playwright/test';

test.only('집중 실행한 시험', () => {});

test('집중 실행에서 빠지는 시험', () => {});
