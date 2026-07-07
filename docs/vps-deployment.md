# VPS Deployment

This deployment replaces Render with one VPS running:

- Caddy for HTTPS
- the Node app container
- a local Postgres container
- no Redis unless the app is scaled to multiple instances later

## First Deploy

On Ubuntu 24.04 LTS:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git ufw
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
```

Clone the repo, then run:

```bash
./scripts/vps_deploy.sh
```

The first run creates `.env.production` and exits. Edit that file, copy the production API/payment/email values from the old host, then run:

```bash
./scripts/vps_deploy.sh
```

## Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
```

## Backup

Run a manual backup:

```bash
./scripts/vps_backup.sh
```

Add a daily cron entry after the first successful deploy:

```bash
0 8 * * * cd /opt/intothebattle && ./scripts/vps_backup.sh >/opt/intothebattle/backups/backup.log 2>&1
```
