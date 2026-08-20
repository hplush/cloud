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

We use a separate user for each website.

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
5. Create an account with `sudo` for every admin from `group_vars/all.yml`
   and add their SSH key:

   ```sh
   ssh root@cloud.hplush.dev
   apt update && apt upgrade -y

   adduser ai
   usermod -aG sudo ai
   mkdir -p /home/ai/.ssh
   cp /root/.ssh/authorized_keys /home/ai/.ssh/
   chown -R ai:ai /home/ai/.ssh
   chmod 700 /home/ai/.ssh
   chmod 600 /home/ai/.ssh/authorized_keys
   ```

6. Generate the Ansible Vault password to `.vault-pass`:

   ```sh
   pnpm dlx nanoid --size 32 > .vault-pass
   chmod 600 .vault-pass
   ```

7. Encrypt the [Ubuntu Pro](https://ubuntu.com/pro) token and put the output
   to `group_vars/all.yml`:

   ```sh
   ansible-vault encrypt_string --name ubuntu_pro_token 'YOUR_TOKEN'
   ```

## Deploy Changes

The playbook connects as your own account, so tell SSH which one to use
in `~/.ssh/config`:

```
Host cloud.hplush.dev
  User ai
```

Then apply the changes and type your `sudo` password when Ansible asks:

```sh
ansible-playbook site.yml --ask-become-pass
```

The playbook is idempotent: it never resets which container currently
serves the domain.

## Add a Website

Copy `websites/hplush.dev.yml` to `websites/YOUR_DOMAIN.yml` and set the user,
the image, the GitHub repository, workflow, and branch allowed to deploy it,
the port the image listens on, and a free pair of host ports.

Every container gets 512 MB of memory, one CPU, and 512 processes, and a
read-only file system with a writable `/tmp`. A website which needs more
can change `memory`, `cpu`, or `tasks` in its config.

Then deploy changes.

### Deploy a Website from GitHub Actions

After publishing a new image, ask GitHub for an OIDC token and call
the deploy API:

```yaml
permissions:
  id-token: write
concurrency:
  group: deploy-hplush.dev
  cancel-in-progress: false
steps:
  # Some steps of preparing the image
  - name: Deploy
    uses: actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0
    with:
      script: |
        let token = await core.getIDToken('https://api.cloud.hplush.dev')
        let response = await fetch(
          'https://api.cloud.hplush.dev/deploy/hplush.dev',
          { method: 'POST', headers: { authorization: `Bearer ${token}` } }
        )
        if (!response.ok) core.setFailed(await response.text())
```

### Debug

Services run as separate users, so their logs are in the system journal:

```sh
sudo journalctl -u caddy
sudo journalctl _SYSTEMD_USER_UNIT=api.service
sudo journalctl _SYSTEMD_USER_UNIT=deploy.service
sudo journalctl _SYSTEMD_USER_UNIT=hplush-blue.service
```

To deploy manually, create the request file, which the website is waiting for:

```sh
sudo touch /var/lib/deploy/hplush.dev/requests/manual
```

The deploy script removes the file, writes the answer to
`/var/lib/deploy/hplush.dev/results/manual`, and prints the same log
to the journal.
