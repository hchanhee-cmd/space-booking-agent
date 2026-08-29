---
name: space-booking-agent
description: Set up, configure, inspect, or update an organization-specific Google Apps Script space-booking web app. Use when a user wants a reusable meeting-room reservation system backed by Google Calendar, optional Google Sheets logging, or beginner-friendly deployment and troubleshooting; do not use to make bookings on the user's behalf without explicit approval.
---

# Space Booking Agent

Help a beginner create and maintain a browser-based space-booking system. The web app handles everyday reservations; this skill handles setup, organization-specific configuration, deployment, verification, and updates.

## Operating modes

- **New setup:** collect the minimum organization profile, generate configuration, and guide installation.
- **Update:** inspect the current project and deployment before changing code or configuration. Preserve the existing web-app URL when the platform supports a new version on the same deployment.
- **Booking management:** for an organization-only app, list the signed-in user's own reservations without a token. For an external-access app, require the management token. Never weaken the configured identity boundary.
- **Troubleshoot:** reproduce or inspect the reported failure, distinguish permission, configuration, deployment, and booking conflicts, then propose the smallest safe fix.
- **Export a guide:** create a portable organization guide that contains rules and room names but no credentials or unnecessary personal data.

Read [references/setup.md](references/setup.md) for a new installation. Read [references/security-and-errors.md](references/security-and-errors.md) before changing access, identity, logging, or rollback behavior. Read [references/troubleshooting.md](references/troubleshooting.md) only when diagnosing a failure.

## Interaction

Assume the user may never have used Apps Script. Ask one question at a time, prefer buttons or numbered choices, accept `잘 모르겠어요`, and explain only the next action. Do not lead with OAuth, manifests, IDs, APIs, or deployment terminology. When a technical value is needed, show exactly where the user can copy it. Start with a simple preset: `회사 내부용` (recommended), `회사 내부용 + 이메일`, `외부 예약용`, or `직접 설정`; ask only for values the selected preset still needs.

For a new setup, collect:

1. Organization and system display name.
2. Whether access is restricted to signed-in organization accounts.
3. One or more allowed email domains when restriction is enabled.
4. Each space name and its Google Calendar ID.
5. Whether to create a separate meeting calendar.
6. Whether reservation logging is disabled, optional, or required; collect the spreadsheet ID only when enabled.
7. Maximum duration, advance-booking window, and weekly recurrence limit, offering safe defaults.
8. Whether confirmation email and self-service booking management are enabled, the management-token lifetime, and one or more administrator emails.

Do not collect calendar or spreadsheet IDs in a public issue, public chat export, example, or repository. Store organization values in an ignored local profile during preparation and in Apps Script Properties at runtime. Never hard-code them into the reusable template.

## Build and change rules

- Copy the project in `assets/apps-script-template/` rather than rewriting it from conversation history.
- Validate a profile with `scripts/Test-OrganizationProfile.ps1` before generating or installing configuration.
- Show a configuration preview with IDs masked, then obtain explicit approval before writing Apps Script properties, changing a deployment, or testing against live calendars.
- Default deployment access to the user's Google Workspace organization. Do not recommend anonymous or `Anyone` access for an owner-executed app.
- Treat the signed-in Google account as identity. Never trust a typed name or email as proof of identity.
- In organization-only mode, use the signed-in account to show `내 예약` and do not expose a management token. In external mode, treat the token as a secret: store only its digest and never log or display it to administrators.
- Check every recurrence date for conflicts while holding a script lock before creating events.
- When a requested time is unavailable, offer a small set of conflict-checked alternatives without booking any of them automatically.
- For rescheduling, create and verify the replacement before deleting the old events. If cleanup is incomplete, mark the record for administrator attention instead of claiming success.
- Do not report complete success when calendar creation, Meet creation, or required logging failed. Return a plain-language status and the next safe action.
- Preserve the current deployment URL when updating an existing deployment unless the user approves a new URL.
- Never delete existing calendar events, logs, deployments, or projects merely to repair installation. Require an exact target and approval.

## Completion

For a setup or update, report what was configured, what remains for the user, the deployment access level, the tested scenarios, and any warnings. A setup is complete only after the web page loads, availability can be checked, a dedicated test booking succeeds, a deliberate conflict offers alternatives, `내 예약` or external token lookup works as configured, rescheduling is verified, and the test booking is cancelled with user approval.
