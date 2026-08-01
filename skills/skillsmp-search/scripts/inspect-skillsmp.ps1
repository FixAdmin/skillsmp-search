[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$InputPath,

    [string]$OutputPath,
    [string]$ReviewIndexPath,
    [string]$RunId,
    [switch]$Resume,
    [string]$CacheDir,
    [string]$StateDir,

    [ValidateRange(1, 12)]
    [int]$Concurrency = 6,

    [ValidateRange(1000, 120000)]
    [int]$TimeoutMs = 15000,

    [ValidateRange(0, 5)]
    [int]$Retries = 2,

    [ValidateRange(1024, 1048576)]
    [int]$MaxSourceBytes = 262144,

    [ValidateSet('json', 'jsonl')]
    [string]$Format = 'json'
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 18 or newer is required.'
}

$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 18) {
    throw 'Node.js 18 or newer is required.'
}

$entryPoint = Join-Path $PSScriptRoot 'inspect-skillsmp.mjs'
$arguments = @(
    $entryPoint,
    '--input', $InputPath,
    '--concurrency', [string]$Concurrency,
    '--timeout-ms', [string]$TimeoutMs,
    '--retries', [string]$Retries,
    '--max-source-bytes', [string]$MaxSourceBytes,
    '--format', $Format
)
if ($OutputPath) { $arguments += @('--output', $OutputPath) }
if ($ReviewIndexPath) { $arguments += @('--review-index', $ReviewIndexPath) }
if ($RunId) { $arguments += @('--run-id', $RunId) }
if ($Resume) { $arguments += '--resume' }
if ($CacheDir) { $arguments += @('--cache-dir', $CacheDir) }
if ($StateDir) { $arguments += @('--state-dir', $StateDir) }

& $node.Source @arguments
exit $LASTEXITCODE
