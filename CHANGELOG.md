# Changelog

## 1.3.1 — 2026-10-22

- Serialize requests per site so concurrent agents use each newly rotated session.
- Persist cookie renewal before later redirects or response body reads can fail.
- Prevent in-flight responses from overwriting manually replaced credentials.
- Retry failed alert deliveries on a later check; start alert throttling only after successful delivery.
- Support direct local service URLs in both extension panels and restrict automatic site selection to an exact origin.
- Forward the HTTPS protocol in nginx examples and generated locations so Space can set Secure cookies.
- Add regression coverage: 12 tests pass, plus a local real-TLS SMTP check that accepts a trusted certificate and rejects an untrusted one.

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
