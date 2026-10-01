#!/usr/bin/env bash
# Installs the sidebar into cmux as a symlink (edits to src/ hot-reload),
# validates it, and selects it as the left sidebar.
set -euo pipefail

name="cmux-sidebar"
src="$(cd "$(dirname "$0")" && pwd)/src/$name.js"
dir="$HOME/.config/cmux/sidebars"
dest="$dir/$name.js"

command -v cmux >/dev/null || { echo "cmux CLI not found on PATH" >&2; exit 1; }

mkdir -p "$dir"
# Never clobber a hand-written file of the same name.
if [ -e "$dest" ] && [ ! -L "$dest" ]; then
  backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
  mv "$dest" "$backup"
  echo "Moved existing $dest to $backup"
fi
ln -sfn "$src" "$dest"
echo "Linked $dest -> $src"

cmux sidebar validate "$name"
cmux sidebar select "$name"
