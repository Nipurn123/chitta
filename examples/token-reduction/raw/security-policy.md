# Information Security Policy

This policy applies to every employee, contractor, and system at Acme. Security is a shared responsibility, and the controls below are mandatory, not advisory.

## Access control

Access follows least privilege: you get the minimum needed to do your job, and nothing more. Every access grant is tied to a role, reviewed quarterly, and revoked automatically when someone changes teams. Production data access requires a documented business reason and is logged. No human has standing access to raw customer data; access is granted just-in-time and expires.

## Authentication

All accounts require hardware-backed multi-factor authentication. Passwords must be generated and stored in the company password manager; reused or memorized passwords are a policy violation. Service-to-service calls authenticate with short-lived tokens, never long-lived API keys committed to source.

## Data handling

Customer data is classified as restricted by default. Restricted data may never leave approved systems, be pasted into third-party tools, or be used in a prompt to an external model without an approved data-processing agreement. Encrypt restricted data at rest and in transit. Delete it when the retention window closes; do not keep it "just in case."

## Incident reporting

If you suspect a breach, a leaked credential, or any unauthorized access, report it within one hour to the security channel - do not investigate alone and do not wait until you are sure. Early false alarms are free; late real incidents are expensive. The security team runs the response; your job is to report fast and preserve evidence.

## Vendor and supply chain

New vendors that touch customer data go through a security review before any contract is signed. Dependencies are pinned and scanned; a new dependency in a pull request needs a reviewer to confirm it is maintained and necessary. Never add a package to work around a problem you could solve in a few lines of your own code.

## Phishing and social engineering

Treat unexpected links and attachments as hostile, especially ones that create urgency. Acme will never ask for your password or MFA code over chat or email. When in doubt, verify through a second channel before acting.
