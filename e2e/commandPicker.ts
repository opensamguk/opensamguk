import { expect, type Locator, type Page } from '@playwright/test';

// INT-29 명령 고르기(직위별 명령 띠) e2e 도우미.
// - 띠: 직위마다 묶음 패(분류)가 있고, 패를 누르면 그 묶음의 세부 명령 단추가 펼쳐진다. 인자 없는 명령은 누르면 바로 들어가고,
//   인자가 있으면 인자 화면(command-args-screen)이 열린다.
// - 명령 찾기: 이름으로 걸러 '찾은 명령' 라디오로 고른다. 받은 명령 전체에서 찾으므로 띠가 감춘 명령(직위 밖의 지금 쓸 수 없는
//   명령)도 찾는다. 고르기만 해서는 넣지 않고, 인자 없는 명령은 'N번 칸에 넣기'로 넣는다.
// 단위 시험 apps/web/src/turns/CommandPicker.test.tsx의 commandButton과 같은 방식이다.

// 명령 고르기 영역. 성 화면에서는 예턴 편집기 밖의 명령 띠 자리에 그려지므로 페이지에서 찾는다.
export const pickerRegion = (scope: Locator) => scope.getByRole('region', { name: '명령 고르기' });

// 그 명령이 든 묶음 패를 차례로 눌러 세부 명령 단추를 돌려준다. 띠에 없으면 null이다.
export async function bandCommand(picker: Locator, name: string): Promise<Locator | null> {
  const find = () => picker.getByRole('group', { name: /세부 명령$/ }).getByRole('button', { name, exact: true });
  if ((await find().count()) > 0) return find().first();
  const plaques = picker.getByRole('group', { name: '명령 분류' }).first().getByRole('button');
  const count = await plaques.count();
  for (let i = 0; i < count; i++) {
    const plaque = plaques.nth(i);
    if ((await plaque.getAttribute('aria-expanded')) !== 'true') await plaque.click();
    if ((await find().count()) > 0) return find().first();
  }
  return null;
}

// 명령 찾기로 이름을 넣고 찾은 명령 라디오를 고른다. 고른 라디오를 돌려준다.
export async function findCommand(picker: Locator, name: string): Promise<Locator> {
  await picker.getByLabel('명령 찾기').fill(name);
  const radio = picker.getByRole('radiogroup', { name: '찾은 명령' }).getByRole('radio', { name, exact: true });
  await radio.check();
  await expect(radio).toBeChecked();
  return radio;
}

// 인자 화면에서 넣는다. 단계가 여럿인 인자 화면은 마지막 단계에서만 넣기 단추를 보이므로(CommandArgsScreen의 data-final)
// '다음:' 단추로 끝 단계까지 간 뒤 누른다. 인자 화면은 dialog라 페이지에서 찾는다.
export async function putFromArgsScreen(page: Page, label: string) {
  await toLastStep(page);
  await argsScreen(page).getByRole('button', { name: label, exact: true }).click();
}

// 단계가 여럿인 인자 화면(dialog)의 맨 끝, 맨 앞, 또는 그 칸이 보이는 단계로 간다. 넣기 단추는 마지막 단계에만 보인다.
export const argsScreen = (page: Page) => page.getByTestId('command-args-screen');
export async function toLastStep(page: Page) {
  for (let guard = 0; guard < 5; guard++) {
    const next = argsScreen(page).getByRole('button', { name: /^다음: / });
    if ((await next.count()) === 0) return;
    await next.click();
  }
}
export async function toStepWith(page: Page, target: Locator) {
  for (let guard = 0; guard < 5 && !(await target.isVisible()); guard++)
    await argsScreen(page)
      .getByRole('button', { name: /^다음: / })
      .click();
}
export async function toFirstStep(page: Page) {
  for (let guard = 0; guard < 5; guard++) {
    const back = argsScreen(page).getByRole('button', { name: '이전', exact: true });
    if ((await back.count()) === 0 || !(await back.isEnabled())) return;
    await back.click();
  }
}

// 고른 명령을 칸에 넣는다. 인자가 있어 인자 화면이 열렸으면 그 끝 단계의 넣기 단추를, 아니면 편집기의 넣기 단추를 누른다.
export async function putPicked(page: Page, scope: Locator, label: string) {
  if (await argsScreen(page).isVisible()) await putFromArgsScreen(page, label);
  else await scope.getByRole('button', { name: label, exact: true }).click();
}
