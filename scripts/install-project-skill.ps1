[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidateNotNullOrEmpty()]
    [string]$Url,

    [string]$ProjectRoot
)

$ErrorActionPreference = 'Stop'

function Resolve-GitRepositoryRoot {
    param([string]$StartPath)

    $resolvedStart = (Resolve-Path -LiteralPath $StartPath).Path
    $gitRoot = & git -C $resolvedStart rev-parse --show-toplevel 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $gitRoot) {
        throw "No Git repository found from '$resolvedStart'. Provide -ProjectRoot with a path inside the target repository."
    }

    return (Resolve-Path -LiteralPath ($gitRoot | Select-Object -First 1)).Path
}

function Resolve-SkillSource {
    param([string]$SourceUrl)

    try {
        $uri = [Uri]$SourceUrl
    }
    catch {
        throw "Invalid GitHub URL: $SourceUrl"
    }

    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'github.com') {
        throw 'The project installer accepts only HTTPS github.com URLs.'
    }

    $segments = @($uri.AbsolutePath.Trim('/') -split '/' | Where-Object { $_ })
    if ($segments.Count -lt 5 -or $segments[2] -notin @('tree', 'blob')) {
        throw 'Use a GitHub tree/blob URL that identifies the skill directory or its SKILL.md file.'
    }

    $owner = $segments[0]
    $repository = $segments[1]
    $ref = $segments[3]
    $skillPath = @($segments[4..($segments.Count - 1)])
    if ($skillPath[-1] -ieq 'SKILL.md') {
        if ($skillPath.Count -eq 1) {
            throw 'The GitHub URL does not identify a skill directory.'
        }
        $skillPath = @($skillPath[0..($skillPath.Count - 2)])
    }

    $skillName = [Uri]::UnescapeDataString($skillPath[-1])
    if ([string]::IsNullOrWhiteSpace($skillName) -or $skillName -in @('.', '..')) {
        throw 'Unable to derive a valid skill name from the GitHub URL.'
    }

    $escapedPath = ($skillPath | ForEach-Object { [Uri]::EscapeDataString([Uri]::UnescapeDataString($_)) }) -join '/'
    return [pscustomobject]@{
        Name = $skillName
        Url = "https://github.com/$owner/$repository/tree/$ref/$escapedPath"
    }
}

$startPath = if ($ProjectRoot) { $ProjectRoot } else { (Get-Location).Path }
$repositoryRoot = Resolve-GitRepositoryRoot -StartPath $startPath
$source = Resolve-SkillSource -SourceUrl $Url
$skillsRoot = Join-Path $repositoryRoot '.agents\skills'
$skillDestination = Join-Path $skillsRoot $source.Name

if (Test-Path -LiteralPath $skillDestination) {
    throw "Project skill already exists: $skillDestination"
}

$codexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
$installerScript = Join-Path $codexHome 'skills\.system\skill-installer\scripts\install-skill-from-github.py'
if (-not (Test-Path -LiteralPath $installerScript -PathType Leaf)) {
    throw "Codex system skill installer not found: $installerScript"
}

$python = Get-Command python -ErrorAction SilentlyContinue
$pythonArgs = @('-B', $installerScript, '--url', $source.Url, '--dest', $skillsRoot)
if ($python) {
    & $python.Source @pythonArgs
}
else {
    $pyLauncher = Get-Command py -ErrorAction SilentlyContinue
    if (-not $pyLauncher) {
        throw 'Python is required to run the Codex system skill installer.'
    }
    & $pyLauncher.Source -3 @pythonArgs
}

if ($LASTEXITCODE -ne 0) {
    throw "Codex skill installer failed with exit code $LASTEXITCODE."
}

$installedSkillFile = Join-Path $skillDestination 'SKILL.md'
if (-not (Test-Path -LiteralPath $installedSkillFile -PathType Leaf)) {
    throw "Installation did not produce the expected file: $installedSkillFile"
}

[pscustomobject]@{
    name = $source.Name
    repositoryRoot = $repositoryRoot
    installedPath = $skillDestination
}
