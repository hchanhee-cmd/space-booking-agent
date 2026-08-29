**English** | [한국어](README.md)

# Space Booking Agent

A reusable Google Apps Script booking website plus an AI setup assistant. Staff use the website for everyday reservations; the AI agent helps an organization install, configure, update, and troubleshoot it.

## Features

- Check room availability and prevent simultaneous booking conflicts.
- Weekly recurring reservations and conflict-checked alternative times.
- Optional personal calendar events, Google Meet links, Google Sheets logging, and confirmation email.
- Signed-in internal users can view and manage their own bookings without copying a management number.
- External-access deployments can use private management tokens.
- Korean and English booking interface with a visible language switch.
- Organization-specific IDs and settings stay outside the public template.

## Install with an AI coding agent

Paste this repository link into Codex or another AI agent that can work with files and say:

```text
Install the Space Booking Agent for my organization.
I am new to AI, so ask one question at a time in plain English.

https://github.com/hchanhee-cmd/space-booking-agent
```

The assistant asks for only the settings needed for your chosen preset, masks private IDs in the preview, and asks for approval before changing a live Apps Script deployment or calendar.

## Language support

The setup agent follows the language you use. The booking website lets each visitor choose `한국어` or `English`; its static labels, actions, validation guidance, results, and common errors follow that choice. Organization names, room names, and booking subjects remain exactly as configured or entered.

## Security

Calendar IDs, spreadsheet IDs, domains, administrator addresses, and organization profiles must not be committed to the public repository. Runtime configuration belongs in Apps Script Properties. Internal deployment is the recommended default.

See [START_HERE.en.md](START_HERE.en.md) for the beginner installation flow and [SKILL.md](SKILL.md) for agent behavior.
