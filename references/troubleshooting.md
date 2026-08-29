# Troubleshooting routes

## Page shows an authorization or sign-in error

Confirm the deployment's executing user and access audience, then run `checkInstallation()` from the editor. Do not broaden access to `Anyone` as a shortcut. Confirm that the deploying account can access every configured calendar and the optional log sheet.

## Saved code does not appear on the web page

Check whether the user edited the active deployment to a new version. Preserve the existing deployment instead of creating a new URL unless the user chooses otherwise.

## A room appears free when it is occupied

Confirm that the event exists on the configured room calendar, the room points to the correct calendar ID, the project time zone is correct, and the event overlaps the requested interval. Availability must not depend on matching a room name inside an event title.

## Reservation exists but the log or Meet is missing

Read the structured result returned by `bookRoom`. Check the profile's logging mode, Sheet permission, Advanced Calendar service for Meet, and the reported warning. Do not recreate the reservation until its event reference has been checked, or a duplicate may be created.

## Repeat booking behaves unexpectedly

Check the selected weekdays, interval, occurrence limit, time zone, and every generated date. Test with a private calendar before changing a live deployment.

## A user cannot find, change, or cancel a reservation

Confirm that the same Google account that created the reservation is signed in, the full management token was copied without spaces, the token has not expired, and the reservation is still active. Administrators should see only aggregate health totals; do not reveal or reset a user's token in a support conversation.

## Time change created a warning

Check both the old and replacement event references before retrying. A `reschedule_cleanup_pending` record means the new time was created but at least one old calendar event could not be removed. Do not create another replacement until the administrator resolves it.
