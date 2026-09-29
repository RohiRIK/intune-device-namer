[CmdletBinding()]
param(
    [ValidateSet('wizard', 'templates', 'validate', 'inventory', 'plan', 'reconcile', 'apply', 'generate-macos-script')]
    [string]$Command = 'wizard',
    [string[]]$CliArguments = @()
)

$ErrorActionPreference = 'Stop'
$bun = Get-Command bun -ErrorAction Stop
$entry = Join-Path $PSScriptRoot 'src/cli.ts'
Push-Location $PSScriptRoot
try {
    & $bun.Source run $entry $Command @CliArguments
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($code -ne 0) { exit $code }
