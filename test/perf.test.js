// Scene-op budget: the host applies every op to its observable scene nodes,
// and data arrives about once a second. A tick must cost ops in proportion to
// what actually changed, never a re-send of the whole tree.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { agent, group, mountSidebar, workspaces } from "./harness.js";

// 60 workspaces in 12 groups nested 3 levels deep: T0..T3, each with T/S and
// T/S/U; every group has its anchor plus 4 members. A few agents are working.
function big(over = {}) {
  const list = [];
  const groups = [];
  for (let t = 0; t < 4; t += 1) {
    for (const path of [`T${t}`, `T${t}/S`, `T${t}/S/U`]) {
      const gid = "g-" + path;
      const anchor = "a-" + path;
      groups.push(group(gid, path, anchor));
      list.push({ id: anchor, title: path, group: gid });
      for (let m = 0; m < 4; m += 1) list.push({ id: `${path}#${m}`, title: `${path} item ${m}`, group: gid });
    }
  }
  const busy = new Set(["T0#1", "T1/S#2", "T2/S/U#3"]);
  return {
    workspaces: workspaces(...list.map((w) => ({
      ...w,
      ...(busy.has(w.id) ? { agents: [agent("working", { id: "s-" + w.id })] } : {}),
      ...(over[w.id] ?? {}),
    }))),
    groups,
  };
}

describe("scene op budget", () => {
  test("an idle tick (identical data) sends the host no scene ops", () => {
    const sb = mountSidebar(big());
    assert.equal(sb.opsDuring(() => sb.setData(big())).length, 0);
  });

  test("an agent starting work touches only its own row and the Active count", () => {
    const sb = mountSidebar(big());
    const ops = sb.opsDuring(() =>
      sb.setData(big({ "T3/S/U#0": { agents: [agent("working", { id: "s-new" })] } })),
    );
    assert.deepEqual(sb.touchedBy(ops), ["Active · 4", "T3/S/U item 0"]);
    assert.ok(ops.length <= 4, `${ops.length} ops`);
  });

  test("a working agent's activity heartbeat costs nothing", () => {
    const sb = mountSidebar(big());
    const ops = sb.opsDuring(() =>
      sb.setData(big({ "T0#1": { agents: [agent("working", { id: "s-T0#1", lastActivityAt: 99 })] } })),
    );
    assert.equal(ops.length, 0);
  });
});
