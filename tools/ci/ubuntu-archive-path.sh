#!/usr/bin/env bash
# T3-04 CI 설치 경로 후속. Ubuntu 공식 저장소 미러 목록에서 azure 미러 한 줄만 뺀다.
# 예상한 구성이 아니면 아무것도 쓰지 않고 종료 코드 1로 멈춘다. 첫 인수는 검사할 루트다(CI는 /).
set -euo pipefail

root=${1:?usage: ubuntu-archive-path.sh ROOT}
root=${root%/}
etc="$root/etc/apt"
src="$etc/sources.list.d/ubuntu.sources"
list="$etc/apt-mirrors.txt"
keyring=/usr/share/keyrings/ubuntu-archive-keyring.gpg
work=$(mktemp -d)
# 실제 실행기(루트 /)는 언제나 apt-config를 쓴다. 시험 자료 루트에서만 같은 출력을 내는 대역 경로를 받는다.
if [ -z "$root" ]; then
  apt_config=apt-config
else
  apt_config=${FIXTURE_APT_CONFIG:?fixture root needs FIXTURE_APT_CONFIG}
fi
# grep 상태는 셋으로 나눈다. 0은 일치, 1은 불일치, 2 이상은 읽기·검사 실패라서 쓰기 전에 멈춘다.
# 불일치가 통과인 검사는 파이프와 grep -q, || true로 상태를 섞지 않고 출력을 파일로 받은 뒤 상태를 직접 본다.
# azure 미러 줄은 아래 두 awk에서 같은 정규식 리터럴 /^http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?$/로 찾는다.
# awk -v로 넘기면 역슬래시가 풀려 \.이 아무 문자에나 맞을 수 있어서 리터럴로 둔다.

stop() { echo "APT_PATH_STOP $*" >&2; exit 1; }
snapshot() {
  find "$etc" "$root/usr/share/keyrings" -type f ! -path "$list" -print0 | sort -z | xargs -0 -r sha256sum
}

# 운영체제와 파일
grep -qx 'VERSION_ID="24.04"' "$root/etc/os-release" || stop os-version
grep -qx 'VERSION_CODENAME=noble' "$root/etc/os-release" || stop os-codename
for f in "$src" "$list" "$root$keyring"; do
  [ -f "$f" ] && [ ! -L "$f" ] || stop "file $f"
done

# 한 줄 형식 sources와 다른 파일의 Ubuntu 저장소는 예상 밖이다
if [ -e "$etc/sources.list" ]; then
  status=0
  grep -E '^[[:space:]]*deb(-src)?[[:space:]]' "$etc/sources.list" > "$work/legacy" || status=$?
  case $status in
    0) cat "$work/legacy" >&2; stop legacy-sources.list ;;
    1) ;;
    *) stop "sources.list-read status=$status" ;;
  esac
fi
status=0
grep -rlE '(azure\.archive|archive|security|ports)\.ubuntu\.com|apt-mirrors\.txt' "$etc/sources.list.d" > "$work/ubuntu-files" || status=$?
case $status in
  0) ;;
  1) stop ubuntu.sources-not-matched ;;
  *) stop "sources.list.d-read status=$status" ;;
esac
status=0
grep -xF "$src" "$work/ubuntu-files" > /dev/null || status=$?
case $status in
  0) ;;
  1) stop ubuntu.sources-not-matched ;;
  *) stop "ubuntu-files-read status=$status" ;;
esac
status=0
grep -vxF "$src" "$work/ubuntu-files" > "$work/other-files" || status=$?
case $status in
  0) cat "$work/other-files" >&2; stop other-ubuntu-source ;;
  1) ;;
  *) stop "ubuntu-files-read status=$status" ;;
esac

# deb822 ubuntu.sources: 모든 stanza가 미러 목록과 Ubuntu keyring을 쓴다
sources=$(awk -v uri="mirror+file:/etc/apt/apt-mirrors.txt" -v keyring="$keyring" '
  function fail(r) { print "STOP " r; failed = 1; exit }
  function within(value, set,   n, a, i) {
    n = split(value, a, /[[:space:]]+/)
    for (i = 1; i <= n; i++) if (!(a[i] in set)) return 0
    return n > 0
  }
  BEGIN {
    RS = ""; FS = "\n"
    n = split("Types URIs Suites Components Signed-By Architectures Enabled", a, " "); for (i = 1; i <= n; i++) F[a[i]]
    n = split("deb deb-src", a, " "); for (i = 1; i <= n; i++) T[a[i]]
    n = split("noble noble-updates noble-backports noble-security", a, " "); for (i = 1; i <= n; i++) S[a[i]]
    n = split("main restricted universe multiverse", a, " "); for (i = 1; i <= n; i++) C[a[i]]
    n = split("amd64 i386", a, " "); for (i = 1; i <= n; i++) A[a[i]]
  }
  {
    split("", v); count = 0
    for (i = 1; i <= NF; i++) {
      line = $i
      if (line == "") continue
      if (line ~ /^#/) continue
      if (line ~ /^[[:space:]]/) fail("continuation-line")
      p = index(line, ":"); if (p < 2) fail("syntax")
      name = substr(line, 1, p - 1); value = substr(line, p + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if (!(name in F)) fail("field " name)
      if (name in v) fail("duplicate " name)
      v[name] = value; count++
    }
    if (count == 0) next
    stanzas++
    if (("Enabled" in v) && v["Enabled"] != "yes") fail("enabled " v["Enabled"])
    if (v["URIs"] != uri) fail("uris " v["URIs"])
    if (v["Signed-By"] != keyring) fail("signed-by " v["Signed-By"])
    if (!within(v["Types"], T)) fail("types " v["Types"])
    if (!within(v["Suites"], S)) fail("suites " v["Suites"])
    if (!within(v["Components"], C)) fail("components " v["Components"])
    if (("Architectures" in v) && !within(v["Architectures"], A)) fail("architectures " v["Architectures"])
    if (v["Types"] ~ /(^|[[:space:]])deb($|[[:space:]])/) {
      n = split(v["Suites"], a, /[[:space:]]+/); for (i = 1; i <= n; i++) seenS[a[i]]
      n = split(v["Components"], a, /[[:space:]]+/); for (i = 1; i <= n; i++) seenC[a[i]]
    }
    print "STANZA Types=" v["Types"] " Suites=" v["Suites"] " Components=" v["Components"] \
      " Architectures=" (("Architectures" in v) ? v["Architectures"] : "-") " Signed-By=" v["Signed-By"]
  }
  END {
    if (failed) exit
    if (!stanzas) { print "STOP no-stanza"; exit }
    for (s in S) if (!(s in seenS)) { print "STOP missing-suite " s; exit }
    n = split("main restricted universe", a, " ")
    for (i = 1; i <= n; i++) if (!(a[i] in seenC)) { print "STOP missing-component " a[i]; exit }
    print "SOURCES_OK"
  }
' "$src")
printf '%s\n' "$sources" | sed 's/^/APT_PATH_/'
[ "$(printf '%s\n' "$sources" | tail -n 1)" = SOURCES_OK ] || stop ubuntu.sources

# 미러 목록: azure http 한 줄과 Ubuntu 공식 호스트 한 줄 이상, 태그는 priority만
mirrors=$(awk '
  BEGIN { FS = "\t" }
  /^[[:space:]]*(#|$)/ { next }
  {
    for (i = 2; i <= NF; i++) if ($i !~ /^priority:[0-9]+$/) { print "STOP tag " $i; failed = 1; exit }
    if ($1 ~ /^http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?$/) { found++; next }
    if ($1 !~ /^https?:\/\/(archive|security)\.ubuntu\.com\/ubuntu\/?$/) { print "STOP host " $1; failed = 1; exit }
    official++
  }
  END {
    if (failed) exit
    if (found != 1) { print "STOP azure-lines " found + 0; exit }
    if (official < 1) { print "STOP no-official-mirror"; exit }
    print "OK"
  }
' "$list")
[ "$mirrors" = OK ] || stop "apt-mirrors.txt $mirrors"

# 아키텍처는 실제 실행기에서만 본다
if [ -z "$root" ]; then
  [ "$(dpkg --print-architecture)" = amd64 ] || stop arch
fi

# 서명·TLS 검증을 끄는 apt 설정. 출력 명령의 성공과 비어 있지 않은 전체 출력을 먼저 요구한다
status=0
"$apt_config" dump > "$work/apt-config.dump" 2> "$work/apt-config.err" || status=$?
if [ "$status" -ne 0 ]; then
  cat "$work/apt-config.err" >&2
  stop "apt-config-dump status=$status"
fi
[ -s "$work/apt-config.dump" ] || stop apt-config-dump-empty
status=0
grep -Ei 'Verify-(Peer|Host) "(false|no|0|off)"|Allow(Insecure|Weak|DowngradeToInsecure)Repositories "(true|yes|1|on)"|AllowUnauthenticated "(true|yes|1|on)"|Trusted "(true|yes|1|on)"' \
  "$work/apt-config.dump" > "$work/apt-config.unsafe" || status=$?
case $status in
  0) cat "$work/apt-config.unsafe" >&2; stop insecure-apt-config ;;
  1) ;;
  *) stop "apt-config-check status=$status" ;;
esac
# Retries·Timeout은 바꾸지 않고 같은 출력에서 기록만 한다. 없으면 apt 기본값이다
status=0
grep -E '^Acquire::(Retries|https?::Timeout) ' "$work/apt-config.dump" > "$work/apt-config.acquire" || status=$?
case $status in
  0) sed 's/^/APT_PATH_ACQUIRE /' "$work/apt-config.acquire" ;;
  1) echo 'APT_PATH_ACQUIRE default' ;;
  *) stop "apt-config-acquire status=$status" ;;
esac

# 쓰기: azure 줄 하나만 뺀 목록을 같은 파일(소유자·권한 유지)에 쓴다
cp "$list" "$work/before"
awk 'BEGIN { FS = "\t" } !($1 ~ /^http:\/\/azure\.archive\.ubuntu\.com\/ubuntu\/?$/)' "$list" > "$work/after"
status=0
diff -U 0 "$work/before" "$work/after" > "$work/mirrors.diff" || status=$?
[ "$status" -eq 1 ] || stop "diff status=$status"
removed=$(awk '/^-/ && !/^---/ { n++ } END { print n + 0 }' "$work/mirrors.diff")
added=$(awk '/^[+]/ && !/^[+][+][+]/ { n++ } END { print n + 0 }' "$work/mirrors.diff")
[ "$removed" = 1 ] && [ "$added" = 0 ] || stop "diff removed=$removed added=$added"
snapshot > "$work/snapshot.before"
tee "$list" < "$work/after" > /dev/null
cmp -s "$list" "$work/after" || stop write
snapshot > "$work/snapshot.after"
cmp -s "$work/snapshot.before" "$work/snapshot.after" || stop other-apt-files-changed

echo APT_PATH_SNAPSHOT; cat "$work/snapshot.after"
echo APT_PATH_MIRRORS_BEFORE; cat "$work/before"
echo APT_PATH_MIRRORS_AFTER; cat "$list"
echo APT_PATH_OK
