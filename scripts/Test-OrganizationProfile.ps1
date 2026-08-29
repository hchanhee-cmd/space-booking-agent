[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProfilePath
)

$ErrorActionPreference = 'Stop'

function Require-Text([object]$Value, [string]$Field) {
    if (-not ($Value -is [string]) -or [string]::IsNullOrWhiteSpace($Value)) {
        throw "$Field must be a non-empty text value."
    }
}

function Mask-Identifier([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
    if ($Value.Length -le 8) { return '********' }
    return $Value.Substring(0, 3) + '...' + $Value.Substring($Value.Length - 3)
}

$resolved = (Resolve-Path -LiteralPath $ProfilePath).Path
$profile = Get-Content -Raw -Encoding UTF8 -LiteralPath $resolved | ConvertFrom-Json

Require-Text $profile.organizationName 'organizationName'
Require-Text $profile.appTitle 'appTitle'
Require-Text $profile.timeZone 'timeZone'

if ($null -eq $profile.access -or $null -eq $profile.access.requireSignedInUser) {
    throw 'access.requireSignedInUser must be true or false.'
}
$domains = @($profile.access.allowedDomains)
if ([bool]$profile.access.requireSignedInUser -and $domains.Count -eq 0) {
    throw 'At least one allowed domain is required when sign-in is required.'
}
foreach ($domain in $domains) {
    if ($domain -notmatch '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$') {
        throw "Invalid allowed domain: $domain"
    }
}
$adminEmails = @($profile.access.adminEmails)
foreach ($email in $adminEmails) {
    if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { throw "Invalid admin email: $email" }
}

$rooms = @($profile.rooms)
if ($rooms.Count -eq 0) { throw 'At least one room is required.' }
$roomIds = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$roomNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($room in $rooms) {
    Require-Text $room.id 'rooms[].id'
    Require-Text $room.name 'rooms[].name'
    Require-Text $room.calendarId 'rooms[].calendarId'
    if ($room.id -notmatch '^[a-z0-9][a-z0-9-]{1,62}$') {
        throw "Room id must use lowercase letters, numbers, and hyphens: $($room.id)"
    }
    if (-not $roomIds.Add([string]$room.id)) { throw "Duplicate room id: $($room.id)" }
    if (-not $roomNames.Add([string]$room.name)) { throw "Duplicate room name: $($room.name)" }
}

$loggingModes = @('disabled', 'optional', 'required')
if ($null -eq $profile.logging -or $profile.logging.mode -notin $loggingModes) {
    throw 'logging.mode must be disabled, optional, or required.'
}
if ($profile.logging.mode -ne 'disabled') {
    Require-Text $profile.logging.spreadsheetId 'logging.spreadsheetId'
}

foreach ($limit in @(
    @{ Name='maxDurationMinutes'; Min=15; Max=1440 },
    @{ Name='maxAdvanceDays'; Min=1; Max=730 },
    @{ Name='maxRecurrenceCount'; Min=1; Max=104 },
    @{ Name='alternativeSearchDays'; Min=1; Max=30 },
    @{ Name='maxRequestsPerMinute'; Min=1; Max=120 }
)) {
    $value = $profile.limits.($limit.Name)
    if ($value -isnot [int] -or $value -lt $limit.Min -or $value -gt $limit.Max) {
        throw "limits.$($limit.Name) must be an integer from $($limit.Min) to $($limit.Max)."
    }
}
if ($null -eq $profile.management -or $profile.management.enabled -isnot [bool]) {
    throw 'management.enabled must be true or false.'
}
if ($profile.management.tokenExpiryDays -isnot [int] -or $profile.management.tokenExpiryDays -lt 1 -or $profile.management.tokenExpiryDays -gt 365) {
    throw 'management.tokenExpiryDays must be an integer from 1 to 365.'
}
if ($null -eq $profile.notifications -or $profile.notifications.emailConfirmation -isnot [bool]) {
    throw 'notifications.emailConfirmation must be true or false.'
}

$maskedRooms = @($rooms | ForEach-Object {
    [pscustomobject][ordered]@{
        id = $_.id
        name = $_.name
        calendarId = Mask-Identifier $_.calendarId
    }
})

[pscustomobject][ordered]@{
    valid = $true
    organizationName = $profile.organizationName
    appTitle = $profile.appTitle
    timeZone = $profile.timeZone
    requireSignedInUser = [bool]$profile.access.requireSignedInUser
    allowedDomains = $domains
    adminEmails = $adminEmails
    rooms = $maskedRooms
    meetingCalendarId = Mask-Identifier $profile.meetingCalendarId
    logging = [pscustomobject]@{
        mode = $profile.logging.mode
        spreadsheetId = Mask-Identifier $profile.logging.spreadsheetId
    }
    notifications = $profile.notifications
    management = $profile.management
    limits = $profile.limits
} | ConvertTo-Json -Depth 6
