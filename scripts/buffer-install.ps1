# Run locally on Windows PowerShell 5.1+. No social posts are created.
param(
  [Parameter(Mandatory=$true)][string]$BufferOrg,
  [Parameter(Mandatory=$true)][string]$PostizOrg,
  [Parameter(Mandatory=$true)][string]$XChannel,
  [Parameter(Mandatory=$true)][string]$LinkedInChannel,
  [Parameter(Mandatory=$true)][string]$TikTokChannel,
  [Parameter(Mandatory=$true)][string]$MediaOrigin,
  [Parameter(Mandatory=$true)][string]$OriginalImage,
  [string]$Image = 'bulwark-postiz:buffer-2.26.0'
)
$ErrorActionPreference = 'Stop'
$stack = '/home/bulwark/bulwark-server/apps/postiz'
$nl = [string][char]10
$stamp = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6)
$backup = Join-Path $env:USERPROFILE "postiz-pre-buffer-$stamp"
$temp = Join-Path $backup 'candidate'
$remote = "buffer-$stamp"
$changed = $false
$secure = $null
$key = $null
$headers = $null
function D {
  & docker @args
  if ($LASTEXITCODE -ne 0) { throw 'Docker command failed. Review the preceding output.' }
}
function DPrivate {
  $old = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $result = & docker @args 2>&1
    if ($LASTEXITCODE -ne 0) { throw 'Private Docker validation failed.' }
    return ($result | ForEach-Object { [string]$_ }) -join $nl
  } finally { $ErrorActionPreference = $old }
}
function WriteUtf8([string]$path,[string]$value) {
  [IO.File]::WriteAllText($path,$value,[Text.UTF8Encoding]::new($false))
}
function ReplaceOne([string]$source,[string]$pattern,[string]$replacement) {
  $found = [regex]::Matches($source,$pattern)
  if ($found.Count -ne 1) { throw 'Unexpected Compose layout. Refusing to overwrite it.' }
  $m = $found[0]
  return $source.Substring(0,$m.Index) + $replacement + $source.Substring($m.Index+$m.Length)
}
function EditService([string]$yaml,[string]$name,[scriptblock]$edit) {
  $pattern = '(?ms)^  ' + [regex]::Escape($name) + ':[ \t]*\n.*?(?=^  [A-Za-z0-9_.-]+:[ \t]*(?:#[^\n]*)?\n|^[^\s#]|\z)'
  $m = [regex]::Match($yaml,$pattern)
  if (!$m.Success) { throw "Cannot find service $name in current Compose file." }
  $updated = & $edit $m.Value
  return $yaml.Substring(0,$m.Index) + $updated + $yaml.Substring($m.Index+$m.Length)
}
function SetImage([string]$block,[string]$tag) {
  $block = ReplaceOne $block '(?m)^    image:[^\n]*$' "    image: $tag"
  if ($block -match '(?m)^    pull_policy:') {
    $block = ReplaceOne $block '(?m)^    pull_policy:[^\n]*$' '    pull_policy: never'
  } else {
    $m = [regex]::Match($block,'(?m)^    image:[^\n]*$')
    $block = $block.Insert($m.Index+$m.Length,$nl+'    pull_policy: never')
  }
  return $block
}
function Gql([string]$query,[hashtable]$variables) {
  try {
    $payload = @{query=$query;variables=$variables} | ConvertTo-Json -Depth 12 -Compress
    $r = Invoke-RestMethod -Uri 'https://api.buffer.com' -Method Post -Headers $headers -ContentType 'application/json' -Body $payload -TimeoutSec 30
    if ($r.errors -or !$r.data) { throw 'GraphQL error' }
    return $r.data
  } catch { throw 'Buffer read-only preflight failed. Verify the API key and channel permissions.' }
}
function ComposeLive {
  D exec -w $stack dockge docker compose -p postiz --env-file .env -f docker-compose.yaml @args
}
try {
  Write-Host '[1/6] Checking running installation and image'
  $running = (D inspect postiz --format '{{.Image}}').Trim()
  if ($running -ne $OriginalImage) { throw 'Running image does not match the expected original. No changes made.' }
  if ((D inspect postiz --format '{{.State.Health.Status}}').Trim() -ne 'healthy') { throw 'Existing Postiz is not healthy.' }
  $labels = (D inspect postiz --format '{{json .Config.Labels}}') | ConvertFrom-Json
  $project = $labels.'com.docker.compose.project'
  if ($project -ne 'postiz') { throw 'Unexpected Compose project.' }
  D image inspect $Image --format '{{.Id}}'
  $rollbackTag = 'bulwark-postiz:pre-buffer-' + $OriginalImage.Replace('sha256:','').Substring(0,12)
  D image tag $OriginalImage $rollbackTag
  D run --rm --network none --entrypoint node $Image --test /app/scripts/buffer-integration.test.cjs | Out-Null
  $aof = (D exec postiz-redis redis-cli INFO persistence) -join $nl
  if ($aof -notmatch '(?m)^aof_enabled:1\s*$' -or $aof -notmatch '(?m)^aof_last_write_status:ok\s*$' -or
      $aof -notmatch '(?m)^aof_last_bgrewrite_status:ok\s*$' -or $aof -notmatch '(?m)^aof_rewrite_in_progress:0\s*$') {
    throw 'Redis AOF is not ready. No deployment attempted.'
  }

  Write-Host '[2/6] Verify the existing Buffer key (input is hidden)'
  $secure = Read-Host 'Buffer API key' -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr).Trim() }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
  if ($key -notmatch '^[A-Za-z0-9._~+/=-]+$') { throw 'Unexpected API key format. No configuration changed.' }
  $headers = @{ Authorization = 'Bearer ' + $key }
  $account = Gql 'query { account { organizations { id name } } }' @{}
  if (@($account.account.organizations | Where-Object { $_.id -eq $BufferOrg }).Count -ne 1) {
    throw 'The key cannot access the expected Buffer organization.'
  }
  foreach ($item in @(
    @{ id=$XChannel; service='twitter'; label='X' },
    @{ id=$LinkedInChannel; service='linkedin'; label='LinkedIn Page' },
    @{ id=$TikTokChannel; service='tiktok'; label='TikTok' }
  )) {
    $result = Gql 'query Channel($input: ChannelInput!) { channel(input: $input) { id organizationId name displayName service type isDisconnected isLocked isQueuePaused } }' @{input=@{id=$item.id}}
    $c = $result.channel
    if (!$c -or $c.id -ne $item.id -or $c.organizationId -ne $BufferOrg -or $c.service -ne $item.service -or
        ($item.service -eq 'linkedin' -and $c.type -ne 'page') -or $c.isDisconnected -or $c.isLocked -or $c.isQueuePaused) {
      throw ('Unexpected or unavailable Buffer channel: ' + $item.label)
    }
    Write-Host ('  Verified ' + $item.label)
  }

  Write-Host '[3/6] Creating a complete local backup'
  New-Item -ItemType Directory -Path $backup -Force | Out-Null
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl $backup
  $acl.SetAccessRuleProtection($true,$false)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
  Set-Acl -Path $backup -AclObject $acl
  New-Item -ItemType Directory -Path $temp -Force | Out-Null
  $oldYamlPath = Join-Path $backup 'docker-compose.yaml'
  $oldEnvPath = Join-Path $backup '.env'
  D cp "dockge:$stack/docker-compose.yaml" $oldYamlPath
  D cp "dockge:$stack/.env" $oldEnvPath
  $dump = "/tmp/postiz-$stamp.dump"
  $rdb = "/tmp/postiz-$stamp.rdb"
  D exec postiz-postgres pg_dump -U postiz-user -d postiz-db-local -Fc -f $dump
  D exec postiz-postgres pg_restore -l $dump | Out-Null
  D cp "postiz-postgres:$dump" (Join-Path $backup 'postiz.dump')
  D exec postiz-redis redis-cli --rdb $rdb
  D cp "postiz-redis:$rdb" (Join-Path $backup 'postiz.rdb')
  D exec postiz-redis redis-check-rdb $rdb | Out-Null
  foreach ($name in @('docker-compose.yaml','.env','postiz.dump','postiz.rdb')) {
    if ((Get-Item (Join-Path $backup $name)).Length -le 0) { throw "Missing or empty backup: $name" }
  }
  D exec postiz-postgres rm -f $dump
  D exec postiz-redis rm -f $rdb
  Write-Host "  Backup verified: $backup"

  Write-Host '[4/6] Preparing and validating Dockge configuration'
  $oldYaml = [IO.File]::ReadAllText($oldYamlPath).Replace([string][char]13,'')
  $oldEnv = [IO.File]::ReadAllText($oldEnvPath)
  $redisYaml = EditService $oldYaml 'postiz-redis' {
    param($block)
    if ($block -match '(?m)^    command:') { throw 'Redis has a custom command; refusing to overwrite it.' }
    $m = [regex]::Match($block,'(?m)^    image:[^\n]*$')
    if (!$m.Success) { throw 'Redis image line missing.' }
    $block.Insert($m.Index+$m.Length, $nl+"    command: [redis-server, --appendonly, 'yes', --appendfsync, everysec, --maxmemory-policy, noeviction]")
  }
  $envLines = @'
      BUFFER_API_KEY: "${BUFFER_API_KEY:?Missing Buffer API key}"
      BUFFER_ORGANIZATION_ID: "${BUFFER_ORGANIZATION_ID:?Missing Buffer organization ID}"
      BUFFER_POSTIZ_ORGANIZATION_ID: "${BUFFER_POSTIZ_ORGANIZATION_ID:?Missing Postiz workspace ID}"
      BUFFER_X_CHANNEL_ID: "${BUFFER_X_CHANNEL_ID:?Missing X channel ID}"
      BUFFER_LINKEDIN_CHANNEL_ID: "${BUFFER_LINKEDIN_CHANNEL_ID:?Missing LinkedIn channel ID}"
      BUFFER_TIKTOK_CHANNEL_ID: "${BUFFER_TIKTOK_CHANNEL_ID:?Missing TikTok channel ID}"
      BUFFER_MEDIA_ORIGIN: "${BUFFER_MEDIA_ORIGIN:?Missing Buffer media origin}"
'@
  $envLines = $envLines.Replace([string][char]13,'').TrimEnd()
  $candidateYaml = EditService $redisYaml 'postiz' {
    param($block)
    if ($block -match '(?m)^      BUFFER_[A-Z_]+:') { throw 'Buffer configuration already exists.' }
    $block = SetImage $block $Image
    ReplaceOne $block '(?m)^    environment:[ \t]*$' ('    environment:' + $nl + $envLines)
  }
  if ($oldEnv -match '(?m)^\s*BUFFER_[A-Z_]+\s*=') { throw 'Existing Buffer .env entries found; refusing to overwrite them.' }
  $candidateEnv = $oldEnv.TrimEnd() + $nl + (@(
    "BUFFER_API_KEY='$key'",
    "BUFFER_ORGANIZATION_ID=$BufferOrg",
    "BUFFER_POSTIZ_ORGANIZATION_ID=$PostizOrg",
    "BUFFER_X_CHANNEL_ID=$XChannel",
    "BUFFER_LINKEDIN_CHANNEL_ID=$LinkedInChannel",
    "BUFFER_TIKTOK_CHANNEL_ID=$TikTokChannel",
    "BUFFER_MEDIA_ORIGIN=$MediaOrigin"
  ) -join $nl) + $nl
  $rollbackYaml = EditService $redisYaml 'postiz' { param($b) SetImage $b $rollbackTag }
  WriteUtf8 (Join-Path $backup 'rollback-compose.yaml') $rollbackYaml
  WriteUtf8 (Join-Path $temp 'docker-compose.yaml') $candidateYaml
  WriteUtf8 (Join-Path $temp '.env') $candidateEnv
  $remoteYaml = "$stack/$remote.yaml"
  $remoteEnv = "$stack/$remote.env"
  D cp (Join-Path $temp 'docker-compose.yaml') "dockge:$remoteYaml" | Out-Null
  D cp (Join-Path $temp '.env') "dockge:$remoteEnv" | Out-Null
  D exec dockge chmod 600 $remoteYaml $remoteEnv
  $raw = DPrivate exec -w $stack dockge docker compose -p postiz --env-file "$remote.env" -f "$remote.yaml" config --format json
  try { $cfg = $raw | ConvertFrom-Json }
  catch { throw 'Unable to parse private Compose validation output.' }
  if ($cfg.services.postiz.image -ne $Image -or
      $cfg.services.postiz.environment.BUFFER_API_KEY -ne $key -or
      $cfg.services.postiz.environment.BUFFER_ORGANIZATION_ID -ne $BufferOrg -or
      $cfg.services.postiz.environment.BUFFER_POSTIZ_ORGANIZATION_ID -ne $PostizOrg -or
      $cfg.services.postiz.environment.BUFFER_X_CHANNEL_ID -ne $XChannel -or
      $cfg.services.postiz.environment.BUFFER_LINKEDIN_CHANNEL_ID -ne $LinkedInChannel -or
      $cfg.services.postiz.environment.BUFFER_TIKTOK_CHANNEL_ID -ne $TikTokChannel -or
      $cfg.services.postiz.environment.BUFFER_MEDIA_ORIGIN -ne $MediaOrigin) {
    throw 'Candidate configuration did not resolve to the intended values.'
  }
  $raw = $null; $cfg = $null
  Write-Host '  Compose validation passed. Redis AOF will persist on future recreation.'
  Write-Host '[5/6] Ready to replace only the Postiz application container.'
  Write-Host '  Database, Redis, Temporal, ports, R2 and direct connections are retained.'
  Write-Host '  This causes a brief Postiz outage. No social posts will be created.'
  Write-Host '  Separate-stack staging has not been performed; this is a controlled production switch with rollback.'
  if ((Read-Host 'Type DEPLOY to proceed, or press Enter to cancel') -cne 'DEPLOY') {
    Write-Host 'Cancelled. Existing Postiz remains unchanged.'
    return
  }
  $changed = $true
  D exec dockge mv -f $remoteEnv "$stack/.env"
  D exec dockge mv -f $remoteYaml "$stack/docker-compose.yaml"
  ComposeLive up -d --no-deps --pull never --force-recreate --wait --wait-timeout 300 postiz
  $expected = (D image inspect $Image --format '{{.Id}}').Trim()
  $actual = (D inspect postiz --format '{{.Image}}').Trim()
  if ($actual -ne $expected -or (D inspect postiz --format '{{.State.Health.Status}}').Trim() -ne 'healthy') {
    throw 'New Postiz failed image or health checks.'
  }
  $changed = $false
  Write-Host '[6/6] CUSTOM POSTIZ HEALTHY'
  Write-Host "  Backup: $backup"
  Write-Host "  Rollback image: $rollbackTag"
  Write-Host '  Next: add the three via Buffer channels in Postiz and verify approved test posts.'
  Write-Host '  Live publishing is not yet verified.'
} catch {
  Write-Host ('SETUP STOPPED: ' + $_.Exception.Message)
  if ($changed) {
    Write-Host 'Attempting application rollback. Redis AOF remains enabled.'
    try {
      D cp (Join-Path $backup 'rollback-compose.yaml') "dockge:$stack/docker-compose.yaml"
      D cp (Join-Path $backup '.env') "dockge:$stack/.env"
      D exec dockge chmod 600 "$stack/.env" "$stack/docker-compose.yaml"
      ComposeLive up -d --no-deps --pull never --force-recreate --wait --wait-timeout 300 postiz
      Write-Host "Original application restored. Backup: $backup"
    } catch { Write-Host "ROLLBACK REQUIRES ATTENTION. Backup: $backup" }
  }
  exit 1
} finally {
  if (Test-Path $temp) { Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue }
  try { & docker exec dockge rm -f "$stack/$remote.yaml" "$stack/$remote.env" 2>$null | Out-Null } catch {}
  if ($secure) { $secure.Dispose() }
  $key = $null; $headers = $null
}
