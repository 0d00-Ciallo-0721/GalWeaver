import { beforeEach, describe, expect, it, vi } from "vitest"
import { fileExists, readFile } from "@/commands/fs"
import { loadGalProject } from "./gal-storage"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

vi.mock("@/commands/fs", () => ({
  readFile: vi.fn(),
  writeFileAtomic: vi.fn(),
  createDirectory: vi.fn(),
  fileExists: vi.fn(),
  listDirectory: vi.fn(),
  deleteFile: vi.fn(),
}))

const projectPath = "D:/Novel"

describe("loadGalProject", () => {
  beforeEach(() => {
    vi.mocked(readFile).mockReset()
    vi.mocked(fileExists).mockReset()
    vi.mocked(fileExists).mockResolvedValue(true)
  })

  it("从 project.json 路由索引兜底加载节点，避免 routes.json 异常时重启后显示空项目", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path.endsWith("/.gal/project.json")) return JSON.stringify(projectMeta())
      if (path.endsWith("/.gal/variables.json")) return "[]"
      if (path.endsWith("/.gal/clues.json")) return "[]"
      if (path.endsWith("/.gal/cgs.json")) return "[]"
      if (path.endsWith("/.gal/routes.json")) throw new Error("missing routes index")
      if (path.endsWith("/.gal/routes/main.json")) return JSON.stringify(mainRoute())
      throw new Error(`unexpected path: ${path}`)
    })

    const project = await loadGalProject(projectPath)

    expect(project?.routes).toHaveLength(1)
    expect(project?.routes[0].id).toBe("main")
    expect(project?.routes[0].nodes.map((node) => node.id)).toEqual(["entry"])
  })

  it("允许 Gal JSON 文件带 UTF-8 BOM", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path.endsWith("/.gal/project.json")) return `\uFEFF${JSON.stringify(projectMeta())}`
      if (path.endsWith("/.gal/variables.json")) return "\uFEFF[]"
      if (path.endsWith("/.gal/clues.json")) return "[]"
      if (path.endsWith("/.gal/cgs.json")) return "[]"
      if (path.endsWith("/.gal/routes.json")) return JSON.stringify([{ id: "main" }])
      if (path.endsWith("/.gal/routes/main.json")) return `\uFEFF${JSON.stringify(mainRoute())}`
      throw new Error(`unexpected path: ${path}`)
    })

    const project = await loadGalProject(projectPath)

    expect(project?.routes[0].nodes).toHaveLength(1)
  })

  it("normalizes unknown node types without dropping node metadata", async () => {
    vi.mocked(readFile).mockImplementation(async (path) => {
      if (path.endsWith("/.gal/project.json")) return JSON.stringify(projectMeta())
      if (path.endsWith("/.gal/variables.json")) return "[]"
      if (path.endsWith("/.gal/clues.json")) return "[]"
      if (path.endsWith("/.gal/cgs.json")) return "[]"
      if (path.endsWith("/.gal/routes.json")) return JSON.stringify([{ id: "main" }])
      if (path.endsWith("/.gal/routes/main.json")) {
        const route = mainRoute()
        route.nodes = [{
          ...node("secret"),
          title: "秘密约会",
          type: "secret_date" as GalNode["type"],
          goal: "保留原始剧情目标",
          summary: "保留原始概要",
          scene: "保留原始场景",
        }]
        return JSON.stringify(route)
      }
      throw new Error(`unexpected path: ${path}`)
    })

    const project = await loadGalProject(projectPath)
    const loadedNode = project?.routes[0].nodes[0]

    expect(loadedNode?.id).toBe("secret")
    expect(loadedNode?.type).toBe("daily")
    expect(loadedNode?.title).toBe("秘密约会")
    expect(loadedNode?.goal).toBe("保留原始剧情目标")
    expect(loadedNode?.summary).toBe("保留原始概要")
    expect(loadedNode?.scene).toBe("保留原始场景")
    expect(loadedNode?.scriptPath).toBe("nodes/main/secret.md")
  })
})

function projectMeta(): GalProject {
  return {
    id: "project",
    title: "Story",
    premise: "",
    globalRules: "",
    variables: [],
    routes: [{
      id: "main",
      title: "主线路",
      theme: "主线树",
      entryNodeId: "entry",
      endingNodeIds: [],
      nodes: [],
    }],
    cgs: [],
    clues: [],
    createdAt: "",
    updatedAt: "",
  }
}

function mainRoute(): GalRoute {
  return {
    id: "main",
    title: "主线路",
    theme: "主线树",
    entryNodeId: "entry",
    endingNodeIds: [],
    nodes: [node("entry")],
  }
}

function node(id: string): GalNode {
  return {
    id,
    routeId: "main",
    title: "入口",
    type: "entry",
    status: "card",
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
  }
}
