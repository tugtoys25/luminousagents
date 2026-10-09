# NDA and confidential data room

Buyer access requires a provisioned active buyer, verified session, accepted current NDA template, active opportunity publication/approval, unexpired opportunity-specific grant, sufficient access tier, and document scan status `clean`. Re-check all conditions on every download request. Revocation must affect the next request. Store the exact NDA template SHA-256 and salted IP hash with each acceptance. Provide signed-PDF upload as an alternative only after legal defines validation and retention rules. A typed-name acknowledgement is not a qualified electronic signature. The active NDA template and all legal wording require counsel approval before production.

Documents are private R2 objects, never public URLs. Release must verify a trusted scanner's completed clean verdict for the exact SHA-256. Do not log document contents, OTPs, secrets, or signed NDA contents.
