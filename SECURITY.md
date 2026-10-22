# Security policy

## Reporting

Please use GitHub's **private vulnerability reporting** on this repository. Do not
open a public issue for a security problem. Include the affected version, a
reproduction and the impact.

## Supported versions

Only the latest release receives security fixes.

## Known limitations (by design, for now)

- **No end-to-end encryption.** The server stores messages and attachments in
  plaintext; the operator can read them.
- **No password reset flow.** Account recovery is manual by the operator.
- **Mesh calls.** Calls are peer-to-peer with a practical limit of about 4–6
  participants; there is no SFU.
- **Self-signed or IP certificates** work in the Android shell but are not
  recommended for public instances.
- The Android app is a WebView shell; its security depends on the WebView and the
  server it points at.

## Operator checklist

- HTTPS/WSS only; keep the CSP and other headers enabled.
- Strong admin password; do not reuse it.
- Keep `data/` and backups private (they contain message content).
- Run the latest release and back up before upgrading.
- Restrict the admin console at the proxy if the instance is public.
