# Deploying

The server is a single Node process that serves the API and the built web
client. State lives in one SQLite file under `DATA_DIR`.

## systemd user unit (development box)

```sh
pnpm install && pnpm build
mkdir -p ~/.config/systemd/user ~/.local/share/love-letter
cp deploy/love-letter.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now love-letter
journalctl --user -u love-letter -f
```

Update: `git pull && pnpm install && pnpm build && systemctl --user restart love-letter`.

## Environment

| Variable         | Default                       | Meaning                                             |
| ---------------- | ----------------------------- | --------------------------------------------------- |
| `PORT`           | `8080`                        | TCP port                                            |
| `HOST`           | `0.0.0.0`                     | Bind address                                        |
| `DATA_DIR`       | `./data`                      | Where the SQLite database lives                     |
| `BASE_URL`       | request origin                | Public URL used in the text instructions and links  |
| `WEB_DIST`       | `packages/web/dist`           | Built web client; API-only if missing               |
| `ROOM_TTL_HOURS` | `48`                          | Idle rooms older than this are deleted              |

Set `BASE_URL` when running behind a reverse proxy so the `curl` instructions
show the public address.

## Public hosting on a small VPS

The public site runs on a small VPS behind a Cloudflare Tunnel, so the server
has no ports open to the internet (SSH is restricted to a private network).
A development copy runs on a separate machine on a private network.

Layout on the VPS, one unprivileged user per concern:

- the app user: the game as a rootless Podman quadlet
  (`~/.config/containers/systemd/love-letter.container`), image
  `localhost/love-letter`, published on `127.0.0.1:8080` only, SQLite in
  `~/data`, read-only root filesystem, all capabilities dropped,
  `UserNS=keep-id:uid=1000` so the container's `node` user owns `~/data`.
- an ingress user: cloudflared as a rootless quadlet with `Network=host`, config
  and the single-tunnel credential in `~/.config/cloudflared` (mode 600). Each
  hosted app is one `hostname:` line in its `config.yml`.

Deploy a new build from the development box (no registry needed):

```sh
podman build -t love-letter .
podman save --format oci-archive love-letter | zstd -T0 | ssh app@host 'zstd -d | podman load'
ssh app@host 'XDG_RUNTIME_DIR=/run/user/$(id -u) systemctl --user restart love-letter'
```

Read the database on the server: `ssh app@host sqlite3 data/love-letter.sqlite`.

Adding another app follows the same recipe: new user with `loginctl enable-linger`,
a quadlet publishing on a loopback port, and one more hostname in the ingress config.

The API applies small per-IP limits (20 rooms a minute, 300 writes a minute,
16 KB bodies) and a cap on live rooms (`MAX_ROOMS`, default 2000); rooms
expire after `ROOM_TTL_HOURS` (default 48) of inactivity.
