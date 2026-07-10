import { describe, expect, it, vi } from "vitest"
import { createDirectory, readFile, writeFile } from "@/commands/fs"
import { buildGalNovelMarkdown, exportGalProjectContents, exportGalRouteTree, traceGalPathToEntry } from "./gal-export"
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

  it("writes web game-content files without removing legacy export files", async () => {
    vi.mocked(readFile).mockResolvedValue("Alex: body")
    vi.mocked(writeFile).mockResolvedValue()
    vi.mocked(createDirectory).mockResolvedValue()
    vi.mocked(writeFile).mockClear()
    vi.mocked(createDirectory).mockClear()
    const entry = node("entry", "entry", [], [])
    entry.characters = ["Alex"]
    const mainRoute = route([entry])
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

    const writtenPaths = vi.mocked(writeFile).mock.calls.map(([path]) => String(path))
    expect(writtenPaths.some((path) => path.endsWith("/.qmai-export.json"))).toBe(true)
    expect(writtenPaths.some((path) => path.endsWith("/graph.json"))).toBe(true)
    expect(writtenPaths.some((path) => path.endsWith(".svg"))).toBe(true)
    expect(writtenPaths.some((path) => path.endsWith(".md"))).toBe(true)
    expect(writtenPaths.some((path) => path.includes("/game-content/story.bundle.json"))).toBe(true)
    expect(writtenPaths.some((path) => path.includes("/game-content/asset-slots.template.json"))).toBe(true)
    expect(writtenPaths.some((path) => path.includes("/game-content/export-report.json"))).toBe(true)
    expect(vi.mocked(createDirectory).mock.calls.some(([path]) => (
      String(path).endsWith("/game-content")
    ))).toBe(true)

    const storyBundleCall = vi.mocked(writeFile).mock.calls.find(([path]) => (
      String(path).includes("/game-content/story.bundle.json")
    ))
    const reportCall = vi.mocked(writeFile).mock.calls.find(([path]) => (
      String(path).includes("/game-content/export-report.json")
    ))

    expect(JSON.parse(String(storyBundleCall?.[1]))).toMatchObject({
      schemaVersion: 1,
      storyId: "project",
      title: "Story",
      entryNodeId: "entry",
    })
    expect(JSON.parse(String(reportCall?.[1]))).toMatchObject({
      schemaVersion: 1,
      stats: {
        routes: 1,
        nodes: 1,
        scriptsReady: 1,
        scriptsMissing: 0,
        choices: 0,
        endings: 0,
      },
    })
  })
})

describe("exportGalRouteTree", () => {
  it("exports only the selected independent route tree", async () => {
    vi.mocked(readFile).mockResolvedValue("selected route body")
    vi.mocked(writeFile).mockResolvedValue()
    const mainRoute = route([node("entry", "main entry", [], [])])
    const sideNode = {
      ...node("side_entry", "side entry", [], []),
      routeId: "side",
      scriptPath: "nodes/side/side_entry.md",
    }
    const sideRoute: GalRoute = {
      id: "side",
      title: "side route",
      theme: "summer side story",
      entryNodeId: "side_entry",
      endingNodeIds: [],
      nodes: [sideNode],
    }
    const project: GalProject = {
      id: "project",
      title: "Story",
      premise: "",
      globalRules: "",
      variables: [],
      routes: [mainRoute, sideRoute],
      cgs: [],
      clues: [],
      createdAt: "",
      updatedAt: "",
    }

    const result = await exportGalRouteTree("D:/project", "D:/exports", project, "side")

    expect(result.nodeCount).toBe(1)
    expect(result.missingNodes).toEqual([])
    expect(vi.mocked(readFile)).toHaveBeenCalledWith("D:/project/.gal/nodes/side/side_entry.md")
    expect(vi.mocked(writeFile).mock.calls.some(([path]) => (
      typeof path === "string" && path.endsWith("/tree.json")
    ))).toBe(true)
    expect(vi.mocked(writeFile).mock.calls.some(([path]) => (
      typeof path === "string" && path.endsWith("/tree.svg")
    ))).toBe(true)
    expect(vi.mocked(writeFile).mock.calls.some(([path]) => (
      typeof path === "string" && path.includes("/节点正文/001-side entry.md")
    ))).toBe(true)
  })

  it("keeps a large main tree separate from a small special route tree", async () => {
    vi.mocked(readFile).mockResolvedValue("body")
    vi.mocked(writeFile).mockResolvedValue()
    const mainNodes = Array.from({ length: 141 }, (_, index) => (
      node(`main_${index}`, `main ${index}`, index === 0 ? [] : [`main_${index - 1}`], [])
    ))
    const sideNodes = Array.from({ length: 4 }, (_, index) => ({
      ...node(`side_${index}`, `side ${index}`, index === 0 ? [] : [`side_${index - 1}`], []),
      routeId: "side",
      scriptPath: `nodes/side/side_${index}.md`,
    }))
    const project: GalProject = {
      id: "project",
      title: "Story",
      premise: "",
      globalRules: "",
      variables: [],
      routes: [
        { ...route(mainNodes), entryNodeId: "main_0", endingNodeIds: [] },
        {
          id: "side",
          title: "side route",
          theme: "",
          entryNodeId: "side_0",
          endingNodeIds: [],
          nodes: sideNodes,
        },
      ],
      cgs: [],
      clues: [],
      createdAt: "",
      updatedAt: "",
    }

    const mainResult = await exportGalRouteTree("D:/project", "D:/exports", project, "main")
    const sideResult = await exportGalRouteTree("D:/project", "D:/exports", project, "side")

    expect(mainResult.nodeCount).toBe(141)
    expect(sideResult.nodeCount).toBe(4)
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
