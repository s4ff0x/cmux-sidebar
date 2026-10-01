import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agent, group, mountSidebar, workspaces } from "./harness.js";

describe("workspace list", () => {
  test("ungrouped workspaces render in tab order", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "w1", title: "alpha" }, { id: "w2", title: "beta" }),
    });
    assert.deepEqual(sb.outline(), ["alpha", "beta"]);
  });
});

describe("activity indicator", () => {
  const one = (agents, extra = {}) => ({ workspaces: workspaces({ id: "w1", title: "job", agents, ...extra }) });

  test("only a working agent or a running subagent shows the orange dot", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "w1", title: "working", agents: [agent("working")] },
        { id: "w2", title: "asking", agents: [agent("needs_input")] },
        { id: "w3", title: "subagent", agents: [agent("idle", { children: [{ id: "c", running: true, startedEpoch: 0 }] })] },
        { id: "w4", title: "idle", agents: [agent("idle"), agent("ended")] },
        { id: "w5", title: "plain" },
      ),
    });
    assert.deepEqual(
      ["working", "asking", "subagent", "idle", "plain"].map((t) => sb.row(t).indicator()),
      ["working", null, "working", null, null],
    );
  });

  test("sessions already finished when the sidebar loads show no dot", () => {
    const sb = mountSidebar(one([agent("idle")]));
    assert.equal(sb.row("job").indicator(), null);
  });

  for (const end of ["idle", "needs_input", "ended"]) {
    test(`a turn that ends (${end}) while you are elsewhere turns the dot green`, () => {
      const sb = mountSidebar(one([agent("working")]));
      assert.equal(sb.row("job").indicator(), "working");
      sb.setData(one([agent(end)]));
      assert.equal(sb.row("job").indicator(), "finished");
    });
  }

  test("a turn that ends while the workspace is open never turns green", () => {
    const sb = mountSidebar(one([agent("working")], { selected: true }));
    sb.setData(one([agent("idle")], { selected: true }));
    assert.equal(sb.row("job").indicator(), null);
  });

  test("opening a green workspace clears it at once", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.row("job").tap();
    assert.equal(sb.row("job").indicator(), null);
    assert.deepEqual(sb.take(), [{ method: "workspace.select", params: { workspace_id: "w1" } }]);
  });

  test("green also clears when the workspace is opened elsewhere, and stays cleared after", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.setData(one([agent("idle")], { selected: true }));
    sb.setData(one([agent("idle")]));
    assert.equal(sb.row("job").indicator(), null);
  });

  test("a new turn turns green back to orange", () => {
    const sb = mountSidebar(one([agent("working")]));
    sb.setData(one([agent("idle")]));
    sb.setData(one([agent("working")]));
    assert.equal(sb.row("job").indicator(), "working");
  });
});

// A 3-level tree: A, A/B, A/B/C, each with an anchor (the header) and one
// member, plus an ungrouped workspace at the end.
function tree3(over = {}) {
  const ws = workspaces(
    { id: "a", title: "A", group: "gA" },
    { id: "a1", title: "a-one", group: "gA" },
    { id: "b", title: "A/B", group: "gB" },
    { id: "b1", title: "b-one", group: "gB" },
    { id: "c", title: "A/B/C", group: "gC" },
    { id: "c1", title: "c-one", group: "gC" },
    { id: "x", title: "loose" },
  ).map((w) => ({ ...w, ...(over[w.id] ?? {}) }));
  const groups = [
    group("gA", "A", "a", over.gA),
    group("gB", "A/B", "b", over.gB),
    group("gC", "A/B/C", "c", over.gC),
  ];
  return { workspaces: ws, groups };
}

describe("nested groups", () => {
  test("a name path renders as an indented tree of leaf names", () => {
    const sb = mountSidebar(tree3());
    assert.deepEqual(sb.outline(), [
      "A",
      "  a-one",
      "  B",
      "    b-one",
      "    C",
      "      c-one",
      "loose",
    ]);
  });

  test("a missing parent path renders as a virtual header", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "b1", title: "api", group: "gB" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.deepEqual(sb.outline(), ["Work", "  Backend", "    api"]);
  });

  test("collapsing a virtual header is local: it hides the subtree without a cmux call", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "b1", title: "api", group: "gB" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    sb.row("Work").tapImage("chevron.right");
    assert.deepEqual(sb.outline(), ["Work"]);
    assert.deepEqual(sb.take(), []);
  });

  test("each subgroup collapses on its own and persists through cmux", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").tapImage("chevron.right");
    assert.deepEqual(sb.outline(), ["A", "  a-one", "  B", "loose"]);
    assert.deepEqual(sb.take(), [{ method: "workspace.group.collapse", params: { group_id: "gB" } }]);
    sb.row("B").tapImage("chevron.right");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.expand", params: { group_id: "gB" } }]);
    assert.equal(sb.outline().length, 7);
  });
});

describe("group header activity", () => {
  test("a header shows its anchor's dot and counts working descendants", () => {
    const sb = mountSidebar(tree3({
      a: { agents: [agent("working")] },
      b: { agents: [agent("needs_input")] },
      b1: { agents: [agent("working")] },
      c1: { agents: [agent("working")] },
    }));
    assert.deepEqual(
      ["A", "B", "C"].map((h) => [sb.row(h).indicator(), sb.row(h).counts().working]),
      [["working", 2], [null, 2], [null, 1]],
    );
  });

  test("a header counts finished descendants separately, until they are opened", () => {
    const sb = mountSidebar(tree3({ c1: { agents: [agent("working")] } }));
    sb.setData(tree3({ c1: { agents: [agent("idle")] } }));
    assert.deepEqual(sb.row("A").counts(), { working: 0, finished: 1 });
    sb.row("c-one").tap();
    assert.deepEqual(sb.row("A").counts(), { working: 0, finished: 0 });
  });

  test("the count stays on a collapsed header", () => {
    const sb = mountSidebar(tree3({ c1: { agents: [agent("working")] }, gA: { collapsed: true } }));
    assert.deepEqual(sb.row("A").counts(), { working: 1, finished: 0 });
  });

  test("headers with no activity below show no count", () => {
    const sb = mountSidebar(tree3());
    assert.deepEqual(sb.outline().slice(0, 1), ["A"]);
  });
});

describe("collapse keeps active work visible", () => {
  const sim = (over) => mountSidebar(tree3(over));

  test("a collapsed group shows only working descendants, with a breadcrumb from subgroups", () => {
    const sb = sim({ gA: { collapsed: true }, c1: { agents: [agent("working")] }, a1: { agents: [agent("working")] }, b1: { agents: [agent("needs_input")] } });
    assert.deepEqual(sb.outline(), ["A ● 2", "  a-one", "  B › C › c-one", "loose"]);
  });

  test("a working subgroup anchor surfaces as a row when its header is hidden", () => {
    const sb = sim({ gA: { collapsed: true }, b: { agents: [agent("working")] } });
    assert.deepEqual(sb.outline(), ["A ● 1", "  B › A/B", "loose"]);
  });

  test("a collapsed subgroup inside an expanded group flattens only its own subtree", () => {
    const sb = sim({ gB: { collapsed: true }, c1: { agents: [agent("working")] } });
    assert.deepEqual(sb.outline(), ["A ● 1", "  a-one", "  B ● 1", "    C › c-one", "loose"]);
  });

  test("a finished row stays under its collapsed header until it is opened", () => {
    const sb = sim({ gA: { collapsed: true } });
    assert.deepEqual(sb.outline(), ["A", "loose"]);
    sb.setData(tree3({ gA: { collapsed: true }, c1: { agents: [agent("working")] } }));
    assert.deepEqual(sb.outline(), ["A ● 1", "  B › C › c-one", "loose"]);
    sb.setData(tree3({ gA: { collapsed: true }, c1: { agents: [agent("ended")] } }));
    assert.equal(sb.row("c-one").indicator(), "finished");
    sb.row("c-one").tap();
    assert.deepEqual(sb.outline(), ["A", "loose"]);
  });
});

describe("group menu", () => {
  const renames = (actions) =>
    actions.filter((a) => a.method === "workspace.group.rename").map((a) => [a.params.group_id, a.params.name]);
  // tree3 plus a second top-level group Z.
  const withZ = () => {
    const t = tree3();
    const ws = workspaces(...t.workspaces, { id: "z", title: "Z", group: "gZ" });
    return { workspaces: ws, groups: [...t.groups, group("gZ", "Z", "z")] };
  };

  test("renaming a group edits its leaf and carries every descendant along", () => {
    const sb = mountSidebar(tree3());
    sb.row("A").doubleTap();
    assert.equal(sb.row("A").editing, "A");
    sb.row("A").submit("X");
    assert.deepEqual(renames(sb.take()), [["gA", "X"], ["gB", "X/B"], ["gC", "X/B/C"]]);
  });

  test("renaming a subgroup keeps its parent path", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Rename Group");
    sb.row("B").submit("Core");
    assert.deepEqual(renames(sb.take()), [["gB", "A/Core"], ["gC", "A/Core/C"]]);
  });

  test("renaming a virtual header renames the real groups beneath it", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "b", title: "Work/Backend", group: "gB" }),
      groups: [group("gB", "Work/Backend", "b")],
    });
    sb.row("Work").menu("Rename Group");
    sb.row("Work").submit("Job");
    assert.deepEqual(renames(sb.take()), [["gB", "Job/Backend"]]);
  });

  test("Move Group Into lists the tree minus the group's own subtree", () => {
    const sb = mountSidebar(withZ());
    assert.deepEqual(sb.row("B").menuLabels("Move Group Into"), ["A", "Z"]);
    assert.deepEqual(sb.row("C").menuLabels("Move Group Into"), ["A", "A › B", "Z"]);
  });

  test("Move Group Into re-parents the group with its descendants", () => {
    const sb = mountSidebar(withZ());
    sb.row("B").menu("Move Group Into", "Z");
    assert.deepEqual(renames(sb.take()), [["gB", "Z/B"], ["gC", "Z/B/C"]]);
  });

  test("Move to Top Level strips the parent path", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Move to Top Level");
    assert.deepEqual(renames(sb.take()), [["gB", "B"], ["gC", "B/C"]]);
  });

  test("Ungroup dissolves the group and promotes its subgroups one level", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("Ungroup");
    const actions = sb.take();
    assert.deepEqual(actions[0], { method: "workspace.group.ungroup", params: { group_id: "gB" } });
    assert.deepEqual(renames(actions), [["gC", "A/C"]]);
  });

  test("Delete Group deletes through cmux and promotes its subgroups one level", () => {
    const sb = mountSidebar(tree3());
    sb.row("A").menu("Delete Group");
    const actions = sb.take();
    assert.deepEqual(actions[0], { method: "workspace.group.delete", params: { group_id: "gA" } });
    assert.deepEqual(renames(actions), [["gB", "B"], ["gC", "B/C"]]);
  });

  test("New Subgroup creates <path>/New Group and opens it for rename once it exists", () => {
    const sb = mountSidebar(tree3());
    sb.row("B").menu("New Subgroup");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.create", params: { name: "A/B/New Group" } }]);
    const t = tree3();
    sb.setData({
      workspaces: workspaces(...t.workspaces, { id: "n", title: "A/B/New Group", group: "gN" }),
      groups: [...t.groups, group("gN", "A/B/New Group", "n")],
    });
    assert.ok(sb.outline().includes("    [New Group]"), sb.outline().join("\n"));
    sb.row("New Group").submit("Tests");
    assert.deepEqual(renames(sb.take()), [["gN", "A/B/Tests"]]);
  });
});

describe("workspaces inside groups", () => {
  test("the header + creates a workspace in that group at any depth", () => {
    const sb = mountSidebar(tree3());
    sb.row("C").tapImage("plus");
    sb.row("B").menu("New Workspace in Group");
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.new_workspace", params: { group_id: "gC" } },
      { method: "workspace.group.new_workspace", params: { group_id: "gB" } },
    ]);
  });

  test("a virtual header offers no workspace creation", () => {
    const sb = mountSidebar({
      workspaces: workspaces({ id: "b", title: "Work/Backend", group: "gB" }),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.ok(!sb.row("Work").menuLabels().includes("New Workspace in Group"));
    sb.row("Work").tapImage("plus");
    assert.deepEqual(sb.take(), []);
  });

  test("Move to Group lists every real group as a path and adds the workspace there", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "b", title: "Work/Backend", group: "gB" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gB", "Work/Backend", "b")],
    });
    assert.deepEqual(sb.row("loose").menuLabels("Move to Group"), ["Work › Backend"]);
    sb.row("loose").menu("Move to Group", "Work › Backend");
    assert.deepEqual(sb.take(), [{ method: "workspace.group.add", params: { group_id: "gB", workspace_id: "x" } }]);
  });

  test("Move to Group follows groups created after the row mounted", () => {
    const sb = mountSidebar(tree3());
    const t = tree3();
    sb.setData({
      workspaces: workspaces(...t.workspaces, { id: "e", title: "A/Extra", group: "gX" }),
      groups: [...t.groups, group("gX", "A/Extra", "e")],
    });
    assert.deepEqual(sb.row("loose").menuLabels("Move to Group"), ["A", "A › B", "A › B › C", "A › Extra"]);
  });
});

describe("border color", () => {
  const two = () =>
    workspaces({ id: "w1", title: "red", color: "#FF453A" }, { id: "w2", title: "plain" });

  test("a workspace color draws the leading bar; no color, no bar", () => {
    const sb = mountSidebar({ workspaces: two() });
    assert.deepEqual([sb.row("red").barColor(), sb.row("plain").barColor()], ["#FF453A", null]);
  });

  test("choosing a swatch sets the native color and shows the bar before the data echoes", () => {
    const sb = mountSidebar({ workspaces: two() });
    sb.row("plain").menu("Border Color", "Blue");
    assert.deepEqual(sb.take(), [
      { method: "workspace.action", params: { action: "set_color", workspace_id: "w2", color: "#0A84FF" } },
    ]);
    assert.equal(sb.row("plain").barColor(), "#0A84FF");
  });

  test("None clears the native color and removes the bar", () => {
    const sb = mountSidebar({ workspaces: two() });
    sb.row("red").menu("Border Color", "None");
    assert.deepEqual(sb.take(), [{ method: "workspace.action", params: { action: "clear_color", workspace_id: "w1" } }]);
    assert.equal(sb.row("red").barColor(), null);
  });

  test("the bar follows a color changed elsewhere (e.g. the built-in sidebar)", () => {
    const sb = mountSidebar({ workspaces: two() });
    sb.setData({ workspaces: workspaces({ id: "w1", title: "red" }, { id: "w2", title: "plain", color: "#30D158" }) });
    assert.deepEqual([sb.row("red").barColor(), sb.row("plain").barColor()], [null, "#30D158"]);
  });
});

describe("drag and drop", () => {
  const adds = (actions) => actions.filter((a) => a.method.startsWith("workspace.group."));

  test("a row dropped right under a subgroup header joins that subgroup", () => {
    const sb = mountSidebar(tree3());
    // Without the dragged row: [A, a-one, B, b-one, C, c-one]; slot 3 sits under B.
    sb.drop("x", 3);
    assert.deepEqual(adds(sb.take()), [{ method: "workspace.group.add", params: { group_id: "gB", workspace_id: "x" } }]);
  });

  test("a row dropped under a virtual header joins the nearest real ancestor", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA" },
        { id: "w", title: "A/V/W", group: "gW" },
        { id: "w1", title: "deep", group: "gW" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gA", "A", "a"), group("gW", "A/V/W", "w")],
    });
    assert.deepEqual(sb.outline(), ["A", "  V", "    W", "      deep", "loose"]);
    sb.drop("x", 2); // right under the virtual V header
    assert.deepEqual(adds(sb.take()), [{ method: "workspace.group.add", params: { group_id: "gA", workspace_id: "x" } }]);
  });

  test("dropping a header moves its whole top-level tree, whichever header was grabbed", () => {
    const state = () => {
      const t = tree3();
      return {
        workspaces: workspaces(...t.workspaces, { id: "z", title: "Z", group: "gZ" }),
        groups: [...t.groups, group("gZ", "Z", "z")],
      };
    };
    const expected = JSON.stringify(["x", "z", "a", "a1", "b", "b1", "c", "c1"]);
    for (const [key, index] of [["h:g:gA", 2], ["h:g:gB", 4]]) {
      const sb = mountSidebar(state());
      sb.drop(key, index, { block: true });
      assert.deepEqual(sb.take(), [{ method: "workspace.reorder_many", params: { workspace_ids: expected } }], key);
    }
  });

  test("a subgroup header drag moving the tree up lands where the tree's first row goes", () => {
    const t = tree3();
    const sb = mountSidebar({
      workspaces: workspaces({ id: "x", title: "loose" }, { id: "z", title: "Z", group: "gZ" }, ...t.workspaces.filter((w) => w.id !== "x")),
      groups: [...t.groups, group("gZ", "Z", "z")],
    });
    // Grabbing B (2 rows into the A block) and dropping the tree at the top puts B at slot 2.
    sb.drop("h:g:gB", 2, { block: true });
    assert.deepEqual(sb.take(), [{
      method: "workspace.reorder_many",
      params: { workspace_ids: JSON.stringify(["a", "a1", "b", "b1", "c", "c1", "x", "z"]) },
    }]);
  });

  test("a tree drag keeps every group's tabs contiguous", () => {
    // A/Z sits before A in the tabs, so it displays above A's own member.
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "z", title: "A/Z", group: "gZ" },
        { id: "z1", title: "zed", group: "gZ" },
        { id: "a", title: "A", group: "gA" },
        { id: "a1", title: "a-one", group: "gA" },
        { id: "x", title: "loose" },
      ),
      groups: [group("gZ", "A/Z", "z"), group("gA", "A", "a")],
    });
    assert.deepEqual(sb.outline(), ["A", "  Z", "    zed", "  a-one", "loose"]);
    sb.drop("h:g:gA", 1, { block: true }); // below loose
    assert.deepEqual(sb.take(), [{
      method: "workspace.reorder_many",
      params: { workspace_ids: JSON.stringify(["x", "a", "a1", "z", "z1"]) },
    }]);
  });

  test("rows listed under a collapsed group keep their group and tab position when reordered", () => {
    const state = tree3({ gA: { collapsed: true }, a1: { agents: [agent("working")] }, c1: { agents: [agent("working")] } });
    const sb = mountSidebar(state);
    assert.deepEqual(sb.outline(), ["A ● 2", "  a-one", "  B › C › c-one", "loose"]);
    sb.drop("c1", 1); // c-one above a-one
    sb.drop("a1", 2); // a-one below c-one
    sb.row("a-one").tap({ cmd: true });
    sb.row("c-one").tap({ cmd: true });
    sb.drop("a1", 2); // both, as a multi-selection
    // The list mixes groups, so its order maps to no tab order: nothing is sent.
    assert.deepEqual(sb.take(), []);
  });

  test("an outside row dropped into a collapsed group's list lands beside the group", () => {
    const sb = mountSidebar(tree3({ gA: { collapsed: true }, a1: { agents: [agent("working")] } }));
    sb.drop("x", 2); // under a-one, inside collapsed A's list
    assert.deepEqual(adds(sb.take()), []); // stays ungrouped instead of vanishing into A
  });
});

describe("group edits stay scoped", () => {
  const renames = (actions) =>
    actions.filter((a) => a.method === "workspace.group.rename").map((a) => [a.params.group_id, a.params.name]);

  test("renaming a duplicate-path group leaves the other group's subgroups alone", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA1" },
        { id: "b", title: "A/B", group: "gB" },
        { id: "a2", title: "A again", group: "gA2" },
      ),
      groups: [group("gA1", "A", "a"), group("gB", "A/B", "b"), group("gA2", "A", "a2")],
    });
    assert.deepEqual(sb.outline(), ["A", "  B", "A"]);
    sb.rows()[2].menu("Rename Group");
    sb.rows().find((r) => r.editing !== null).submit("Y");
    sb.rows()[2].menu("Ungroup");
    assert.deepEqual(renames(sb.take()), [["gA2", "Y"]]);
  });

  test("renaming onto a taken sibling path picks a free name instead of merging", () => {
    const t = tree3();
    const sb = mountSidebar({
      workspaces: workspaces(...t.workspaces, { id: "d", title: "A/D", group: "gD" }),
      groups: [...t.groups, group("gD", "A/D", "d")],
    });
    sb.row("B").menu("Rename Group");
    sb.row("B").submit("D");
    assert.deepEqual(renames(sb.take()), [["gB", "A/D 2"], ["gC", "A/D 2/C"]]);
  });

  test("New Subgroup avoids a taken name and expands a collapsed parent so the editor shows", () => {
    const t = tree3({ gB: { collapsed: true } });
    const sb = mountSidebar({
      workspaces: workspaces(...t.workspaces, { id: "n", title: "A/B/New Group", group: "gN" }),
      groups: [...t.groups, group("gN", "A/B/New Group", "n", { collapsed: true })],
    });
    sb.row("B").menu("New Subgroup");
    assert.deepEqual(sb.take(), [
      { method: "workspace.group.expand", params: { group_id: "gB" } },
      { method: "workspace.group.create", params: { name: "A/B/New Group 2" } },
    ]);
  });

  test("Ungroup promotes subgroups onto free paths instead of merging into a sibling", () => {
    const sb = mountSidebar({
      workspaces: workspaces(
        { id: "a", title: "A", group: "gA" },
        { id: "b", title: "A/B", group: "gB" },
        { id: "c", title: "A/B/C", group: "gC" },
        { id: "d", title: "A/B/C/D", group: "gD" },
        { id: "c2", title: "A/C", group: "gC2" },
      ),
      groups: [group("gA", "A", "a"), group("gB", "A/B", "b"), group("gC", "A/B/C", "c"), group("gD", "A/B/C/D", "d"), group("gC2", "A/C", "c2")],
    });
    sb.row("B").menu("Ungroup");
    assert.deepEqual(renames(sb.take()), [["gC", "A/C 2"], ["gD", "A/C 2/D"]]);
  });
});
