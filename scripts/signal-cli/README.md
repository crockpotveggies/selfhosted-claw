# Managed Signal Bridge

Self-Hosted Claw can launch this stack from the setup wizard after you capture:

- `SIGNAL_ACCOUNT`
- `SIGNAL_RPC_URL`

The wizard writes `scripts/signal-cli/.env` and runs:

```bash
docker compose -f scripts/signal-cli/docker-compose.yml --env-file scripts/signal-cli/.env up -d
```

The managed bridge binds only to `127.0.0.1` and stores Signal state under the host admin data directory, not inside the repo.

The setup wizard can also drive:

- QR-code device linking for an existing Signal account
- SMS or voice registration for a brand-new Signal account

You still need to complete the human step by scanning the QR code or entering the verification code before the bridge can exchange real messages.
