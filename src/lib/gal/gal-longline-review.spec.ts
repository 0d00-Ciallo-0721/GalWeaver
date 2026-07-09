import { describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import { generateGalLonglineOptimizationPlan } from "./gal-longline-optimization"
import { reviewGalLongline, type GalLonglineReviewReport } from "./gal-longline-review"
import type { GalNode, GalProject, GalRoute } from "./gal-types"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

const llmConfig = {
  provider: "custom",
  apiKey: "",
  model: "test",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 8000,
} as const

describe("reviewGalLongline", () => {
  it("过滤长线单出口节点的补选项类误报", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
      callbacks.onToken?.(JSON.stringify({
        rangeSummary: "最后一个目标节点缺少选项导致无法导向下游。",
        issues: [
          {
            nodeId: "a",
            title: "脸红的心跳约定",
            severity: "warning",
            category: "导向",
            detail: "节点结尾缺少【选择】部分，无法提供路径导向下游界节点，必须添加结尾选项。",
          },
          {
            nodeId: "b",
            title: "重复拥抱",
            severity: "warning",
            category: "重复",
            detail: "连续两段都用相同动作承接，节奏重复。",
          },
        ],
        missingScripts: [],
        continuityBreaks: [],
        suggestedInsertions: [],
        rewriteTargets: [
          {
            nodeId: "a",
            title: "脸红的心跳约定",
            reason: "必须补充三个选项，否则玩家无法推进。",
          },
          {
            nodeId: "b",
            title: "重复拥抱",
            reason: "建议改写重复动作。",
          },
        ],
      }))
      callbacks.onDone?.()
    })

    const report = await reviewGalLongline({
      project,
      route,
      upstreamBoundary: null,
      targetNodes: [
        { node: node("a", "脸红的心跳约定"), script: "她轻轻靠近。选项1: 继续" },
        { node: node("b", "重复拥抱"), script: "她再次靠近。" },
      ],
      downstreamBoundary: null,
      llmConfigOverride: llmConfig,
    })

    expect(report.issues.map((item) => item.nodeId)).toEqual(["b"])
    expect(report.rewriteTargets.map((item) => item.nodeId)).toEqual(["b"])
  })
})

describe("generateGalLonglineOptimizationPlan", () => {
  it("Per-Finding Plan 过滤涉及选项的 step", async () => {
    const mockStep = {
      type: "rewrite_node",
      targetNodeId: "a",
      title: "补充选项",
      reason: "补充选项。",
      intent: "增加分支选择。",
      scope: "改写节点选项。",
      constraints: ["补充三个选项"],
      priority: "high",
      risk: "medium",
    }

    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      // 验证新架构的 Per-Finding Plan prompt
      expect(messages[1].content).toContain("对应发现")
      expect(messages[1].content).not.toContain("optimizedScript")
      callbacks.onToken?.(JSON.stringify(mockStep))
      callbacks.onDone?.()
    })

    const plan = await generateGalLonglineOptimizationPlan({
      project,
      route,
      mode: "problem_nodes",
      reviewReport: choiceOnlyReport,
      upstreamBoundary: null,
      targetNodes: [
        { node: node("a", "脸红的心跳约定"), script: "她轻轻靠近。选项1: 继续" },
      ],
      downstreamBoundary: null,
      llmConfigOverride: llmConfig,
    })

    expect(plan.steps).toEqual([])
  })
})

const project: GalProject = {
  id: "project",
  title: "测试项目",
  premise: "",
  globalRules: "",
  variables: [],
  clues: [],
  cgs: [],
  routes: [],
  createdAt: "",
  updatedAt: "",
}

const route: GalRoute = {
  id: "route",
  title: "主线路",
  theme: "",
  entryNodeId: "a",
  endingNodeIds: [],
  nodes: [],
}

const choiceOnlyReport: GalLonglineReviewReport = {
  rangeSummary: "最后一个目标节点缺少选项。",
  issues: [{
    nodeId: "a",
    title: "脸红的心跳约定",
    severity: "warning",
    category: "导向",
    detail: "节点结尾缺少【选择】部分，无法提供路径导向下游界节点，必须添加结尾选项。",
  }],
  missingScripts: [],
  continuityBreaks: [],
  suggestedInsertions: [],
  rewriteTargets: [{
    nodeId: "a",
    title: "脸红的心跳约定",
    reason: "必须补充三个选项，否则玩家无法推进。",
  }],
}

function node(id: string, title: string): GalNode {
  return {
    id,
    routeId: "route",
    title,
    type: "daily",
    status: "draft",
    parents: [],
    children: [],
    goal: "",
    summary: "",
    scriptPath: `nodes/route/${id}.md`,
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
