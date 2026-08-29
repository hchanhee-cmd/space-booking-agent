# Beginner setup

## What the user needs

- A Google account allowed to create or edit an Apps Script project.
- One Google Calendar per independently bookable space.
- Optional: a meeting calendar and a Google Sheet for logs.

Explain that a Calendar ID is the calendar's address, not a password. Tell the user to open Google Calendar, select the calendar's settings, and copy **Integrate calendar → Calendar ID**. For a spreadsheet, copy only the part between `/d/` and `/edit` in its URL.

## Profile format

Create a local JSON file from `assets/organization-profile.example.json`. Use real values only in the user's private working folder and exclude that file from Git.

Required fields:

- `organizationName`, `appTitle`
- `access.requireSignedInUser`
- `access.allowedDomains`
- `access.adminEmails`: users allowed to view anonymous booking-health totals
- `rooms[]`: stable `id`, visible `name`, and `calendarId`
- `meetingCalendarId`, which may be empty
- `logging.mode`: `disabled`, `optional`, or `required`
- `logging.spreadsheetId`, required unless logging is disabled
- limits for duration, advance days, and recurrence count
- `management.enabled` and `management.tokenExpiryDays`
- `notifications.emailConfirmation`
- limits for alternative search days and requests per minute

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\Test-OrganizationProfile.ps1 -ProfilePath .\organization-profile.json
```

The validator returns a masked preview suitable for confirmation. Do not paste the unmasked profile into a public conversation.

## Install the web app

1. Create a standalone Apps Script project.
2. Add `Code.gs` and `index.html` from `assets/apps-script-template/`. Choose one manifest below and save it in Apps Script under the name `appsscript.json`:

   - No logging or email: `appsscript.json`
   - Logging only: `appsscript.with-logging.json`
   - Email only: `appsscript.with-email.json`
   - Logging and email: `appsscript.with-logging-and-email.json`
3. Open **Project Settings → Script Properties → Add script property**. Enter `SPACE_BOOKING_CONFIG` as the property name and paste the validated private JSON as its value. Script Properties are runtime configuration, not a public source file.
4. Run `checkInstallation()` in the editor. Resolve every reported error before deployment.
5. Deploy as a web app. Prefer **execute as the deploying user** and access restricted to the organization.
6. Approve only the Calendar and optional Sheets permissions required by the selected profile.
7. Open the deployment URL and perform the completion tests listed in `SKILL.md`. Keep the test management token private and cancel the test reservation when finished.
8. If self-service management is enabled, optionally add a monthly time trigger for `purgeExpiredBookingRecords()` after the administrator approves automatic removal of expired management records. This removes only expired management metadata, not calendar history.

When updating, use **Manage deployments → Edit → New version** to preserve the URL. Explain that saving code alone does not update a versioned web deployment.
