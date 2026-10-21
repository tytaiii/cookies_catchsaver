# Changelog

## 1.3.0 — 2026-10-22

- Renew stored session cookies from Set-Cookie responses, including within redirect chains.
- Capture the browser User-Agent and basic client hints when the extension writes cookies.
- Add optional SMTP alerts for expired sessions and invalid URLs, with status and test endpoints.
- Add authentication failure limits, optional access-token expiration, and authenticated extension binding.
- Add optional Space token protection for listing, downloading, and deleting files.
- Add configurable web labels, bilingual configuration instructions, an example mail configuration, and six local integration tests.
- Preserve HTTPS service URL validation and exact destination checks for credential-bearing requests.
- Reset token age on regeneration, keep renewed cookies encrypted, and remove Space bootstrap tokens from visible URLs.

SMTP delivery is tested with a local protocol fixture. Configure and test your own implicit-TLS SMTP account before relying on email alerts.
