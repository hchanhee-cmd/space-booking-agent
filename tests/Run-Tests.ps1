[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$validator = Join-Path $root 'scripts\Test-OrganizationProfile.ps1'
$example = Join-Path $root 'assets\organization-profile.example.json'
$code = Join-Path $root 'assets\apps-script-template\Code.gs'
$html = Join-Path $root 'assets\apps-script-template\index.html'
$results = [Collections.Generic.List[object]]::new()

function Check([string]$Name, [scriptblock]$Test) {
    try { $ok = [bool](& $Test); $detail = if ($ok) { '' } else { 'Assertion returned false.' } }
    catch { $ok = $false; $detail = $_.Exception.Message }
    $results.Add([pscustomobject]@{ name=$Name; passed=$ok; detail=$detail })
}

Check 'Example profile validates' { (& $validator -ProfilePath $example | ConvertFrom-Json).valid }
Check 'Example identifiers are masked' { ((& $validator -ProfilePath $example | ConvertFrom-Json).rooms[0].calendarId) -eq 'rep...-id' }
Check 'No live organization profile is shipped' { -not (Test-Path (Join-Path $root 'organization-profile.json')) }
Check 'Backend reads configuration from Script Properties' { (Get-Content -Raw $code) -match 'PropertiesService\.getScriptProperties' }
Check 'Backend has no calendar address literals' { (Get-Content -Raw $code) -notmatch '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}' }
Check 'Signed-in account is used for identity' { (Get-Content -Raw $code) -match 'Session\.getActiveUser\(\)\.getEmail\(\)' }
Check 'Script lock protects bookings' { (Get-Content -Raw $code) -match 'getScriptLock' }
Check 'Duplicate requests are cached' { (Get-Content -Raw $code) -match 'request:\$\{normalized\.requestId\}' }
Check 'Every recurrence date is conflict checked' { (Get-Content -Raw $code) -match 'hasAnyConflict_' }
Check 'Rollback is implemented' { (Get-Content -Raw $code) -match 'function rollback_' }
Check 'Required logging failure triggers rollback' { (Get-Content -Raw $code) -match "logging\.mode === 'required'" }
Check 'Optional logging failure becomes a warning' { (Get-Content -Raw $code) -match "logging\.mode === 'optional'" }
Check 'Meet failure becomes partial success' { (Get-Content -Raw $code) -match 'PARTIAL_SUCCESS' }
Check 'Users can choose whether to create a meeting event' { (Get-Content -Raw $code) -match 'createMeetingEvent' }
Check 'Unknown room is rejected server-side' { (Get-Content -Raw $code) -match 'UNKNOWN_ROOM' }
Check 'Past requests are rejected' { (Get-Content -Raw $code) -match 'PAST_TIME' }
Check 'Advance limit is enforced' { (Get-Content -Raw $code) -match 'TOO_FAR_AHEAD' }
Check 'Duration limit is enforced' { (Get-Content -Raw $code) -match 'INVALID_DURATION' }
Check 'Recurrence limit is enforced' { (Get-Content -Raw $code) -match 'INVALID_RECURRENCE' }
Check 'Frame embedding is not opened globally' { (Get-Content -Raw $code) -notmatch 'ALLOWALL' }
Check 'Web page includes accessible status updates' { (Get-Content -Raw $html) -match 'aria-live="polite"' }
Check 'Booking management lookup exists' { (Get-Content -Raw $code) -match 'function getBooking' }
Check 'Internal users can list their own bookings' { (Get-Content -Raw $code) -match 'function getMyBookings' }
Check 'Management mode is derived from sign-in policy' { (Get-Content -Raw $code) -match "managementMode:.*requireSignedInUser" }
Check 'Internal booking result hides management token' { (Get-Content -Raw $code) -match "managementToken:.*!config\.access\.requireSignedInUser" }
Check 'Account lookup verifies the booking owner' { (Get-Content -Raw $code) -match 'function requireOwnedRecordById_' }
Check 'Cancellation requires owned record' { (Get-Content -Raw $code) -match 'function cancelBooking' -and (Get-Content -Raw $code) -match 'requireOwnedRecord_' }
Check 'Rescheduling checks conflicts before replacement' { (Get-Content -Raw $code) -match 'function rescheduleBooking' }
Check 'Alternative suggestions are generated server-side' { (Get-Content -Raw $code) -match 'function findAlternatives_' }
Check 'Raw management tokens are hashed before storage' { (Get-Content -Raw $code) -match 'BOOKING_PREFIX\}\$\{digest_\(token\)' }
Check 'Rate limiting is enforced on mutations' { (Get-Content -Raw $code) -match 'function enforceRateLimit_' }
Check 'Confirmation email is optional' { (Get-Content -Raw $code) -match 'notifications\.emailConfirmation' }
Check 'Admin summary returns aggregate counts' { (Get-Content -Raw $code) -match 'function getAdminSummary' }
Check 'Expired management records have a cleanup function' { (Get-Content -Raw $code) -match 'function purgeExpiredBookingRecords' }
Check 'Management interface is present' { (Get-Content -Raw $html) -match 'id="manageTab"' }
Check 'Internal interface uses an account-specific label' { (Get-Content -Raw $html) -match "managementMode==='account'" }
Check 'Token input is hidden outside token mode' { (Get-Content -Raw $html) -match "tokenLookup.*managementMode!=='token'" }
Check 'Alternative buttons require another explicit action' { (Get-Content -Raw $html) -match 'renderAlternatives' }
Check 'Disabled management is rejected server-side' { (Get-Content -Raw $code) -match 'MANAGEMENT_DISABLED' }
Check 'Email manifests request mail scope only when selected' { (Get-Content -Raw (Join-Path $root 'assets\apps-script-template\appsscript.with-email.json')) -match 'script.send_mail' }

$nodeRaw = & node (Join-Path $PSScriptRoot 'apps-script.test.js')
if ($LASTEXITCODE -ne 0) { throw ($nodeRaw -join [Environment]::NewLine) }
$nodeResult = ($nodeRaw -join [Environment]::NewLine) | ConvertFrom-Json
foreach ($item in $nodeResult.results) {
    $results.Add([pscustomobject]@{ name=('Runtime: ' + $item.name); passed=[bool]$item.passed; detail=$item.detail })
}

$failed = @($results | Where-Object { -not $_.passed })
[pscustomobject]@{ total=$results.Count; passed=$results.Count-$failed.Count; failed=$failed.Count; results=$results } | ConvertTo-Json -Depth 5
if ($failed.Count) { exit 1 }
