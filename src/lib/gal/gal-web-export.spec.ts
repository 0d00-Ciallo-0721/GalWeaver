import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  buildStoryBundle,
  buildStoryNode,
  collectKnownCharacters,
  collectGraphRoutes,
  collectSavedPathRoutes,
  createEmptyExportReport,
  normalizeStoryRoutes,
  normalizeVariableDefinitions,
  parseScriptBlocks,
} from "./gal-web-export"
import { loadNodeScript } from "./gal-storage"
import type { GalNode, GalProject, GalRoute, GalVariable } from "./gal-types"

vi.mock("./gal-storage", () => ({
  loadNodeScript: vi.fn(),
}))

beforeEach(() => {
  vi.mocked(loadNodeScript).mockReset()
})

function node(id: string, routeId: string): GalNode {
  return {
    id,
    routeId,
    title: id,
    type: id.endsWith("entry") ? "entry" : "daily",
    status: "card",
    parents: [],
    children: [],
    goal: "",
    summary: "",
    scriptPath: `nodes/${routeId}/${id}.md`,
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

function graphRoute(id: string, title: string): GalRoute {
  return {
    id,
    title,
    theme: "",
    entryNodeId: `${id}_entry`,
    endingNodeIds: [`${id}_ending`],
    nodes: [node(`${id}_entry`, id), node(`${id}_ending`, id)],
  }
}

function savedPathRoute(): GalRoute {
  return {
    id: "saved_path",
    title: "Saved path",
    theme: "",
    entryNodeId: "main_entry",
    endingNodeIds: ["main_ending"],
    nodeIds: ["main_entry", "main_ending"],
    nodes: [],
  }
}

function project(variables: GalVariable[] = []): GalProject {
  return {
    id: "story",
    title: "Story",
    premise: "",
    globalRules: "",
    variables,
    routes: [
      graphRoute("main", "Main route"),
      graphRoute("side", "Side route"),
      savedPathRoute(),
    ],
    cgs: [],
    clues: [],
    createdAt: "",
    updatedAt: "",
  }
}

function routeWithNodes(nodes: GalNode[], patch: Partial<GalRoute> = {}): GalRoute {
  return {
    id: "route",
    title: "Route",
    theme: "",
    entryNodeId: nodes[0]?.id ?? "",
    endingNodeIds: [],
    nodes,
    ...patch,
  }
}

function countedGraphRoute(id: string, count: number): GalRoute {
  const nodes = Array.from({ length: count }, (_, index) => {
    const item = node(`${id}_${index}`, id)
    item.type = index === 0 ? "entry" : index === count - 1 ? "ending" : "daily"
    item.children = index < count - 1 ? [`${id}_${index + 1}`] : []
    item.parents = index > 0 ? [`${id}_${index - 1}`] : []
    item.characters = index === 0 ? ["Alex"] : []
    return item
  })
  return {
    id,
    title: `${id} route`,
    theme: "",
    entryNodeId: `${id}_0`,
    endingNodeIds: [`${id}_${count - 1}`],
    nodes,
  }
}

function nodeMap(nodes: GalNode[]): Map<string, GalNode> {
  return new Map(nodes.map((item) => [item.id, item]))
}

describe("gal web export stage 1", () => {
  it("creates an empty machine-readable export report", () => {
    expect(createEmptyExportReport("2026-07-11T00:00:00.000Z")).toEqual({
      schemaVersion: 1,
      exportedAt: "2026-07-11T00:00:00.000Z",
      stats: {
        routes: 0,
        nodes: 0,
        scriptsReady: 0,
        scriptsMissing: 0,
        choices: 0,
        endings: 0,
      },
      errors: [],
      warnings: [],
    })
  })

  it("separates graph routes from saved path routes", () => {
    const sample = project()

    expect(collectGraphRoutes(sample).map((route) => route.id)).toEqual(["main", "side"])
    expect(collectSavedPathRoutes(sample).map((route) => route.id)).toEqual(["saved_path"])
  })

  it("normalizes main and independent routes as graph routes and legacy nodeIds routes as saved paths", () => {
    const routes = normalizeStoryRoutes(project())

    expect(routes).toEqual([
      {
        id: "main",
        title: "Main route",
        kind: "graph",
        entryNodeId: "main_entry",
        endingNodeIds: ["main_ending"],
      },
      {
        id: "side",
        title: "Side route",
        kind: "graph",
        entryNodeId: "side_entry",
        endingNodeIds: ["side_ending"],
      },
      {
        id: "saved_path",
        title: "Saved path",
        kind: "saved-path",
        entryNodeId: "main_entry",
        endingNodeIds: ["main_ending"],
        nodeIds: ["main_entry", "main_ending"],
      },
    ])
  })

  it("normalizes existing variables into stable web variable definitions", () => {
    const variables: GalVariable[] = [
      {
        id: "intimacy",
        name: "Intimacy",
        type: "intimacy",
        defaultValue: 0,
        min: 0,
        max: 100,
        description: "Trust and closeness.",
      },
      {
        id: "love",
        name: "Love",
        type: "love",
        defaultValue: 5,
        min: 0,
        max: 100,
        description: "Romantic feeling.",
      },
      {
        id: "has_secret",
        name: "Has secret",
        type: "flag",
        defaultValue: false,
        description: "Whether a secret is known.",
      },
    ]

    expect(normalizeVariableDefinitions(project(variables))).toEqual([
      {
        id: "intimacy",
        name: "Intimacy",
        type: "number",
        initialValue: 0,
        min: 0,
        max: 100,
        description: "Trust and closeness.",
      },
      {
        id: "love",
        name: "Love",
        type: "number",
        initialValue: 5,
        min: 0,
        max: 100,
        description: "Romantic feeling.",
      },
      {
        id: "has_secret",
        name: "Has secret",
        type: "boolean",
        initialValue: false,
        description: "Whether a secret is known.",
      },
    ])
  })
})

describe("gal web export script parser", () => {
  it("parses scene, dialogue, thought, action, and narration blocks without losing text", () => {
    const result = parseScriptBlocks(
      "node_a",
      [
        "【场景：家，客厅沙发】",
        "妃爱：哥哥，过来一下。",
        "妃爱：（内心）再靠近一点就好了。",
        "（妃爱悄悄拽住袖口）",
        "窗外的雨声慢慢变轻。",
      ].join("\n"),
      [{ id: "fei_ai", name: "妃爱" }],
    )

    expect(result.blocks).toEqual([
      { id: "node_a:block:0", type: "scene", text: "家，客厅沙发" },
      { id: "node_a:block:1", type: "dialogue", speakerId: "fei_ai", text: "哥哥，过来一下。" },
      { id: "node_a:block:2", type: "thought", speakerId: "fei_ai", text: "再靠近一点就好了。" },
      { id: "node_a:block:3", type: "action", text: "妃爱悄悄拽住袖口" },
      { id: "node_a:block:4", type: "narration", text: "窗外的雨声慢慢变轻。" },
    ])
    expect(result.warnings).toEqual([
      {
        code: "SCRIPT_LINE_FALLBACK_NARRATION",
        message: "正文行未匹配到结构化格式，已按旁白保留。",
        nodeId: "node_a",
        line: 5,
      },
    ])
  })

  it("stops before choice markdown because choices must come from node.choices", () => {
    const result = parseScriptBlocks(
      "node_choice",
      [
        "妃爱：那就这样说定了。",
        "【选择】",
        "选项1：继续抱一会儿",
        "选项2：马上出门",
      ].join("\n"),
      ["妃爱"],
    )

    expect(result.blocks).toEqual([
      {
        id: "node_choice:block:0",
        type: "dialogue",
        speakerId: "character_fuoe",
        text: "那就这样说定了。",
      },
    ])
    expect(result.warnings).toEqual([])
  })

  it("keeps unrecognized non-empty text as narration and returns a warning", () => {
    const result = parseScriptBlocks("node_plain", "这是一行没有显式格式的正文。", [])

    expect(result.blocks).toEqual([
      {
        id: "node_plain:block:0",
        type: "narration",
        text: "这是一行没有显式格式的正文。",
      },
    ])
    expect(result.warnings).toEqual([
      {
        code: "SCRIPT_LINE_FALLBACK_NARRATION",
        message: "正文行未匹配到结构化格式，已按旁白保留。",
        nodeId: "node_plain",
        line: 1,
      },
    ])
  })

  it("generates stable speaker ids and warnings for unknown characters", () => {
    const first = parseScriptBlocks("node_unknown", "神秘人：你终于来了。", [])
    const second = parseScriptBlocks("node_unknown", "神秘人：换一句话也保持同一角色。", [])

    const firstSpeakerId = first.blocks[0].type === "dialogue" ? first.blocks[0].speakerId : ""
    const secondSpeakerId = second.blocks[0].type === "dialogue" ? second.blocks[0].speakerId : ""

    expect(first.blocks[0]).toEqual({
      id: "node_unknown:block:0",
      type: "dialogue",
      speakerId: firstSpeakerId,
      text: "你终于来了。",
    })
    expect(second.blocks[0]).toMatchObject({
      type: "dialogue",
      speakerId: firstSpeakerId,
    })
    expect(firstSpeakerId).toMatch(/^character_/)
    expect(secondSpeakerId).toBe(firstSpeakerId)
    expect(first.warnings).toEqual([
      {
        code: "SCRIPT_UNKNOWN_CHARACTER",
        message: "正文中出现未注册角色「神秘人」，已生成稳定角色 ID。",
        nodeId: "node_unknown",
        line: 1,
      },
    ])
  })

  it("keeps block ids stable when empty lines are present", () => {
    const result = parseScriptBlocks("node_stable", "妃爱：第一句。\n\n（点头）", ["妃爱"])

    expect(result.blocks.map((block) => block.id)).toEqual(["node_stable:block:0", "node_stable:block:1"])
  })

  it("collects known characters from project and route nodes before parsing", () => {
    const sample = project()
    sample.routes[0].nodes[0].characters = ["妃爱", "智宏"]
    sample.routes[1].nodes[0].characters = ["妃爱", "欧尼酱"]

    const characters = collectKnownCharacters({
      ...sample,
      characters: [{ id: "fei_ai_project", name: "妃爱" }],
    })
    const result = parseScriptBlocks("node_known", "妃爱：不会丢角色映射。", characters)

    expect(characters).toEqual([
      { id: "fei_ai_project", name: "妃爱" },
      { id: "character_hxlh", name: "智宏" },
      { id: "character_g5hy4", name: "欧尼酱" },
    ])
    expect(result.blocks).toEqual([
      {
        id: "node_known:block:0",
        type: "dialogue",
        speakerId: "fei_ai_project",
        text: "不会丢角色映射。",
      },
    ])
    expect(result.warnings).toEqual([])
  })
})

describe("gal web export story node builder", () => {
  it("exports node choices with stable ids, targetNodeId, and valid effects", () => {
    const start = node("start", "route")
    const target = node("target", "route")
    start.characters = ["Alex"]
    start.children = ["target"]
    start.choices = [{
      id: "",
      text: "Go to target",
      emotionalIntent: "continue",
      effects: [{ variable: "love", op: "add", value: 1 }],
      nextNodeId: "target",
    }]
    const route = routeWithNodes([start, target])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(
      start,
      route,
      nodeMap(route.nodes),
      "Alex: Hello.",
      [{ id: "love", name: "Love", type: "love", defaultValue: 0, description: "Love score." }],
      report,
    )

    expect(storyNode).toMatchObject({
      id: "start",
      type: "normal",
      status: "ready",
      choices: [{
        id: "start:choice:0",
        text: "Go to target",
        targetNodeId: "target",
        effects: [{ variableId: "love", op: "add", value: 1 }],
      }],
    })
    expect(storyNode.nextNodeId).toBeUndefined()
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it("exports nextNodeId when a node has no choices and exactly one child", () => {
    const start = node("start", "route")
    const child = node("child", "route")
    start.children = ["child"]
    const route = routeWithNodes([start, child])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode.nextNodeId).toBe("child")
    expect(storyNode.choices).toEqual([])
    expect(storyNode.status).toBe("missing-script")
    expect(report.errors).toEqual([])
    expect(report.warnings).toEqual([])
  })

  it("records an error when a node has multiple children but no choices", () => {
    const start = node("start", "route")
    const childA = node("child_a", "route")
    const childB = node("child_b", "route")
    start.children = ["child_a", "child_b"]
    const route = routeWithNodes([start, childA, childB])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode.nextNodeId).toBeUndefined()
    expect(report.errors).toEqual([{
      code: "NODE_HAS_MULTIPLE_DIRECT_CHILDREN",
      message: "Node start has multiple children but no choices.",
      nodeId: "start",
      routeId: "route",
    }])
  })

  it("records a warning when a non-ending node has no choices or children", () => {
    const start = node("start_entry", "route")
    const route = routeWithNodes([start])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode).toMatchObject({
      id: "start_entry",
      type: "entry",
      status: "missing-script",
      choices: [],
    })
    expect(storyNode.nextNodeId).toBeUndefined()
    expect(report.warnings).toEqual([{
      code: "NON_ENDING_NODE_HAS_NO_OUTGOING",
      message: "Non-ending node start_entry has no choices or children.",
      nodeId: "start_entry",
    }])
  })

  it("records an error when a choice points to a missing target node", () => {
    const start = node("start", "route")
    start.choices = [{
      id: "choice_missing",
      text: "Missing target",
      emotionalIntent: "continue",
      effects: [],
      nextNodeId: "missing",
    }]
    const route = routeWithNodes([start])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode.choices[0]).toMatchObject({
      id: "choice_missing",
      targetNodeId: "missing",
    })
    expect(report.errors).toEqual([{
      code: "CHOICE_TARGET_NOT_FOUND",
      message: "Choice choice_missing on node start points to missing node missing.",
      nodeId: "start",
    }])
  })

  it("records an error when a direct nextNodeId points to a missing node", () => {
    const start = node("start", "route")
    start.children = ["missing"]
    const route = routeWithNodes([start])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode.nextNodeId).toBe("missing")
    expect(report.errors).toEqual([{
      code: "NEXT_NODE_NOT_FOUND",
      message: "Node start points to missing child missing.",
      nodeId: "start",
      routeId: "route",
    }])
  })

  it("records an error when a choice effect references an unknown variable", () => {
    const start = node("start", "route")
    const target = node("target", "route")
    start.choices = [{
      id: "choice_bad_effect",
      text: "Bad effect",
      emotionalIntent: "continue",
      effects: [{ variable: "unknown", op: "set", value: true }],
      nextNodeId: "target",
    }]
    const route = routeWithNodes([start, target])
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(start, route, nodeMap(route.nodes), "", [], report)

    expect(storyNode.choices[0].effects).toBeUndefined()
    expect(report.errors).toEqual([{
      code: "CHOICE_EFFECT_VARIABLE_NOT_FOUND",
      message: "Choice choice_bad_effect on node start references missing variable unknown.",
      nodeId: "start",
    }])
  })

  it("marks ending nodes and warns when they still have outgoing targets", () => {
    const ending = node("ending", "route")
    const after = node("after", "route")
    ending.type = "ending"
    ending.children = ["after"]
    const route = routeWithNodes([ending, after], { endingNodeIds: ["ending"] })
    const report = createEmptyExportReport("2026-07-11T00:00:00.000Z")

    const storyNode = buildStoryNode(ending, route, nodeMap(route.nodes), "The end.", [], report)

    expect(storyNode).toMatchObject({
      id: "ending",
      type: "ending",
      status: "ready",
      endingId: "ending",
      nextNodeId: "after",
    })
    expect(report.warnings).toEqual(expect.arrayContaining([{
      code: "ENDING_NODE_HAS_OUTGOING",
      message: "Ending node ending has outgoing targets.",
      nodeId: "ending",
    }]))
  })
})

describe("gal web export story bundle builder", () => {
  it("builds a self-contained bundle from all graph route nodes", async () => {
    const main = countedGraphRoute("main", 141)
    const side = countedGraphRoute("side", 4)
    const legacy = {
      ...savedPathRoute(),
      nodes: [node("saved_only", "saved_path")],
    }
    const sample: GalProject = {
      ...project(),
      id: "story_id",
      title: "Story title",
      updatedAt: "2026-07-11T01:00:00.000Z",
      routes: [main, side, legacy],
    }
    vi.mocked(loadNodeScript).mockImplementation(async (_projectPath, routeId, nodeId) => `Alex: ${routeId}/${nodeId}`)

    const { bundle, report } = await buildStoryBundle("D:/project", sample, "2026-07-11T02:00:00.000Z")

    expect(bundle).toMatchObject({
      schemaVersion: 1,
      contentVersion: "2026-07-11T01:00:00.000Z",
      storyId: "story_id",
      title: "Story title",
      exportedAt: "2026-07-11T02:00:00.000Z",
      entryNodeId: "main_0",
    })
    expect(bundle.routes.map((route) => [route.id, route.kind])).toEqual([
      ["main", "graph"],
      ["side", "graph"],
      ["saved_path", "saved-path"],
    ])
    expect(bundle.nodes).toHaveLength(145)
    expect(bundle.nodes.some((item) => item.id === "saved_only")).toBe(false)
    expect(bundle.characters).toEqual([{ id: "character_17sqm", name: "Alex" }])
    expect(report.stats).toEqual({
      routes: 3,
      nodes: 145,
      scriptsReady: 145,
      scriptsMissing: 0,
      choices: 0,
      endings: 2,
    })
  })

  it("does not copy saved-path nodes into StoryBundle.nodes", async () => {
    const main = countedGraphRoute("main", 2)
    const legacy = {
      ...savedPathRoute(),
      nodes: [node("saved_only", "saved_path")],
    }
    const sample: GalProject = { ...project(), routes: [main, legacy] }
    vi.mocked(loadNodeScript).mockResolvedValue("Alex: body")

    const { bundle } = await buildStoryBundle("D:/project", sample, "2026-07-11T02:00:00.000Z")

    expect(bundle.routes.find((route) => route.id === "saved_path")).toMatchObject({
      kind: "saved-path",
      nodeIds: ["main_entry", "main_ending"],
    })
    expect(bundle.nodes.map((item) => item.id)).toEqual(["main_0", "main_1"])
  })

  it("loads independent route scripts using their own route ids", async () => {
    const main = countedGraphRoute("main", 1)
    const side = countedGraphRoute("side", 4)
    const sample: GalProject = { ...project(), routes: [main, side] }
    vi.mocked(loadNodeScript).mockImplementation(async (_projectPath, routeId, nodeId) => `Alex: loaded from ${routeId}/${nodeId}`)

    const { bundle } = await buildStoryBundle("D:/project", sample, "2026-07-11T02:00:00.000Z")

    expect(vi.mocked(loadNodeScript)).toHaveBeenCalledWith("D:/project", "side", "side_0")
    expect(vi.mocked(loadNodeScript)).toHaveBeenCalledWith("D:/project", "side", "side_3")
    expect(bundle.nodes.find((item) => item.id === "side_0")?.script).toEqual([
      {
        id: "side_0:block:0",
        type: "dialogue",
        speakerId: "character_17sqm",
        text: "loaded from side/side_0",
      },
    ])
  })

  it("collects character definitions from script speakers even when node characters are empty", async () => {
    const start = node("main_0", "main")
    start.type = "entry"
    start.characters = []
    const main = routeWithNodes([start], {
      id: "main",
      entryNodeId: "main_0",
      endingNodeIds: [],
    })
    const sample: GalProject = { ...project(), routes: [main] }
    vi.mocked(loadNodeScript).mockResolvedValue("Narrator: This speaker only exists in script.")

    const { bundle } = await buildStoryBundle("D:/project", sample, "2026-07-11T02:00:00.000Z")
    const narrator = bundle.characters.find((character) => character.name === "Narrator")

    expect(narrator?.id).toMatch(/^character_/)
    expect(bundle.nodes[0].script).toEqual([
      {
        id: "main_0:block:0",
        type: "dialogue",
        speakerId: narrator?.id,
        text: "This speaker only exists in script.",
      },
    ])
  })

  it("marks missing node scripts and counts them in the export report", async () => {
    const main = countedGraphRoute("main", 2)
    const side = countedGraphRoute("side", 4)
    const sample: GalProject = { ...project(), routes: [main, side] }
    vi.mocked(loadNodeScript).mockImplementation(async (_projectPath, _routeId, nodeId) => (
      nodeId === "side_3" ? null : "Alex: body"
    ))

    const { bundle, report } = await buildStoryBundle("D:/project", sample, "2026-07-11T02:00:00.000Z")

    expect(bundle.nodes.find((item) => item.id === "side_3")).toMatchObject({
      id: "side_3",
      status: "missing-script",
      script: [],
    })
    expect(report.stats.scriptsReady).toBe(5)
    expect(report.stats.scriptsMissing).toBe(1)
  })
})
