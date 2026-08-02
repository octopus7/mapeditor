[CmdletBinding()]
param(
    [string]$ProjectName = 'mapedit',
    [Parameter(Mandatory)]
    [string]$ApiBaseUrl,
    [string]$SecretsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildOutput = Join-Path $repositoryRoot 'apps\web\dist'
$appConfigPath = Join-Path $buildOutput 'app-config.json'

if ([string]::IsNullOrWhiteSpace($SecretsPath)) {
    $SecretsPath = Join-Path $repositoryRoot '.dev.vars'
}

. (Join-Path $PSScriptRoot 'Secret-Helpers.ps1')
$secretValues = Import-SecretValues -Path $SecretsPath
$googleClientId = Get-RequiredSecretValue -Values $secretValues -Name 'GOOGLE_CLIENT_ID'

$apiUri = [Uri]$ApiBaseUrl
if (-not $apiUri.IsAbsoluteUri -or $apiUri.Scheme -ne 'https') {
    throw 'ApiBaseUrl은 절대 HTTPS 주소여야 합니다.'
}
$normalizedApiBaseUrl = $apiUri.GetLeftPart([UriPartial]::Authority)
Push-Location $repositoryRoot

try {
    npm.cmd run check

    if (-not (Test-Path -LiteralPath $buildOutput -PathType Container)) {
        throw "Pages 빌드 산출물을 찾을 수 없습니다: $buildOutput"
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

    npx.cmd wrangler pages deploy $buildOutput --project-name $ProjectName --branch main
    if ($LASTEXITCODE -ne 0) {
        throw "Pages 배포가 실패했습니다. 종료 코드: $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
