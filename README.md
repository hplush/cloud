# h+h lab cloud server

Small hosting for non-critical websites such as:

1. Development preview of [Slow Reader](github.com/hplush/slowreader).
2. [Browserslist REPL](https://browsersl.ist/)
3. [Sitnik personal website](https://sitnik.es/)

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

Web services are publicly available Podman images.

When a new version of the image is published, GitHub Actions sends an HTTP request (we verify that the request came from GitHub and from the specific repository), Podman pulls the new version, starts it, runs the health check, and replaces the service on the domain.

### Database and Tooling

Databases and tools like Redis are Podman containers as well.

We use rolling tags like `:9` and update them automatically with Podman tools.

### Internal Web API

The CI endpoint is a custom HTTP server written in Node.js. We keep it as source files on the server and run it with the Node.js image.

Node.js is updated automatically.

## Deploy

We use Ansible to configure the services over an SSH session.
