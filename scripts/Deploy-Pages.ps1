[CmdletBinding()]
param(
    [string]$ProjectName = 'mapedit',
    [string]$ApiBaseUrl,
    [string]$SecretsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildOutput = Join-Path $repositoryRoot 'apps\web\dist'
$appConfigPath = Join-Path $buildOutput 'app-config.json'
$deploymentMetaPath = Join-Path $buildOutput 'deployment-meta.json'

if ([string]::IsNullOrWhiteSpace($SecretsPath)) {
    $SecretsPath = Join-Path $repositoryRoot '.dev.vars'
}

. (Join-Path $PSScriptRoot 'Secret-Helpers.ps1')
$secretValues = Import-SecretValues -Path $SecretsPath
$googleClientId = Get-RequiredSecretValue -Values $secretValues -Name 'GOOGLE_CLIENT_ID'
if ([string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    $ApiBaseUrl = Get-RequiredSecretValue -Values $secretValues -Name 'MAPEDITOR_API_BASE_URL'
}

$apiUri = [Uri]$ApiBaseUrl
if (-not $apiUri.IsAbsoluteUri -or $apiUri.Scheme -ne 'https') {
    throw 'ApiBaseUrl must be an absolute HTTPS URL.'
}
$normalizedApiBaseUrl = $apiUri.GetLeftPart([UriPartial]::Authority)
Push-Location $repositoryRoot

try {
    npm.cmd run check

    if (-not (Test-Path -LiteralPath $buildOutput -PathType Container)) {
        throw "Pages build output was not found: $buildOutput"
    }

    $publicConfig = @{
        apiBaseUrl = $normalizedApiBaseUrl
        googleClientId = $googleClientId
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        $appConfigPath,
        $publicConfig,
        [System.Text.UTF8Encoding]::new($false)
    )
    $deploymentMetadata = @{
        deployedAt = [DateTime]::UtcNow.ToString('o')
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText(
        $deploymentMetaPath,
        $deploymentMetadata,
        [System.Text.UTF8Encoding]::new($false)
    )

    npx.cmd wrangler pages deploy $buildOutput --project-name $ProjectName
    if ($LASTEXITCODE -ne 0) {
        throw "Pages deployment failed. Exit code: $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
