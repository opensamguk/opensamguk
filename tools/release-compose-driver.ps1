[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('DEPLOY', 'ROLLBACK')][string]$Operation,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$Revision,
  [Parameter(Mandatory)][string]$ManifestPath,
  [Parameter(Mandatory)][string]$PreflightReceiptPath,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-f-]{36}$')][string]$RequestId
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step 실패" }
}
function Existing-Path([string]$Path, [bool]$Directory = $false) {
  if (![IO.Path]::IsPathFullyQualified($Path)) { throw '운영 경로는 절대 경로로 지정하세요.' }
  $item = Get-Item -LiteralPath $Path
  if ($item.LinkType -or $item.PSIsContainer -ne $Directory) { throw '운영 경로가 다릅니다.' }
  return $item.FullName
}
function Fingerprint([string]$Path) {
  return (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
}

$configPath = Existing-Path $env:OPENSAMGUK_RELEASE_COMPOSE_CONFIG
$options = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json -AsHashtable
$docker = Existing-Path $options.dockerExecutable
$bash = Existing-Path $options.bashExecutable
$backupScript = Existing-Path $options.backupScript
$backupDirectory = Existing-Path $options.backupDirectory $true
$runtimeDirectory = Existing-Path $options.runtimeDirectory $true
$project = $options.project
$dbContainer = $options.databaseContainer
$dbName = $options.database
$dbUser = $options.dbUser
$dbSystem = $options.databaseSystemId
$dbOid = $options.databaseOid
$publicOrigin = [uri]$options.publicOrigin
if (
  $Revision -ceq $ExpectedRevision -or
  $project -cnotmatch '^[a-z0-9][a-z0-9_-]{0,50}$' -or
  $dbContainer -cnotmatch '^[0-9a-f]{64}$' -or
  $dbName -cnotmatch '^[a-zA-Z_][a-zA-Z_0-9]{0,62}$' -or
  $dbUser -cnotmatch '^[a-zA-Z_][a-zA-Z_0-9]{0,62}$' -or
  $dbSystem -cnotmatch '^[0-9]{1,20}$' -or
  $dbOid -cnotmatch '^[0-9]{1,10}$' -or
  $publicOrigin.Scheme -cne 'https' -or $publicOrigin.GetLeftPart('Authority') -cne $options.publicOrigin -or
  $publicOrigin.UserInfo -or (Fingerprint $backupScript) -cne $options.backupScriptSha256
) { throw '배포 실행 설정을 확인하세요.' }

$manifestFile = Existing-Path $ManifestPath
$receiptFile = Existing-Path $PreflightReceiptPath
$manifest = Get-Content -Raw -LiteralPath $manifestFile | ConvertFrom-Json -AsHashtable
$receipt = Get-Content -Raw -LiteralPath $receiptFile | ConvertFrom-Json -AsHashtable
if (
  $manifest.sourceRevision -cne $Revision -or $receipt.sourceRevision -cne $Revision -or
  $receipt.outcome -cne 'artifact-preflight-passed' -or $receipt.manifestSha256 -cne (Fingerprint $manifestFile) -or
  $manifest.web.directory -cne 'payload/web'
) { throw '배포판과 사전 검사 영수증이 다릅니다.' }
$release = Split-Path -Parent $manifestFile
$contexts = @(Get-ChildItem -LiteralPath $release -Directory -Force -Filter '.partial-*')
if ($contexts.Count -ne 1 -or $contexts[0].LinkType) { throw '배포판의 검증된 소스 디렉터리가 하나여야 합니다.' }
$newCompose = Existing-Path (Join-Path $contexts[0].FullName 'context/deploy/compose.tunnel.yml')
$web = Existing-Path (Join-Path $release 'payload/web') $true
$entry = @($manifest.web.files | Where-Object path -CEQ 'index.html')
if ($entry.Count -ne 1 -or (Fingerprint (Existing-Path (Join-Path $web 'index.html'))) -cne $entry[0].sha256) {
  throw '공개 화면 파일의 해시가 다릅니다.'
}

function Inspect-Container([string]$Name, [string]$Format) {
  $result = & $docker inspect --type container --format $Format "$project-$Name-1"
  Assert-Exit '운영 컨테이너 확인'
  return $result
}
function Inspect-Image([string]$Image) {
  if ($Image -cnotmatch '^sha256:[0-9a-f]{64}$') { throw '확정 이미지 ID가 필요합니다.' }
  $result = & $docker image inspect --format '{{.Id}} {{index .Config.Labels "org.opencontainers.image.revision"}}' $Image
  Assert-Exit '운영 이미지 확인'
  return $result
}
function Assert-LiveRevision([string]$Sha) {
  foreach ($service in @('server', 'engine')) {
    $image = Inspect-Container $service '{{.Image}}'
    if ((Inspect-Image $image) -cne "$image $Sha") { throw '실행 중인 배포판이 달라졌습니다.' }
  }
}
function Invoke-Sql([string]$Sql) {
  $rows = @($Sql | & $docker exec -i $dbContainer psql -X -qAt -v ON_ERROR_STOP=1 -U $dbUser -d $dbName)
  Assert-Exit '배포 대상 DB 확인'
  return $rows
}
function Assert-Database {
  $container = Inspect-Container 'postgres' '{{.Id}} {{.State.Running}} {{index .Config.Labels "com.docker.compose.project"}}'
  if ($container -cne "$dbContainer true $project") { throw '배포 대상 DB 컨테이너가 다릅니다.' }
  if ((Invoke-Sql 'SELECT system_identifier || '' '' || (SELECT oid FROM pg_database WHERE datname=current_database()) FROM pg_control_system();') -cne "$dbSystem $dbOid") {
    throw '배포 대상 DB가 다릅니다.'
  }
}
function Migration-Ledger($Manifest) {
  return $Manifest.migrations | ForEach-Object {
    if ($_.name -cnotmatch '^[0-9]{14}_[a-z0-9_]+$' -or $_.sha256 -cnotmatch '^[0-9a-f]{64}$') {
      throw '배포판의 migration 형식이 잘못되었습니다.'
    }
    "$($_.name) $($_.sha256)"
  }
}
function Confirm-Migrations([bool]$Exact) {
  if ((Invoke-Sql 'SELECT COUNT(*) FROM "_prisma_migrations" WHERE finished_at IS NULL AND rolled_back_at IS NULL;') -cne '0') {
    throw '종료되지 않은 migration이 있습니다.'
  }
  $applied = @(Invoke-Sql 'SELECT migration_name || '' '' || checksum FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name COLLATE "C";')
  $expected = @(Migration-Ledger $manifest)
  if ($expected.Count -eq 0) { throw '배포판에 migration 기록이 없습니다.' }
  if ($applied.Count -gt $expected.Count -or ($Exact -and $applied.Count -ne $expected.Count)) {
    throw '배포판에 없는 migration이 적용됐거나 적용할 migration이 남아 있습니다.'
  }
  for ($i = 0; $i -lt $applied.Count; $i++) {
    if ($applied[$i] -cne $expected[$i]) { throw '적용된 migration과 배포판의 이름 또는 해시가 다릅니다.' }
  }
  return ($expected.Count - $applied.Count)
}
function Assert-RollbackContract {
  # An approved pair binds both artifacts and the owner's application-data compatibility review.
  $pairs = @($options.rollbackPairs | Where-Object {
    $_.fromRevision -ceq $ExpectedRevision -and $_.revision -ceq $Revision
  })
  if ($pairs.Count -ne 1) { throw '현재 판과 이전 판의 데이터 호환 검토가 필요합니다.' }
  $pair = $pairs[0]
  $currentFile = Existing-Path $pair.currentManifest
  if ((Fingerprint $currentFile) -cne $pair.currentManifestSha256 -or
      (Fingerprint $manifestFile) -cne $pair.targetManifestSha256) {
    throw '데이터 호환을 검토한 배포판이 다릅니다.'
  }
  $current = Get-Content -Raw -LiteralPath $currentFile | ConvertFrom-Json -AsHashtable
  if ($current.sourceRevision -cne $ExpectedRevision -or
      $current.resourcesSql.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $current.resourcesSql.sha256 -cne $manifest.resourcesSql.sha256 -or
      ((Migration-Ledger $current) -join "`n") -cne ((Migration-Ledger $manifest) -join "`n")) {
    throw '복원과 전환을 검증한 되돌리기 절차가 필요합니다.'
  }
  foreach ($service in @('server', 'engine')) {
    $live = Inspect-Container $service '{{.Image}}'
    $approved = @($current.images | Where-Object target -CEQ $service)
    if ($approved.Count -ne 1 -or $approved[0].id -cne $live) {
      throw '현재 이미지가 데이터 호환을 검토한 이미지와 다릅니다.'
    }
  }
}

$lock = [IO.File]::Open((Join-Path $runtimeDirectory "$project.compose.release.lock"), 'OpenOrCreate', 'ReadWrite', 'None')
try {
  Assert-Database
  Assert-LiveRevision $ExpectedRevision
  $isRollback = $Operation -ceq 'ROLLBACK'
  if ($isRollback) { Assert-RollbackContract }
  [void](Confirm-Migrations $isRollback)
  $oldCompose = Existing-Path (Inspect-Container 'server' '{{index .Config.Labels "com.docker.compose.project.config_files"}}')
  $oldEnv = Existing-Path (Inspect-Container 'server' '{{index .Config.Labels "com.docker.compose.project.environment_file"}}')
  $values = @{ PUBLIC_WEB_DIRECTORY = $web.Replace('\', '/') }
  foreach ($service in @('server', 'engine', 'migrate')) {
    $image = @($manifest.images | Where-Object target -CEQ $service)
    if ($image.Count -ne 1 -or (Inspect-Image $image[0].id) -cne "$($image[0].id) $Revision") {
      throw '배포판의 실행 이미지가 없습니다.'
    }
    $values[$service.ToUpperInvariant() + '_IMAGE'] = $image[0].id
  }
  $newEnv = Join-Path $runtimeDirectory "production-$Revision-$RequestId.env"
  $newLines = foreach ($line in Get-Content -LiteralPath $oldEnv) {
    $name = ($line -split '=', 2)[0]
    if ($values.ContainsKey($name)) { "$name=$($values[$name])" } else { $line }
  }
  $seen = @{}
  foreach ($line in $newLines) {
    $name = ($line -split '=', 2)[0]
    if ($values.ContainsKey($name)) {
      if ($seen.ContainsKey($name)) { throw '배포 환경의 키가 중복됐습니다.' }
      $seen[$name] = $true
    }
  }
  if ($seen.Count -ne $values.Count) { throw '배포 환경의 필수 키가 빠졌습니다.' }
  $stream = [IO.File]::Open($newEnv, 'CreateNew', 'Write', 'None')
  try {
    $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
    try { foreach ($line in $newLines) { $writer.WriteLine($line) } } finally { $writer.Dispose() }
  } finally { $stream.Dispose() }
  $oldArgs = @('compose', '--project-name', $project, '--env-file', $oldEnv, '-f', $oldCompose)
  $newArgs = @('compose', '--project-name', $project, '--env-file', $newEnv, '-f', $newCompose)
  & $docker @oldArgs config --quiet
  Assert-Exit '현재 Compose 확인'
  & $docker @newArgs config --quiet
  Assert-Exit '새 Compose 확인'

  function Stop-Services($ArgsSet) {
    & $docker @ArgsSet stop cloudflared caddy
    Assert-Exit '공개 연결 정지'
    & $docker @ArgsSet stop server engine
    Assert-Exit '서버 및 엔진 정지'
  }
  function Start-Services($ArgsSet) {
    & $docker @ArgsSet up -d --wait --no-deps --force-recreate server engine
    Assert-Exit '서버 및 엔진 시작'
    & $docker @ArgsSet up -d --no-deps --force-recreate caddy cloudflared
    Assert-Exit '공개 연결 시작'
  }
  function Verify-Public {
    $output = Join-Path $runtimeDirectory "$RequestId-index.partial"
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      try {
        foreach ($path in @('/healthz', '/healthz/engine', '/login', '/trpc/world.publicMaps')) {
          $response = Invoke-WebRequest -Uri "$($options.publicOrigin)$path" -TimeoutSec 7 -Headers @{'Cache-Control' = 'no-cache'}
          if ($response.StatusCode -ne 200) { throw '공개 응답이 정상 상태가 아닙니다.' }
        }
        Invoke-WebRequest -Uri "$($options.publicOrigin)/lobby" -TimeoutSec 7 -OutFile $output -Headers @{'Cache-Control' = 'no-cache'}
        if ((Fingerprint $output) -cne $entry[0].sha256) { throw '공개 화면이 승인된 배포판과 다릅니다.' }
        return
      } catch {
        if ($attempt -eq 19) { throw '공개 응답을 확인하지 못했습니다.' }
        Start-Sleep -Seconds 3
      } finally {
        if (Test-Path -LiteralPath $output -PathType Leaf) { Remove-Item -LiteralPath $output }
      }
    }
  }
  $stopped = $false
  $possibleDbChange = $false
  try {
    $stopped = $true
    Stop-Services $oldArgs
    Assert-Database
    $pending = Confirm-Migrations $isRollback
    $dockerHost = & $docker context inspect --format '{{(index .Endpoints "docker").Host}}'
    Assert-Exit 'Docker 연결 확인'
    $priorHost = $env:DOCKER_HOST
    $priorConfig = $env:DOCKER_CONFIG
    try {
      $env:DOCKER_HOST = $dockerHost
      $env:DOCKER_CONFIG = Existing-Path $options.backupDockerConfig $true
      & $bash ($backupScript.Replace('\', '/')) --docker $docker --container $dbContainer --system-identifier $dbSystem --db-user $dbUser --admin-db postgres --source-db $dbName --backup-dir ($backupDirectory.Replace('\', '/')) --reason pre-deploy --release-sha $ExpectedRevision
      Assert-Exit '서비스 전환 전 백업'
    } finally {
      $env:DOCKER_HOST = $priorHost
      $env:DOCKER_CONFIG = $priorConfig
    }
    if ($pending -gt 0) {
      $possibleDbChange = $true
      & $docker @newArgs run --rm migrate
      Assert-Exit 'migration 적용'
    }
    Assert-Database
    [void](Confirm-Migrations $true)
    $possibleDbChange = $true
    Start-Services $newArgs
    Verify-Public
    Assert-LiveRevision $Revision
  } catch {
    if ($possibleDbChange) { Stop-Services $newArgs }
    elseif ($stopped) { Start-Services $oldArgs }
    throw
  }
} finally {
  $lock.Dispose()
}

