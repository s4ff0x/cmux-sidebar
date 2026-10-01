#!/bin/sh
# Installs the cmux-sidebar custom sidebar into cmux.
#
#   curl -fsSL https://github.com/s4ff0x/cmux-sidebar/releases/latest/download/install.sh | sh
#
# Options (after `sh -s --` when piped):
#   --version <tag>   install a specific release, e.g. v0.1.0-beta (default: latest)
#   --dev             symlink this clone's src/cmux-sidebar.js instead (edits hot-reload)
#   --uninstall       remove the installed sidebar file
#
# Run it from a cmux terminal: cmux only accepts CLI commands from processes it started.
set -eu

repo="s4ff0x/cmux-sidebar"
name="cmux-sidebar"
dir="$HOME/.config/cmux/sidebars"
dest="$dir/$name.js"
version="latest"
mode="download"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) [ $# -ge 2 ] || { echo "--version needs a tag" >&2; exit 2; }; version="$2"; shift 2 ;;
    --dev) mode="dev"; shift ;;
    --uninstall) mode="uninstall"; shift ;;
    -h|--help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

cmux_bin=""
if command -v cmux >/dev/null 2>&1; then
  cmux_bin="cmux"
elif [ -x /Applications/cmux.app/Contents/Resources/bin/cmux ]; then
  cmux_bin="/Applications/cmux.app/Contents/Resources/bin/cmux"
fi

if [ "$mode" = "uninstall" ]; then
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    rm -f "$dest"
    echo "Removed $dest"
    echo "Right-click the sidebar button in cmux and pick another sidebar."
  else
    echo "Nothing to remove: $dest does not exist."
  fi
  exit 0
fi

mkdir -p "$dir"
backup=""

# A file this installer wrote starts with the sidebar's own header line and is
# simply replaced on update; anything else with the same name is set aside.
set_aside_foreign() {
  if [ -L "$dest" ]; then
    rm -f "$dest"
  elif [ -e "$dest" ] && ! head -n 1 "$dest" | grep -q '^// cmux-sidebar:'; then
    backup="$dest.bak.$(date +%Y%m%d%H%M%S)"
    mv "$dest" "$backup"
    echo "Moved your existing $dest to $backup"
  fi
}

if [ "$mode" = "dev" ]; then
  src="$(cd "$(dirname "$0")" && pwd)/src/$name.js"
  [ -f "$src" ] || { echo "--dev must run from a clone: $src not found" >&2; exit 1; }
  set_aside_foreign
  ln -sfn "$src" "$dest"
  echo "Linked $dest -> $src"
else
  if [ "$version" = "latest" ]; then
    url="https://github.com/$repo/releases/latest/download/$name.js"
  else
    url="https://github.com/$repo/releases/download/$version/$name.js"
  fi
  tmp="$(mktemp "${TMPDIR:-/tmp}/$name.XXXXXX")"
  prev="$tmp.prev"
  trap 'rm -f "$tmp" "$prev"' EXIT
  echo "Downloading $url"
  curl -fsSL "$url" -o "$tmp" || { echo "Download failed. Check the version tag and your connection." >&2; exit 1; }
  head -n 1 "$tmp" | grep -q '^// cmux-sidebar:' || { echo "The downloaded file is not cmux-sidebar; nothing was changed." >&2; exit 1; }
  if [ -f "$dest" ] && [ ! -L "$dest" ]; then cp "$dest" "$prev"; fi
  set_aside_foreign
  cp "$tmp" "$dest"
  echo "Installed $dest ($version)"
fi

# cmux answers CLI commands only from processes it started (its default socket
# mode), so outside a cmux terminal the file is installed but not activated.
if [ -z "$cmux_bin" ] || ! "$cmux_bin" ping >/dev/null 2>&1; then
  echo "Could not reach cmux from this terminal. Open cmux, right-click the sidebar button,"
  echo "and pick \"$name\" (or re-run this command from a cmux terminal)."
  exit 0
fi

if ! "$cmux_bin" sidebar validate "$name"; then
  # Put back what was there before, so a bad file never replaces a working sidebar.
  if [ -n "${prev:-}" ] && [ -f "$prev" ]; then
    mv "$prev" "$dest"
    echo "Restored the previous version." >&2
  elif [ -n "$backup" ]; then
    mv "$backup" "$dest"
    echo "Restored $dest." >&2
  fi
  exit 1
fi

"$cmux_bin" sidebar select "$name" >/dev/null
echo "Selected \"$name\" as the left sidebar. Done."
