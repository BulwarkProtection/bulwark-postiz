# Read-only account discovery. Never prints or saves the API key.
$ErrorActionPreference = 'Stop'
$secure = Read-Host 'Enter your Buffer personal API key' -AsSecureString
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  $headers = @{ Authorization = "Bearer $key" }
  function Invoke-BufferQuery([string]$query, [hashtable]$variables = @{}) {
    $body = @{ query = $query; variables = $variables } | ConvertTo-Json -Depth 10 -Compress
    $result = Invoke-RestMethod -Uri 'https://api.buffer.com' -Method Post -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 30
    if ($result.errors) { throw 'Buffer returned a GraphQL error.' }
    return $result.data
  }
  $account = Invoke-BufferQuery 'query { account { organizations { id name } } }'
  foreach ($org in $account.account.organizations) {
    Write-Host ("Organization: {0} | ID: {1}" -f $org.name, $org.id)
    $channels = Invoke-BufferQuery 'query Channels($input: ChannelsInput!) { channels(input: $input) { id name displayName service type isDisconnected isLocked isQueuePaused } }' @{ input = @{ organizationId = $org.id } }
    $channels.channels | Select-Object id, name, displayName, service, type, isDisconnected, isLocked, isQueuePaused | Format-Table -AutoSize
  }
} catch {
  Write-Error 'Buffer discovery failed. Check the API key, network, and account permissions.'
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable key,headers,secure,ptr -ErrorAction SilentlyContinue
}
