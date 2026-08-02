Set-StrictMode -Version Latest

function Import-SecretValues {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $resolvedPath -PathType Leaf)) {
        throw "Secret input file was not found: $resolvedPath"
    }

    $values = @{}
    foreach ($line in Get-Content -LiteralPath $resolvedPath -Encoding utf8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) {
            continue
        }
        $separator = $line.IndexOf('=')
        if ($separator -le 0) {
            continue
        }
        $name = $line.Substring(0, $separator).Trim()
        $value = $line.Substring($separator + 1).Trim()
        if ($name -match '^[A-Za-z_][A-Za-z0-9_]*$') {
            $values[$name] = $value
        }
    }
    return $values
}

function Get-RequiredSecretValue {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [hashtable]$Values,
        [Parameter(Mandatory)]
        [string]$Name
    )

    if (-not $Values.ContainsKey($Name) -or [string]::IsNullOrWhiteSpace($Values[$Name])) {
        throw "A value for $Name is required in .dev.vars."
    }
    return [string]$Values[$Name]
}
