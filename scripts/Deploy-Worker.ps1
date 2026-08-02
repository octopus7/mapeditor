[CmdletBinding()]
param(
    [string]$SecretsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerConfig = Join-Path $repositoryRoot 'apps\api\wrangler.jsonc'
if ([string]::IsNullOrWhiteSpace($SecretsPath)) {
    $SecretsPath = Join-Path $repositoryRoot '.dev.vars'
}

. (Join-Path $PSScriptRoot 'Secret-Helpers.ps1')
$secretValues = Import-SecretValues -Path $SecretsPath
$googleClientId = Get-RequiredSecretValue -Values $secretValues -Name 'GOOGLE_CLIENT_ID'
$sessionSecret = Get-RequiredSecretValue -Values $secretValues -Name 'SESSION_SECRET'
if ([System.Text.Encoding]::UTF8.GetByteCount($sessionSecret) -lt 32) {
    throw 'SESSION_SECRET은 UTF-8 기준 32바이트 이상이어야 합니다.'
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporarySecrets = Join-Path $temporaryRoot ("mapeditor-worker-secrets-{0}.json" -f [Guid]::NewGuid())
$payload = @{
    GOOGLE_CLIENT_ID = $googleClientId
    SESSION_SECRET = $sessionSecret
} | ConvertTo-Json

Push-Location $repositoryRoot
try {
    npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw '정적 검사가 실패했습니다.' }

    npx.cmd wrangler types (Join-Path $repositoryRoot 'apps\api\worker-configuration.d.ts') --check --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Worker 바인딩 타입 검사가 실패했습니다.' }

    npx.cmd wrangler d1 migrations apply DB --local --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw '로컬 D1 마이그레이션이 실패했습니다.' }

    npx.cmd wrangler d1 migrations apply DB --remote --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw '원격 D1 마이그레이션이 실패했습니다.' }

    [System.IO.File]::WriteAllText(
        $temporarySecrets,
        $payload,
        [System.Text.UTF8Encoding]::new($false)
    )

    npx.cmd wrangler deploy --secrets-file $temporarySecrets --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Worker 배포가 실패했습니다.' }
}
finally {
    Pop-Location
    $resolvedTemporarySecrets = [System.IO.Path]::GetFullPath($temporarySecrets)
    if ($resolvedTemporarySecrets.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporarySecrets -Force -ErrorAction SilentlyContinue
    }
}
