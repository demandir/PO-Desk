# PO Desk design critique

## Direction

The selected direction began as **The product performs** (seed `1860861104`) and was later simplified around a single form, live total, and one request code.

## First rendered pass

Overall: **8.2 / 10**

- Hierarchy — 8.5: the oversized Libre Franklin heading and porcelain order sheet made the main action immediately legible on desktop.
- Composition — 8.0: the split stage was distinct, but the 390-pixel view placed the sheet before the page proposition.
- Typography — 8.7: Libre Franklin and Source Serif 4 created a useful operational/editorial contrast without weakening form readability.
- Colour — 8.8: light blue, porcelain, deep ink, and restrained gold were coherent and gold remained reserved for decisive actions.
- Interaction — 7.8: the live total and request receipt worked well, but the generated private code was unnecessarily long and mobile navigation hid useful destinations.
- Accessibility — 8.2: semantic headings, labels, skip navigation, focus states, status text, and reduced-motion handling were present; compact navigation needed improvement.
- Performance — 7.5: the production build worked, but Supabase was bundled into the initial JavaScript path.

## Changes made after critique

1. Reordered the compact hero so the proposition and **Start request** action appear before the live sheet; changed the mobile header into a two-row layout that keeps Request, Track, and Admin visible.
2. Replaced the 64-character receipt secret with a four-block, 80-bit code while retaining server-side SHA-256 hashing and lookup rate limits.
3. Moved the Supabase client behind a dynamic import, reducing the initial JavaScript chunk and removing the large-chunk build warning.

## Simplified palette pass

Overall: **9.1 / 10**

- Hierarchy — 9.2
- Composition — 9.0
- Typography — 8.9
- Colour — 9.4
- Interaction — 9.3
- Accessibility — 9.0
- Performance — 8.8

The repeat order-sheet preview and four tall workflow panels were removed. Form sections now sit in a compact 1180-pixel work area, the dashboard sections are shorter, and the footer is a single compact band. The exact supplied white, pink, blue, and gold values anchor both themes. Light/dark preference persists locally. At 836 pixels and a real 390-pixel iframe viewport, navigation, hierarchy, and form controls remain clear.

The main remaining shortfall is density in the administrator detail view on very small screens: complete order data, a decision form, and the audit history necessarily require vertical scrolling. That is preferable to hiding operational data, but it should be watched with real administrators after launch. Production authentication, MFA, and cross-department row-level policies also require an acceptance pass against the configured Supabase project; demo mode cannot prove the remote environment.

## Imagery and fragments

No stock or generated photography was used. The visual content is the real request form, calculated totals, status result, and administrator ledger. There are no image credits or external image assets to track.
