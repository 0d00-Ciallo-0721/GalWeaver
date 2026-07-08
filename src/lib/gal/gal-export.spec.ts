import { describe, expect, it, vi } from "vitest"
import { readFile, writeFile } from "@/commands/fs"
import { buildGalNovelMarkdown, exportGalProjectContents, traceGalPathToEntry } from "./gal-export"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  createDirectory: vi.fn(),
  writeFile: vi.fn(),
}))

function node(
  id: string,
  title: string,
  parents: string[],
  children: string[],
): GalNode {
  return {
    id,
    title,
    parents,
    children,
    routeId: "main",
    type: id === "entry" ? "entry" : "daily",
    status: "final",
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
  }
}

function route(nodes: GalNode[]): GalRoute {
  return {
    id: "main",
    title: "主线路",
    theme: "",
    entryNodeId: "entry",
    endingNodeIds: ["end"],
    nodes,
  }
}

describe("traceGalPathToEntry", () => {
  it("在合流节点要求选择父节点，并生成唯一正向路径", () => {
    const graph = route([
      node("entry", "入口", [], ["left", "right"]),
      node("left", "左线", ["entry"], ["end"]),
      node("right", "右线", ["entry"], ["end"]),
      node("end", "结局", ["left", "right"], []),
    ])

    const unresolved = traceGalPathToEntry(graph, "end")
    expect(unresolved.status).toBe("needs-selection")
    if (unresolved.status === "needs-selection") {
      expect(unresolved.options.map((option) => option.parentId)).toEqual(["left", "right"])
    }

    const resolved = traceGalPathToEntry(graph, "end", { end: "right" })
    expect(resolved.status).toBe("complete")
    if (resolved.status === "complete") {
      expect(resolved.nodes.map((item) => item.id)).toEqual(["entry", "right", "end"])
    }
  })

  it("拒绝无法回到入口的断线节点", () => {
    const result = traceGalPathToEntry(
      route([node("entry", "入口", [], []), node("orphan", "断线", [], [])]),
      "orphan",
    )
    expect(result).toEqual({
      status: "error",
      message: "节点「断线」无法向上连接到入口节点。",
    })
  })
})

describe("exportGalProjectContents", () => {
  it("writes an export marker so route exports cannot be reopened as projects", async () => {
    vi.mocked(readFile).mockResolvedValue("")
    vi.mocked(writeFile).mockResolvedValue()
    const mainRoute = route([node("entry", "entry", [], [])])
    const project: GalProject = {
      id: "project",
      title: "Story",
      premise: "",
      globalRules: "",
      variables: [],
      routes: [mainRoute],
      cgs: [],
      clues: [],
      createdAt: "",
      updatedAt: "",
    }

    await exportGalProjectContents("D:/project", "D:/exports", project)

    const markerCall = vi.mocked(writeFile).mock.calls.find(([path]) => (
      typeof path === "string" && path.endsWith("/.qmai-export.json")
    ))
    expect(markerCall).toEqual([
      expect.stringContaining("/.qmai-export.json"),
      expect.stringContaining('"kind": "gal-route-export"'),
    ])
    // expect(vi.mocked(writeFile)).toHaveBeenCalledWith(
    /*
      "D:/exports/Story-绾胯矾瀵煎嚭-20260705/.qmai-export.json",
      // expect.stringContaining('"kind": "gal-route-export"'),
    */
    // )
  })
})

describe("buildGalNovelMarkdown", () => {
  it("按路径顺序拼接完整正文并标记缺失节点", async () => {
    vi.mocked(readFile)
      .mockResolvedValueOnce("第一章完整正文")
      .mockRejectedValueOnce(new Error("missing"))
    const nodes = [
      node("entry", "开场", [], ["end"]),
      node("end", "结局", ["entry"], []),
    ]

    const result = await buildGalNovelMarkdown("D:/project", "main", "右线", nodes)

    expect(result.content).toContain("## 1. 开场\n\n第一章完整正文")
    expect(result.content).toContain("## 2. 结局\n\n> 该节点正文尚未生成。")
    expect(result.missingNodes.map((item) => item.id)).toEqual(["end"])
  })
})
