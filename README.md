# cmux-sidebar

Custom left sidebar for [cmux](https://cmux.com), built on the cmux JS custom-sidebar runtime
(`~/.config/cmux/sidebars/<name>.js`, see the [authoring guide](https://cmux.com/docs/custom-sidebars)).
It is a fork of the upstream
[`Examples/CustomSidebars/workspaces.js`](https://github.com/manaflow-ai/cmux/blob/main/Examples/CustomSidebars/workspaces.js)
and keeps its behavior: select on click, inline rename (double-click), pin, close, unread badge,
multi-select (⌘-click / ⇧-click), Close Others, and drag-and-drop.

## Features

- **Nested groups.** Workspace groups nest by name (see below), each level indented and
  independently collapsible.
- **Activity dots.** Orange marks a workspace whose coding agent is really working, mid-turn or
  with a running subagent. Waiting for input, idle, and ended are not working. Green marks a
  workspace whose turn **finished while you were elsewhere**; it stays green until you open that
  workspace. Group headers show an orange `● N` (working) and a green `● N` (finished) count.
- **Collapse keeps active work visible.** A collapsed group hides everything except working and
  finished-unopened workspaces, listed under its header with a dim breadcrumb (`Backend › API ›`)
  when they come from a subgroup.
- **Border color.** Right-click a workspace → **Border Color** to draw a 3pt leading bar. This is
  the native cmux workspace color, so it persists and is shared with the built-in sidebar.
- **Create inside a group.** Use the hover `+` on a group header, or right-click →
  **New Workspace in Group**. Right-click a workspace → **Move to Group** lists the full tree.

## Install

Requires cmux (tested on 0.64.25) with Custom Sidebars enabled (on by default).

```sh
git clone https://github.com/s4ff0x/cmux-sidebar.git
cd cmux-sidebar
./install.sh
```

`install.sh` symlinks `src/cmux-sidebar.js` into `~/.config/cmux/sidebars/`, so edits to the
source hot-reload. It then runs `cmux sidebar validate cmux-sidebar` and
`cmux sidebar select cmux-sidebar`. An existing non-symlink file with the same name is moved
aside to a timestamped `.bak` first.

To switch back, right-click the sidebar toggle button and pick another sidebar.

### Prerequisite: agent hooks

The activity dots read the agent sessions cmux tracks through hooks. cmux exposes no process
information to sidebars, so an agent without hooks never shows as working.

- **Claude Code:** the cmux Claude wrapper injects its hooks automatically.
- **omp:** install the hooks once with `cmux hooks omp install`. This creates
  `~/.omp/agent/extensions/cmux-omp-session.ts`. omp loads it when a session starts, so restart
  sessions that were already running.

### Limits of the green dot

cmux records no "last opened" time, so the sidebar watches each workspace go from working to
finished itself and keeps that in memory. Green dots therefore start empty whenever the sidebar
mounts: on cmux launch, on `cmux sidebar reload`, when the source file changes, or when you
switch to another sidebar and back. A turn that finished before then shows no dot.

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
- Dragging any header moves its whole top-level tree. The cmux reorder surface only drags
  blocks at the top level. To re-parent a group, use **Move Group Into**.
- Tradeoff: the built-in cmux sidebar shows the full names (`Work/Backend`).

## Development

```sh
npm test        # node:test suite, run against cmux's real SidebarRuntime.js
npm run check   # syntax check
cmux sidebar validate cmux-sidebar
```

The tests load the runtime from the installed app
(`/Applications/cmux.app/.../SidebarRuntime.js`). Override the path with
`CMUX_SIDEBAR_RUNTIME=/path/to/SidebarRuntime.js`.
