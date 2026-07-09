import { beforeEach, describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import { buildGalContextPack } from "./gal-context-engine"
import { generateRelayNodeCard } from "./gal-node-generation"
import { saveGalProject, saveNodeScript } from "./gal-storage"
import { executeGalLonglinePlan, type GalLonglinePlanExecutionStep } from "./gal-longline-plan-executor"
import type { GalLonglineOptimizationPlan, GalLonglineOptimizationStep } from "./gal-longline-optimization"
import type { GalProject, GalRoute } from "./gal-types"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

vi.mock("./gal-context-engine", () => ({
  buildGalContextPack: vi.fn(),
}))

vi.mock("./gal-node-generation", () => ({
  generateRelayNodeCard: vi.fn(),
}))

vi.mock("./gal-storage", () => ({
  saveGalProject: vi.fn(),
  saveNodeScript: vi.fn(),
}))

const llmConfig = {
  provider: "custom",
  apiKey: "",
  model: "test",
  ollamaUrl: "",
  customEndpoint: "",
  maxContextSize: 8000,
} as const

describe("executeGalLonglinePlan", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(buildGalContextPack).mockResolvedValue(contextPack)
    vi.mocked(generateRelayNodeCard).mockResolvedValue(relayCard)
  })

  it("按计划步骤顺序串行执行选中项", async () => {
    const events: string[] = []
    const reportPromise = executeGalLonglinePlan({
      ...baseParams(),
      selectedStepIds: new Set(["step_1", "step_2"]),
      onStepUpdate: (step) => events.push(`${step.stepId}:${step.status}`),
      executeStep: async (step) => {
        events.push(`${step.id}:start`)
        await Promise.resolve()
        events.push(`${step.id}:finish`)
        return result(step, "succeeded")
      },
    })

    const report = await reportPromise

    expect(events).toEqual([
      "step_1:running",
      "step_1:start",
      "step_1:finish",
      "step_1:succeeded",
      "step_2:running",
      "step_2:start",
      "step_2:finish",
      "step_2:succeeded",
    ])
    expect(report.steps.map((step) => step.stepId)).toEqual(["step_1", "step_2"])
    expect(report.steps.every((step) => step.status === "succeeded")).toBe(true)
  })

  it("rewrite_node 成功生成完整正文并写回", async () => {
    mockStreamResponses(["智宏沉默片刻，终于把话说完整。妃爱听完以后，轻轻点头，两个人的距离自然拉近。"])

    const params = baseParams()
    const report = await executeGalLonglinePlan({
      ...params,
      selectedStepIds: new Set(["step_1"]),
    })

    expect(report.steps[0]).toMatchObject({
      stepId: "step_1",
      status: "succeeded",
      nodeId: "node_1",
      nodeTitle: "目标一",
      written: true,
    })
    expect(report.steps[0].updatedScript).toContain("智宏沉默片刻")
    expect(saveNodeScript).toHaveBeenCalledWith("D:/project", "route", "node_1", expect.stringContaining("智宏沉默片刻"))
    expect(saveGalProject).toHaveBeenCalledOnce()
    expect(params.project.routes[0].nodes[0].status).toBe("draft")
  })

  it("route 参数不是 project 内同一引用时也会更新 project 节点状态", async () => {
    mockStreamResponses(["智宏把重复的动作收束成一次更清晰的靠近，妃爱也因此自然地接下了这段对话。"])

    const params = baseParams()
    const detachedRoute = {
      ...params.route,
      nodes: params.route.nodes.map((node) => ({ ...node, parents: [...node.parents], children: [...node.children] })),
    }
    await executeGalLonglinePlan({
      ...params,
      route: detachedRoute,
      selectedStepIds: new Set(["step_1"]),
    })

    expect(detachedRoute.nodes[1].updatedAt).not.toBe("")
    expect(params.project.routes[0].nodes[1].updatedAt).toBe(detachedRoute.nodes[1].updatedAt)
  })

  it("空正文会触发重试，第二次成功后写回", async () => {
    mockStreamResponses(["", "妃爱先是一怔，随后把手收紧了一点。智宏顺着她的反应放慢语速，让这段对话自然落到下一幕。"])

    const report = await executeGalLonglinePlan({
      ...baseParams(),
      selectedStepIds: new Set(["step_1"]),
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(report.steps[0].status).toBe("succeeded")
    expect(saveNodeScript).toHaveBeenCalledOnce()
  })

  it("连续失败不会写回正文", async () => {
    mockStreamResponses(["", "这里是优化正文：请自行补充", "{\"script\":\"正文\"}"])

    const report = await executeGalLonglinePlan({
      ...baseParams(),
      selectedStepIds: new Set(["step_1"]),
    })

    expect(streamChat).toHaveBeenCalledTimes(3)
    expect(report.steps[0].status).toBe("failed")
    expect(saveNodeScript).not.toHaveBeenCalled()
    expect(saveGalProject).not.toHaveBeenCalled()
  })

  it("Markdown 代码块输出会被拒绝且不写回", async () => {
    mockStreamResponses([
      "```text\n智宏把话说完，妃爱听见以后终于稍微放松下来。\n```",
      "```text\n智宏把话说完，妃爱听见以后终于稍微放松下来。\n```",
      "```text\n智宏把话说完，妃爱听见以后终于稍微放松下来。\n```",
    ])

    const report = await executeGalLonglinePlan({
      ...baseParams(),
      selectedStepIds: new Set(["step_1"]),
    })

    expect(report.steps[0].status).toBe("failed")
    expect(saveNodeScript).not.toHaveBeenCalled()
  })

  it("只执行用户选中的 rewrite_node step", async () => {
    mockStreamResponses(["智宏把先前的犹豫收束成一句明确的回应，妃爱也终于露出安心的表情。"])

    const report = await executeGalLonglinePlan({
      ...baseParams(),
      selectedStepIds: new Set(["step_1"]),
    })

    expect(report.steps.map((step) => step.stepId)).toEqual(["step_1"])
    expect(streamChat).toHaveBeenCalledTimes(1)
    expect(saveNodeScript).toHaveBeenCalledTimes(1)
  })

  it("insert_bridge_node 成功插入中继节点并正确重接单线", async () => {
    mockStreamResponses(["智宏和妃爱在短暂的停顿里整理好情绪，两个人重新确认彼此的想法后，自然走向下一段对话。"])

    const params = baseParams()
    const report = await executeGalLonglinePlan({
      ...params,
      selectedStepIds: new Set(["step_2"]),
    })
    const route = params.project.routes[0]
    const bridge = route.nodes.find((node) => node.id === report.steps[0].insertedNodeId)

    expect(report.steps[0].status).toBe("succeeded")
    expect(report.steps[0]).toMatchObject({
      nodeTitle: relayCard.title,
      insertedNodeId: bridge!.id,
      insertedNodeTitle: relayCard.title,
      written: true,
    })
    expect(bridge).toBeTruthy()
    expect(bridge).toMatchObject({
      title: relayCard.title,
      type: "daily",
      status: "draft",
      parents: ["node_1"],
      children: ["node_2"],
    })
    expect(route.nodes.find((node) => node.id === "node_1")?.children).toEqual([bridge!.id])
    expect(route.nodes.find((node) => node.id === "node_2")?.parents).toEqual([bridge!.id])
    expect(bridge!.choices).toHaveLength(1)
    expect(bridge!.choices[0].nextNodeId).toBe("node_2")
    expect(route.nodeIds).toEqual(["upstream", "node_1", bridge!.id, "node_2", "downstream"])
    expect(saveNodeScript).toHaveBeenCalledWith("D:/project", "route", bridge!.id, expect.stringContaining("智宏和妃爱"))
    expect(saveGalProject).toHaveBeenCalledOnce()
  })

  it("insert_bridge_node 拒绝非相邻节点且不会调用 AI", async () => {
    const params = baseParams()
    const brokenPlan = {
      ...plan,
      steps: [{ ...plan.steps[1], afterNodeId: "node_1", beforeNodeId: "downstream" }],
    }

    const report = await executeGalLonglinePlan({
      ...params,
      plan: brokenPlan,
      selectedStepIds: new Set(["step_2"]),
    })

    expect(report.steps[0].status).toBe("failed")
    expect(generateRelayNodeCard).not.toHaveBeenCalled()
    expect(streamChat).not.toHaveBeenCalled()
    expect(saveGalProject).not.toHaveBeenCalled()
  })

  it("insert_bridge_node 正文为空时不插入节点", async () => {
    mockStreamResponses(["", "", ""])
    const params = baseParams()

    const report = await executeGalLonglinePlan({
      ...params,
      selectedStepIds: new Set(["step_2"]),
    })

    expect(report.steps[0].status).toBe("failed")
    expect(generateRelayNodeCard).toHaveBeenCalledTimes(3)
    expect(saveNodeScript).not.toHaveBeenCalled()
    expect(saveGalProject).not.toHaveBeenCalled()
    expect(params.project.routes[0].nodes.map((node) => node.id)).toEqual(["upstream", "node_1", "node_2", "downstream"])
  })

  it("insert_bridge_node 正文重试后成功插入", async () => {
    mockStreamResponses(["", "妃爱先停住脚步，智宏顺着她的沉默放慢语气。两个人把刚才的误会说清楚后，情绪自然落到下一幕。"])
    const params = baseParams()

    const report = await executeGalLonglinePlan({
      ...params,
      selectedStepIds: new Set(["step_2"]),
    })

    expect(streamChat).toHaveBeenCalledTimes(2)
    expect(generateRelayNodeCard).toHaveBeenCalledTimes(2)
    expect(report.steps[0].status).toBe("succeeded")
    expect(params.project.routes[0].nodes).toHaveLength(5)
  })

  it("insert_bridge_node 连续失败不改 project", async () => {
    mockStreamResponses(["", "这里是优化正文：请自行补全", "{\"script\":\"正文\"}"])
    const params = baseParams()
    const beforeNodeIds = params.project.routes[0].nodes.map((node) => node.id)
    const beforePath = [...params.project.routes[0].nodeIds!]

    const report = await executeGalLonglinePlan({
      ...params,
      selectedStepIds: new Set(["step_2"]),
    })

    expect(report.steps[0].status).toBe("failed")
    expect(params.project.routes[0].nodes.map((node) => node.id)).toEqual(beforeNodeIds)
    expect(params.project.routes[0].nodeIds).toEqual(beforePath)
    expect(saveNodeScript).not.toHaveBeenCalled()
    expect(saveGalProject).not.toHaveBeenCalled()
  })
})

const plan: GalLonglineOptimizationPlan = {
  mode: "problem_nodes",
  summary: "测试计划",
  steps: [
    step("step_1", "rewrite_node", "node_1"),
    step("step_2", "insert_bridge_node"),
    step("step_3", "skip", "node_2"),
    step("step_4", "rewrite_node", "node_2"),
  ],
}

const contextPack = {
  task: "",
  soulDoc: "灵魂文档",
  outline: "大纲",
  novelCharacterStates: "角色状态",
  projectDocs: "",
  premise: "世界观",
  globalRules: "禁止跑偏",
  routeTheme: "主线",
  characterProfiles: "角色档案",
  nodeCard: "",
  parentEndings: "",
  childBeginnings: "",
  pathSummary: "",
  variableState: "",
  characterMoods: "",
  acquiredClues: "",
  characterCognition: "",
}

const relayCard = {
  title: "情绪缓冲",
  goal: "让前后节点之间的行动和情绪自然过渡",
  summary: "两人短暂停顿并重新确认彼此想法。",
  scene: "客厅",
  characters: ["妃爱", "智宏"],
  entryChoiceText: "继续",
  entryChoiceIntent: "自然进入后续节点",
}

function baseParams() {
  const project = makeProject()
  return {
    projectPath: "D:/project",
    project,
    route: project.routes[0],
    plan,
    selectedStepIds: new Set<string>(),
    scripts: {
      upstream: "上游边界结尾。",
      node_1: "原正文。",
      node_2: "后续节点开头。",
      downstream: "下游边界开头。",
    },
    upstreamBoundary: {
      node: project.routes[0].nodes[0],
      script: "上游边界结尾。",
    },
    downstreamBoundary: {
      node: project.routes[0].nodes[3],
      script: "下游边界开头。",
    },
    llmConfigOverride: llmConfig,
  }
}

function makeProject(): GalProject {
  return {
    id: "project",
    title: "测试项目",
    premise: "",
    globalRules: "",
    variables: [],
    clues: [],
    cgs: [],
    routes: [route()],
    createdAt: "",
    updatedAt: "",
  }
}

function route(): GalRoute {
  return {
    id: "route",
    title: "主线路",
    theme: "",
    entryNodeId: "upstream",
    endingNodeIds: [],
    nodeIds: ["upstream", "node_1", "node_2", "downstream"],
    nodes: [
      node("upstream", "上游", [], ["node_1"], 0),
      node("node_1", "目标一", ["upstream"], ["node_2"], 1),
      node("node_2", "目标二", ["node_1"], ["downstream"], 2),
      node("downstream", "下游", ["node_2"], [], 3),
    ],
  }
}

function node(id: string, title: string, parents: string[], children: string[], sequence: number) {
  return {
    id,
    routeId: "route",
    title,
    type: "daily" as const,
    status: "draft" as const,
    parents,
    children,
    goal: "节点目标",
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
    memoryScope: "node" as const,
    characters: ["妃爱", "智宏"],
    scene: "家",
    clueIds: [],
    sequence,
    createdAt: "",
    updatedAt: "",
  }
}

function step(
  id: string,
  type: GalLonglineOptimizationStep["type"],
  targetNodeId?: string,
): GalLonglineOptimizationStep {
  return {
    id,
    type,
    targetNodeId,
    afterNodeId: type === "insert_bridge_node" ? "node_1" : undefined,
    beforeNodeId: type === "insert_bridge_node" ? "node_2" : undefined,
    title: id,
    reason: "原因",
    intent: "意图",
    scope: "范围",
    constraints: [],
    priority: "medium",
    risk: "low",
  }
}

function result(
  step: GalLonglineOptimizationStep,
  status: GalLonglinePlanExecutionStep["status"],
): GalLonglinePlanExecutionStep {
  return {
    stepId: step.id,
    type: step.type,
    title: step.title,
    status,
    message: "done",
  }
}

function mockStreamResponses(responses: string[]) {
  let index = 0
  vi.mocked(streamChat).mockImplementation(async (_config, _messages, callbacks) => {
    callbacks.onToken?.(responses[index] ?? "")
    index += 1
    callbacks.onDone?.()
  })
}
