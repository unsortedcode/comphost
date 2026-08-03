# Docker Compose Stacks

A **Stack** is a Docker Compose project managed entirely from this UI — no terminal
required. Each stack is a directory on the host containing a `compose.yaml` file.

## Creating a stack

1. Click **Add Stack**.
2. Give it a name (lowercase letters, numbers, hyphens, underscores).
3. Paste or write your Compose YAML in the editor.
4. Save — this writes the compose file to disk as a **draft**.

## Lifecycle actions

From a stack's actions menu:

- **Deploy** — `docker compose up -d` (creates and starts the stack).
- **Restart** — restart the running services.
- **Stop** — stop services without removing them.
- **Down** — stop and remove the stack's containers.
- **Update** — pull the latest images, then redeploy.

## Status

- **Draft** — compose file saved but never deployed.
- **Created** — created in Docker but not running.
- **Running** — all services up.
- **Exited** — one or more services have exited.
