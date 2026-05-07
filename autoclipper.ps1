<#
Scheduled task helper for `raleys-auto-clipper`.

Usage:
  .\autoclipper.ps1          # Default scheduled run (headless)
  .\autoclipper.ps1 login    # Interactive login run (non-headless)

Behavior:
  - No parameter: runs with `--headless true`
  - `login` parameter: runs with `--headless false` so browser UI is visible
#>
param(
    [string]$Mode = ""
)

$nodePath = "C:\program files\nodejs\node.exe"
$headlessValue = "true"

if ($Mode -and $Mode -notmatch "^(?i)login$") {
    Write-Error "Unknown mode '$Mode'. Supported modes: login"
    exit 1
}

if ($Mode -match "^(?i)login$") {
    $headlessValue = "false"
}

$scriptArgs = "index.js --headless $headlessValue --saveCookies true --loadCookies true"
$cmdLine = "`"$nodePath`" $scriptArgs"

Write-Output "Executing $cmdLine"
cmd /c $cmdLine
Write-Output "Node process finished with exit code $LASTEXITCODE"
exit $LASTEXITCODE
