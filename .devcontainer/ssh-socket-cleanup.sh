#!/usr/bin/env bash
# Continuously remove the SSH auth sockets VSCode re-creates inside the container.
# Clearing SSH_AUTH_SOCK (see ssh-hardening.sh) loses the race against VSCode's
# re-injection, so we also delete the underlying socket files it points at.
# Launched in the background from postStartCommand (see .devcontainer.json).

set -u

while true; do
  find /tmp -maxdepth 2 \
    \( -name 'vscode-ssh-auth-*.sock' -o -name 'vscode-gpg-agent-*.sock' \) \
    -delete 2>/dev/null || true
  sleep 5
done
