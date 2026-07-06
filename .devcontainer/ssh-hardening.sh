# shellcheck shell=bash
# Neutralize VSCode's automatic SSH/GPG agent forwarding inside this dev container.
#
# The Dev Containers extension forwards the host SSH agent automatically (whenever
# one is running) by creating a socket in the container and injecting SSH_AUTH_SOCK.
# It re-injects this when spawning new processes, so clearing it once is not enough —
# this file is sourced from the TOP of ~/.bashrc (before the interactive-shell guard)
# so it also runs for the non-interactive login shells that tools/agents use.

export SSH_AUTH_SOCK=
export GPG_AGENT_INFO=
unset SSH_AGENT_PID 2>/dev/null || true

# Optional: also cut the channel back to the host VSCode instance. Uncomment if you
# want a coding agent in this container fully isolated from the host editor.
# unset VSCODE_IPC_HOOK_CLI 2>/dev/null || true
