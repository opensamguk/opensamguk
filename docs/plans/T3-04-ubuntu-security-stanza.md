# T3-04 CI 설치 경로 후속: Ubuntu 보안 저장소 직접 stanza

> 대기열: T3-04 후속 · AC: AC-M3-03 설치 경로 후속 (T2-15 / AC-M2-08의 필수 CI도 이 문제로 막힘) · 계획: Claude · 구현: Codex · 리뷰: Claude(구현하지 않은 세션)
> 기준: main `9ab06108`, 작업 트리·브랜치 `codex/t3-04-ubuntu-security-stanza` · 관련: [T3-04 CI 설치 경로 후속](./T3-04.md#ci-설치-경로-구현-기록-codex-2026-10-24), `tools/ci/ubuntu-archive-path.sh`, `.github/workflows/ci.yml`

## 계획 (Claude, 2026-11-03)

### 배경

PR #335의 job `125375369813`(실행기 이미지 `ubuntu24/20261018.96`)에서 `Use official Ubuntu archive path` 단계가 제품 시험 전에 실패했다. 첫 stanza는 검사를 통과했고 다음 stanza에서 `APT_PATH_STOP uris http://security.ubuntu.com/ubuntu`로 멈췄다. 지금 parser는 `ubuntu.sources`의 모든 stanza `URIs`가 `mirror+file:/etc/apt/apt-mirrors.txt`이기를 요구한다. 이 이미지는 보안 저장소를 미러 목록이 아닌 직접 주소로 둔 stanza를 함께 가진 것으로 읽힌다. 그 stanza의 Suites·Components·Signed-By 값은 지금 자료에 없으므로 관측했다고 쓰지 않는다.

`security.ubuntu.com`은 이미 미러 목록 검사에서 허용하는 Ubuntu 공식 호스트다. Ubuntu 공식 [noble-security InRelease](https://security.ubuntu.com/ubuntu/dists/noble-security/InRelease)는 Origin·Label `Ubuntu`, Suite `noble-security`, Codename `noble`, Version `24.04`인 PGP 서명 자료다. 이 사실은 허용 범위를 정한 근거일 뿐 실행기 구성의 관측이 아니다.

### 목표

`ubuntu.sources`에 `security.ubuntu.com` 직접 주소의 `noble-security` stanza가 있어도 검사가 통과하고 미러 목록에서 azure 한 줄만 빠지게 한다. 다른 모양은 지금처럼 쓰기 전에 멈춘다.

### 범위와 허용 조건

stanza 하나는 두 양식 중 하나여야 한다.

| 양식 | URIs | Suites |
| ---- | ---- | ------ |
| 미러 (기존) | 정확히 `mirror+file:/etc/apt/apt-mirrors.txt` | 기존 허용 집합 안 (`noble noble-updates noble-backports noble-security`) |
| 보안 직접 (새로) | 단일 값이 정규식 리터럴 `/^https?:\/\/security\.ubuntu\.com\/ubuntu\/?$/`에 맞음 | 정확히 `noble-security` 한 값 |

두 양식 모두 기존 검사를 그대로 받는다. 모르는 필드(`Trusted` 포함)와 중복 필드, 이어진 줄, `Enabled` 값 이상, `Signed-By`가 `/usr/share/keyrings/ubuntu-archive-keyring.gpg`와 정확히 같지 않음, Types·Components·Architectures 범위 밖은 멈춘다. 네 suite와 main·restricted·universe가 `deb` stanza 전체에 있어야 한다는 END 검사도 그대로다. 보안 직접 stanza는 `noble-security`만 낼 수 있으므로 `noble`·`noble-updates`·`noble-backports`는 미러 양식 stanza에서만 채워진다. 그래서 미러 stanza가 없으면 기존 `missing-suite`로 멈추고 별도 검사를 더하지 않는다.

`apt-config dump`의 검증 해제 값 검사, 미러 목록 검사(azure http 한 줄, 공식 호스트 한 줄 이상, priority 태그만), azure 한 줄 삭제와 diff 계수, `/etc/apt`·keyring 해시 보존은 바꾸지 않는다.

### 하지 않는 것

보안 직접 URI를 미러 목록 URI로 다시 쓰지 않는다. `ubuntu.sources`와 keyring, 다른 apt 파일은 읽기만 한다. 서명·TLS 검증을 끄거나 허용 호스트·suite를 이 표 밖으로 넓히지 않는다. `archive.ubuntu.com`·azure 등 다른 호스트의 직접 주소는 지금처럼 `uris`로 멈춘다. workflow 설정, APT `Retries`·`Timeout`, job timeout, 명령·순서, 캐시 단계, 게임 코드와 메일 정책은 손대지 않는다. AC-M3-03과 AC-M2-08의 상태, T3-04·T2-15 단계도 바꾸지 않는다.

### 수정 파일

| 파일 | 변경 |
| ---- | ---- |
| `tools/ci/ubuntu-archive-path.sh` | sources awk의 URIs 판정과 STANZA 출력, 68행 주석. 다른 줄은 그대로 |
| `docs/plans/T3-04-ubuntu-security-stanza.md` | 이 계획, 구현 기록, 리뷰 |
| `docs/index.md` | 이 문서 한 줄 등록 |

### 구현

101행 한 줄을 아래로 바꾼다. 보안 정규식은 azure 정규식과 같은 이유로 `awk -v`가 아닌 리터럴로 둔다.

```awk
    if (v["URIs"] == uri) form = "mirror"
    else if (v["URIs"] ~ /^https?:\/\/security\.ubuntu\.com\/ubuntu\/?$/) {
      if (v["Suites"] != "noble-security") fail("security-suites " v["Suites"])
      form = "security"
    } else fail("uris " v["URIs"])
```

`Signed-By` 이하 검사는 이 판정 뒤에 지금 순서대로 둔다. STANZA 줄 앞에 `Form=` form과 `URIs=` 값을 더해 CI 로그에서 어느 양식이 통과했는지 남긴다. 68행 주석은 두 양식과 Ubuntu keyring을 쓴다는 뜻으로 고친다.

### 회귀 시험

Codex가 올리기 전에 실제 Linux 파일 시스템의 임시 루트에서 bash로 실행한다. 기존 로컬 Linux 이미지나 WSL 중 bash가 있는 환경을 쓰고 새 이미지를 받아야 하면 먼저 알린다. 실행 환경의 이미지 digest와 bash·awk·grep·diff 버전을 기록한다. 대역 `FIXTURE_APT_CONFIG`와 시험 자료는 이전 후속과 같은 방식이다. 시험 자료의 sources 모양은 가정이며 실행기 구성으로 세지 않는다. driver, 자료, 로그는 저장소 밖(`E:/codex-artifacts/opensamguk/t3-04-ubuntu-security-stanza/`)에 두고 커밋하지 않는다.

driver는 매 사례 전후로 시험 루트 아래 모든 파일의 sha256과 미러 목록의 소유자·권한을 잰다. 멈춤 사례는 종료 코드 1, 기대한 `APT_PATH_STOP` 이유, 모든 파일 해시 불변(쓰기 0)을 확인한다. 통과 사례는 `APT_PATH_OK`, 미러 목록에서 azure 한 줄만 빠지고 나머지 줄·순서·태그·소유자·권한이 같음, 그 밖의 모든 파일 해시 불변을 확인한다.

| 사례 | 기대 |
| ---- | ---- |
| 기존 23개 사례 (미러 양식만) | 이전 결과와 같음 |
| 미러 stanza(`noble noble-updates noble-backports`) + 보안 직접 stanza, URI `http://security.ubuntu.com/ubuntu`, `http://…/ubuntu/`, `https://…/ubuntu`, `https://…/ubuntu/` 네 가지 | 각각 통과, STANZA에 `Form=security` |
| 미러 stanza 하나에 네 suite + 보안 직접 stanza | 통과 |
| 보안 직접 stanza가 `Types: deb deb-src`, 또는 deb·deb-src 두 stanza | 통과 |
| 위장 host: `security.ubuntu.com.evil.example`, `securityXubuntu.com`, `evil.example/security.ubuntu.com`, `user@security.ubuntu.com`, `:80` 포트, `/ubuntu/extra`, `/ubuntu//`, `ftp://`, 대문자 scheme, 두 URI를 한 필드에 | `uris`로 멈춤, 쓰기 0 |
| 다른 공식·비공식 호스트 직접 주소(`archive.ubuntu.com`, `azure.archive.ubuntu.com`) | `uris`로 멈춤, 쓰기 0 |
| 보안 직접 stanza의 Suites가 `noble`, `noble-updates`, `noble-security noble-updates`, `noble-proposed`, `jammy-security` | `security-suites`로 멈춤, 쓰기 0 |
| 보안 직접 stanza의 `Signed-By` 다른 경로, 빈 값, 인라인 키 | `signed-by`나 `continuation-line`으로 멈춤, 쓰기 0 |
| 보안 직접 stanza에 `Trusted: yes` | `field Trusted`로 멈춤, 쓰기 0 |
| 보안 직접 stanza의 Types·Components·Architectures 범위 밖, `Enabled: no` | 해당 이유로 멈춤, 쓰기 0 |
| 보안 직접 stanza만 있고 미러 stanza 없음 | `missing-suite`로 멈춤(남는 suite 이름은 awk 순회 순서에 따름), 쓰기 0 |
| 미러 stanza에 `noble-security`가 없고 보안 직접 stanza도 없음 | `missing-suite noble-security`로 멈춤, 쓰기 0 |
| 보안 직접 구성 + dump에 `Verify-Peer "false"`, `AllowInsecureRepositories "true"`, `AllowUnauthenticated "1"`, `Trusted "true"` | 각각 `insecure-apt-config`로 멈춤, 쓰기 0 |
| 보안 직접 구성 + 미러 목록 azure 0줄·2줄, 다른 호스트 | `apt-mirrors.txt`로 멈춤, 쓰기 0 |

사례 수와 통과 수를 원문 그대로 기록한다. 실패한 실행도 덮어쓰지 않는다.

### 정적 검사

`bash -n tools/ci/ubuntu-archive-path.sh`, `pnpm check`, `pnpm lint:text --strict docs/plans/T3-04-ubuntu-security-stanza.md`, `git diff --check`를 최종 내용으로 실행하고 종료 코드를 기록한다. `main` 대비 diff가 위 세 파일뿐인지 확인한다.

### 리뷰와 병합

구현하지 않은 새 Claude 세션이 diff, 이 계획과의 대조, 회귀 시험 원문, 정적 검사 기록을 읽고 판정을 이 문서에 적는다. 허용 정규식이 넓어지지 않았는지, 쓰기 전 멈춤이 유지되는지, 다른 파일을 쓰는 코드가 없는지를 본다.

리뷰가 통과하면 Codex가 작업 ID·AC ID로 시작하는 commit 하나를 push하고 PR을 연다. 그 head SHA의 필수 CI와 merge queue가 통과하고 충돌이 없으면 보호 규칙을 지켜 즉시 병합한다. 병합 뒤 PR 번호, 병합 SHA, CI 실행 번호를 Claude 채팅과 Codex 채팅 양쪽에 전달한다. CI가 다른 `APT_PATH_STOP`이나 설치 실패로 멈추면 rerun, 허용 범위 확대, timeout 변경 없이 원문을 저장소 밖에 보존하고 계획 담당에게 돌린다.

### 완료 증거 (아직 없음)

PR CI의 원본 로그에서 `APT_PATH_STANZA` 줄(Form·URIs·Suites)과 `APT_PATH_OK`, 같은 job 설치 성공, 서명·해시 경고 0을 확인해 구현 기록에 적는다. 그때 처음으로 실행기의 보안 stanza 값을 관측 사실로 쓴다. 지금은 실제 CI·APT 성공을 주장하지 않는다. AC-M3-03과 AC-M2-08의 전체 상태는 이 후속으로 바꾸지 않으며 T2-15의 필수 CI 재확인은 T2-15 쪽 기록에 남긴다.

### 한계

보안 직접 stanza는 azure 줄 삭제와 관계없이 원래부터 `security.ubuntu.com`으로 간다. http 주소면 보호는 지금과 같이 `Signed-By` keyring의 서명·해시 검증뿐이다. 실행기 이미지가 또 바뀌면 다른 이유로 멈출 수 있고 그 실행은 실패로 남긴다. 시험 자료 결과는 실행기 bash·awk·APT 동작을 증명하지 않는다.

## 구현·검증 (Codex, 2026-11-03)

구현은 허용한 보안 URI·정확한 suite 검사, 양식·URI 진단과 주석에 한정했다. 기본 URI와 모든 기존 검증·쓰기 순서·workflow·Retries·Timeout은 보존했다. 변경은 이 문서와 지도, 검사 스크립트 세 파일이다.

| 검사 | 실제 결과 |
| --- | --- |
| Linux 비root 회귀 | 기존23·신규40, 총63실행·63통과·실패0·미실행0, UID10001 |
| 파일 보존 | 실패 시 전체 파일 SHA·UID·GID·mode·종류 동일. 성공 시 미러 목록 azure 한 줄 삭제 외 동일, 목록 소유자·권한 보존 |
| Linux 환경 | 기존 로컬 image ID `sha256:bdc30e2881dd9911f5c777b47c1f1e9c0460dee7cbaee965fb15b1df43ae8fbb`, bash5.2.15·mawk1.3.4·GNU grep3.8·diffutils3.8 |
| shell 문법 | 위 Linux에서 `bash -n` exit0 |
| `pnpm check` | Windows 388파일·6490시험 통과, exit0 |
| 문구·diff | 두 문서 strict 검사·`git diff --check` 통과 |
| 실제 hosted CI·APT | PR head와 merge queue에서 확인할 필수 gate, 아직 성공으로 세지 않음 |

검사 소스 SHA-256은 `d89a98c185935dc2e206f82491174b646aae5f663c47bbf81e78d157f2ae2772`로 시험 자료 결과와 Windows·Linux 계산이 모두 같았다. `validation.json`에 실제 종료 코드를 남겼으며 문구 검사와 diff 검사도 exit0이다.

driver·원문·개별 파일의 전후 해시는 위 외부 경로의 `fixtures.mjs`·`fixture-run2.json`·`fixture-summary.json`·`linux-environment.json`·`pnpm-check.log`에 보존했다. 첫 fixture 실행은 시험용 `/tmp`의 noexec 때문에 대역 실행 파일을 열 수 없어20사례가 실패했다. 원문 `fixture-run1.json`을 유지하고 시험용 tmpfs만 exec로 바꿔63사례를 실행했다. 제품의 read_only·noexec와 검사 소스는 이 재실행에서 바꾸지 않았다. 이 자료는 실제 Ubuntu CI 설치 성공을 대신하지 않는다.

## 독립 리뷰 (구현하지 않은 Claude, 2026-11-03)

별도 읽기 전용 세션이 구현·기존 기준·63사례 driver와 결과를 대조해 승인했다. P0·P1은0건이며 문서에 구현·실행 결과를 남기라는 P2 한 건을 위 표로 보완했다. 서명·TLS·허용 suite·쓰기 전 거부와 보존 경계를 확인했다. 실제 실행기의 보안 stanza와 같은 job의 APT 설치·서명/해시 경고0은 PR CI에서 확인한 뒤에만 관측 사실로 기록한다. 리뷰 원문은 외부 `claude-review.log`다.
