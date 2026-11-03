# T3-04 AC-M3-03 CI 설치 경로 후속: Ubuntu EC2 미러 호스트 허용

> 계획: Claude · 구현: Codex · 리뷰: 구현에 참여하지 않은 새 Claude 세션

## 목표
- PR342 head `aac76975`의 GitHub job `125796588010`(run `41600112261`, ubuntu-24.04 이미지 `20261018.96.1`)이 `APT_PATH_STOP apt-mirrors.txt STOP host http://us-east-2.ec2.archive.ubuntu.com/ubuntu/`에서 멈춘 문제를 가장 작은 범위로 고친다.
- 같은 job에서 미러 목록 stanza와 `noble-security` 직접 stanza는 Ubuntu keyring `Signed-By` 검사를 통과했다. 따라서 바꿀 곳은 `apt-mirrors.txt` 호스트 허용 목록 하나다.
- 관련 항목은 T2-15/AC-M2-08과 막힌 lineage PR342다. 이 작업은 AC 상태를 바꾸지 않는다.

## 근거
- 실제 hosted 로그: 위 job/run의 STOP 줄. 관찰한 호스트는 정확히 `us-east-2.ec2.archive.ubuntu.com`이다.
- [Canonical cloud-init 문서](https://github.com/canonical/cloud-init/blob/main/doc/examples/cloud-config-apt.txt) 58-61행은 `<region>.ec2.archive.ubuntu.com`을 EC2 미러로 설명한다.
- 문서는 지역 일반형을 설명한다. 허용은 관찰한 한 지역만 한다. 다른 지역이 나타나면 그 실행기 증거를 확보한 뒤 다시 판단한다.

## 기준
- 브랜치: `codex/t2-15-ci-ec2-mirror`. 보호된 `main` `7ff13b7f`에서 새로 분리했고 다른 작업과 격리되어 있다.
- 원래 PR342 브랜치와 worktree는 읽지도 쓰지도 않는다.

## 변경 파일 (세 개만)
1. `tools/ci/ubuntu-archive-path.sh`
2. `docs/plans/T3-04-ubuntu-ec2-mirror.md` (이 계획과 실제 결과)
3. `docs/index.md` (위 계획 문서 한 줄 등록)

## 스크립트 변경
- 미러 목록 awk의 공식 호스트 정규식 리터럴 하나만 바꾼다.
  - 전: `/^https?:\/\/(archive|security)\.ubuntu\.com\/ubuntu\/?$/`
  - 후: `/^https?:\/\/(archive|security|us-east-2\.ec2\.archive)\.ubuntu\.com\/ubuntu\/?$/`
- 기존 형태는 그대로 받는다. scheme은 http와 https, 경로는 `/ubuntu`에 끝 슬래시 0개 또는 1개다.
- EC2 줄도 `official` 개수에 들어간다.
  - 이유 1: Canonical이 문서화한 미러다.
  - 이유 2: 목록이 azure와 EC2 두 줄뿐이어도 azure 한 줄을 뺀 뒤 EC2 미러가 남아야 한다.
  - 실제 목록의 구성은 hosted 로그의 `APT_PATH_MIRRORS_BEFORE`에서 확인한다.
- 바로 위 주석 `azure http 한 줄과 Ubuntu 공식 호스트 한 줄 이상`에 EC2 us-east-2 호스트를 짧게 덧붙인다. 주석 밀도는 주변 코드와 맞춘다.
- 다음 항목은 바꾸지 않는다.
  - sources deb822 parser. EC2 URI가 sources에 직접 나오면 계속 `uris`로 실패해야 한다.
  - `Signed-By` 검사
  - insecure APT 설정 거부
  - azure 줄을 정확히 하나만 빼는 규칙
  - `priority:` 태그 규칙
  - 쓰기 전 검증 순서
  - snapshot/hash, 소유자, 권한 유지
- 다음은 변경 범위 밖이다: 임의 서브도메인, 다른 지역, 자격 증명, 포트, query, fragment, 추가 경로, workflow, cache, retry, timeout, 의존성, 게임, Docker, migration, 원격 Tunnel/DNS 작업.

## 로컬 검증 (실제 Linux bash/awk, 저장소 밖 fixture)
1. 기존 63개 수동 fixture 검사를 그대로 다시 돌린다. 63개 모두 변경 전과 같은 결과가 나와야 한다.
2. 양성 8개를 추가한다.
   - 기존 sources 두 형태(미러 stanza만, 미러와 security 직접 stanza)마다 EC2 줄 네 형태를 하나씩 넣는다.
   - 네 형태: `http://…/ubuntu`, `http://…/ubuntu/`, `https://…/ubuntu`, `https://…/ubuntu/`
   - 각 경우 확인 항목:
     - 종료 코드 0과 `APT_PATH_OK`
     - azure 한 줄만 빠짐
     - EC2 줄은 남음
     - snapshot이 같음
     - 소유자와 권한이 같음
3. 음성 사례를 추가한다. 각 사례는 종료 코드 1, 기대한 `APT_PATH_STOP` 이유, `apt-mirrors.txt`의 hash와 내용 불변, snapshot 불변(쓰기 0회)을 모두 확인한다.
   - 다른 지역: `us-east-1.ec2.archive.ubuntu.com`, `us-west-2.ec2.archive.ubuntu.com`, `eu-west-1.ec2.archive.ubuntu.com`
   - 지역 없음: `ec2.archive.ubuntu.com`
   - 앞에 덧붙인 호스트: `x.us-east-2.ec2.archive.ubuntu.com`
   - 뒤에 덧붙인 호스트: `us-east-2.ec2.archive.ubuntu.com.evil.test`
   - 점 대신 다른 문자: `us-east-2Xec2.archive.ubuntu.com`, `us-east-2.ec2Xarchive.ubuntu.com`, `us-east-2.ec2.archiveXubuntu.com`
   - 자격 증명 `user@`, 포트 `:80`, query `?x`, fragment `#x`
   - 추가 경로 `/ubuntu/x`, 슬래시 둘 `/ubuntu//`·`//ubuntu/`, 다른 경로 `/ubuntu-ports/`
   - 다른 scheme: `ftp://`, `mirror+file:`
   - 대문자 호스트
   - sources stanza의 `URIs`에 EC2 URI를 직접 쓴 경우: `uris`로 실패해야 한다
   - EC2 줄에 `priority:` 외의 태그를 붙인 경우: `tag`로 실패해야 한다
4. POSIX 실행: fixture 트리를 uid 10001이 소유하게 하고 uid 10001로 실제 실행한다. 양성 사례에서 쓰기 뒤 UID와 mode가 유지되는지 확인한다.
5. `bash -n tools/ci/ubuntu-archive-path.sh`
6. `pnpm check`
7. 텍스트 엄격 검사:
   - 세 파일 모두 LF이고 끝 개행이 있다.
   - `git diff --check`를 통과한다.
   - 커밋 전 `git diff --stat`과 새 계획 문서, 커밋 뒤 `git diff --stat origin/main...HEAD`에 위 세 파일만 나온다.
   - 스크립트 diff는 정규식 한 줄과 주석뿐이다.
8. fixture 결과는 로컬 증거로만 기록한다. hosted 증명으로 쓰지 않는다.

## 리뷰
- 커밋 전에 구현에 참여하지 않은 새 Claude 세션이 독립 리뷰를 한다. 대상은 diff, fixture 목록, 실제 출력이다.
- 지적 사항은 고친 뒤 해당 검증을 다시 돌린다. 리뷰 결과는 계획 문서에 사실대로 짧게 적는다.

## 커밋과 PR
- 커밋 메시지는 `T3-04 AC-M3-03`으로 시작한다. 예: `T3-04 AC-M3-03 allow observed us-east-2 EC2 Ubuntu mirror`
- PR을 만들고 바로 일반 auto-merge를 켠다.
  - source CI와 merge queue를 통과해야 한다.
  - admin bypass와 강제 병합은 쓰지 않는다.
- hosted 확인 항목:
  - 실제 job 로그의 APT 단계(`APT_PATH_MIRRORS_BEFORE`/`AFTER`, `APT_PATH_OK`)
  - 이어지는 설치 단계
  - e2e 결과
- 결과는 실패를 포함해 그대로 기록한다.
- 결과 SHA와 PR 번호를 원래 대화에 전달해 PR342 lineage base를 갱신하게 한다. 원래 브랜치와 worktree는 수정하지 않는다.

## 멈춤 조건
- hosted 실행기에서 다른 지역, 다른 호스트, 다른 형태가 나오면 허용 목록을 넓히지 않고 실패를 유지한다. 로그 증거를 붙여 다시 판단한다.
- 실행기의 azure 줄 개수가 1이 아니면 실패를 기록하고 기존 규칙을 유지한다.
- 63개 기존 사례 중 하나라도 결과가 바뀌면 멈춘다.
- 음성 사례 중 하나라도 쓰기가 일어나면 멈춘다.
- 네 번째 파일에 변경이 생기면 멈춘다.

## 구현·검증 (Codex, 2026-11-03)

스크립트 변경은 정규식 한 줄과 주석 한 줄이다. 기존 63개 사례에 EC2 양성 8개, 음성·검증 보존 27개를 더했다. 새 사례의 성공 기대값은 각 실행 직전 목록에서 azure 한 줄을 뺀 실제 바이트다.

| 검사 | 실제 결과 |
| --- | --- |
| 변경 전 Linux | 기존 63개 통과. 새 EC2 양성 8개는 호스트 거부를 재현했고 뒤쪽 검사 4개도 호스트 거부에서 먼저 멈춤 |
| 변경 뒤 Linux | UID10001, 98개 실행·98개 통과·실패0·미실행0 |
| 파일 보존 | 실패 시 전체 파일 SHA·UID·GID·mode·종류 동일. 성공 시 azure 한 줄 외 바이트와 다른 파일, 소유자·권한 보존 |
| 검증 이미지 | 기존 로컬 Linux 이미지 `sha256:bdc30e2881dd9911f5c777b47c1f1e9c0460dee7cbaee965fb15b1df43ae8fbb` |
| 스크립트 SHA-256 | `f9ba20cb8e0f37b3034deded4dc782c39c6f59fba24491862292d046555c4eeb` |
| 셸 문법 | 같은 Linux 이미지에서 `bash -n` exit0 |
| `pnpm check` | 411파일·6687시험 통과, exit0. generate·lint·문구·format·typecheck·next 포함 |

시험 공간은 fixture apt-config를 실행하는 Linux tmpfs다. 운영 tmpfs 설정은 바꾸지 않았다.

독립 Claude 리뷰는 스크립트·fixture를 통과로 판단했다. 문서 상태와 음성 사례 목록을 고친 뒤 후속 검토에서 찾은 점 치환 사례 누락 한 건도 보완했다. 리뷰어는 이 한 줄을 추가하면 재리뷰 없이 OKAY로 판단한다고 명시했다. 해당 줄을 추가했으며 최종 문구·format 검사를 커밋 전에 다시 실행한다.

실제 hosted APT·설치·E2E는 PR에서 확인할 단계다. 로컬 fixture를 hosted 성공으로 세지 않으며 AC 전체 상태는 바꾸지 않는다.
