# Production VPS Deployment

IntoTheBattle runs on one ordinary Linux VPS with Docker Compose:

- Caddy terminates HTTPS and proxies WebSocket traffic.
- The Node application runs as an unprivileged container.
- PostgreSQL and uploaded media use persistent Docker volumes.
- Restic can copy client-encrypted database and media backups to any
  S3-compatible storage provider.

The deployment is provider-neutral. Hostinger KVM, DigitalOcean, Hetzner, and
other Ubuntu VPS products work; no provider-specific API is required.

## Recommended Size

Start with at least 1 vCPU, 4 GB RAM, and 40 GB of SSD storage. The application,
PostgreSQL, FFmpeg, Caddy, and Docker all run on the same machine. Do not use a
free or sleeping web-service tier because TikTok LIVE and Socket.IO require a
continuously running process.

## 1. Bootstrap Ubuntu 24.04

Run these commands once as `root` or with `sudo`:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com -o /tmp/get-docker.sh
sudo sh /tmp/get-docker.sh
rm -f /tmp/get-docker.sh
sudo usermod -aG docker "$USER"
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

Sign out and back in after adding a non-root account to the Docker group.

## 2. Configure GitHub Deployment

Configure these repository variables:

- `VPS_HOST`: the new server's public IP address or hostname.
- `VPS_PORT`: SSH port, normally `22`.
- `VPS_USER`: deployment user, normally `root` on Hostinger or `ubuntu` on a
  cloud image.

Configure these repository secrets:

- `VPS_SSH_KEY`: the private deployment SSH key.
- `VPS_SSH_HOST_FINGERPRINT`: the trusted `SHA256:...` server fingerprint.
- `VPS_PRODUCTION_ENV`: the complete contents of `.env.production` for the new
  server. It is installed with mode `0600` and never printed.

Read the server fingerprint from the provider's console or, on the server:

```bash
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

The workflow scans the presented host keys and refuses the connection unless
one matches this pinned fingerprint. There is deliberately no default host IP.

Push to `main` or run **Production VPS Deploy** manually. The first deployment
creates `/opt/intothebattle`; later deployments make a verified database/media
backup before changing the release.

## 3. Point DNS at the New Server

After the deployment succeeds locally on the VPS, update the Hostinger DNS zone:

- Apex `A` record (`@`) -> the new IPv4 address.
- `www` `CNAME` -> `intothebattle.com`.
- Remove the obsolete `51.81.186.80` record.

Do not point DNS at a server until its SSH host key has been verified. Caddy
will obtain and renew TLS certificates after DNS reaches the new host.

## 4. Encrypted Off-Server Backups

The VPS provider's snapshot/weekly-backup option is the first recovery layer.
For independent recovery, create a private S3-compatible bucket and set:

```dotenv
OFFSITE_BACKUP_REQUIRED=true
RESTIC_REPOSITORY=s3:https://S3_ENDPOINT/BUCKET/intothebattle
RESTIC_PASSWORD=generate-a-long-unique-backup-password
AWS_ACCESS_KEY_ID=replace-me
AWS_SECRET_ACCESS_KEY=replace-me
AWS_DEFAULT_REGION=us-east-1
```

Run and verify a backup:

```bash
cd /opt/intothebattle
bash ./scripts/vps_backup.sh
```

Schedule it daily after a successful manual run:

```bash
(crontab -l 2>/dev/null; printf '%s\n' \
  '0 8 * * * cd /opt/intothebattle && bash ./scripts/vps_backup.sh >>/opt/intothebattle/backups/backup.log 2>&1') \
  | awk '!seen[$0]++' | crontab -
```

Restic encrypts the PostgreSQL dump, uploaded media archive, and checksums
before they leave the VPS. Keep `RESTIC_PASSWORD` in a password manager outside
both the VPS and the object-storage account; the backup cannot be restored
without it.

## 5. Recovery Verification

At least monthly, restore the newest snapshot into a temporary directory and
confirm both archives are readable before updating `BACKUP_RESTORE_VERIFIED_AT`:

```bash
cd /opt/intothebattle
docker run --rm --env-file .env.production \
  -v "$PWD/restore-test:/restore" \
  restic/restic:0.18.0 restore latest --target /restore
sha256sum -c restore/backup/sha256-*.txt
tar -tzf restore/backup/app-data-*.tgz >/dev/null
```

Importing a dump replaces live database state and must be performed only during
a deliberate maintenance window. Keep the restore test separate from the live
PostgreSQL volume.

## Rollback

The previous source release is retained under
`/opt/intothebattle.previous-<UTC timestamp>` for seven days. Database and media
state remain in Docker volumes. Restore state from the matching pre-deployment
backup if a release changed the database incompatibly.
