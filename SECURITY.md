# Security

Report suspected vulnerabilities privately to **admin@d9911.org**. Include the affected version, steps to reproduce and impact. Do not attach live keys, OAuth tokens or personal files. Avoid disclosing an exploitable issue publicly before contacting the maintainer.

## Deployment configuration

- Keep `.env`, `FILES_API_KEY`, `FILES_READONLY_API_KEY`, database credentials and `YANDEX_DISK_OAUTH_TOKEN` outside source control. Never put server credentials into static UI assets.
- Standalone API keys grant access across the instance. Use the Timepost Accounts/Projects mode for user/project authorization; do not expose shared owner keys in a public demo.
- The standalone Compose port binds to loopback. For external access, configure HTTPS through a reverse proxy and restrict API access to intended users.
- The UI keeps the access key in tab memory. Local storage contains only language and theme preferences. Reloading clears the in-memory key.
- UI assets use an explicit server allowlist and a same-origin Content Security Policy. Files remain behind API authorization; metadata and object bytes are separate from public icons/screenshots.
- A web manifest and icon set do not provide offline functionality. No service worker caches authenticated API responses.

The local simulator is intended for local development or a managed filesystem deployment. Back up metadata and objects together. Real Yandex Disk operation requires a server-side OAuth token; it is not enabled by supplying a key in the browser.
