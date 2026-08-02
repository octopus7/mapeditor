[CmdletBinding()]
param(
    [string]$ProjectName = 'mapedit'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildOutput = Join-Path $repositoryRoot 'apps\web\dist'
Push-Location $repositoryRoot

try {
    npm.cmd run check

    if (-not (Test-Path -LiteralPath $buildOutput -PathType Container)) {
        throw "Pages 빌드 산출물을 찾을 수 없습니다: $buildOutput"
    }

    npx.cmd wrangler pages deploy $buildOutput --project-name $ProjectName --branch main
    if ($LASTEXITCODE -ne 0) {
        throw "Pages 배포가 실패했습니다. 종료 코드: $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
