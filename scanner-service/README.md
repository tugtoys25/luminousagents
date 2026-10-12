# Free malware scanner for the data room

The Worker does not scan files itself. It sends each uploaded document to a scanner
service and accepts only a **signed** "clean" answer. This folder is that service:
ClamAV (free, open source) plus a small signed-result adapter. Nothing is sent to a
third party.

## 1. Install (once, inside Debian)

    apt update && apt install -y clamav clamav-freshclam openssl curl

You need about 1.5 GB of free RAM while ClamAV runs.

## 2. Free public address (once)

Cloudflare must be able to reach the scanner over HTTPS. A free quick tunnel does this:

    # 64-bit phones (arm64):
    curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared

(On a PC or server use the `amd64` file instead.)

## 3. Run the scanner

    cd /data/data/com.termux/files/home/casinosofmayfair
    bash scanner-service/start.sh

First run downloads virus definitions (a few minutes). Leave it running. It prints a
line like `https://something-random.trycloudflare.com`: that is your scanner URL.
Your token and signing secret are in `~/.mayfair-scanner/secrets.env`.

## 4. Tell the Worker (staging)

Run each command and paste the value when asked:

    pnpm exec wrangler secret put MALWARE_SCANNER_API_URL --env staging
    pnpm exec wrangler secret put MALWARE_SCANNER_API_TOKEN --env staging
    pnpm exec wrangler secret put MALWARE_SCANNER_SIGNING_SECRET --env staging
    pnpm exec wrangler secret put MALWARE_SCANNER_PROVIDER --env staging

- URL: the trycloudflare address (no trailing slash needed)
- Token: `SCANNER_TOKEN` from secrets.env
- Signing secret: `SCANNER_SIGNING_SECRET` from secrets.env
- Provider: `clamav-selfhosted`

## 5. Use it

Dashboard, Data room documents: upload a file (it starts as `pending`), then press
**Scan** on its row (admin or super admin). A clean result releases it to buyers who
have an approved NDA. A malicious result marks it `rejected`. If the scanner is off,
the file stays unavailable (it fails closed).

## Good to know

- A quick tunnel gets a new address each time it restarts. Repeat step 4 for the URL.
  For a permanent address use a named Cloudflare tunnel, or run this on a small
  always-on server (for example an Oracle Cloud Always Free VM).
- Keep the scanner running whenever staff need to scan.
- Check it: `curl http://127.0.0.1:8787/health` should print `{"ok":true}`.
- If ClamAV refuses to start as root, create a normal user (`adduser scanner`), run
  `start.sh` as that user, and remove the `User root` lines it writes.
- Tests: `pnpm test:node` includes `test/unit/scanner-service-security-invariants.test.ts`, which checks
  this service against the Worker's own verifier using a fake ClamAV.
