# PO Desk

A lightweight purchase-order request system for one company. Employees submit without an account, department administrators see only their department, and one global administrator sees all requests and dashboard statistics.

The interface uses a light-blue, porcelain, and restrained gold palette and is designed for GitHub Pages. Supabase supplies the database, authentication, row-level authorization, and two anonymous Edge Functions. No email notifications are included.

## Hosting

The live site runs on GitHub Pages only, in browser-only demo mode. Requests, statuses, and admin views are saved in each visitor's browser and are never shared, so administrators do not receive requests. The Supabase code in this repository is unused unless a backend is added later, which also requires restoring the Supabase and Turnstile origins in the Content Security Policy in `index.html` and the build secrets in the deploy workflow.

## Try it locally

```bash
npm install
npm run dev
```

Open the printed local URL. When no `.env` values are present, PO Desk enters demo mode. Use the demo access buttons on the Admin page; the sample request code is `7K2M-B4WN`.

To connect Supabase, copy `.env.example` to `.env.local` and enter the public project URL, public anonymous key, and optional Turnstile site key. Never put the Supabase service-role key in a `VITE_` variable.

## Commands

```bash
npm test
npm run build
npm run lint:taste
npm run preview
```

## Production setup

Start with [the production checklist](docs/production-checklist.md) and [the architecture and security model](docs/architecture.md). Apply the SQL migration and deploy both Edge Functions before adding the GitHub Actions secrets.

## What is included

- Anonymous multi-item requests with one item-based total and safe submission retries.
- Requester name, department, vendor, item descriptions, quantities, prices, and business reason. Project codes and quote links are optional.
- No requester email, shipping, tax, or delivery fields.
- One private no-login request code, stored only as a server-side hash.
- Persistent light and dark modes using the company white, pink, blue, and gold palette.
- Department-scoped and global administrator dashboards.
- Status workflow, review notes, and append-only audit history.
- Global status/spend statistics and department management.
- Database row-level security, server-generated references/totals, anonymous rate limits, and optional Turnstile protection.
- GitHub Pages deployment workflow and browser-only demo mode.

## Deliberately not included

- Email notifications.
- File uploads; use an approved HTTPS quote link.
- Payment, bank, tax-identity, health, credential, or other highly sensitive data.
- Accounting-system integration or automatic vendor purchasing.
