# Security and error behavior

## Access and identity

An owner-executed web app can use the owner's Calendar and Sheets permissions. Therefore, restrict access to the organization and validate the signed-in account's domain. If Apps Script cannot provide a signed-in email while identity is required, stop with `AUTH_REQUIRED`; do not accept a typed replacement.

The reusable source and public repository must not contain live calendar IDs, spreadsheet IDs, deployment URLs, organization names, or user inventories.

Self-service management uses a long random token plus the signed-in account. Only a SHA-256 digest of the token is stored. The raw token appears only in the creator's success screen and optional confirmation email. Do not put it in logs, administrator summaries, screenshots, or support tickets.

## Validation

Reject unknown rooms, invalid dates, past times, durations outside the configured limit, excessive advance dates, empty subjects, unsupported recurrence patterns, and recurrence counts above the configured maximum. Use stable room IDs in requests and obtain names from server-side configuration.

## Booking consistency

Acquire a script lock, recalculate every requested date, and check all room conflicts before the first write. Track every created event. If a later required step fails, attempt rollback and report both the original failure and any rollback failure.

Google Meet is optional. If Meet creation fails after the calendar event succeeds, return `PARTIAL_SUCCESS` with a warning and the created event reference; do not silently claim complete success.

Logging modes:

- `disabled`: never access Sheets.
- `optional`: keep the reservation and return a warning when logging fails.
- `required`: roll back newly created reservation events when logging fails.

Never swallow an operational failure only to write it to a developer console. Return a safe error code and plain-language message without exposing calendar IDs, spreadsheet IDs, stack traces, or private event details.

Rate-limit booking, cancellation, and rescheduling per signed-in identity. An unavailable time may return verified alternatives, but selecting an alternative must still require an explicit booking action.
