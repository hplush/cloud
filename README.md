# h+h lab cloud server

Small hosting for non-critical websites such as:

1. [h+h lab landing](https://hplush.dev/)
1. Development preview of [Slow Reader](github.com/hplush/slowreader)
1. [Browserslist REPL](https://browsersl.ist/)
1. [Sitnik personal website](https://sitnik.es/)

It is based on:

- Ubuntu 26.04 LTS + Canonical Livepatch
- Ansible
- Rootless Podman/Quadlet for each service
- Caddy web server as a balancer

## Goals

1. Automatic updates. Keep maintenance time low.
2. Since these are not critical services, downtime is acceptable. But it should be as short as possible.
3. No need for backups or duplication.

## Services

Each service is a systemd service with auto-restart.

We use a separate user for each website. A website can run several apps
under this user. Every app has its own image, containers, domain, and deploy.

### Web Service

Web services are publicly available Podman images. The container is read-only,
without capabilities, and with limits on memory, CPU, and processes, so one
website can’t take the server down with it.

The image should define a `HEALTHCHECK`. Podman runs it and kills a container
which stops answering, so systemd can start it again. The images left from
the previous deploys are removed every night.

When a new version of the image is published, GitHub Actions sends an HTTP request (we verify that the request came from GitHub and from the specific repository), Podman pulls the new version, starts it, runs the health check, and replaces the service on the domain.

The request waits until the deploy finishes and answers with its log, so a broken image fails the workflow instead of staying unnoticed.

### Database and Tooling

Databases and tools like Redis are Podman containers as well.

We use rolling tags like `:9` and update them automatically with Podman tools.

A database belongs to one website and publishes no port to the host. It only
listens in a private Podman network, which is inside the network namespace of
the website’s user.

### Pull Request Previews

A pull request of a project can get its own subdomain running single image, like `preview-42.slowreader.hplush.dev`.

The code in a pull request is not reviewed yet, so previews live in
their own user, far from the websites: no database, no shared network,
no access to the host, and their own memory limit for all of them
together. The preview user never writes Caddy config itself: it asks
the root `preview-route` wrapper, which validates the pull request
number and the port and writes the route from its own template.

A preview stops with its pull request, and a daily timer also cleans
every preview which nobody redeployed for `max_days` (30 by default),
so a failed clean workflow can’t leave unreviewed code running forever.

### Internal Web API

The deploy API is a custom HTTP server written in Node.js. We keep it as source files on the server and run it with the Node.js image.

Node.js is updated automatically.

## Files

- `inventory.yml`: the server address and the account for the SSH connection.
- `requirements.txt`: the versions of the Ansible CLI.
- `requirements.yml`: the versions of the Ansible collections.
- `.vault-pass`: the Ansible Vault password. Not in Git, create it locally.
- `group_vars/all.yml`: server-wide settings.
- `websites/`: one config per website, named after its domain.
- `previews/`: one config per kind of pull request preview, named after
  the domain of their subdomains.
- `site.yml`: the playbook, which calls all roles.
- `roles/base/`: updates, Livepatch, `fail2ban`, firewall, Podman, users,
  journal limits, and the daily cleanup of old images.
- `roles/caddy/`: Caddy and the domain configs.
- `roles/api/`: the internal web API for GitHub Actions.
- `roles/web/`: a user, two containers, and the deploy script for a website.

## Prepare the Server

1. Create some cheap server with 4 GB memory and Ubuntu 26.04 LTS.
2. Create firewall rules:
   - `ICMP` open for everyone
   - `TCP 80` open for everyone
   - `TCP 443` open for everyone
   - `UDP 443` open for everyone, for QUIC of HTTP/3
   - `TCP 22` only for admin’s IP address
3. Add `A` and `AAAA` DNS record for `hplush.dev`.
4. Add `CNAME` for `cloud` and `api.cloud` to `hplush.dev`.
5. Update system:

   ```sh
   ssh root@cloud.hplush.dev
   apt update && apt upgrade -y
   sudo reboot now
   ```

6. Create users:

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

8. Generate the Ansible Vault password to `.vault-pass`:

   ```sh
   pnpm dlx nanoid --size 32 > .vault-pass
   chmod 600 .vault-pass
   ```

9. Encrypt the [Ubuntu Pro](https://ubuntu.com/pro) token and put the output
   to `group_vars/all.yml`:

   ```sh
   ansible-vault encrypt_string --name ubuntu_pro_token 'YOUR_TOKEN'
   ```

## Deploy Changes

Run deploy and type server’s user password when Ansible asks:

```sh
ansible-playbook site.yml --user ai --ask-become-pass
```

The playbook is idempotent: it never resets which container currently
serves the domain.

## Add a Website

Copy `websites/hplush.dev.yml` to `websites/YOUR_DOMAIN.yml` and set the user,
the image, the GitHub repository, workflow, and branch allowed to deploy it,
the port the image listens on, and a free pair of host ports.

By default, every container gets 512 MB of memory, one CPU, and 512 processes.

Add `A` and `AAAA` DNS records for the domain to the server, and then deploy
changes. Caddy asks Let's Encrypt for the certificate on the first request,
so HTTPS only works after the DNS is ready.

### Deploy a Website from GitHub Actions

After publishing a new image, ask GitHub for an OIDC token and call
the deploy API. The endpoint is the domain of the app, and the API accepts
the request only from the workflow in its config, so every app deploys
on its own:

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

## Add Pull Request Previews

Copy `previews/slowreader.hplush.dev.yml` and set values. Add `A` and `AAAA`
DNS wildcard records for `*.YOUR_DOMAIN` to the server.

You mus create `preview` tag to enable preview for the PR only after basic
review.

Workflow on `pull_request` without permissions should build Docker image
and upload it to artifacts. Then `workflow_run` workflow should download
artifact, push it with a preview tag and send HTTP request (this server will validate that request came from specific workflow).

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

When PR will be closed, `pull_request` workflow with `closed` type will trigger `workflow_run` workflow which will send `DELETE` to the same
address.

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

Both wait for the answer, so a preview which does not start fails the workflow.

See examples:

1. [`preview-prepare.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-prepare.yml)
2. [`preview-deploy.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-deploy.yml)
3. [`preview-close.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-close.yml)
4. [`preview-clean.yml`](https://github.com/hplush/slowreader/blob/main/.github/workflows/preview-clean.yml)

## Maintenance

The server updates itself: `unattended-upgrades` installs the packages every
night, `needrestart` restarts the services which still hold an old library,
and Livepatch fixes the running kernel. None of this reboots the server,
so a new kernel waits until we reboot it by hand.

Once a month is good to check does server need a restart to use new kernel.

Every SSH login prints `*** System restart required ***` when a reboot is
needed. To ask for it and to see what waits for it:

```sh
sudo needrestart -r l
```

The websites are down for a minute:

```sh
sudo reboot
```

### Debug

Find failed service:

```sh
systemctl --failed
```

Services run as separate users, so their logs are in the system journal:

```sh
sudo journalctl -u caddy
sudo journalctl _SYSTEMD_USER_UNIT=api.service
sudo journalctl _SYSTEMD_USER_UNIT=deploy-hplush.service
sudo journalctl _SYSTEMD_USER_UNIT=hplush-blue.service
sudo journalctl _SYSTEMD_USER_UNIT=slowreader-db.service
sudo journalctl _SYSTEMD_USER_UNIT=preview-42.service
```

The units are named after the app, so an app named `slowreader-server` has
`slowreader-server-blue.service` and `deploy-slowreader-server.service`.

To open the database of a website:

```sh
sudo -u slowreader podman exec -it slowreader-db psql -U slowreader
```

To deploy manually, create the request file, which the website is waiting for:

```sh
sudo touch /var/lib/deploy/hplush.dev/requests/manual
```

To start or to stop a preview by hand, write the request file yourself:

```sh
echo 'deploy 42' | sudo tee /var/lib/deploy/previews/slowreader.hplush.dev/requests/manual
echo 'clean 42' | sudo tee /var/lib/deploy/previews/slowreader.hplush.dev/requests/manual
```

The deploy script removes the file, writes the answer to
`/var/lib/deploy/hplush.dev/results/manual`, and prints the same log
to the journal.
