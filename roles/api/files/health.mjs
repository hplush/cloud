// Podman runs this as the health check of the API container. The hardened
// Node.js image has no `wget` and no `curl`, so we ask Node itself.
// A failed `fetch` rejects, and Node exits with an error on its own.

let response = await fetch(`http://127.0.0.1:${process.env.PORT || 8000}/health`)
process.exit(response.ok ? 0 : 1)
