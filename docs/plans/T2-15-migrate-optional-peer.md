# T2-15 migrate 이미지의 선택 peer TypeScript 제거 계획

- 작업: T2-15
- AC: AC-M2-08 운영 Docker 이미지 경량화
- 기준: `origin/main` `8bc847e3`, 브랜치 `codex/t2-15-migrate-optional-peer`
- 담당: 계획 Claude, 구현 Codex, 리뷰는 구현하지 않은 별도 Claude 세션

## 배경

`7ff13b7f` migrate 이미지의 전체 tar 파일 목록에서 `/app/migrate/node_modules/.pnpm/typescript@6.0.3` 트리가 나왔다. compiler 실행 파일 `bin/tsc`, `bin/tsserver`와 `lib` 파일이 이 트리 안에 남았다. `.pnpm/node_modules/.bin/tsc`, `.bin/tsserver` wrapper도 있었다. server·engine에는 TypeScript, 개발 도구, pnpm store가 없었다.

`deploy/migrate/package.json`의 의존성은 `prisma` 7.10.1 하나다. Prisma 7.10.1은 `typescript`를 `optional: true` peer로 선언한다. lock에서 이 peer가 workspace의 `typescript@6.0.3`으로 풀렸고 `pnpm deploy --prod --legacy`가 그대로 복사했다.

운영 migrate 이미지에는 Prisma CLI, schema engine과 asset, `schema.prisma`, migrations, `prisma.config.ts`만 있으면 된다. compiler가 필요 없다는 판정은 TypeScript를 지운 이미지로 실제 `migrate deploy`를 돌려 내린다. CLI `version` 통과는 근거로 쓰지 않는다.

## 방법

변경 파일은 `deploy/Dockerfile`, 이 계획 문서, `docs/index.md` 세 개다. lock, pnpm 설정, `deploy/migrate/package.json`, AC 문서는 바꾸지 않는다. 새 스크립트, 범용 함수, 새 단위 시험도 만들지 않는다. `--no-optional`과 lock·전역 설정을 바꾸는 pnpm 옵션은 쓰지 않는다.

기존 `migrate-pack`의 `RUN` 하나 안에서 deploy 직후 Prisma metadata를 검증하고 고정 경로의 TypeScript만 지운다. 기존 Prisma CLI·schema engine 검사는 삭제 뒤로 옮겨 사후 상태를 확인한다.

```dockerfile
FROM dependencies AS migrate-pack
RUN pnpm --filter @opensamguk/migrate-runtime deploy --prod --legacy /opt/migrate \
    && node -e 'const p=JSON.parse(require("fs").readFileSync("/opt/migrate/node_modules/prisma/package.json","utf8"));if(p.version!=="7.10.1"||!p.peerDependencies?.typescript||p.peerDependenciesMeta?.typescript?.optional!==true||p.dependencies?.typescript||p.optionalDependencies?.typescript)process.exit(1)' \
    && test -n "$(find /opt/migrate/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name 'typescript@*' -print -quit)" \
    && find /opt/migrate/node_modules -type l -name typescript -delete \
    && find /opt/migrate/node_modules -type f \( -path '*/.bin/tsc' -o -path '*/.bin/tsserver' \) -delete \
    && find /opt/migrate/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d -name 'typescript@*' -exec rm -rf -- {} + \
    && test -z "$(find /opt/migrate/node_modules \( -name typescript -o -name 'typescript@*' -o -name tsc -o -name tsserver \) -print -quit)" \
    && test -z "$(find /opt/migrate/node_modules -xtype l -print -quit)" \
    && test -f /opt/migrate/node_modules/prisma/build/index.js \
    && test -n "$(find /opt/migrate/node_modules -name schema-engine-debian-openssl-3.0.x -print -quit)"
```

각 줄의 역할을 정리한다. `node -e`는 Prisma 버전이 7.10.1이고 `typescript`가 선택 peer로만 선언됐는지 확인한다. 버전이나 선언이 바뀌면 빌드가 실패해 다시 검토하게 된다. 지울 `typescript@*` 디렉터리가 없을 때도 실패시켜 이 단계가 쓸모없어졌음을 알린다.

`find`는 기본값 `-P`라 symlink를 따라가지 않는다. `-type l -delete`는 링크 자체만 지우고 `rm -rf`는 고정된 `.pnpm` 바로 아래의 실제 디렉터리만 받는다. 삭제 경로가 Docker 빌드 안의 `/opt/migrate/node_modules`로 고정되어 workspace의 링크 대상에 닿지 않는다.

삭제 뒤에는 `typescript`, `typescript@*`, `tsc`, `tsserver` 이름이 하나라도 남거나 끊긴 symlink가 생기면 빌드를 실패시킨다. 예상 밖 위치에 같은 이름이 있으면 지우지 않고 실패로 드러낸다.

Prisma 가상 디렉터리 이름의 `_typescript@6.0.3` 접미사와 `.modules.yaml` 같은 pnpm metadata 속 문자열은 그대로 둔다.

## 유의점

server·engine·web 단계, compose, entrypoint, UID 10001, secrets, `read_only`, `cap_drop`, source 검사 label, 개발 실행 경로는 바꾸지 않는다. 다른 패키지가 TypeScript를 필수로 쓰는지는 정적으로 단정하지 않고 아래 실제 DB 회귀로 판정한다. TypeScript 없이 `migrate deploy`가 실패하면 우회하지 않고 출력과 함께 멈춰 알린다.

## 검증

### 이미지 빌드와 inventory

기존 release 경로의 새 source 인자로 `web`, `server`, `engine`, `migrate` 4개 target을 실제로 다시 빌드한다. 비교 기준은 이미 있는 `7ff13b7f` 이미지 4개다. 이 기준이 `8bc847e3`과 runtime 입력이 같다는 증거가 있으므로 기준 이미지는 다시 빌드하지 않는다.

각 이미지를 export해 파일 inventory를 만든다. OS timestamp, 컨테이너 metadata, 패키지 환경의 비결정성 때문에 파일 전체 해시 일치는 요구하지 않는다. 비교 범위는 앱 payload(번들, entrypoint, resources, 필수 asset)와 재현 가능한 파일이다.

- server·engine·web은 이 범위의 내용이 기준과 같아야 한다.
- migrate는 기준과 비교해 `typescript@6.0.3` 트리와 그 symlink·bin wrapper만 빠져야 한다. Prisma CLI, schema engine, Prisma asset, `schema.prisma`, migration 40개, `migration_lock.toml`, `prisma.config.ts`는 남아야 한다.
- migrate에 pnpm 다운로드 store와 앱 개발 compiler 실파일이 없어야 하고 끊긴 symlink도 없어야 한다. root cache의 빈 디렉터리 자체는 금지 대상이 아니다.
- runtime 계열 3개(server·engine·migrate)만 UID 10001과 OCI label을 확인한다. label 값은 새 source 기준이다. web은 scratch export라 원래 user·label이 없고 이 계약은 넓히지 않는다.

### 실제 DB 회귀

기존 검증 절차를 따른다. 원본 PG 39 데이터 디렉터리를 읽기 전용으로 물리 복사해 이 검증이 소유하는 새 volume을 만든다. migration 작업과 같은 PostgreSQL 18.6으로 기동하며 공유 개발 DB와 공유 포트는 쓰지 않는다.

새 migrate 이미지를 compose의 기존 migrate 설정(UID, `read_only`, `cap_drop`, secret 파일) 그대로 실행해 migration 40을 적용한다. DB 접속 정보는 저장소 밖 임시 secret 파일로만 넘기고 명령 인자와 로그에 넣지 않는다.

적용 뒤 확인할 항목:

- `_prisma_migrations`에 40행이 모두 완료 상태다.
- migration 40의 스키마 변경이 실제 DB에 있다.
- 같은 이미지를 다시 실행하면 적용할 migration 없이 끝난다.
- 같은 이미지 안에서 `typescript`를 해석하면 찾지 못한다.

끝나면 이 검증이 만든 컨테이너와 volume만 지운다.

### 저장소 검사와 병합

`pnpm check`, 영향받는 기존 release·supervisor 검사, `pnpm lint:text docs/plans`를 실행한다. 크기, 파일 수, inventory 차이 같은 실측 결과는 PR 본문과 Git 밖 artifact에 남긴다. 이 문서에는 결과나 세션 로그를 적지 않는다.

커밋 메시지는 `T2-15 AC-M2-08`로 시작한다. 보호 CI가 정확한 head SHA에서 통과하고 별도 Claude 세션의 독립 리뷰를 통과하며 충돌이 없으면 일반 병합한다. 보호 규칙은 우회하지 않는다.

## 범위

이 작업은 migrate 이미지의 compiler 누락만 고친다. 병합과 위 실측 증거가 갖춰지면 이 누락 수정을 완료로 본다. 공개 Tunnel SSE와 실제 IP 두 곳은 사람의 DNS 승인을 기다리는 상태로 남고 AC-M2-08 전체의 완료 상태는 바꾸지 않는다.
