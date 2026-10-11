# Owner decisions needed

The team must not guess these. Each row says what it blocks and a recommended default to react to.
Record the answer, the date and who decided, then update `DECISIONS.md`.

| # | Decision | What it blocks | Recommended default | Answer / date |
| --- | --- | --- | --- | --- |
| 1 | **Decision 3.** The blueprint records the owner's third decision as blank. | Anything it affects | Supply it; do not infer it | |
| 2 | **Staff MFA.** Required for all staff, required for admin roles only, optional, or accepted risk with a named owner? Cloudflare Access is not being used. | Launch hardening; session and login work | Require authenticator-app MFA for `super_admin` and `admin` at minimum | |
| 3 | **Compliance role.** Is a separate `compliance` role needed for NDA review and tier-3 approval, or do existing roles cover it? | Role matrix sign-off; NDA review ownership | Add a dedicated role if one person must review NDAs without full admin rights | |
| 4 | **Access tier 3.** Is it required, and which fields and documents does each tier allow? The code makes tier 3 super-admin only. | Data-room policy | Write the field and document matrix per tier before any tier-3 grant is made | |
| 5 | **Media permissions.** Which roles may make an image private, change its public URL, and delete media that is still referenced? | Media policy sign-off | Publisher and above may change visibility; only admin may delete referenced media after unlinking | |
| 6 | **Sold listings.** Are sold listings a public track record? 71 legacy listings are sold. | Whether they are ever published, and how | Keep private until decided; if published, hide all amounts | |
| 7 | **NDA.** Counsel-approved text, accepted signature method, named approver, and buyer-verification owner. | Any buyer NDA flow (none is active today) | Counsel approves the text, then upload it as the managed template and activate it | |
| 8 | **Regulatory scope.** AML, KYC, sanctions and gaming-regulation obligations and disclaimer. | Launch | Obtain written counsel advice | |
| 9 | **Listing rights.** Authority to market each listing and rights to each image and document. | Publishing any listing | Require a recorded decision per listing before approval | |
| 10 | **Service levels.** Enquiry response target and who owns the on-call and incident roles. | Monitoring and alerts | Name one primary and one backup owner | |
| 11 | **Retention.** How long to keep enquiries, NDA records, audit logs and backups, and how deletion requests are handled. | Privacy policy; backup policy | Agree a schedule with counsel | |
