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
    throw "시크릿 예시 파일을 찾을 수 없습니다: $resolvedTemplatePath"
}

if (Test-Path -LiteralPath $resolvedSecretsPath) {
    Write-Host "기존 시크릿 파일을 유지합니다: $resolvedSecretsPath"
    return
}

$secretsDirectory = Split-Path -Parent $resolvedSecretsPath
if (-not (Test-Path -LiteralPath $secretsDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $secretsDirectory | Out-Null
}

Copy-Item -LiteralPath $resolvedTemplatePath -Destination $resolvedSecretsPath
Write-Host "시크릿 파일을 생성했습니다: $resolvedSecretsPath"
Write-Host '실제 값을 입력한 뒤 파일을 저장하세요. 이 파일의 내용은 Git에 포함되거나 출력되어서는 안 됩니다.'
