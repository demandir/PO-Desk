# PO Desk

A lightweight purchase-order request system for one company. Employees submit without an account, department administrators see only their department, and one global administrator sees all requests and dashboard statistics.

The interface uses a light-blue, porcelain, and restrained gold palette and is designed for GitHub Pages. Neon supplies the database and the server function. Notifications go through an optional Telegram bot; no email notifications are included.

## Hosting

The website is hosted on GitHub Pages. Neon holds the database and runs one server function (`functions/api.ts`) that handles submissions, status checks, admin sign-in, and dashboards. Row-level security in `db/migrations` keeps each department to its own requests.

## Try it locally

```bash
npm install
npm run dev
```

Open the printed local URL. When no `.env` values are present, PO Desk enters demo mode. Use the demo access buttons on the Admin page; the sample request code is `7K2M-B4WN`.

Local runs stay in demo mode. The published build reads its API address from `.env.production`.

## Commands

```bash
npm test
npm run build
npm run lint:taste
npm run preview
```

## Production setup

See [the operations guide](docs/production-checklist.md) and [the architecture and security model](docs/architecture.md).

## What is included

- Anonymous multi-item requests with one item-based total and safe submission retries.
- Requester name, department, vendor, item descriptions, quantities, prices, and business reason. Project codes and quote links are optional.
- No requester email, shipping, tax, or delivery fields.
- One private no-login request code, stored only as a server-side hash.
- Persistent light and dark modes using the company white, pink, blue, and gold palette.
- Department-scoped and global administrator dashboards.
- Status workflow, review notes, and append-only audit history.
- Telegram group bot: new requests are posted in one group, any member can accept or deny with a required reason, and requesters track by code.
- Global status/spend statistics and department management.
- Database row-level security, server-generated references/totals, anonymous rate limits, and optional Turnstile protection.
- GitHub Pages deployment workflow and browser-only demo mode.

## Deliberately not included

- Email notifications.
- File uploads; use an approved HTTPS quote link.
- Payment, bank, tax-identity, health, credential, or other highly sensitive data.
- Accounting-system integration or automatic vendor purchasing.
