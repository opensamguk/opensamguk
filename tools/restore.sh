#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL=C.UTF-8
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
source "$(dirname -- "${BASH_SOURCE[0]}")/backup.sh"

docker= container= system= role= admin= archive= manifest= target=
approved_source= approved_source_oid= approved_manifest_hash= approved_revision= stage_receipt=
declare -A supplied=()
while [[ $# -gt 0 ]]; do
  [[ $# -ge 2 && -n "$2" && -z "${supplied[$1]:-}" ]] || t215_fail ARGUMENT
  key=$1; value=$2; supplied[$key]=1; shift 2
  case "$key" in
    --docker) docker=$value;; --container) container=$value;; --system-identifier) system=$value;;
    --db-user) role=$value;; --admin-db) admin=$value;; --archive) archive=$value;;
    --manifest) manifest=$value;; --target-db) target=$value;;
    --approved-source-db) approved_source=$value;; --approved-source-oid) approved_source_oid=$value;;
    --approved-manifest-sha256) approved_manifest_hash=$value;; --approved-release-sha) approved_revision=$value;;
    --stage-receipt) stage_receipt=$value;; *) t215_fail ARGUMENT;;
  esac
done
[[ -n "$docker" && -n "$container" && -n "$system" && -n "$role" && -n "$admin" && -n "$archive" && -n "$manifest" && -n "$target" ]] || t215_fail ARGUMENT
t215_name "$target" || t215_fail TARGET_NAME
[[ "$target" =~ ^t215_dst_[0-9a-f]{32}_test$ || "$target" =~ ^opensamguk_restore_[0-9]{8}t[0-9]{6}z_[0-9a-f]{8}$ ]] || t215_fail TARGET_NAME
[[ "$admin" != "$target" ]] || t215_fail TARGET_ADMIN
t215_absolute "$archive" && t215_absolute "$manifest" && [[ -f "$archive" && -f "$manifest" ]] || t215_fail ARCHIVE_PATH
staged=false
if [[ "$target" =~ ^opensamguk_restore_ ]]; then
  t215_name "$approved_source" && [[ "$approved_source" != "$target" && "$approved_source" != "$admin" ]] ||
    t215_fail OPERATIONAL_RESTORE_UNASSIGNED
  [[ "$approved_source_oid" =~ ^[0-9]{1,10}$ && "$approved_manifest_hash" =~ ^[0-9a-f]{64}$ && "$approved_revision" =~ ^[0-9a-f]{40}$ ]] ||
    t215_fail STAGE_APPROVAL
  t215_absolute "$stage_receipt" && [[ ! -e "$stage_receipt" && ! -L "$stage_receipt" && ! -L "$archive" && ! -L "$manifest" ]] ||
    t215_fail STAGE_RECEIPT
  [[ "$(sha256sum <"$manifest" | cut -d ' ' -f 1)" == "$approved_manifest_hash" ]] || t215_fail STAGE_APPROVAL
  staged=true
elif [[ -n "$approved_source$approved_source_oid$approved_manifest_hash$approved_revision$stage_receipt" ]]; then
  t215_fail STAGE_APPROVAL
fi
t215_init
work_dir=$(dirname -- "$manifest")
lock="$work_dir/.t215.lock"; locked=false; partials=(); created=false; target_oid=
mkdir -- "$lock" 2>/dev/null || t215_fail LOCKED
locked=true
err="$work_dir/.partial-$run_id.err"
migration_sql="$work_dir/.partial-$run_id.migrations.sql"
migration_rows="$work_dir/.partial-$run_id.migrations"
expected_rows="$work_dir/.partial-$run_id.expected"
partials=("$err" "$migration_sql" "$migration_rows" "$expected_rows")

restore_clean() {
  local status=$? current connections
  trap - ERR
  if [[ "$status" -ne 0 && "$created" == true && "$target" =~ ^t215_dst_[0-9a-f]{32}_test$ ]]; then
    # 별도 subshell에서 identity 확인이 실패해도 부분 파일 정리는 계속한다.
    if (t215_identity); then
      current=$(t215_psql "$admin" -v "target=$target" <<'SQL'
-- t215:target-oid
SELECT oid FROM pg_database WHERE datname=:'target';
SQL
      ) || current=unknown
      connections=$(t215_psql "$admin" -v "target=$target" <<'SQL'
-- t215:target-connections
SELECT count(*) FROM pg_stat_activity WHERE datname=:'target';
SQL
      ) || connections=unknown
      if [[ "$current" == "$target_oid" && "$target_oid" =~ ^[0-9]+$ && "$connections" == 0 ]]; then
        if ! t215_psql "$admin" -v "target=$target" <<'SQL' >/dev/null
-- t215:drop
DROP DATABASE :"target";
SQL
        then printf 'failed CLEANUP_RETAINED %s %s\n' "$target" "$target_oid" >&2; fi
      else printf 'failed CLEANUP_RETAINED %s %s\n' "$target" "$target_oid" >&2
      fi
    else printf 'failed CLEANUP_RETAINED %s %s\n' "$target" "$target_oid" >&2
    fi
  elif [[ "$status" -ne 0 && "$created" == true ]]; then
    printf 'failed CLEANUP_RETAINED %s %s\n' "$target" "$target_oid" >&2
  fi
  t215_clean
}
trap restore_clean EXIT
trap 't215_fail INTERRUPTED' INT TERM
trap 't215_fail INTERNAL' ERR
: >"$err"
t215_identity
manifest_json=$(cat -- "$manifest") || t215_fail MANIFEST_READ
if [[ "$staged" == true ]]; then
  # The backup writer terminates its canonical manifest with one newline.
  [[ "$(printf '%s\n' "$manifest_json" | sha256sum | cut -d ' ' -f 1)" == "$approved_manifest_hash" ]] || t215_fail STAGE_APPROVAL
fi
header=$(t215_psql "$admin" -v "manifest=$manifest_json" <<'SQL'
-- t215:manifest
WITH m AS (SELECT :'manifest'::jsonb j)
SELECT concat_ws('|',j->'source'->>'name',j->'source'->>'oid',j->'source'->>'systemIdentifier',j->>'dumpMajor',j->>'consistency',j->>'sha256',coalesce(j->>'contentHash','null'),j->>'contentHashReason',j->>'size')
FROM m WHERE j->>'format'='t215-pg-custom-v1' AND j->'success'='true'::jsonb
AND jsonb_typeof(j->'migrations')='array' AND jsonb_array_length(j->'migrations')>0
AND (j->>'releaseSha') ~ '^[0-9a-fA-F]{40}$'
AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(j->'migrations') x WHERE coalesce(x->>'name','') !~ '^[0-9]{14}_[a-z0-9_]+$' OR coalesce(x->>'checksum','') !~ '^[0-9a-f]{64}$');
SQL
) || t215_fail MANIFEST_FORMAT
IFS='|' read -r source_name source_oid source_system dump_major consistency expected_hash content_hash content_reason expected_size overflow <<<"$header"
t215_name "$source_name" && [[ "$source_oid" =~ ^[0-9]+$ && "$source_system" =~ ^[0-9]+$ && "$dump_major" =~ ^[0-9]{1,3}$ && "$expected_hash" =~ ^[0-9a-f]{64}$ && "$expected_size" =~ ^[0-9]+$ && -z "$overflow" ]] || t215_fail MANIFEST_FORMAT
[[ "$source_name" != "$target" ]] || t215_fail SOURCE_TARGET_SAME
if [[ "$target" =~ ^t215_dst_ ]]; then
  [[ "$source_name" =~ ^t215_src_[0-9a-f]{32}_test$ && "$source_system" == "$system" ]] || t215_fail MANIFEST_IDENTITY
else
  [[ "$source_name" == "$approved_source" && "$source_oid" == "$approved_source_oid" && "$source_system" == "$system" && "$consistency" == quiesced ]] ||
    t215_fail STAGE_APPROVAL
  actual_revision=$(t215_psql "$admin" -v "manifest=$manifest_json" <<'SQL'
SELECT :'manifest'::jsonb->>'releaseSha';
SQL
  ) || t215_fail STAGE_APPROVAL
  [[ "$actual_revision" == "$approved_revision" ]] || t215_fail STAGE_APPROVAL
  stage_identity() {
    local identity
    identity=$(t215_psql "$admin" -v "source=$approved_source" <<'SQL'
SELECT oid || '|' || (SELECT rolsuper FROM pg_roles WHERE rolname=current_user)
FROM pg_database WHERE datname=:'source';
SQL
    ) || t215_fail STAGE_SOURCE
    [[ "$identity" == "$approved_source_oid|true" ]] || t215_fail STAGE_SOURCE
  }
  stage_identity
fi
case "$consistency" in
  quiesced) [[ "$content_hash" =~ ^[0-9a-f]{64}$ && "$content_reason" == quiesced ]] || t215_fail CONTENT_MANIFEST;;
  live) [[ "$content_hash" == null && "$content_reason" == live-source ]] || t215_fail CONTENT_MANIFEST;;
  *) t215_fail CONTENT_MANIFEST;;
esac
exists=$(t215_psql "$admin" -v "target=$target" <<'SQL'
-- t215:target-oid
SELECT oid FROM pg_database WHERE datname=:'target';
SQL
) || t215_fail TARGET_QUERY
[[ -z "$exists" ]] || t215_fail TARGET_EXISTS
[[ "$(sha256sum <"$archive" | cut -d ' ' -f 1)" == "$expected_hash" && "$(wc -c <"$archive" | tr -d ' ')" == "$expected_size" ]] || t215_fail ARCHIVE_HASH
t215_exec_stdin pg_restore --list <"$archive" >/dev/null || t215_fail ARCHIVE_LIST
version=$(t215_exec pg_restore --version) || t215_fail RESTORE_VERSION
restore_major=$(t215_major "$version") || t215_fail RESTORE_VERSION
[[ "$restore_major" -ge "$dump_major" ]] || t215_fail RESTORE_TOO_OLD
t215_psql "$admin" -v "manifest=$manifest_json" <<'SQL' >"$expected_rows"
-- t215:expected-migrations
SELECT (x->>'name') || chr(9) || (x->>'checksum') FROM jsonb_array_elements(:'manifest'::jsonb->'migrations') x ORDER BY x->>'name' COLLATE "C";
SQL
t215_validate_migrations "$expected_rows"
t215_archive_migrations
cmp -s -- "$migration_rows" "$expected_rows" || t215_fail MIGRATIONS_ARCHIVE_MISMATCH
t215_identity
if [[ "$staged" == true ]]; then
  stage_identity
  t215_psql "$admin" -v "target=$target" <<'SQL' >/dev/null || t215_fail CREATE_FAILED
CREATE DATABASE :"target" TEMPLATE template0 CONNECTION LIMIT 0;
SQL
else
  t215_psql "$admin" -v "target=$target" <<'SQL' >/dev/null || t215_fail CREATE_FAILED
-- t215:create
CREATE DATABASE :"target" TEMPLATE template0;
SQL
fi
created=true
target_oid=$(t215_psql "$admin" -v "target=$target" <<'SQL'
-- t215:target-oid
SELECT oid FROM pg_database WHERE datname=:'target';
SQL
) || t215_fail TARGET_IDENTITY
[[ "$target_oid" =~ ^[0-9]+$ && ( "$source_system" != "$system" || "$target_oid" != "$source_oid" ) ]] || t215_fail TARGET_IDENTITY
t215_identity
t215_exec_stdin pg_restore --exit-on-error --single-transaction -U "$role" -d "$target" <"$archive" >/dev/null || t215_fail RESTORE_FAILED
identity=$(t215_database_identity "$target") || t215_fail TARGET_IDENTITY
IFS='|' read -r restored_name restored_oid restored_system restored_version <<<"$identity"
[[ "$restored_name" == "$target" && "$restored_oid" == "$target_oid" && "$restored_system" == "$system" ]] || t215_fail TARGET_IDENTITY
t215_psql "$target" <<'SQL' >"$migration_rows"
-- t215:target-migrations
SELECT migration_name || chr(9) || checksum FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name COLLATE "C";
SQL
cmp -s -- "$migration_rows" "$expected_rows" || t215_fail MIGRATIONS_TARGET_MISMATCH
if [[ "$consistency" == quiesced ]]; then
  t215_quiesced "$target"
  [[ "$(t215_content "$target")" == "$content_hash" ]] || t215_fail CONTENT_MISMATCH
fi
if [[ "$staged" == true ]]; then
  t215_identity
  stage_identity
  sealed=$(t215_psql "$admin" -q -v "target=$target" <<'SQL'
ALTER DATABASE :"target" ALLOW_CONNECTIONS false;
SELECT oid || '|' || datconnlimit || '|' || datallowconn || '|' ||
       (SELECT count(*) FROM pg_stat_activity WHERE datid=pg_database.oid)
FROM pg_database WHERE datname=:'target';
SQL
  ) || t215_fail TARGET_IDENTITY
  [[ "$sealed" == "$target_oid|0|false|0" ]] || t215_fail TARGET_IDENTITY
  receipt_partial=$(mktemp "$(dirname -- "$stage_receipt")/.restore-staged-$run_id.XXXXXXXX") || t215_fail STAGE_RECEIPT
  partials+=("$receipt_partial")
  printf '{"version":1,"outcome":"restore-staged","source":{"database":"%s","oid":"%s","systemIdentifier":"%s"},"target":{"database":"%s","oid":"%s","systemIdentifier":"%s","connectionLimit":0,"allowsConnections":false},"sourceRevision":"%s","backupManifestSha256":"%s","backupArchiveSha256":"%s","contentSha256":"%s","activeDatabaseChanged":false,"cutoverAuthorized":false}\n' \
    "$source_name" "$source_oid" "$source_system" "$target" "$target_oid" "$system" "$approved_revision" "$approved_manifest_hash" "$expected_hash" "$content_hash" >"$receipt_partial" || t215_fail STAGE_RECEIPT
  sync || t215_fail SYNC
  ln -- "$receipt_partial" "$stage_receipt" || t215_fail STAGE_RECEIPT
  sync || t215_fail SYNC
fi
printf 'ok %s %s\n' "$target" "$target_oid"
