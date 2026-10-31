# PO Desk design brief

## Reading

PO Desk is an internal purchase-request system for one company of about 100 employees. Any employee can submit a request without an account. Department administrators sign in to review only their own department, while a global administrator can see every request and company-wide statistics. The interface must be deployable to GitHub Pages, remain deliberately simple, and support light and dark modes. Its core palette is white `#E8E5E1`; pink `#E0C3CC` and `#CBA6B5`; blue `#B6D3DA`, `#91B8C3`, and `#73929B`; and gold `#D4A43A` and `#A87824`.

## Subject inventory

- An internal purchase-order reference for administrators.
- Requester name and work contact.
- A department stamped onto every request.
- Line items with description, quantity, unit price, and calculated totals.
- Vendor, quote link, cost center, delivery location, and needed-by date.
- A business justification that explains why the order exists.
- Status language: Submitted, Under review, Needs information, Approved, Rejected, Ordered.
- One private request code for people who submit without an account.
- Department queues that cannot see one another.
- A global ledger with spend, volume, and turnaround summaries.
- An append-only review history.
- The approval mark: a small gold field used only for decisive actions and status.

## Argument

- Anyone in the company can make a complete request without an account. Proof: the full request form is the first screen.
- A requester can see exactly what they are asking the company to spend. Proof: line totals and the complete request total update as they type.
- A no-login request can still be checked safely. Proof: submission returns one high-entropy request code; public lookup reveals status only.
- Department administrators work inside a hard department boundary. Proof: the authenticated queue and database row-level policies use the administrator’s department.
- The global administrator can understand the whole purchasing picture. Proof: an all-department queue and aggregate spend/status views.
- Every decision remains explainable. Proof: status transitions write an append-only audit event.

## Idea

One form, one request code, and one clear decision path.

## Live thing

The line-item editor continuously updates every line total and the final request total without adding a duplicate preview surface.

## Copy deck

Navigation: PO Desk · Request · Track · Admin

Hero heading: Request what your team needs.

Supporting line: Add who needs it, what it costs, and when it is needed. No account required.

Primary action: Submit request

Form headings: Requester · Order · Delivery · Reason

Tracking heading: Check a request

Tracking support: Enter the single request code shown after submission.

Admin login heading: Review purchase requests

Dashboard heading: Purchase order desk

Department dashboard support: Review requests assigned to your department and keep each decision in the record.

Global dashboard support: See every department, current commitments, and the work waiting for a decision.

Empty state: No requests match these filters.

