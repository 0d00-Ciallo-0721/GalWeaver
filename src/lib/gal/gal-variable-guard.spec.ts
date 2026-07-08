import { describe, expect, it } from "vitest"
import {
  sanitizeGalEffects,
  sanitizeGalProjectVariables,
} from "./gal-variable-guard"
import type { GalProject, GalVariable } from "./gal-types"

const variables: GalVariable[] = [
  {
    id: "intimacy",
    name: "亲密度",
    type: "intimacy",
    defaultValue: 0,
    description: "",
  },
  {
    id: "love",
    name: "恋爱度",
    type: "love",
    defaultValue: 0,
    description: "",
  },
]

describe("Gal variable guard", () => {
  it("只保留已定义变量，并把显示名归一化为变量 ID", () => {
    expect(sanitizeGalEffects([
      { variable: "亲密度", op: "add", value: 2 },
      { variable: "love", op: "set", value: 10 },
      { variable: "trust", op: "add", value: 1 },
      { variable: "", op: "add", value: 1 },
    ], variables)).toEqual([
      { variable: "intimacy", op: "add", value: 2 },
      { variable: "love", op: "set", value: 10 },
    ])
  })

  it("允许人工提前定义的自定义变量", () => {
    const customVariables: GalVariable[] = [
      ...variables,
      {
        id: "trust",
        name: "信任度",
        type: "custom",
        defaultValue: 0,
        description: "用户手动创建的变量",
      },
    ]

    expect(sanitizeGalEffects([
      { variable: "trust", op: "add", value: 1 },
    ], customVariables)).toEqual([
      { variable: "trust", op: "add", value: 1 },
    ])
  })

  it("保存前移除选项和状态快照里的虚空变量", () => {
    const project = createProject()
    const sanitized = sanitizeGalProjectVariables(project)
    const node = sanitized.routes[0].nodes[0]

    expect(sanitized.variables.map((variable) => variable.id)).toEqual(["intimacy", "love"])
    expect(node.choices[0].effects).toEqual([
      { variable: "intimacy", op: "add", value: 1 },
    ])
    expect(node.incomingState.variables).toEqual({
      intimacy: 5,
      love: 3,
    })
    expect(sanitized.routes[0].variableDefaults).toEqual({
      intimacy: 1,
    })
  })
})

function createProject(): GalProject {
  const now = "2026-07-05T00:00:00.000Z"
  return {
    id: "project",
    title: "test",
    premise: "",
    globalRules: "",
    variables: [...variables, { ...variables[0] }],
    routes: [{
      id: "main",
      title: "主线路",
      theme: "",
      entryNodeId: "entry",
      endingNodeIds: [],
      variableDefaults: {
        "亲密度": 1,
        trust: 9,
      },
      nodes: [{
        id: "entry",
        routeId: "main",
        title: "入口",
        type: "entry",
        status: "card",
        parents: [],
        children: [],
        goal: "",
        summary: "",
        scriptPath: "nodes/main/entry.md",
        incomingState: {
          variables: {
            intimacy: 5,
            "恋爱度": 3,
            affection: 8,
          },
          characterCognition: {},
          acquiredClueIds: [],
          seenCgIds: [],
          visitedNodeIds: [],
          currentScene: "",
          characterMoods: {},
        },
        choices: [{
          id: "choice",
          text: "选择",
          emotionalIntent: "",
          effects: [
            { variable: "亲密度", op: "add", value: 1 },
            { variable: "bond", op: "add", value: 1 },
          ],
        }],
        memoryScope: "node",
        characters: [],
        scene: "",
        clueIds: [],
        sequence: 0,
        createdAt: now,
        updatedAt: now,
      }],
    }],
    cgs: [],
    clues: [],
    createdAt: now,
    updatedAt: now,
  }
}
