[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Config,
  [switch]$Watch,
  [ValidatePattern('^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')][string]$ResolveRequest
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-Value($Value, [string]$Pattern) {
  if ($Value -isnot [string] -or $Value -cnotmatch $Pattern) { throw '배포 호스트 설정을 확인하세요.' }
  return $Value
}
function Read-Path([string]$Path) {
  if (![IO.Path]::IsPathFullyQualified($Path)) { throw '배포 호스트는 파일의 절대 경로가 필요합니다.' }
  $file = Get-Item -LiteralPath $Path
  if ($file.PSIsContainer -or $file.LinkType) { throw '배포 호스트 설정의 파일을 확인하세요.' }
  return $file.FullName
}
function Assert-Hash([string]$Path, [string]$Expected) {
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() -cne $Expected) {
    throw '배포 산출물 또는 실행기의 해시가 다릅니다.'
  }
}
$revisionPattern = '^[0-9a-f]{40}$'
$hashPattern = '^[0-9a-f]{64}$'
$idPattern = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$configPath = Read-Path $Config
$options = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json -AsHashtable
$docker = Read-Path $options.dockerExecutable
$project = Require-Value $options.project '^[a-z0-9][a-z0-9_-]{0,50}$'
$databaseContainer = Require-Value $options.databaseContainer $hashPattern
$database = Require-Value $options.database '^[a-zA-Z_][a-zA-Z_0-9]{0,62}$'
$dbUser = Require-Value $options.dbUser '^[a-zA-Z_][a-zA-Z_0-9]{0,62}$'
$systemId = Require-Value $options.databaseSystemId '^[0-9]{1,20}$'
$dbOid = Require-Value $options.databaseOid '^[0-9]{1,10}$'
$runDirectory = Get-Item -LiteralPath $options.runDirectory
if (!$runDirectory.PSIsContainer -or $runDirectory.LinkType -or ![IO.Path]::IsPathFullyQualified($options.runDirectory)) {
  throw '배포 실행 기록 디렉터리를 확인하세요.'
}
if (@($options.candidates).Count -gt 32) { throw '승인된 대상은 32개 이하여야 합니다.' }
$driverPaths = @{}
foreach ($operation in @('DEPLOY', 'ROLLBACK')) {
  $driver = $options.drivers[$operation]
  if (!$driver) { continue }
  $path = Read-Path $driver.path
  if ([IO.Path]::GetExtension($path) -cne '.ps1') { throw '배포 실행기는 PowerShell 스크립트여야 합니다.' }
  $hash = Require-Value $driver.sha256 $hashPattern
  Assert-Hash $path $hash
  $driverPaths[$operation] = @{ path = $path; sha256 = $hash }
}
$registry = @{}
foreach ($entry in $options.candidates) {
  $from = Require-Value $entry.fromRevision $revisionPattern
  $target = Require-Value $entry.revision $revisionPattern
  $operation = Require-Value $entry.operation '^(DEPLOY|ROLLBACK)$'
  $registryKey = "${from}:${operation}:$target"
  if ($from -ceq $target -or $registry.ContainsKey($registryKey) -or !$driverPaths.ContainsKey($operation)) {
    throw '배포 승인 목록의 대상과 실행기를 확인하세요.'
  }
  $registry[$registryKey] = @{
    fromRevision = $from
    revision = $target
    operation = $operation
    manifest = Read-Path $entry.manifest
    manifestSha256 = Require-Value $entry.manifestSha256 $hashPattern
    receipt = Read-Path $entry.receipt
    receiptSha256 = Require-Value $entry.receiptSha256 $hashPattern
  }
}
function Invoke-Sql([string]$Sql) {
  $result = @($Sql | & $docker exec -i $databaseContainer psql -X -qAt -v ON_ERROR_STOP=1 -U $dbUser -d $database)
  if ($LASTEXITCODE -ne 0) { throw '배포 호스트의 DB 작업이 실패했습니다.' }
  return $result | Where-Object { $_ }
}
function Assert-Database {
  $identity = & $docker inspect --type container --format '{{.Id}} {{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}' $databaseContainer
  if ($LASTEXITCODE -ne 0 -or $identity -cne "$databaseContainer true $project") { throw '배포 대상 DB 컨테이너가 다릅니다.' }
  $observed = Invoke-Sql 'SELECT system_identifier || '' '' || (SELECT oid FROM pg_database WHERE datname=current_database()) FROM pg_control_system();'
  if (@($observed).Count -ne 1 -or $observed -cne "$systemId $dbOid") { throw '배포 대상 DB가 다릅니다.' }
}
function Get-CurrentRevision {
  $revisions = foreach ($service in @('server', 'engine')) {
    $name = "$project-$service-1"
    $state = & $docker inspect --type container --format '{{.State.Running}} {{.Image}} {{index .Config.Labels "com.docker.compose.project"}}' $name
    if ($LASTEXITCODE -ne 0 -or $state -cnotmatch "^true (sha256:[a-f0-9]{64}) $([regex]::Escape($project))$") {
      throw '운영 서비스가 정상 기동 중인지 확인하세요.'
    }
    $value = & $docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' $Matches[1]
    if ($LASTEXITCODE -ne 0) { throw '운영 이미지의 버전을 확인하지 못했습니다.' }
    Require-Value $value $revisionPattern
  }
  if ($revisions.Count -ne 2 -or $revisions[0] -cne $revisions[1]) { throw '운영 서비스의 버전이 서로 다릅니다.' }
  return $revisions[0]
}
function Assert-Candidate($Entry) {
  Assert-Hash $Entry.manifest $Entry.manifestSha256
  Assert-Hash $Entry.receipt $Entry.receiptSha256
  $manifest = Get-Content -Raw -LiteralPath $Entry.manifest | ConvertFrom-Json -AsHashtable
  $receipt = Get-Content -Raw -LiteralPath $Entry.receipt | ConvertFrom-Json -AsHashtable
  if ($manifest.sourceRevision -cne $Entry.revision -or
      $receipt.outcome -cne 'artifact-preflight-passed' -or
      $receipt.sourceRevision -cne $Entry.revision -or
      $receipt.manifestSha256 -cne $Entry.manifestSha256) {
    throw '사전 검사 영수증이 승인된 산출물과 다릅니다.'
  }
}
function Publish-Control([string]$Current) {
  $allowed = foreach ($entry in $registry.Values) {
    if ($entry.fromRevision -cne $Current) { continue }
    Assert-Candidate $entry
    @{
      operation = $entry.operation
      revision = $entry.revision
      manifestSha256 = $entry.manifestSha256
    }
  }
  $json = ConvertTo-Json -InputObject @($allowed | Where-Object { $_ }) -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  Invoke-Sql @"
INSERT INTO "ReleaseControl" (id,"currentRevision",candidates,"seenAt")
VALUES ('production','$Current',convert_from(decode('$encoded','base64'),'UTF8')::jsonb,clock_timestamp() AT TIME ZONE 'UTC')
ON CONFLICT (id) DO UPDATE SET "currentRevision"=EXCLUDED."currentRevision",candidates=EXCLUDED.candidates,"seenAt"=EXCLUDED."seenAt";
"@ | Out-Null
}
function Update-Result([string]$Id, [string]$Status, [string]$From, [string]$Outcome) {
  [void](Require-Value $Id $idPattern)
  [void](Require-Value $Status '^(FAILED|NEEDS_OWNER|SUCCEEDED)$')
  [void](Require-Value $From '^(QUEUED|RUNNING|NEEDS_OWNER)$')
  [void](Require-Value $Outcome '^[a-z-]+$')
  Invoke-Sql @"
WITH updated AS (
  UPDATE "ReleaseRequest"
  SET status='$Status',"finishedAt"=clock_timestamp() AT TIME ZONE 'UTC'
  WHERE id='$Id' AND status='$From'
  RETURNING *
)
INSERT INTO "AuditLog" ("actorKind","actorUserId",action,"targetType","targetId",payload)
SELECT 'CLI',"actorUserId",'release.result','Release',id,jsonb_build_object('status',status,'outcome','$Outcome','revision',"targetRevision")
FROM updated;
"@ | Out-Null
}
function Run-Request {
  Assert-Database
  $current = Get-CurrentRevision
  Publish-Control $current
  $queued = Invoke-Sql 'SELECT row_to_json(r) FROM "ReleaseRequest" r WHERE status=''QUEUED'' ORDER BY "requestedAt",id LIMIT 1;'
  if (!$queued) { return }
  $request = $queued | ConvertFrom-Json -AsHashtable
  $id = Require-Value $request.id $idPattern
  $from = Require-Value $request.expectedRevision $revisionPattern
  $target = Require-Value $request.targetRevision $revisionPattern
  $operation = Require-Value $request.operation '^(DEPLOY|ROLLBACK)$'
  $entry = $registry["${from}:${operation}:$target"]
  if ($current -cne $from -or !$entry -or $entry.manifestSha256 -cne $request.manifestSha256) {
    Update-Result $id FAILED QUEUED 'approval-changed'
    return
  }
  Assert-Candidate $entry
  $driver = $driverPaths[$operation]
  Assert-Hash $driver.path $driver.sha256
  $claimed = Invoke-Sql @"
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('release:control', 0));
WITH updated AS (
  UPDATE "ReleaseRequest" r
  SET status='RUNNING',"startedAt"=clock_timestamp() AT TIME ZONE 'UTC'
  WHERE r.id='$id' AND r.status='QUEUED'
    AND r."requestedAt" >= (clock_timestamp() AT TIME ZONE 'UTC') - interval '2 minutes'
    AND NOT EXISTS (SELECT 1 FROM "ReleaseRequest" WHERE status IN ('RUNNING','NEEDS_OWNER'))
    AND EXISTS (SELECT 1 FROM "User" u WHERE u.id=r."actorUserId" AND u.role='ADMIN' AND u.status='ACTIVE')
    AND NOT EXISTS (
      SELECT 1 FROM "Sanction" s WHERE s."userId"=r."actorUserId" AND s."worldId" IS NULL
      AND s."liftedAt" IS NULL AND (s."expiresAt" IS NULL OR s."expiresAt" > (clock_timestamp() AT TIME ZONE 'UTC'))
    )
  RETURNING *
), recorded AS (
  INSERT INTO "AuditLog" ("actorKind","actorUserId",action,"targetType","targetId",payload)
  SELECT 'CLI',"actorUserId",'release.start','Release',id,jsonb_build_object('operation',operation,'revision',"targetRevision")
  FROM updated RETURNING "targetId"
)
SELECT "targetId" FROM recorded;
COMMIT;
"@
  if ($claimed -cne $id) {
    Update-Result $id FAILED QUEUED 'authorization-or-queue-changed'
    return
  }
  try {
    if ((Get-CurrentRevision) -cne $from) { throw '운영판이 바뀌었습니다.' }
    $log = Join-Path $runDirectory.FullName "$id.log"
    if (Test-Path -LiteralPath $log) { throw '같은 실행 기록 파일이 이미 있습니다.' }
    $pwsh = (Get-Process -Id $PID).Path
    & $pwsh -NoProfile -NonInteractive -File $driver.path -Operation $operation -ExpectedRevision $from -Revision $target -ManifestPath $entry.manifest -PreflightReceiptPath $entry.receipt -RequestId $id *> $log
    if ($LASTEXITCODE -ne 0 -or (Get-CurrentRevision) -cne $target) { throw '실행 후 운영판을 확인하세요.' }
    Assert-Database
    Update-Result $id SUCCEEDED RUNNING 'revision-verified'
    Publish-Control $target
  } catch {
    Assert-Database
    Update-Result $id NEEDS_OWNER RUNNING 'host-review-required'
    throw '배포가 끝났는지 확인하지 못했습니다. 호스트에서 실행 기록과 서비스 상태를 확인하세요.'
  }
}
function Resolve-Result([string]$Id) {
  Assert-Database
  $current = Get-CurrentRevision
  $selected = Invoke-Sql @"
SELECT row_to_json(r) FROM "ReleaseRequest" r WHERE id='$Id' AND status IN ('RUNNING','NEEDS_OWNER');
"@
  if (!$selected) { throw '점검할 배포 요청이 없습니다.' }
  $request = $selected | ConvertFrom-Json -AsHashtable
  if ($current -ceq $request.targetRevision) {
    Update-Result $Id SUCCEEDED $request.status 'host-reconciled-target'
  } elseif ($current -ceq $request.expectedRevision) {
    Update-Result $Id FAILED $request.status 'host-reconciled-previous'
  } else {
    throw '현재 운영판이 요청의 이전 버전과 대상 버전 모두와 다릅니다.'
  }
  Publish-Control $current
}

if ($Watch -and $ResolveRequest) { throw '배포 호스트 실행 모드를 하나만 선택하세요.' }
$lockPath = Join-Path $runDirectory.FullName "$project.release.lock"
$lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  if ($ResolveRequest) { Resolve-Result $ResolveRequest; return }
  do {
    try {
      Run-Request
    } catch {
      if (!$Watch) { throw }
      Write-Warning '배포 호스트 점검이 필요합니다.'
    }
    if ($Watch) { Start-Sleep -Seconds 5 }
  } while ($Watch)
} finally {
  $lock.Dispose()
}

