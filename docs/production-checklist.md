# Production setup checklist

The current deployment is GitHub Pages only and does not use this checklist's Supabase steps. To publish, push to `main` with **Settings → Pages → GitHub Actions** selected. Everything below applies only if a backend is added later.

## 1. Create the Supabase project

1. Create one Supabase project in the region nearest the company.
2. Install the Supabase CLI and authenticate locally.
3. From this repository, link the project and apply every file in `supabase/migrations`, in order (`supabase db push`).
4. Deploy the `submit-po` and `lookup-po` Edge Functions. Their JWT checks are intentionally disabled because both are anonymous endpoints; they perform their own input validation, rate limiting, origin checks, and limited-result handling.
5. Set Edge Function secrets:
   - `ALLOWED_ORIGINS` — the exact GitHub Pages origin, such as `https://company.github.io` (no repository path and no trailing slash). Separate multiple approved origins with commas.
   - `TURNSTILE_SECRET_KEY` — Cloudflare Turnstile secret; strongly recommended for production.
   - `RATE_LIMIT_SALT` — a private random value generated with a password manager or `openssl rand -hex 32`.
   - `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are supplied by Supabase's function environment. Never add the service-role key to GitHub or browser variables.

## 2. Create administrator accounts

1. In Supabase Auth, create each administrator with a confirmed email and password, using the dashboard or a trusted server-side admin API. This app has password sign-in; invitation acceptance, self-service password reset, and MFA screens are not implemented. Employees who submit requests do not need accounts or email addresses.
2. Copy each Auth user UUID.
3. Insert a matching `public.profiles` row using `user_id` and `full_name`, with `role = 'department_admin'` and the correct `department_id`, or `role = 'global_admin'` with a null department.
4. If MFA is required by company policy, implement and verify enrollment/challenge screens and AAL2 database enforcement before launch. This version does not claim MFA support.
5. Test with two different department accounts and prove each receives zero rows from the other department.

Example profile assignment (replace every placeholder):

```sql
insert into public.profiles (user_id, full_name, role, department_id)
select
  '<auth-user-uuid>'::uuid,
  'Operations Admin',
  'department_admin'::public.admin_role,
  id
from public.departments
where name = 'Operations';
```

## 3. Define departments

The migration creates only a `General` department. A global administrator can add real departments from the dashboard, or they can be inserted before launch. Deactivate obsolete departments rather than deleting historical records.

## 4. Configure GitHub Pages

1. Push this repository to GitHub with `main` as the default branch.
2. In **Settings → Pages**, choose **GitHub Actions** as the source.
3. Add repository Actions secrets:
   - `VITE_SUPABASE_URL` — the project URL.
   - `VITE_SUPABASE_ANON_KEY` — the browser-safe anonymous key, never the service-role key.
   - `VITE_TURNSTILE_SITE_KEY` — the public Cloudflare Turnstile site key.
4. In Turnstile, allow the final GitHub Pages hostname.
5. If a custom Supabase domain is used, add its HTTPS and WSS origins to the Content Security Policy in `index.html`.
6. Push to `main`; the included workflow tests, builds, and publishes `dist`. A build without the Supabase secrets shows a warning in the Actions run.

The site works at any Pages path, including `https://company.github.io/po-desk/`, because assets use relative paths and pages use `#/` routes. No repository-name setting or `404.html` is needed. GitHub Pages sites are publicly reachable, and the site asks search engines not to index it.

When updating an existing deployment, apply new migrations and deploy Edge Functions before pushing the frontend.

Without the first two browser variables the app deliberately runs in clearly labeled demo mode using local browser storage. Demo data is not shared and is not suitable for production.

## 5. Operations before launch

- Enable point-in-time recovery or automated encrypted hourly exports to meet the one-hour recovery target. Perform and time a restore test.
- Configure a five-minute synthetic workflow check and alert when monthly availability risks falling below 99.5%.
- Keep logs free of requester names, emails, item descriptions, business reasons, request codes, access tokens, and Turnstile tokens.
- Review Supabase Auth session duration, password policy, allowed origins, and administrator offboarding.
- Decide the data-retention period and document who may export or delete purchase records.
- Run dependency review and the automated tests before each release.
- Test keyboard navigation, mobile layouts, anonymous submission, request-code lookup, both administrator scopes, every status transition, sign-out, and direct database access attempts.
- Confirm no email-notification provider or email workflow has been enabled. Only administrator sign-in uses email; requesters provide no email address.
- Offboard administrators by revoking their profile and disabling their Auth account. Deleting Auth users referenced by immutable audit history is intentionally not supported by this schema.

## Local verification

`npm test` includes PostgreSQL integration tests using PGlite. These execute the actual migration and exercise row-level security with simulated Supabase identity/roles, atomic submissions, retries, totals, audit immutability, and status changes. They do not replace a test against deployed Supabase Auth and Edge Functions. Check functions locally with `npx deno check supabase/functions/submit-po/index.ts supabase/functions/lookup-po/index.ts`.

The initial migration is for a new project. If an earlier schema has already been deployed independently, prepare and review a separate forward migration before connecting this frontend; do not rerun the initial migration or drop existing data.
