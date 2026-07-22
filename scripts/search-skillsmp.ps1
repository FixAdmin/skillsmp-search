[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string[]]$Query,

    [ValidateRange(1, 100)]
    [int]$LimitPerQuery = 20,

    [ValidateSet('stars', 'recent')]
    [string]$SortBy = 'stars',

    [ValidateRange(1, 200)]
    [int]$MaxCandidates = 40
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$baseUri = 'https://skillsmp.com/api/v1/skills/search'
$headers = @{ Accept = 'application/json' }
$apiKey = $env:SKILLSMP_API_KEY
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable('SKILLSMP_API_KEY', 'User')
}
if (-not [string]::IsNullOrWhiteSpace($apiKey)) {
    $headers.Authorization = "Bearer $apiKey"
}

$recordsByKey = @{}

foreach ($term in $Query) {
    $trimmed = $term.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        continue
    }

    $parameters = [ordered]@{
        q      = $trimmed
        page   = 1
        limit  = $LimitPerQuery
        sortBy = $SortBy
    }
    $queryString = ($parameters.GetEnumerator() | ForEach-Object {
        '{0}={1}' -f $_.Key, [uri]::EscapeDataString([string]$_.Value)
    }) -join '&'

    try {
        $response = Invoke-RestMethod -Method Get -Uri "$baseUri`?$queryString" -Headers $headers
    }
    catch {
        throw "SkillsMP request failed for query '$trimmed': $($_.Exception.Message)"
    }

    if (-not $response.success) {
        throw "SkillsMP returned an unsuccessful response for query '$trimmed'."
    }

    $skills = @($response.data.skills)
    for ($index = 0; $index -lt $skills.Count; $index++) {
        $skill = $skills[$index]
        $key = if (-not [string]::IsNullOrWhiteSpace([string]$skill.githubUrl)) {
            [string]$skill.githubUrl
        }
        else {
            [string]$skill.id
        }

        if (-not $recordsByKey.ContainsKey($key)) {
            $stars = if ($null -eq $skill.stars) { 0 } else { [long]$skill.stars }
            $recordsByKey[$key] = [pscustomobject]@{
                Id             = [string]$skill.id
                Name           = [string]$skill.name
                Author         = [string]$skill.author
                Description    = [string]$skill.description
                GitHubUrl      = [string]$skill.githubUrl
                SkillUrl       = [string]$skill.skillUrl
                Stars          = $stars
                UpdatedAt      = [string]$skill.updatedAt
                BestRank       = $index + 1
                MatchedQueries = [System.Collections.Generic.List[string]]::new()
            }
        }

        $record = $recordsByKey[$key]
        if (-not $record.MatchedQueries.Contains($trimmed)) {
            $record.MatchedQueries.Add($trimmed)
        }
        if (($index + 1) -lt $record.BestRank) {
            $record.BestRank = $index + 1
        }
    }
}

$candidates = @(foreach ($record in $recordsByKey.Values) {
    [pscustomobject]@{
        id             = $record.Id
        name           = $record.Name
        author         = $record.Author
        description    = $record.Description
        githubUrl      = $record.GitHubUrl
        skillUrl       = $record.SkillUrl
        stars          = $record.Stars
        updatedAt      = $record.UpdatedAt
        matchedQueries = @($record.MatchedQueries)
        matchCount     = $record.MatchedQueries.Count
        bestRank       = $record.BestRank
    }
}) | Sort-Object -Property `
    @{ Expression = 'matchCount'; Descending = $true }, `
    @{ Expression = 'bestRank'; Ascending = $true }, `
    @{ Expression = 'stars'; Descending = $true } |
    Select-Object -First $MaxCandidates

$output = [pscustomobject]@{
    generatedAt    = [DateTime]::UtcNow.ToString('o')
    queries        = @($Query | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    sortBy         = $SortBy
    limitPerQuery  = $LimitPerQuery
    candidateCount = @($candidates).Count
    candidates     = @($candidates)
}

$output | ConvertTo-Json -Depth 6
