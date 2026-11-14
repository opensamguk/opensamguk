<#
  도커 데몬이 올라올 때 compose의 depends_on은 적용되지 않는다. network_mode를 공유하는
  caddy·cloudflared가 server보다 먼저 복원되면 사라진 네트워크 네임스페이스에 묶여
  "network is unreachable"로 공개 접속이 끊긴다. 컨테이너는 Up 상태를 유지하므로
  재시작 정책도 이를 되돌리지 못한다. 이 스크립트는 그 상태를 찾아 공유 측만 다시 붙인다.
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [ValidateRange(0, 3600)][int]$WaitSeconds = 300,
  [ValidateRange(0, 600)][int]$StableSeconds = 30
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

$configPath = Existing-Path $env:OPENSAMGUK_RELEASE_COMPOSE_CONFIG
$options = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json -AsHashtable
$docker = Existing-Path $options.dockerExecutable
$project = $options.project
if ($project -cnotmatch '^[a-z0-9][a-z0-9_-]{0,50}$') { throw '배포 실행 설정을 확인하세요.' }

# 네임스페이스 주인과, 그것을 빌려 쓰는 서비스들.
$owner = 'server'
$sharers = @('caddy', 'cloudflared')

function Find-Container([string]$Service) {
  $id = & $docker ps --quiet --no-trunc `
    --filter "label=com.docker.compose.project=$project" `
    --filter "label=com.docker.compose.service=$Service"
  Assert-Exit "$Service 컨테이너 조회"
  $ids = @($id | Where-Object { $_ })
  if ($ids.Count -ne 1) { throw "$Service 컨테이너가 하나가 아닙니다." }
  return $ids[0]
}
function Get-State([string]$Id) {
  $raw = & $docker inspect $Id --format '{{.HostConfig.NetworkMode}}|{{.State.StartedAt}}|{{.State.Running}}'
  Assert-Exit '컨테이너 상태 조회'
  $parts = "$raw".Trim() -split '\|', 3
  if ($parts.Count -ne 3) { throw '컨테이너 상태를 읽지 못했습니다.' }
  return @{ NetworkMode = $parts[0]; StartedAt = [datetimeoffset]::Parse($parts[1]); Running = $parts[2] -ceq 'true' }
}

# 데몬이 아직 준비되지 않았을 수 있다. 부팅 직후 실행되는 경로이므로 기다린다.
$deadline = [datetime]::UtcNow.AddSeconds($WaitSeconds)
while ($true) {
  & $docker info --format '{{.ServerVersion}}' > $null 2>&1
  if ($LASTEXITCODE -eq 0) { break }
  if ([datetime]::UtcNow -ge $deadline) { throw 'Docker 데몬이 준비되지 않았습니다.' }
  Start-Sleep -Seconds 5
}

function Get-Orphans {
  $ownerId = Find-Container $owner
  $ownerState = Get-State $ownerId
  if (!$ownerState.Running) { throw "$owner 컨테이너가 실행 중이 아닙니다." }
  $found = @()
  foreach ($service in $sharers) {
    $id = Find-Container $service
    $state = Get-State $id
    # 공유 대상이 지금의 주인이 아니거나, 주인보다 먼저 떠 있으면 네임스페이스가 끊긴 것이다.
    $expected = "container:$ownerId"
    if ($state.NetworkMode -cne $expected -or $state.StartedAt -le $ownerState.StartedAt) {
      $found += [pscustomobject]@{ Service = $service; Id = $id; NetworkMode = $state.NetworkMode; StartedAt = $state.StartedAt }
    }
  }
  return ,$found
}

# 부팅 직후에는 컨테이너가 아직 복원되지 않았을 수 있다. 기다렸다가 판단한다.
function Wait-Orphans {
  while ($true) {
    try { return Get-Orphans } catch {
      if ([datetime]::UtcNow -ge $deadline) { throw }
      Start-Sleep -Seconds 5
    }
  }
}

$orphans = Wait-Orphans
if ($orphans.Count -eq 0) {
  Write-Output '공개 연결의 네트워크 네임스페이스가 정상입니다.'
  exit 0
}
foreach ($orphan in $orphans) {
  Write-Output "끊긴 네임스페이스: $($orphan.Service) (시작 $($orphan.StartedAt.ToString('o')))"
}
if ($CheckOnly) { exit 1 }

# 배포 드라이버는 server를 재생성한 뒤 공유 서비스를 다시 만든다. 그 사이에 끼어들지
# 않도록, 같은 상태가 유지될 때만 고친다.
if ($StableSeconds -gt 0) {
  Start-Sleep -Seconds $StableSeconds
  $again = Wait-Orphans
  $still = @($again | Where-Object { $orphans.Service -ccontains $_.Service -and $orphans.Id -ccontains $_.Id })
  if ($still.Count -eq 0) {
    Write-Output '다시 확인하니 정상입니다. 배포 중일 수 있어 고치지 않습니다.'
    exit 0
  }
  $orphans = $still
}

# 주인에 다시 붙이려면 빌려 쓰는 쪽을 다시 시작해야 한다. 순서는 배포 드라이버와 같다.
foreach ($service in $sharers) {
  $id = Find-Container $service
  & $docker restart $id > $null
  Assert-Exit "$service 재시작"
}
$remaining = Get-Orphans
if ($remaining.Count -ne 0) { throw '재시작 뒤에도 네임스페이스가 끊겨 있습니다.' }
Write-Output '공개 연결을 네트워크 네임스페이스에 다시 붙였습니다.'
exit 0
