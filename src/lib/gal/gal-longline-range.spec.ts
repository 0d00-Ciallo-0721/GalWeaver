import { describe, expect, it } from "vitest"
import { detectGalLonglineRange } from "./gal-longline-range"
import type { GalChoice, GalNode, GalRoute } from "./gal-types"

describe("detectGalLonglineRange", () => {
  it("detects a simple linear segment between entry and ending boundaries", () => {
    const route = routeWith([
      node("entry", { type: "entry", children: ["a"] }),
      node("a", { parents: ["entry"], children: ["b"] }),
      node("b", { parents: ["a"], children: ["ending"] }),
      node("ending", { type: "ending", parents: ["b"] }),
    ])

    const range = detectGalLonglineRange(route, "a")

    expect(range.upstreamBoundary?.id).toBe("entry")
    expect(range.targetNodes.map((item) => item.id)).toEqual(["a", "b"])
    expect(range.downstreamBoundary?.id).toBe("ending")
    expect(range.warnings).toEqual([])
    expect(range.stopReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "upstream", reason: "entry_node", relatedNodeId: "entry" }),
      expect.objectContaining({ direction: "downstream", reason: "ending_node", relatedNodeId: "ending" }),
    ]))
  })

  it("stops upstream at a branch boundary", () => {
    const route = routeWith([
      node("branch", {
        choices: [choice("to-a", "a"), choice("to-x", "x")],
        children: ["a", "x"],
      }),
      node("a", { parents: ["branch"], children: ["b"] }),
      node("b", { parents: ["a"] }),
      node("x", { parents: ["branch"] }),
    ])

    const range = detectGalLonglineRange(route, "b")

    expect(range.upstreamBoundary?.id).toBe("branch")
    expect(range.targetNodes.map((item) => item.id)).toEqual(["a", "b"])
    expect(range.stopReasons).toContainEqual(expect.objectContaining({
      direction: "upstream",
      reason: "branch_node",
      relatedNodeId: "branch",
    }))
  })

  it("stops downstream at a merge boundary", () => {
    const route = routeWith([
      node("a", { children: ["b"] }),
      node("b", { parents: ["a"], children: ["merge"] }),
      node("other", { children: ["merge"] }),
      node("merge", { parents: ["b", "other"] }),
    ])

    const range = detectGalLonglineRange(route, "a")

    expect(range.targetNodes.map((item) => item.id)).toEqual(["a", "b"])
    expect(range.downstreamBoundary?.id).toBe("merge")
    expect(range.stopReasons).toContainEqual(expect.objectContaining({
      direction: "downstream",
      reason: "merge_node",
      relatedNodeId: "merge",
    }))
  })

  it("keeps selected entry as the only target and stops", () => {
    const route = routeWith([
      node("entry", { type: "entry", children: ["a"] }),
      node("a", { parents: ["entry"] }),
    ])

    const range = detectGalLonglineRange(route, "entry")

    expect(range.upstreamBoundary).toBeNull()
    expect(range.targetNodes.map((item) => item.id)).toEqual(["entry"])
    expect(range.downstreamBoundary).toBeNull()
    expect(range.stopReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "upstream", reason: "entry_node", nodeId: "entry" }),
      expect.objectContaining({ direction: "downstream", reason: "entry_node", nodeId: "entry" }),
    ]))
  })

  it("keeps selected ending as the only target and stops", () => {
    const route = routeWith([
      node("a", { children: ["ending"] }),
      node("ending", { type: "ending", parents: ["a"] }),
    ])

    const range = detectGalLonglineRange(route, "ending")

    expect(range.targetNodes.map((item) => item.id)).toEqual(["ending"])
    expect(range.upstreamBoundary).toBeNull()
    expect(range.downstreamBoundary).toBeNull()
    expect(range.stopReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "upstream", reason: "ending_node", nodeId: "ending" }),
      expect.objectContaining({ direction: "downstream", reason: "ending_node", nodeId: "ending" }),
    ]))
  })

  it("reports broken links as warnings", () => {
    const route = routeWith([
      node("a", { parents: ["missing-parent"], children: ["missing-child"] }),
    ])

    const range = detectGalLonglineRange(route, "a")

    expect(range.targetNodes.map((item) => item.id)).toEqual(["a"])
    expect(range.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "broken_parent", nodeId: "a", relatedNodeId: "missing-parent" }),
      expect.objectContaining({ type: "broken_child", nodeId: "a", relatedNodeId: "missing-child" }),
    ]))
    expect(range.stopReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "upstream", reason: "broken_link", nodeId: "a", relatedNodeId: "missing-parent" }),
      expect.objectContaining({ direction: "downstream", reason: "broken_link", nodeId: "a", relatedNodeId: "missing-child" }),
    ]))
  })

  it("treats multiple valid choices as a branch even when they target the same node", () => {
    const route = routeWith([
      node("a", {
        choices: [choice("soft", "b"), choice("direct", "b")],
      }),
      node("b", { parents: ["a"] }),
    ])

    const range = detectGalLonglineRange(route, "a")

    expect(range.targetNodes.map((item) => item.id)).toEqual(["a"])
    expect(range.downstreamBoundary).toBeNull()
    expect(range.stopReasons).toContainEqual(expect.objectContaining({
      direction: "downstream",
      reason: "branch_node",
      nodeId: "a",
    }))
  })

  it("stops on cycles without mutating route data", () => {
    const route = routeWith([
      node("a", { parents: ["c"], children: ["b"] }),
      node("b", { parents: ["a"], children: ["c"] }),
      node("c", { parents: ["b"], children: ["a"] }),
    ])
    const before = JSON.stringify(route)

    const range = detectGalLonglineRange(route, "a")

    expect(range.targetNodes.map((item) => item.id).sort()).toEqual(["a", "b", "c"])
    expect(range.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "cycle" }),
    ]))
    expect(range.stopReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "upstream", reason: "cycle" }),
      expect.objectContaining({ direction: "downstream", reason: "cycle" }),
    ]))
    expect(JSON.stringify(route)).toBe(before)
  })
})

function routeWith(nodes: GalNode[]): GalRoute {
  return {
    id: "main",
    title: "Main",
    theme: "",
    entryNodeId: nodes[0]?.id ?? "",
    endingNodeIds: nodes.filter((item) => item.type === "ending").map((item) => item.id),
    nodes,
  }
}

function node(id: string, patch: Partial<GalNode> = {}): GalNode {
  return {
    id,
    routeId: "main",
    title: id,
    type: "daily",
    status: "draft",
    parents: [],
    children: [],
    goal: "",
    summary: "",
    scriptPath: `nodes/main/${id}.md`,
    incomingState: {
      variables: {},
      characterCognition: {},
      acquiredClueIds: [],
      seenCgIds: [],
      visitedNodeIds: [],
      currentScene: "",
      characterMoods: {},
    },
    choices: [],
    memoryScope: "node",
    characters: [],
    scene: "",
    clueIds: [],
    sequence: 0,
    createdAt: "",
    updatedAt: "",
    ...patch,
  }
}

function choice(id: string, nextNodeId: string): GalChoice {
  return {
    id,
    text: id,
    emotionalIntent: "",
    effects: [],
    nextNodeId,
  }
}
