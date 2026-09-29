#Requires -Version 7
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.Graph.Authentication -ErrorAction Stop
$ReadScopes = @('DeviceManagementManagedDevices.Read.All', 'Device.Read.All', 'User.Read', 'User.Read.All', 'Group.Read.All')
$WriteScope = 'DeviceManagementManagedDevices.PrivilegedOperations.All'

function Connect-ProxyGraph {
    [CmdletBinding()]
    param([switch]$Write)

    $required = @($ReadScopes)
    if ($Write) { $required += $WriteScope }
    $context = Get-MgContext -ErrorAction SilentlyContinue
    $missing = @($required | Where-Object { $_ -notin @($context.Scopes) })
    if (-not $context -or -not $context.Account -or $context.AuthType -ne 'Delegated' -or $missing.Count -gt 0) {
        [Console]::Error.WriteLine('Connecting to Microsoft Graph interactively...')
        Connect-MgGraph -Scopes $required -NoWelcome -ErrorAction Stop | Out-Null
        $context = Get-MgContext -ErrorAction Stop
    }
    if (-not $context -or -not $context.Account -or $context.AuthType -ne 'Delegated') {
        throw 'Interactive Graph sign-in did not complete.'
    }
    $missing = @($required | Where-Object { $_ -notin @($context.Scopes) })
    if ($missing.Count -gt 0) { throw "Graph consent missing: $($missing -join ', ')" }
    return $context
}

# One JSON request/response per line. Bun keeps this PowerShell process alive for a wizard
# run or saved-plan apply so the delegated Connect-MgGraph session can be reused.
# The proxy permits only inventory/organization reads and the explicit beta rename POST.
while ($null -ne ($line = [Console]::In.ReadLine())) {
    try {
        $request = ConvertFrom-Json -InputObject $line -AsHashtable -ErrorAction Stop
        switch ($request.op) {
            'connect' {
                $context = Connect-ProxyGraph
                $data = @{ tenantId = $context.TenantId; account = $context.Account }
            }
            'request' {
                $uri = [uri]$request.url
                if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'graph.microsoft.com' -or $uri.Port -ne 443 -or $uri.AbsolutePath -notmatch '^/(v1\.0|beta)/') {
                    throw 'Graph request URL is not allowed.'
                }
                if ($request.method -notin @('GET', 'POST')) { throw 'Unsupported Graph method.' }
                if ($request.method -eq 'POST' -and $uri.AbsolutePath -notmatch '^/beta/deviceManagement/managedDevices/[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/setDeviceName$') {
                    throw 'POST is restricted to the rename action.'
                }
                if ($request.method -eq 'GET' -and $uri.AbsolutePath -notmatch '^/v1\.0/(organization|devices|deviceManagement/managedDevices|groups|users/[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12})(/|$)') {
                    throw 'GET endpoint is not used by this CLI.'
                }
                if ($request.method -eq 'POST' -and ($null -eq $request.body -or @($request.body.Keys).Count -ne 1 -or $request.body.deviceName -cnotmatch '^[A-Z0-9-]{1,63}$')) {
                    throw 'Invalid rename body.'
                }
                $null = Connect-ProxyGraph -Write:($request.method -eq 'POST')
                $params = @{ Uri = $uri.AbsoluteUri; Method = $request.method; OutputType = 'PSObject'; ErrorAction = 'Stop' }
                if ($request.method -eq 'POST') {
                    $params.Body = ConvertTo-Json -InputObject $request.body -Depth 10 -Compress
                    $params.ContentType = 'application/json'
                }
                $data = Invoke-MgGraphRequest @params
                if ($null -eq $data -and $request.method -eq 'POST') { $data = @{ submitted = $true } }
            }
            default { throw 'Unknown proxy operation.' }
        }
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $true; data = $data } -Depth 40 -Compress))
    }
    catch {
        [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ ok = $false; error = $_.Exception.Message } -Compress))
    }
}
