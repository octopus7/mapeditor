[CmdletBinding()]
param(
    [string]$ProjectName = 'mapedit',
    [string]$ApiBaseUrl,
    [string]$SecretsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workerScript = Join-Path $PSScriptRoot 'Deploy-Worker.ps1'
$pagesScript = Join-Path $PSScriptRoot 'Deploy-Pages.ps1'

$workerArguments = @{}
$pagesArguments = @{ ProjectName = $ProjectName }
if (-not [string]::IsNullOrWhiteSpace($SecretsPath)) {
    $workerArguments.SecretsPath = $SecretsPath
    $pagesArguments.SecretsPath = $SecretsPath
}
if (-not [string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
    $pagesArguments.ApiBaseUrl = $ApiBaseUrl
}

Push-Location $repositoryRoot
try {
    Write-Host '==> Deploying Worker API'
    & $workerScript @workerArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Worker deployment failed. Pages deployment will not start. Exit code: $LASTEXITCODE"
    }

    Write-Host '==> Deploying Pages'
    & $pagesScript @pagesArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Pages deployment failed. Exit code: $LASTEXITCODE"
    }

    Write-Host '==> Worker and Pages production deployment completed.'
}
finally {
    Pop-Location
}
