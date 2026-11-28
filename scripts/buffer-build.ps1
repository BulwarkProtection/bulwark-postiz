# Build the custom image locally. No production containers are changed.
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
function Check-Native([string]$message) {
  if ($LASTEXITCODE -ne 0) { throw $message }
}
$commit = (git rev-parse HEAD).Trim()
Check-Native 'Unable to identify the source commit.'
$short = $commit.Substring(0,12)
$image = "bulwark-postiz:buffer-2.26.0-$short"

$dirty = git status --porcelain
Check-Native 'Unable to check the source tree.'
if ($dirty) { throw 'Build from a clean checkout, without local configuration or credentials.' }

$current = docker inspect postiz --format '{{.Image}}'
Check-Native 'The existing postiz container could not be identified.'
$rollback = docker image inspect bulwark-postiz:pre-buffer --format '{{.Id}}' 2>$null
if ($LASTEXITCODE -ne 0) {
  docker image tag $current bulwark-postiz:pre-buffer
  Check-Native 'Could not preserve the existing image.'
} elseif ($rollback.Trim() -ne $current.Trim()) {
  throw 'The rollback tag already refers to a different image. Do not overwrite it automatically.'
}
Write-Host "Building $image from $commit"
docker build --file Dockerfile.dev --build-arg "NEXT_PUBLIC_VERSION=v2.26.0-bulwark-buffer-$short" --label "org.opencontainers.image.revision=$commit" --tag $image .
Check-Native 'Docker build failed. Your live Postiz installation was not changed.'

Write-Host 'Running the Buffer test suite in an isolated container...'
docker run --rm --network none --entrypoint node $image --test /app/scripts/buffer-integration.test.cjs
Check-Native 'The custom image failed its Buffer tests. Do not deploy it.'

Write-Host ""
Write-Host "Verified local build: $image"
Write-Host "Rollback image: bulwark-postiz:pre-buffer"
Write-Host "Your live container is unchanged. Follow docs/bulwark-buffer.md for local configuration and staged testing."
