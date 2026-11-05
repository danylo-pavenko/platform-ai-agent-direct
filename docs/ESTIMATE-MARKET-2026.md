# Pre-Estimate

**Statement of Work**  
**Direct AI Agents**

| | |
|---|---|
| Document No. | SJ-PE-2026-001 |
| Revision | 1.0 |
| Date | 5 October 2026 |
| Issued by | Subjektiv |
| Prepared for | The Client |
| Engagement | Design and delivery of the Direct AI Agents platform |
| Status | Pre-estimate. Becomes binding only when the parties execute a Statement of Work that incorporates it. |
| Validity | 30 days from the date of this document, through 4 November 2026 |
| Currency | Euro (EUR) |

**Classification:** Confidential. Prepared for the Client in connection with a proposed Statement of Work.

---

## 1. Purpose

Subjektiv submits this pre-estimate as the commercial and scope basis for a Statement of Work. It describes the work, the delivery milestones, the professional rates, and the commercial cap for building the Direct AI Agents platform: a white-label AI agent for Instagram Direct, in the scope of the functions the product already comprises.

This document is not an invoice and not a signed contract. Hours, dates, and amounts are planning figures. They are confirmed in the Statement of Work.

| | |
|---|---:|
| Planned effort | 5,488 hours |
| Base | **€162,833** |
| Contingency inside the cap | €24,425 (15%) |
| Commercial cap | **€187,258** |
| Average professional rate | €29.67 per hour |
| Planned duration | 9 months |
| Team | 34.3 person-months, peak of 5 people |
| First payment | **€17,400** |

The first payment is **€17,400**, due when the Statement of Work is signed. It is Milestone 1: confirmation of scope and the opening of the tenant platform.

---

## 2. Professional rates

Rates below are Subjektiv’s professional rates for this engagement, in euro. They apply to time worked on the scope in this pre-estimate. They do not include third-party subscriptions, infrastructure, or vendor accounts.

| Role | Assignment | Rate | Hours | Amount |
|---|---|---:|---:|---:|
| Tech Lead | Architecture and technical direction | €36.18 | 336 | €12,158 |
| Backend | Node.js, TypeScript, PostgreSQL | €30.92 | 2,628 | €81,261 |
| Frontend | Vue administration applications | €29.61 | 880 | €26,053 |
| DevOps | Environments, processes, backups | €33.55 | 456 | €15,300 |
| QA | Acceptance against the scenarios in this document | €24.10 | 860 | €20,725 |
| Project management | Planning, client communication, milestone control | €22.37 | 328 | €7,336 |
| **Total** | | | **5,488** | **€162,833** |

A change of role mix during delivery does not change a milestone price that the parties have already fixed in the Statement of Work. Work outside this scope is estimated separately before it starts.

---

## 3. Team and schedule

Planned duration is nine months from the start date named in the Statement of Work. Streams overlap. The admin interface proceeds in parallel with CRM work. Environment work returns for the fleet toward the end of the plan.

| Month | Team | Closes |
|---|---|---|
| 1 | Tech Lead, backend, DevOps, project management | Milestone 1 — foundation, €17,400 |
| 2 | QA joins | Remainder of tenant isolation; Instagram channel starts |
| 3–4 | Second backend and frontend join | Webhooks, echo handling, agent runtime, admin shell |
| 5–6 | The same team | Shop and booking in parallel; admin screens |
| 7 | Backend, frontend, QA, project management | Leads, Telegram, Teach, Sandbox, AI assistant |
| 8 | DevOps returns | Super Admin, backups, automatic update |
| 9 | QA, Tech Lead, backend, project management | Acceptance, handover, schedule buffer |

Peak staffing is five people. Average load is about 3.8 full-time equivalents. A second backend engineer is planned from month 3.

The plan assumes the team is implementing behavior that is already defined for this product. Discovery of a new product, or a material change of scope, is outside this pre-estimate.

---

## 4. Statement of work by milestone

Each milestone is limited to behavior the platform already comprises. A new messaging channel or a new CRM is a change request.

Weeks are the planned length of that stream. They are not added together to produce the nine-month calendar. Milestones 5, 6, and 8 run in parallel.

| ID | Milestone | Weeks | Hours | Amount |
|---|---|---:|---:|---:|
| M1 | Foundation: scope confirmation and start of the tenant platform | 6 | 571 | €17,400 |
| M2 | Tenant isolation, remainder | 3 | 273 | €8,350 |
| M3 | Instagram / Meta channel | 7 | 700 | €20,752 |
| M4 | Agent runtime | 8 | 780 | €23,253 |
| M5 | Shop, catalog, Nova Poshta, KeyCRM | 5 | 424 | €12,448 |
| M6 | Booking: CleverBOX, BeautyPro, Altegio | 8 | 696 | €20,608 |
| M7 | Leads, events, Telegram for managers | 4 | 272 | €7,936 |
| M8 | Tenant administration | 6 | 620 | €17,934 |
| M9 | Teach, Sandbox, AI assistant | 4 | 396 | €11,642 |
| M10 | Super Admin, backups, automatic update | 5 | 524 | €16,057 |
| M11 | Acceptance and handover | 3 | 232 | €6,453 |
| | **Base** | **9 months** | **5,488** | **€162,833** |
| | Contingency | | | €24,425 |
| | **Commercial cap** | | | **€187,258** |

### M1. Foundation — €17,400

Subjektiv confirms the scope of this pre-estimate, including the acceptance scenarios in Section 5, and the Client provides access to Meta, the CRM accounts in scope, and the server.

The same milestone opens the tenant platform: operating-system user, PostgreSQL, process layout (`api`, `bot`, `sync`, `admin`), handling of secrets so that tokens are not written to logs or API responses, and administrator sign-in.

Acceptance: the scope list is agreed in writing, and an administrator can sign in to a first tenant environment.

Staffing: Tech Lead 69 h, backend 235 h, frontend 20 h, DevOps 126 h, QA 57 h, project management 64 h.

### M2. Tenant isolation — €8,350

Domain and TLS per tenant. Two tenants on one server cannot read each other’s data. Owner and manager roles are enforced.

Acceptance: a record created in tenant A is not visible in tenant B.

Staffing: Tech Lead 19 h, backend 125 h, frontend 12 h, DevOps 70 h, QA 31 h, project management 16 h.

### M3. Instagram / Meta channel — €20,752

OAuth limited to `business_management`, `pages_show_list`, `pages_read_engagement`, and `instagram_manage_messages`. Webhook routing by the business identifier. A separate path for a manager reply sent from the Instagram application. Burst messages are joined into one turn. Shared posts, a Stories frame, voice notes on a dedicated port per tenant, vision for screenshots and PDF files, a public/debug reply mode, and one follow-up after a period of silence.

Acceptance: an inbound direct message receives one reply; a manager reply from the Instagram application is stored and does not start a new model run.

The Client provides the Meta application and the required app review. A delay in that review moves the schedule. Time spent waiting is not billed.

Staffing: Tech Lead 32 h, backend 420 h, frontend 56 h, DevOps 40 h, QA 120 h, project management 32 h.

### M4. Agent runtime — €23,253

The customer agent runs through the Claude Agent SDK, with the command-line path as fallback. Modes: sales, lead generation, booking, and general. Prompt versions can be activated and rolled back. One model session per turn. History follows the tenant’s civil day. Greeting rules follow the day and the freshness of the session. Internal identifiers are not shown to the customer. Confirmation of a visit that already exists does not create a new visit. At this milestone, tools may run against stubs.

Acceptance: the general mode contains the tools of the three specialized modes, and a prompt activation during a turn stops that turn.

Staffing: Tech Lead 80 h, backend 480 h, frontend 16 h, DevOps 16 h, QA 140 h, project management 40 h.

### M5. Shop — €12,448

Catalog from the CRM or from CSV, nightly refresh, search by price and availability, a quoted total recorded beside the catalog total, Nova Poshta rate and tracking status only for the current buyer’s shipment, a local order, a Telegram card to managers, and a mirror into KeyCRM.

Acceptance: a completed test order shows the quoted total, and a tracking number that belongs to another buyer is not described.

Staffing: Tech Lead 16 h, backend 240 h, frontend 80 h, QA 64 h, project management 24 h.

### M6. Booking — €20,608

CleverBOX, BeautyPro, and Altegio through adapters. Routing by a single provider, by action, or by prompt. Free time is checked before a visit is created. A closed day or a missing time does not create a visit. Cancellation, removal of one service, and rescheduling are separate actions. The conversation is linked to the CRM client. A failed booking can be retried from the administration screen.

Acceptance: a free window creates one visit; a closed day creates none; a reschedule does not leave two active visits.

The Client provides CRM sandboxes and the BeautyPro marketplace grant.

Staffing: Tech Lead 40 h, backend 480 h, frontend 24 h, QA 120 h, project management 32 h.

### M7. Leads, events, and Telegram — €7,936

A structured lead brief, events with a period in which the agent may discuss them, one escalation card, one SLA reminder, return of the conversation to the agent after idle time, and manager commands. The private diagnostic chat does not post into the manager group.

Acceptance: five customer messages during an escalation do not produce five cards.

Staffing: Tech Lead 8 h, backend 160 h, frontend 40 h, QA 48 h, project management 16 h.

### M8. Tenant administration — €17,934

Dashboard, conversations, orders, prompts, events, synchronization, CRM fields, users, and settings for the live integrations. On a phone, lists are cards, primary navigation sits at the bottom, and tap targets are at least 44 px. Teach, Sandbox, and the AI assistant are Milestone 9.

Acceptance: a manager cannot open prompt administration, user administration, or synchronization. The owner can.

Staffing: Tech Lead 8 h, backend 140 h, frontend 360 h, QA 88 h, project management 24 h.

### M9. Agent control — €11,642

Teaching produces a prompt revision that can be rolled back. The sandbox holds up to 15 cases. The AI assistant shows a metrics snapshot and writes only after the owner confirms. None of these screens sends a message to a live customer conversation.

Staffing: Tech Lead 24 h, backend 140 h, frontend 160 h, QA 56 h, project management 16 h.

### M10. Fleet — €16,057

Super Admin covers tenants, deployment, rollback of code when the health check fails, a nightly update when a newer version number is published, backup, a restore drill, and a webhook log. Database migrations are not rolled back and must remain compatible with the previous release for one version.

Acceptance: a tenant with automatic update switched off does not update at midnight. A failed release returns the code to the previous version. A restore from the drill backup brings back a conversation and an order.

Staffing: Tech Lead 16 h, backend 160 h, frontend 88 h, DevOps 180 h, QA 56 h, project management 24 h.

### M11. Acceptance and handover — €6,453

Two demonstration tenants, one shop and one salon. Subjektiv runs the scenarios in Section 5 and delivers a short operating note: how to bring a tenant up, read the health check, roll a release back, restore a backup, and sign the model account in again.

For 30 calendar days after acceptance of M11, defects against those scenarios are corrected within the remaining cap. New functionality is not part of that correction period.

Staffing: Tech Lead 24 h, backend 48 h, frontend 16 h, DevOps 24 h, QA 80 h, project management 40 h.

---

## 5. Acceptance scenarios

1. A shared shop post ends as a local order, a Telegram card, and a KeyCRM record. The customer message contains no product identifier.
2. A tracking number that belongs to another buyer is not disclosed. A tracking number that belongs to this buyer is.
3. A free salon window creates a visit in the CRM.
4. A closed day for the professional does not create a visit.
5. A reschedule does not leave two active visits.
6. Confirmation of an existing visit does not create a new appointment.
7. A lead brief reaches Telegram and the CRM. A complaint produces one escalation card.
8. A manager reply from the Instagram application is visible in the admin and does not start a new generation.
9. After 14 days of silence, a new conversation starts.
10. Two tenants cannot see each other’s orders.
11. An expired model login does not send the customer a failure text. Managers receive an alert.
12. The conversation list and the conversation screen are usable at a width of 390 px.

---

## 6. Commercial terms

**Form.** Time and materials at the rates in Section 2, subject to a cap of €187,258.

**Invoices.** Monthly, for hours worked. Payment is due within 5 business days.

**Contingency.** €24,425 inside the cap is reserved for integration variance: undocumented CRM fields, differences between a sandbox and the live API, and corrections to echo handling and appointment slots after the first live week. Hours above the cap begin only after a written change.

**First payment.** **€17,400**, payable when the Statement of Work is signed. It is the price of Milestone 1 and is credited against that milestone. Later invoices follow the milestone amounts in Section 4.

**Milestone acts.** If the Statement of Work requires an acceptance act, the act amount is the milestone amount in Section 4. Contingency is not pre-allocated across acts. Unused contingency is not invoiced. The cap is a maximum.

**Fixed alternative.** The parties may instead fix the price at €187,258. In that case unused contingency is retained by Subjektiv, and Subjektiv does not invoice overruns up to the cap. Unless the Statement of Work says otherwise, this pre-estimate assumes time and materials with a cap.

**Intellectual property.** Rights in the code written under the Statement of Work pass to the Client when the accepted hours are paid. A rental or subscription offer is outside this document.

**Currency.** Invoices are issued in euro.

---

## 7. Included, excluded, and assumed

**Included.** Delivery of M1 through M11, verification of Section 5, the operating note, and 30 days of defect correction inside the cap.

**Excluded from hours and from the cap.**

- Claude subscription, servers, domains, certificates, and CRM or Meta account fees
- WhatsApp, Viber, and Telegram as a customer channel
- Shopify, Google Sheets, LiqPay, WayForPay, Fondy, Monobank, and creation of a shipping waybill
- CRM systems other than KeyCRM, CleverBOX, BeautyPro, and Altegio
- Memberships, group classes, prepayment, and refunds
- A third-party penetration test and a legal opinion on GDPR
- Authoring the prompt and catalog of one particular salon or shop

**Assumptions.**

- The Client names one person authorized to accept milestones.
- The Client provides the Meta business assets, the CRM credentials required by the scenarios, DNS, and server access in time for the relevant milestone.
- A delay in Client access extends the schedule and is not billed as worked time. If Subjektiv is asked to hold the team during that delay, the hold is estimated separately.
- Meta review or a BeautyPro marketplace grant may move months 2 through 5 without increasing the cap, provided the team is not held idle.
- The contingency covers variance inside this scope. It does not cover a new channel or a new business mode.

---

## 8. Incorporation into the Statement of Work

On execution, the Statement of Work will state the start date, the Client’s legal name, the billing contact, and whether the commercial form is time and materials with the cap in Section 6 or the fixed alternative. This pre-estimate is then incorporated by reference.

Work outside Section 4 is not authorized by this document.

---

## 9. Acknowledgement

| | Subjektiv | The Client |
|---|---|---|
| Name | | |
| Title | | |
| Signature | | |
| Date | | |

Signing this page acknowledges receipt of pre-estimate SJ-PE-2026-001. It does not by itself authorize the work or create a payment obligation. Authorization is the executed Statement of Work.
