param(
    [Parameter(Mandatory = $true)]
    [uri]$SignalingUrl,
    [ValidateRange(1, 24)]
    [int]$Hours = 8
)

$ErrorActionPreference = 'Stop'
if (!$SignalingUrl.IsAbsoluteUri -or $SignalingUrl.Scheme -ne 'wss' -or
    $SignalingUrl.AbsolutePath -ne '/signal' -or
    $SignalingUrl.UserInfo -or $SignalingUrl.Query -or $SignalingUrl.Fragment) {
    throw 'Enter the full secure signaling URL, for example wss://anysys-signal.onrender.com/signal.'
}

$health = [UriBuilder]::new($SignalingUrl)
$health.Scheme = 'https'
$health.Path = '/health'
Write-Host 'Waiting for the signaling service. A sleeping Render instance can take about a minute.'
$deadline = [DateTime]::UtcNow.AddSeconds(120)
$ready = $false
do {
    try {
        $check = Invoke-WebRequest -Uri $health.Uri -UseBasicParsing -TimeoutSec 10 -MaximumRedirection 0
        $ready = $check.StatusCode -eq 200 -and $check.Content.Trim() -ceq 'ok'
    } catch {
        $ready = $false
    }
    if (!$ready) { Start-Sleep -Seconds 3 }
} until ($ready -or [DateTime]::UtcNow -ge $deadline)
if (!$ready) {
    throw "The signaling service did not respond at $($health.Uri). Check that the deployment is live."
}

$keyId = (Read-Host 'Cloudflare TURN key ID').Trim()
if ($keyId -notmatch '^[A-Za-z0-9_-]+$') { throw 'Enter the Cloudflare TURN key ID from the dashboard.' }
$secret = Read-Host 'Cloudflare TURN key API token' -AsSecureString
try {
    if ($secret.Length -eq 0) { throw 'A TURN key API token is required.' }
    $credential = [PSCredential]::new('turn', $secret)
    $result = Invoke-RestMethod -Method Post -TimeoutSec 20 -MaximumRedirection 0 `
        -Uri "https://rtc.live.cloudflare.com/v1/turn/keys/$keyId/credentials/generate-ice-servers" `
        -Headers @{ Authorization = 'Bearer ' + $credential.GetNetworkCredential().Password } `
        -ContentType 'application/json' -Body (@{ ttl = $Hours * 3600 } | ConvertTo-Json -Compress)
} catch {
    throw 'Cloudflare did not issue TURN credentials. Check the TURN key ID and its API token.'
} finally {
    $secret.Dispose()
}

# Chromium blocks port 53, which may be present among the provider's alternatives.
$servers = @(
    foreach ($entry in $result.iceServers) {
        $urls = @($entry.urls | Where-Object { $_ -and $_ -notmatch ':53(?:\?|$)' })
        if ($urls.Count -gt 0) {
            $server = @{ urls = $urls }
            if ($entry.username) { $server.username = $entry.username }
            if ($entry.credential) { $server.credential = $entry.credential }
            $server
        }
    }
)
if (!($servers | Where-Object { $_.username -and $_.credential -and ($_.urls -match '^turns?:') })) {
    throw 'Cloudflare returned no usable TURN server.'
}

Set-Clipboard -Value (ConvertTo-Json -InputObject $servers -Depth 5 -Compress)
Write-Host "Paste the copied ICE servers into AnySys. They are valid for $Hours hour(s)."
Write-Host "Set the AnySys signaling URL to $SignalingUrl"
