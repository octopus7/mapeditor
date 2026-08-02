[CmdletBinding()]
param(
    [string]$TemplatePath,
    [string]$SecretsPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))

if ([string]::IsNullOrWhiteSpace($TemplatePath)) {
    $TemplatePath = Join-Path $repositoryRoot 'secrets.example.env'
}

if ([string]::IsNullOrWhiteSpace($SecretsPath)) {
    $SecretsPath = Join-Path $repositoryRoot '.dev.vars'
}

$resolvedTemplatePath = [System.IO.Path]::GetFullPath($TemplatePath)
$resolvedSecretsPath = [System.IO.Path]::GetFullPath($SecretsPath)

if (-not (Test-Path -LiteralPath $resolvedTemplatePath -PathType Leaf)) {
    throw "Secret template file was not found: $resolvedTemplatePath"
}

if (Test-Path -LiteralPath $resolvedSecretsPath) {
    Write-Host "Keeping the existing secrets file: $resolvedSecretsPath"
    return
}

$secretsDirectory = Split-Path -Parent $resolvedSecretsPath
if (-not (Test-Path -LiteralPath $secretsDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $secretsDirectory | Out-Null
}

Copy-Item -LiteralPath $resolvedTemplatePath -Destination $resolvedSecretsPath
Write-Host "Created the secrets file: $resolvedSecretsPath"
Write-Host 'Enter the real values and save the file. Never commit or print its contents.'
