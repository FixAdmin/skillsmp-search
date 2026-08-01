[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]]$Query,

    [ValidateRange(1, 100)]
    [int]$LimitPerQuery = 20,

    [ValidateSet('stars', 'recent')]
    [string]$SortBy = 'stars',

    [ValidateRange(1, 200)]
    [int]$MaxCandidates = 40,

    [ValidatePattern('^\d{8}T\d{6}Z-[0-9a-f]{8}$')]
    [string]$HeavySearchId,

    [switch]$RetryAmbiguous
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 18 or newer is required. Install it from https://nodejs.org/.'
}

$script = Join-Path $PSScriptRoot 'search-skillsmp.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "Search script not found: $script"
}

$arguments = @()
foreach ($term in $Query) {
    $arguments += @('--query', $term)
}
$arguments += @(
    '--limit-per-query', [string]$LimitPerQuery,
    '--sort-by', $SortBy,
    '--max-candidates', [string]$MaxCandidates
)
if ($HeavySearchId) { $arguments += @('--heavy-search-id', $HeavySearchId) }
if ($RetryAmbiguous) { $arguments += '--retry-ambiguous' }

& $node.Source $script @arguments
if ($LASTEXITCODE -ne 0) {
    throw "SkillsMP search failed with exit code $LASTEXITCODE."
}
