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
$memeUploadToken = Get-RequiredSecretValue -Values $secretValues -Name 'MEME_UPLOAD_TOKEN'
if ([System.Text.Encoding]::UTF8.GetByteCount($sessionSecret) -lt 32) {
    throw 'SESSION_SECRET must be at least 32 bytes in UTF-8.'
}
if ([System.Text.Encoding]::UTF8.GetByteCount($memeUploadToken) -lt 32) {
    throw 'MEME_UPLOAD_TOKEN must be at least 32 bytes in UTF-8.'
}
$workerConfigValues = Get-Content -Raw -Encoding utf8 $workerConfig | ConvertFrom-Json
foreach ($name in @('MEME_UPLOAD_BASE_URL', 'MEME_IMAGE_ORIGIN')) {
    $value = [string]$workerConfigValues.vars.$name
    if ([string]::IsNullOrWhiteSpace($value) -or $value -match '(?i)\.example') {
        throw "$name must be set to a real HTTPS origin in apps/api/wrangler.jsonc."
    }
    $parsedUrl = $null
    if (-not [Uri]::TryCreate($value, [UriKind]::Absolute, [ref]$parsedUrl) -or $parsedUrl.Scheme -ne 'https') {
        throw "$name must be an HTTPS URL."
    }
}

$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporarySecrets = Join-Path $temporaryRoot ("mapeditor-worker-secrets-{0}.json" -f [Guid]::NewGuid())
$payload = @{
    GOOGLE_CLIENT_ID = $googleClientId
    SESSION_SECRET = $sessionSecret
    MEME_UPLOAD_TOKEN = $memeUploadToken
} | ConvertTo-Json

Push-Location $repositoryRoot
try {
    npm.cmd run check
    if ($LASTEXITCODE -ne 0) { throw 'Static checks failed.' }

    npx.cmd wrangler types (Join-Path $repositoryRoot 'apps\api\worker-configuration.d.ts') --check --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Worker binding type checks failed.' }

    npx.cmd wrangler d1 migrations apply DB --local --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Local D1 migrations failed.' }

    npx.cmd wrangler d1 migrations apply DB --remote --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Remote D1 migrations failed.' }

    [System.IO.File]::WriteAllText(
        $temporarySecrets,
        $payload,
        [System.Text.UTF8Encoding]::new($false)
    )

    npx.cmd wrangler deploy --secrets-file $temporarySecrets --config $workerConfig
    if ($LASTEXITCODE -ne 0) { throw 'Worker deployment failed.' }
}
finally {
    Pop-Location
    $resolvedTemporarySecrets = [System.IO.Path]::GetFullPath($temporarySecrets)
    if ($resolvedTemporarySecrets.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $resolvedTemporarySecrets -Force -ErrorAction SilentlyContinue
    }
}
