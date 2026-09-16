# h+h lab cloud server

Small hosting for non-critical websites:

1. [h+h lab landing](https://hplush.dev/)
1. Development preview of [Slow Reader](https://github.com/hplush/slowreader)
1. [Browserslist REPL](https://browsersl.ist/)
1. [Sitnik personal website](https://sitnik.es/)
1. [Logux website](https://logux.org/)

Stack:

- Ubuntu 26.04 LTS + Canonical Livepatch
- Ansible
- Rootless Podman/Quadlet for each service
- gVisor for the pull request previews
- Caddy web server and load balancer

## Goals

1. Automatic updates for low maintenance.
2. Accept downtime, but keep it short.
3. No backups or duplication needed.

## Services

All services run under systemd with auto-restart.

Each website has a separate user and can run multiple apps. Each app has
its own image, containers, domain, and deployment.

### Web Service

Web services use public Podman images. Containers are read-only, have no
capabilities, and limit memory, CPU, and processes to protect the server.

Images should define a `HEALTHCHECK`. Podman kills unresponsive containers;
systemd restarts them. Old deployment images are removed nightly.

After publishing an image:

1. GitHub Actions sends an HTTP request; we verify its GitHub origin and repository.
2. Podman pulls and starts the image, checks its health, and switches the domain to it.
3. The API waits for deployment and returns its log. Broken images fail the workflow.

### Database and Tooling

Databases and tools like Redis also run in Podman, with rolling tags
such as `:9` updated automatically by Podman tools.

Each database belongs to one website and exposes no host port. It listens
only on a private Podman network inside that user’s network namespace.

### Pull Request Previews

A pull request can run a single image on its own subdomain,
such as `preview-42.slowreader.hplush.dev`.

Because pull request code is unreviewed, previews have:

- A separate user, no database, no shared network, and no host access.
- A shared memory limit for all previews.
- Routes written by the root `preview-route` wrapper, never the preview user.
  The wrapper validates the PR number and port, then uses its own Caddy template.
- gVisor, a userspace kernel, to handle syscalls. Escaping a regular container
  can require only a host kernel bug; previews require a gVisor bug as well.

Network syscalls use the host kernel within each preview’s own network
namespace, not the host’s network namespace. The user’s firewall rules still
apply. This is needed because gVisor’s network stack cannot use pasta’s tap
device, which would leave published ports unreachable.

gVisor costs memory and network throughput. Websites and databases keep
the default runtime because we build their images ourselves.

Previews stop when their PR closes. A daily timer also removes previews
not redeployed for `max_days` days (default: 30), limiting their lifetime even
if the cleanup workflow fails.

### Internal Web API

The deploy API is a custom Node.js HTTP server. Its source files live on
the server and run in an automatically updated Node.js image.

## Files

- `inventory.yml`: server address and SSH account.
- `requirements.txt`: Ansible CLI versions.
- `requirements.yml`: Ansible collection versions.
- `.vault-pass`: Ansible Vault password; create locally, excluded from Git.
- `group_vars/all.yml`: server-wide settings.
- `websites/`: one config per website, named after its domain.
- `previews/`: one config per preview type, named after its parent domain.
- `site.yml`: playbook calling all roles.
- `roles/base/`: updates, Livepatch, `fail2ban`, firewall, Podman, gVisor,
  users, journal limits, and daily image cleanup.
- `roles/caddy/`: Caddy and domain configs.
- `roles/api/`: internal web API for GitHub Actions.
- `roles/web/`: website user, two containers, and deploy script.

## Prepare the Server

1. Create a cheap server with 4 GB memory and Ubuntu 26.04 LTS.
2. Create firewall rules:
   - Public: `ICMP`, `TCP 80`, `TCP 443`, `UDP 443` (HTTP/3 QUIC)
   - Admin IP only: `TCP 22`
3. Add `A` and `AAAA` DNS records for `hplush.dev`.
4. Add `CNAME` records for `cloud` and `api.cloud` pointing to `hplush.dev`.
5. Update the system:

   ```sh
   ssh root@cloud.hplush.dev
   apt update && apt upgrade -y
   sudo reboot now
   ```

6. Create the admin user:

   ```sh
   ssh root@cloud.hplush.dev
   adduser ai
   usermod -aG sudo ai
   mkdir -p /home/ai/.ssh
   cp /root/.ssh/authorized_keys /home/ai/.ssh/
   chown -R ai:ai /home/ai/.ssh
   chmod 700 /home/ai/.ssh
   chmod 600 /home/ai/.ssh/authorized_keys
   exit
   ```

7. Create `known_hosts`:

   ```sh
   ssh-keyscan cloud.hplush.dev > known_hosts
   ssh-keygen -lf known_hosts
   ```

8. Generate the Ansible Vault password in `.vault-pass`:

   ```sh
   pnpm dlx nanoid --size 32 > .vault-pass
   chmod 600 .vault-pass
   ```

9. Encrypt the [Ubuntu Pro](https://ubuntu.com/pro) token and add the output
   to `group_vars/all.yml`:

   ```sh
   ansible-vault encrypt_string --name ubuntu_pro_token 'YOUR_TOKEN'
   ```

## Deploy Changes

Deploy, entering the server user’s password when prompted:

```sh
ansible-playbook site.yml --user ai --ask-become-pass
```

The playbook is idempotent and preserves the container serving each domain.

## Add a Website

1. Copy `websites/hplush.dev.yml` to `websites/YOUR_DOMAIN.yml`.
2. Set the user, image, allowed GitHub repository/workflow/branch,
   container port, and a free pair of host ports.
3. Point the domain’s `A` and `AAAA` records to the server and deploy changes.

Default container limits: 512 MB memory, one CPU, and 512 processes.

Caddy requests a Let's Encrypt certificate on the first request;
HTTPS requires working DNS.

### Deploy a Website from GitHub Actions

After publishing an image, get a GitHub OIDC token and call the deploy API.
Each app deploys independently through its domain endpoint, which accepts
only its configured workflow:

```yaml
permissions:
  id-token: write
concurrency:
  group: deploy-hplush.dev
  cancel-in-progress: false
steps:
  # Some steps of preparing the image
  - name: Deploy image
    uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
    with:
      script: |
        let token = await core.getIDToken('https://api.cloud.hplush.dev')
        let response = await fetch(
          'https://api.cloud.hplush.dev/deploy/hplush.dev',
          { method: 'POST', headers: { authorization: `Bearer ${token}` } }
        )
        let answer = await response.text()
        if (response.ok) core.info(answer)
        else core.setFailed(`${response.status} ${response.statusText}: ${answer}`)
```

See [full example](./docs/workflow.yml).

## Add Pull Request Previews

1. Copy `previews/slowreader.hplush.dev.yml` and configure it.
2. Point wildcard `A` and `AAAA` records for `*.YOUR_DOMAIN` to the server.
3. Create a `preview` label; apply it to PRs only after basic review.
4. Use a `pull_request` workflow without permissions to build a Docker image
   and upload it as an artifact.
5. Use a `workflow_run` workflow to download the artifact, push it with
   a preview tag, and request deployment. The server verifies the workflow:

```yaml
# Download artifact from pull_request workflow and push it with tag
- name: Deploy the preview
  uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
  with:
    script: |
      let token = await core.getIDToken('https://api.cloud.hplush.dev')
      let response = await fetch(
        `https://api.cloud.hplush.dev/deploy/preview-${process.env.PR}.slowreader.hplush.dev`,
        { method: 'POST', headers: { authorization: `Bearer ${token}` } }
      )
      let answer = await response.text()
      if (response.ok) core.info(answer)
      else core.setFailed(`${response.status} ${response.statusText}: ${answer}`)
```

On PR close, a `pull_request` workflow with type `closed` triggers
a `workflow_run` workflow that sends `DELETE` to the same endpoint:

```yaml
- name: Clean the preview
  uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
  with:
    script: |
      let token = await core.getIDToken('https://api.cloud.hplush.dev')
      let response = await fetch(
        `https://api.cloud.hplush.dev/deploy/preview-${process.env.PR}.slowreader.hplush.dev`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }
      )
      let answer = await response.text()
      if (response.ok) core.info(answer)
      else core.setFailed(`${response.status} ${response.statusText}: ${answer}`)
```

Both requests wait for the result; a preview startup failure fails the workflow.

See examples:

1. [`preview-prepare.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-prepare.yml)
2. [`preview-deploy.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-deploy.yml)
3. [`preview-close.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-close.yml)
4. [`preview-clean.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-clean.yml)

## Maintenance

Automatic updates:

- `unattended-upgrades` installs packages nightly.
- `needrestart` restarts services using old libraries.
- Livepatch patches the running kernel.

These never reboot the server; new kernels require a manual reboot.
Check monthly. SSH logins show `*** System restart required ***` when
needed. Inspect pending restarts:

```sh
ssh ai@cloud.hplush.dev
sudo needrestart -r l
```

Reboot to use the new kernel:

```sh
sudo reboot
```

If the kernel needs no reboot, restart everything listed, including user
managers. Websites will be down for a few seconds:

```sh
sudo needrestart -b -r l | awk -F': ' '/^NEEDRESTART-SVC/{print $2} /^NEEDRESTART-SESS/{split($2,u," ");c="id -u "u[1];c|getline i;close(c);print "user@"i".service"}' | sort -u | xargs -r sudo systemctl restart
```

### Debug

Find failed services:

```sh
systemctl --failed
```

Services run as separate users; read their logs in the system journal:

```sh
sudo journalctl -u caddy
sudo journalctl _SYSTEMD_USER_UNIT=api.service
sudo journalctl _SYSTEMD_USER_UNIT=deploy-hplush.service
sudo journalctl _SYSTEMD_USER_UNIT=hplush-blue.service
sudo journalctl _SYSTEMD_USER_UNIT=slowreader-db.service
sudo journalctl _SYSTEMD_USER_UNIT=preview-42.service
```

Units use app names: `slowreader-server` has
`slowreader-server-blue.service` and `deploy-slowreader-server.service`.

Open a website’s database:

```sh
sudo -u slowreader podman exec -it slowreader-db psql -U slowreader
```

Deploy manually by creating a request file:

```sh
sudo touch /var/lib/deploy/hplush.dev/requests/manual
```

Start or stop a preview manually:

```sh
echo 'deploy 42' | sudo tee /var/lib/deploy/previews/slowreader.hplush.dev/requests/manual
echo 'clean 42' | sudo tee /var/lib/deploy/previews/slowreader.hplush.dev/requests/manual
```

The deploy script removes the request file, writes the result to
`/var/lib/deploy/hplush.dev/results/manual`, and logs it to the journal.
