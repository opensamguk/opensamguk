# T3-04 AC-M3-03 guard 보완 계획 (PR344 후속)

## 목표

- 보호 CI 41625375262의 E2E1 job 125881261307은 앱 시험 전에 `APT_PATH_STOP apt-mirrors.txt STOP azure-lines 0`으로 멈췄다. 기존 guard `ubuntu-archive-path.sh`가 다음 두 입력도 정상 처리하도록 고친다.
  - Azure 미러가 이미 없는 러너 입력
  - 이미 정규화된 입력에 대한 재실행(idempotent)
- 나머지 안전 정책은 그대로 둔다.
- 0 Azure 입력에 공식 미러가 몇 개 있었는지는 아직 단정하지 않는다. 새 head 로그로 확인한다.
- cache는 deb 다운로드만 저장한다. 따라서 cache를 미러 줄 제거의 원인으로 보지 않는다.
- 범위: branch `codex/t2-15-migrate-optional-peer`, base 8bc, HEAD 23c1dc54. PG repo 중심이고 Workers 포트는 제외한다. Tunnel 공개 증거 승인은 대기 상태 그대로 미완료로 둔다.

## 구체 수정 방법 (guard 한 파일)

1. **미러 awk END 순서 변경**
   - 줄마다 하는 검사는 그대로 둔다: tag는 `priority:N`만 허용, 호스트 allowlist는 archive/security/us-east-2.ec2.archive만 허용, unknown host는 STOP.
   - END 검사 순서를 바꾼다.
     - `found > 1` → `STOP azure-lines N`
     - `official < 1` → `STOP no-official-mirror`. empty나 comments-only 입력도 여기서 거부된다.
     - 그 외 → `OK azure=0` 또는 `OK azure=1`
   - 셸에서는 `case "$mirrors"`로 이 두 값만 받는다. 나머지 출력은 `stop "apt-mirrors.txt $mirrors"`로 끝낸다.
   - `azure=` 값은 변수에 보관하고 `APT_PATH_AZURE_LINES N` 한 줄로 기록한다.
2. **그대로 두는 검사**: OS/arch, deb822(Signed-By, keyring, 필드, suites, components), apt-config 전체 dump와 서명·TLS flag 검사, Retries/Timeout 기록. 정규식 리터럴과 상태 3분기 관례도 유지한다.
3. **쓰기 단계 분기**. `before`/`after` 생성과 `diff -U 0` 실행은 공통이고 diff 상태가 2 이상이면 어느 경로든 쓰기 없이 STOP한다.
   - **azure=1**: 기존과 동일하다. diff 상태 1, removed=1, added=0을 확인한 뒤 snapshot, `tee`, `cmp`, snapshot 비교 순으로 진행한다.
   - **azure=0**: 다음 조건을 모두 확인한다.
     - diff 상태 0, removed=0, added=0
     - `cmp -s "$work/before" "$work/after"`
     - `tee`는 실행하지 않는다.
     - `$list`의 내용은 `cmp`로 확인하고 `stat -c '%u %g %a %i %Y'` 값도 앞뒤로 기록해 비교한다. SHA와 더 정밀한 mtime·inode는 Linux fixture에 남긴다.
     - snapshot을 앞뒤로 떠서 비교한다.
4. 마지막 출력 `APT_PATH_SNAPSHOT`/`MIRRORS_BEFORE`/`MIRRORS_AFTER`/`APT_PATH_OK`는 두 경로 모두 그대로 출력한다. 이렇게 하면 실제 러너의 0 Azure 입력 전체 내용이 로그에 남는다.
5. 헤더 주석에서 "azure 한 줄만 뺀다"를 "0줄이면 쓰지 않고 1줄이면 그 줄만 뺀다"로 고친다.
6. 문서
   - `docs/plans/T3-04-ubuntu-no-azure.md`: 바뀐 정책, CI 실패 근거, 미확정 사항을 추가한다.
   - `docs/index.md`: 링크 한 줄을 추가한다.
   - 이 세 파일 외의 source는 변경하지 않는다. 기존 PR의 migrate 3 files는 유지한다.

**변경 금지**: 범용 harness, workflow, timeout, cache 옵션, 서명키, 허용 호스트 범위, Dockerfile, 사용자가 바꿀 수 없는 원본 fixture와 artifact.

## 검증

1. **로컬 정적 검사**: changed bash에 `bash -n`, LF와 strict text 검사, format, `git diff --check`를 돌리고 변경 파일 목록이 의도한 대로인지 확인한다.
2. **fixture 준비**: Git 밖에 있는 기존 98개 Linux UID 10001 bash fixture를 재사용한다. 원본은 두고 사본에 case를 추가한다.
   - **양성으로 추가**: zero-Azure 승인 URL 여러 개, http와 https, trailing slash 유무, priority tag, security 직접 사용, 이미 정규화된 입력 2회 실행.
   - **거부로 추가**: empty, comments-only, double Azure, unknown host, unsafe APT flag, unauthenticated, PATH shim으로 diff 상태 2를 내는 경우.
   - **기존 case 변경**: `security-no-azure`와 `ec2-no-azure` 두 건을 negative에서 positive로 바꾼다.
3. **baseline-before (23c1dc54 guard)**
   - 기존 98개가 기존 기대값과 같아야 한다. 두 no-Azure case는 기존 거부 기대값을 쓴다.
   - 새 valid zero-Azure case들은 `azure-lines 0`으로 실패해야 한다. 이것이 CI 실패 현상의 재현이다.
4. **after (새 guard)**
   - 기존 98개 대비 정책 차이는 두 no-Azure case뿐이어야 한다.
   - 추가 case는 모두 기대값과 맞아야 한다.
   - 거부 case와 zero 경로에서는 대상 파일의 sha, uid, gid, mode, inode, mtime이 불변이어야 한다(쓰기 0).
   - azure=1 경로의 출력과 쓰기는 기존과 동일해야 한다.
5. **추가하지 않는 것**: 제품 단위 test나 mirrored code는 추가하지 않는다. 의미 있는 검증은 실제 Linux fixture와 새 head 보호 CI가 맡는다.
6. **새 head 보호 CI**
   - E2E 로그에서 Azure 줄 수와 허용 미러 목록을 기록한다. 0 Azure 입력이 관측되면 그 목록을 확인한다. 다른 경로만 관측되면 0줄 분기의 Linux fixture 증거와 구분한다.
   - 이어서 실제 `apt update`/install과 browser 단계가 통과했는지 확인한다.
   - pnpm check(기존 6687), 실제 DB, e2e가 모두 green이어야 한다.
7. **독립 review**: 별도 Claude 세션이 독립 review를 하고 OKAY를 받아야 한다.

## 완료 범위

- PR344 title과 body를 최종 scope로 갱신한다.
  - 내용: migrate optional compiler 제거와 T3-04 guard의 zero-Azure 허용.
  - 이번 CI 후속에서는 Dockerfile을 바꾸지 않는다. 이미지 실측(f404 source)은 그대로 보존된다.
  - 추가 diff는 CI와 문서뿐이라 runtime bytes가 같다. 따라서 기존 proof가 유효하며 새 head로 라벨을 갈아 끼우지 않는다는 점을 적는다.
- normal autoMerge는 유지한다. 새 head에서 exact-SHA CI가 green이고 독립 review가 OKAY일 때만 완료로 본다.
- 결과와 session log는 이 계획 단계에서 쓰지 않는다.
