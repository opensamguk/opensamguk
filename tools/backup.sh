#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C.UTF-8
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'

# T2-15/AC-M2-09. restore.sh도 이 파일의 함수만 읽는다.
t215_fail() { printf 'failed %s\n' "$1" >&2; exit 1; }
t215_name() { [[ "$1" != *$'\n'* && "$1" != *$'\r'* && "$1" =~ ^[a-z][a-z0-9_]*$ && ${#1} -le 63 ]]; }
t215_absolute() { [[ "$1" == /* || "$1" =~ ^[A-Za-z]:[/\\] ]]; }
t215_clean() {
  local item
  for item in "${partials[@]}"; do rm -f -- "$item" || true; done
  if [[ "$locked" == true ]]; then rmdir -- "$lock" 2>/dev/null || true; fi
}
t215_init() {
  umask 077
  unset DATABASE_URL TEST_DATABASE_URL PGPASSWORD PGPASSFILE PGSERVICE PGSERVICEFILE PGHOST PGPORT PGUSER PGDATABASE PGOPTIONS DOCKER_CONTEXT
  case "${DOCKER_HOST:-}" in
    npipe:////./pipe/*|unix:///*) ;;
    *) t215_fail DOCKER_HOST ;;
  esac
  [[ -n "${DOCKER_CONFIG:-}" && -d "$DOCKER_CONFIG" ]] || t215_fail DOCKER_CONFIG
  t215_absolute "$docker" && [[ -f "$docker" && -x "$docker" ]] || t215_fail DOCKER_PATH
  [[ ${#container} -eq 64 && "$container" =~ ^[0-9a-f]{64}$ && "$system" != *$'\n'* && "$system" != *$'\r'* && "$system" =~ ^[0-9]+$ ]] || t215_fail IDENTITY_ARGUMENT
  t215_name "$role" && t215_name "$admin" || t215_fail DATABASE_ARGUMENT
  run_id=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
  [[ "$run_id" =~ ^[0-9a-f]{32}$ ]] || t215_fail RUN_ID
}
t215_exec() { "$docker" exec "$container" "$@" 2>>"$err"; }
t215_psql() {
  local database=$1
  shift
  "$docker" exec -i "$container" psql -X -At -w -v ON_ERROR_STOP=1 -U "$role" -d "$database" "$@" 2>>"$err"
}
t215_identity() {
  local observed sid
  observed=$("$docker" inspect --type container "$container" --format '{{.Id}} {{.State.Running}}' 2>>"$err") || t215_fail CONTAINER_INSPECT
  [[ "$observed" == "$container true" ]] || t215_fail CONTAINER_IDENTITY
  sid=$(t215_psql "$admin" <<'SQL'
-- t215:system
SELECT system_identifier FROM pg_control_system();
SQL
  ) || t215_fail SYSTEM_QUERY
  [[ "$sid" == "$system" ]] || t215_fail SYSTEM_IDENTITY
}
t215_database_identity() {
  t215_psql "$1" <<'SQL'
-- t215:database-identity
SELECT current_database() || '|' || oid || '|' || (SELECT system_identifier FROM pg_control_system()) || '|' || current_setting('server_version_num') FROM pg_database WHERE datname=current_database();
SQL
}
t215_quiesced() {
  local count
  count=$(t215_psql "$1" <<'SQL'
-- t215:quiesced
SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()) + (SELECT count(*) FROM public."EngineLease" WHERE "expiresAt" > clock_timestamp() AT TIME ZONE 'UTC');
SQL
  ) || t215_fail QUIESCED_QUERY
  [[ "$count" == 0 ]] || t215_fail SOURCE_BUSY
}
t215_content() {
  local rows
  rows=$(t215_psql "$1" <<'SQL'
-- t215:content
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL TimeZone='UTC';
SET LOCAL DateStyle='ISO, YMD';
SET LOCAL IntervalStyle='postgres';
SET LOCAL extra_float_digits=3;
SET LOCAL bytea_output='hex';
SELECT format('SELECT %L || chr(9) || %L || chr(9) || count(*) || chr(9) || md5(coalesce(string_agg(h, '''' ORDER BY h COLLATE "C"), '''')) FROM (SELECT md5(t::text) h FROM public.%I t) s;', 'table', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname COLLATE "C"
\gexec
SELECT format('SELECT %L || chr(9) || %L || chr(9) || last_value || chr(9) || is_called FROM public.%I;', 'sequence', c.relname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='S' ORDER BY c.relname COLLATE "C"
\gexec
COMMIT;
SQL
  ) || t215_fail CONTENT_QUERY
  # -q는 BEGIN·SET·COMMIT 명령 태그를 숨긴다. 반환값은 표·sequence 행뿐이다.
  rows=$(printf '%s\n' "$rows" | sed '/^BEGIN$/d; /^SET$/d; /^COMMIT$/d')
  printf '%s' "$rows" | sha256sum | cut -d ' ' -f 1
}
t215_archive_migrations() {
  t215_exec_stdin pg_restore --data-only --table=_prisma_migrations -f - <"$archive" >"$migration_sql" || t215_fail MIGRATIONS_ARCHIVE
  awk '
    /^COPY public\._prisma_migrations / {
      header=$0; sub(/^.*\(/,"",header); sub(/\).*$/,"",header); n=split(header,cols,", ");
      for(i=1;i<=n;i++) {gsub(/"/,"",cols[i]); ix[cols[i]]=i}
      if(!ix["migration_name"] || !ix["checksum"] || !ix["finished_at"] || !ix["rolled_back_at"]) exit 1;
      copy=1; seen++; next
    }
    copy && /^\\\.$/ {copy=0; next}
    copy {split($0,f,"\t"); if(f[ix["finished_at"]]=="\\N" || f[ix["rolled_back_at"]]!="\\N") exit 1; print f[ix["migration_name"]] "\t" f[ix["checksum"]]; rows++}
    END {if(seen!=1 || rows<1 || copy) exit 1}
  ' "$migration_sql" | LC_ALL=C sort >"$migration_rows" || t215_fail MIGRATIONS_FORMAT
  t215_validate_migrations "$migration_rows"
}
t215_validate_migrations() {
  local name checksum rest count=0
  while IFS=$'\t' read -r name checksum rest; do
    [[ "$name" =~ ^[0-9]{14}_[a-z0-9_]+$ && "$checksum" =~ ^[0-9a-f]{64}$ && -z "$rest" ]] || t215_fail MIGRATIONS_FORMAT
    count=$((count+1))
  done <"$1"
  [[ "$count" -gt 0 ]] || t215_fail MIGRATIONS_EMPTY
  [[ "$(cut -f 1 "$1" | uniq -d | wc -l)" -eq 0 ]] || t215_fail MIGRATIONS_DUPLICATE
}
t215_exec_stdin() { "$docker" exec -i "$container" "$@" 2>>"$err"; }
t215_migrations_json() {
  local name checksum comma=''
  printf '['
  while IFS=$'\t' read -r name checksum; do
    printf '%s{"name":"%s","checksum":"%s"}' "$comma" "$name" "$checksum"
    comma=,
  done <"$migration_rows"
  printf ']'
}
t215_major() { [[ "$1" =~ PostgreSQL\)\ ([0-9]+) ]] && printf '%s' "${BASH_REMATCH[1]}"; }

t215_backup_main() {
  docker= container= system= role= admin= source_db= backup_dir= reason=
  local release_sha=''
  local key value
  declare -A supplied=()
  while [[ $# -gt 0 ]]; do
    [[ $# -ge 2 && -n "$2" && -z "${supplied[$1]:-}" ]] || t215_fail ARGUMENT
    key=$1; value=$2; supplied[$key]=1; shift 2
    case "$key" in
      --docker) docker=$value;; --container) container=$value;; --system-identifier) system=$value;;
      --db-user) role=$value;; --admin-db) admin=$value;; --source-db) source_db=$value;;
      --backup-dir) backup_dir=$value;; --reason) reason=$value;; --release-sha) release_sha=$value;; *) t215_fail ARGUMENT;;
    esac
  done
  [[ -n "$docker" && -n "$container" && -n "$system" && -n "$role" && -n "$admin" && -n "$source_db" && -n "$backup_dir" && -n "$reason" && -n "$release_sha" ]] || t215_fail ARGUMENT
  [[ ${#release_sha} -eq 40 && "$release_sha" =~ ^[0-9a-fA-F]{40}$ ]] || t215_fail RELEASE_SHA_ARGUMENT
  t215_name "$source_db" || t215_fail SOURCE_NAME
  t215_absolute "$backup_dir" || t215_fail BACKUP_PATH
  case "$reason" in daily) consistency=live;; pre-deploy|rehearsal) consistency=quiesced;; *) t215_fail REASON;; esac
  t215_init
  mkdir -p -- "$backup_dir" || t215_fail BACKUP_DIRECTORY
  chmod 700 -- "$backup_dir" || t215_fail BACKUP_PERMISSIONS
  lock="$backup_dir/.t215.lock"; locked=false; partials=()
  mkdir -- "$lock" 2>/dev/null || t215_fail LOCKED
  locked=true
  err="$backup_dir/.partial-$run_id.err"
  archive="$backup_dir/.partial-$run_id.dump"
  migration_sql="$backup_dir/.partial-$run_id.migrations.sql"
  migration_rows="$backup_dir/.partial-$run_id.migrations"
  local manifest="$backup_dir/.partial-$run_id.manifest.json"
  partials=("$err" "$archive" "$migration_sql" "$migration_rows" "$manifest")
  trap t215_clean EXIT
  trap 't215_fail INTERRUPTED' INT TERM
  trap 't215_fail INTERNAL' ERR
  : >"$err"
  t215_identity
  local db_identity source_name source_oid source_system server_version dump_version dump_major started finished size digest before_hash after_hash
  db_identity=$(t215_database_identity "$source_db") || t215_fail SOURCE_QUERY
  IFS='|' read -r source_name source_oid source_system server_version <<<"$db_identity"
  [[ "$source_name" == "$source_db" && "$source_system" == "$system" && "$source_oid" =~ ^[0-9]+$ && "$server_version" =~ ^[0-9]+$ ]] || t215_fail SOURCE_IDENTITY
  dump_version=$(t215_exec pg_dump --version) || t215_fail DUMP_VERSION
  dump_major=$(t215_major "$dump_version") || t215_fail DUMP_VERSION
  [[ "$dump_major" -ge $((server_version / 10000)) ]] || t215_fail DUMP_TOO_OLD
  before_hash=null
  if [[ "$consistency" == quiesced ]]; then
    t215_quiesced "$source_db"
    before_hash=$(t215_content "$source_db") || t215_fail CONTENT_HASH
    [[ "$before_hash" =~ ^[0-9a-f]{64}$ ]] || t215_fail CONTENT_HASH
  fi
  started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  t215_identity
  t215_exec pg_dump -Fc -U "$role" -d "$source_db" >"$archive" || t215_fail DUMP_FAILED
  [[ -s "$archive" ]] || t215_fail DUMP_EMPTY
  t215_exec_stdin pg_restore --list <"$archive" >/dev/null || t215_fail ARCHIVE_LIST
  t215_archive_migrations
  if [[ "$consistency" == quiesced ]]; then
    t215_quiesced "$source_db"
    after_hash=$(t215_content "$source_db") || t215_fail CONTENT_HASH
    [[ "$before_hash" == "$after_hash" ]] || t215_fail SOURCE_CHANGED
  fi
  digest=$(sha256sum <"$archive" | cut -d ' ' -f 1) || t215_fail ARCHIVE_HASH
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || t215_fail ARCHIVE_HASH
  size=$(wc -c <"$archive" | tr -d ' ')
  finished=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local stamp="$(date -u +%Y%m%dt%H%M%Sz)-$run_id" content_json=null content_reason=live-source
  [[ "$before_hash" == null ]] || { content_json="\"$before_hash\""; content_reason=quiesced; }
  {
    printf '{\n"format":"t215-pg-custom-v1",\n"success":true,\n"consistency":"%s",\n"reason":"%s",\n' "$consistency" "$reason"
    printf '"source":{"name":"%s","oid":"%s","systemIdentifier":"%s"},\n' "$source_db" "$source_oid" "$system"
    printf '"dumpMajor":%s,\n"serverVersion":%s,\n"releaseSha":"%s",\n' "$dump_major" "$server_version" "$release_sha"
    printf '"startedUtc":"%s",\n"finishedUtc":"%s",\n"createdUnix":%s,\n"size":%s,\n"sha256":"%s",\n' "$started" "$finished" "$(date -u +%s)" "$size" "$digest"
    printf '"contentHash":%s,\n"contentHashReason":"%s",\n"externalCopy":"not-configured",\n"migrations":' "$content_json" "$content_reason"
    t215_migrations_json
    printf '\n}\n'
  } >"$manifest"
  chmod 600 -- "$archive" "$manifest" || t215_fail FILE_PERMISSIONS
  sync || t215_fail SYNC
  local final_dump="$backup_dir/backup-$stamp.dump" final_manifest="$backup_dir/backup-$stamp.manifest.json"
  [[ ! -e "$final_dump" && ! -e "$final_manifest" ]] || t215_fail OUTPUT_EXISTS
  mv -- "$archive" "$final_dump" || t215_fail DUMP_RENAME
  mv -- "$manifest" "$final_manifest" || t215_fail MANIFEST_RENAME
  # 자기 형식의 성공 manifest와 해시가 맞는 dump만 보관 대상으로 센다.
  local old old_dump old_time old_hash old_size old_metadata cutoff=$(( $(date -u +%s) - 7*86400 ))
  for old in "$backup_dir"/backup-*.manifest.json; do
    [[ -f "$old" && ! -L "$old" && "$old" != "$final_manifest" ]] || continue
    [[ "$(basename -- "$old")" =~ ^backup-[0-9]{8}t[0-9]{6}z-[0-9a-f]{32}\.manifest\.json$ ]] || continue
    old_metadata=$(t215_psql "$admin" -v "manifest=$(cat -- "$old")" -v "source=$source_db" -v "system=$system" <<'SQL'
-- t215:retention
WITH m AS (SELECT :'manifest'::jsonb j)
SELECT concat_ws('|',j->>'createdUnix',j->>'sha256',j->>'size') FROM m
WHERE j->>'format'='t215-pg-custom-v1' AND j->'success'='true'::jsonb
AND j->'source'->>'name'=:'source' AND j->'source'->>'systemIdentifier'=:'system'
AND (j->'source'->>'oid') ~ '^[0-9]+$' AND (j->>'releaseSha') ~ '^[0-9a-fA-F]{40}$'
AND (j->>'dumpMajor') ~ '^[0-9]{1,3}$' AND (j->>'serverVersion') ~ '^[0-9]+$'
AND (j->>'createdUnix') ~ '^[0-9]{1,12}$' AND (j->>'sha256') ~ '^[0-9a-f]{64}$' AND (j->>'size') ~ '^[0-9]+$'
AND j->>'externalCopy'='not-configured'
AND ((j->>'consistency'='quiesced' AND (j->>'contentHash') ~ '^[0-9a-f]{64}$' AND j->>'contentHashReason'='quiesced')
 OR (j->>'consistency'='live' AND j->'contentHash'='null'::jsonb AND j->>'contentHashReason'='live-source'))
AND jsonb_typeof(j->'migrations')='array' AND jsonb_array_length(j->'migrations')>0
AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'migrations') x WHERE coalesce(x->>'name','') !~ '^[0-9]{14}_[a-z0-9_]+$' OR coalesce(x->>'checksum','') !~ '^[0-9a-f]{64}$');
SQL
    ) || continue
    IFS='|' read -r old_time old_hash old_size <<<"$old_metadata"
    [[ "$old_time" =~ ^[0-9]{1,12}$ && "$old_hash" =~ ^[0-9a-f]{64}$ ]] || continue
    [[ "$old_time" -lt "$cutoff" ]] || continue
    old_dump="${old%.manifest.json}.dump"
    [[ -f "$old_dump" && ! -L "$old_dump" ]] || continue
    [[ "$old_size" =~ ^[0-9]+$ && "$(wc -c <"$old_dump" | tr -d ' ')" == "$old_size" ]] || continue
    [[ "$(sha256sum <"$old_dump" | cut -d ' ' -f 1)" == "$old_hash" ]] || continue
    rm -f -- "$old_dump" "$old" || t215_fail RETENTION
  done
  printf 'ok %s %s\n' "$(basename -- "$final_dump")" "$(basename -- "$final_manifest")"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then t215_backup_main "$@"; fi
