#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMAND="$ROOT/bin/ai-review"
BIN_DIR="${AI_REVIEW_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/ai-review"

if [[ ! -f "$COMMAND" ]]; then
  echo "install-ai-review: missing $COMMAND" >&2
  exit 1
fi

chmod +x "$COMMAND"
mkdir -p "$BIN_DIR"
ln -sfn "$COMMAND" "$TARGET"

echo "Installed $TARGET -> $COMMAND"

path_has_bin_dir() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

append_path_export() {
  local rc="$1"
  local marker="# ai-review command"
  local export_line="export PATH=\"$BIN_DIR:\$PATH\""
  if [[ -f "$rc" ]] && grep -F "$BIN_DIR" "$rc" >/dev/null 2>&1; then
    return 0
  fi
  {
    echo ""
    echo "$marker"
    echo "$export_line"
  } >> "$rc"
  echo "Added $BIN_DIR to PATH in $rc"
}

if path_has_bin_dir; then
  echo "$BIN_DIR is already on PATH"
else
  shell_name="$(basename "${SHELL:-}")"
  case "$shell_name" in
    zsh)
      append_path_export "$HOME/.zshrc"
      ;;
    bash)
      if [[ -f "$HOME/.bashrc" ]]; then
        append_path_export "$HOME/.bashrc"
      else
        append_path_export "$HOME/.bash_profile"
      fi
      ;;
    *)
      append_path_export "$HOME/.profile"
      ;;
  esac
  echo "Open a new terminal or run: export PATH=\"$BIN_DIR:\$PATH\""
fi

echo "Run: ai-review"
