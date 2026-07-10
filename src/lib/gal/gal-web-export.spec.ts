import { describe, expect, it } from "vitest"
import {
  collectKnownCharacters,
  collectGraphRoutes,
  collectSavedPathRoutes,
  createEmptyExportReport,
  normalizeStoryRoutes,
  normalizeVariableDefinitions,
  parseScriptBlocks,
} from "./gal-web-export"
import type { GalNode, GalProject, GalRoute, GalVariable } from "./gal-types"

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
