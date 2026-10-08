# cmux-sidebar

> **Beta.** Used daily, but expect rough edges. Please
> [open an issue](https://github.com/s4ff0x/cmux-sidebar/issues) with your cmux version
> (`cmux --version`) when something looks wrong.

A custom left sidebar for [cmux](https://cmux.com): nested workspace groups, live agent activity
dots, and Active / Favorites filters. It runs on the cmux JS custom-sidebar runtime (one file in
`~/.config/cmux/sidebars/`) and is a fork of the upstream
[`Examples/CustomSidebars/workspaces.js`](https://github.com/manaflow-ai/cmux/blob/main/Examples/CustomSidebars/workspaces.js).
It keeps that example's behavior: select on click, inline rename (double-click), close, unread
badge, multi-select (⌘-click / ⇧-click), Close Others, and drag-and-drop.

## Features

- **Nested groups.** Workspace groups nest by name (see below), each level indented and
  independently collapsible.
- **Activity dots.** Orange marks a workspace whose coding agent is really working, mid-turn or
  with a running subagent. Waiting for input, idle, and ended are not working. Green marks a
  workspace whose turn **finished while you were elsewhere**; it stays green until you open that
  workspace. A group header shows its own anchor workspace's dot; headers show no counts.
- **Filters.** Two toggle chips sit at the top of the sidebar:
  - **Active · N** shows only workspaces with an orange or green dot.
  - **Favorites · N** shows only favorite workspaces.

  While either chip is on, the tree is replaced by one flat list in tab order. Each row keeps
  its dot and gets a dim group path (`Work › Backend ›`). With both chips on,
  a workspace shows if it matches either filter. Turn the chips off to get the tree back with
  every group's collapse state unchanged. Filter state is local and resets when the sidebar
  mounts.
- **Favorites.** Right-click a workspace → **Favorite** / **Unfavorite**. A favorite shows a red
  bookmark before its title. A favorite is the native cmux pin, so it persists, the built-in
  sidebar shows it as pinned, and cmux keeps it at the top of the tab order.
- **Collapse keeps active work visible.** A collapsed group hides everything except working and
  finished-unopened workspaces, listed under its header with a dim breadcrumb (`Backend › API ›`)
  when they come from a subgroup.
- **Workspace color.** Right-click a workspace → **Border Color** sets the native cmux workspace
  color, which the built-in sidebar shows. This sidebar does not draw it.
- **Create inside a group.** Use the hover `+` on a group header, or right-click →
  **New Workspace in Group**. Right-click a workspace → **Move to Group** lists the full tree.

## Install

Paste this into a **cmux terminal**:

```sh
curl -fsSL https://github.com/s4ff0x/cmux-sidebar/releases/latest/download/install.sh | sh
```

This downloads the latest release into `~/.config/cmux/sidebars/cmux-sidebar.js`, validates it,
and switches the left sidebar to it. Run it from a cmux terminal: by default cmux accepts CLI
commands only from processes it started. From any other terminal the file is still installed;
then right-click the sidebar button in cmux and pick **cmux-sidebar**.

Requirements: cmux 0.64.25 or newer (the version it is tested on), with Custom Sidebars enabled
(the default; **Settings → Custom Sidebars**).

- **Update:** run the same command again.
- **Pin a version:** `curl -fsSL https://github.com/s4ff0x/cmux-sidebar/releases/latest/download/install.sh | sh -s -- --version v0.1.0-beta`
  ([releases](https://github.com/s4ff0x/cmux-sidebar/releases)).
- **Uninstall:** `curl -fsSL https://github.com/s4ff0x/cmux-sidebar/releases/latest/download/install.sh | sh -s -- --uninstall`,
  then pick another sidebar from the sidebar button's right-click menu.
- **Without the script:** download `cmux-sidebar.js` from a
  [release](https://github.com/s4ff0x/cmux-sidebar/releases), put it in
  `~/.config/cmux/sidebars/`, and pick it from the sidebar button's right-click menu.

If a file named `cmux-sidebar.js` that this installer did not write is already there, it is moved
to a timestamped `.bak` first. If the new file fails `cmux sidebar validate`, the previous one is
put back.

## Supported agents

The activity dots read the coding-agent sessions that cmux tracks through its agent hooks. cmux
exposes no process information to sidebars, so an agent without hooks never shows as working.

**Tested:**

- **Claude Code:** works out of the box; the cmux Claude wrapper injects its hooks.
- **omp:** install the hooks once with `cmux hooks omp install`, then restart running omp
  sessions (omp loads the hook extension when a session starts).

**Untested, expected to work:** the sidebar reads cmux's generic session status (working, needs
input, idle, ended) and never checks which agent it is. So any agent that cmux hooks into should
show the same dots once its hooks are installed with `cmux hooks setup` (or
`cmux hooks setup <agent>`). As of cmux 0.64.25 that list is Codex, OpenCode, Pi, Gemini, Cursor
CLI, Copilot, Amp, Grok, Kimi Code, Kiro CLI, Rovo Dev, CodeBuddy, Factory, Qoder, Campfire,
and Antigravity; see cmux's
[agent hook docs](https://github.com/manaflow-ai/cmux/blob/main/docs/agent-hooks.md). Reports
for other agents are welcome.

### Limits of the green dot

cmux records no "last opened" time, so the sidebar watches each workspace go from working to
finished itself and keeps that in memory. Green dots therefore start empty whenever the sidebar
mounts: on cmux launch, on `cmux sidebar reload`, when the source file changes, or when you
switch to another sidebar and back. A turn that finished before then shows no dot. Toggling a
filter chip remounts rows but not the sidebar, so green dots survive it.

## Nesting convention

cmux groups are flat, so this sidebar encodes the hierarchy in the group **name**, using `/` as
the separator:

| Group name         | Shown as                 |
| ------------------ | ------------------------ |
| `Work`             | `Work`                   |
| `Work/Backend`     | `Backend` under `Work`   |
| `Work/Backend/API` | `API` under `Backend`    |

- Only the leaf segment is shown. Siblings are ordered by tab position.
- If a parent path has no real group (for example `Work/Backend` exists but `Work` does not),
  the sidebar shows a *virtual* header for it. A virtual header's collapse state is local and
  resets when the sidebar reloads.
- Group header menu items:
  - **New Subgroup** creates `<path>/New Group` and opens it for rename.
  - **Rename Group** edits the leaf, and descendants follow. Typing `a/b` nests further.
  - **Move Group Into ›** and **Move to Top Level** move a group together with its subtree.
  - **Ungroup** and **Delete Group** dissolve the group the cmux way: member workspaces are
    kept. Its direct subgroups move up one level.
- Drag a header to move a group with its whole subtree. Drop it right under another group's
  header (or among its rows) to nest it there; at the end of a group, the pointer's X position
  picks between staying inside and moving out a level. Dropping at the top level un-nests it.
- Tradeoff: the built-in cmux sidebar shows the full names (`Work/Backend`).

## Development

```sh
git clone https://github.com/s4ff0x/cmux-sidebar.git
cd cmux-sidebar
./install.sh --dev   # symlinks src/cmux-sidebar.js into cmux, so saves hot-reload
npm test            # node:test suite, run against cmux's real SidebarRuntime.js
npm run check       # syntax check
cmux sidebar validate cmux-sidebar
```

The tests load the runtime from the installed app
(`/Applications/cmux.app/.../SidebarRuntime.js`). Override the path with
`CMUX_SIDEBAR_RUNTIME=/path/to/SidebarRuntime.js`.

### Releasing

1. On a Mac with cmux installed, run `npm test` on the commit you want to release (CI cannot:
   the tests need the app's runtime).
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` publishes a GitHub Release with `cmux-sidebar.js` and
   `install.sh` attached. The install command always fetches the newest release, so do not
   mark a release as a pre-release unless users should skip it.

### Performance

The cmux runtime re-sends a reactive prop whenever anything it read notifies, and every data
key arrives as a freshly parsed object about once a second. To keep ticks cheap, the sidebar
reads data only through change-only memos (`memo`, `memoJSON`) and gives each workspace its own
signal, so a tick costs ops only for what actually changed. `test/perf.test.js` holds this
budget on a 60-workspace, 3-level fixture: an identical tick sends 0 scene ops (it used to send
about 1144), and one agent starting work touches only its own row and the `Active` count.

Scrolling has a different cost. The host renders the list in a non-lazy SwiftUI `ScrollView`,
and every scroll frame re-processes each rendered scene node (every node carries its own hover
tracking), so scroll cost grows with nodes per row, not with data. Rows therefore mount only what
they show: the activity dot, favorite bookmark, breadcrumb, and unread badge mount on demand
(a row without a dot keeps the slot as padding), and the dot is one circle. A plain row is 7 nodes
(it was 13), a header 7 (was 9), with the same pixels. On a 102-workspace sidebar this cut the
cmux main thread from about 85% to about 52% busy while scrolling, and SwiftUI's render share
from about 55% to about 29%. The same `test/perf.test.js` holds the per-row node budget.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE). This sidebar is derived from cmux's
`Examples/CustomSidebars/workspaces.js` (Copyright Manaflow, Inc., GPL-3.0-or-later).
