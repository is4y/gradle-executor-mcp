#!/usr/bin/env bash
# One-time (per container) setup: source ssh-hardening.sh from the TOP of the shell
# rc files. It must be prepended, not appended — the default ~/.bashrc returns early
# for non-interactive shells, so anything after that guard never runs for agents.
# Run from postCreateCommand (see .devcontainer.json). Idempotent.

set -euo pipefail

HARDEN_SRC="${HARDEN_SRC:-/workspaces/default/.devcontainer/ssh-hardening.sh}"
MARKER="# >>> dev-container ssh-agent hardening >>>"

prepend_block() {
  local rc="$1"
  [ -e "$rc" ] || : > "$rc"
  if grep -qF "$MARKER" "$rc" 2>/dev/null; then
    return 0
  fi
  local tmp
  tmp="$(mktemp)"
  {
    printf '%s\n' "$MARKER"
    printf '[ -r %q ] && . %q\n' "$HARDEN_SRC" "$HARDEN_SRC"
    printf '%s\n\n' "# <<< dev-container ssh-agent hardening <<<"
    cat "$rc"
  } >"$tmp"
  mv "$tmp" "$rc"
}

# .bashrc covers interactive + non-interactive bash; the login files cover login shells.
prepend_block "$HOME/.bashrc"
prepend_block "$HOME/.bash_profile"
prepend_block "$HOME/.profile"

echo "ssh-agent hardening installed (SSH_AUTH_SOCK / GPG agent neutralized)."
