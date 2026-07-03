/**
 * Galgame 任务路由
 *
 * 模仿 NovelTaskIntent 的正则+关键词匹配模式，
 * 将用户自然语言请求路由到 Galgame 专用操作。
 *
 * ponytail: 复用 task-router.ts 的架构，只改 intent 定义和模式。
 */

// ─── 意图定义 ──────────────────────────────────────────────

export type GalTaskIntent =
  | "init_gal_project"       // 初始化 Gal 项目
  | "generate_route_graph"   // 生成线路骨架
  | "write_entry_node"       // 写入入口节点
  | "expand_child_nodes"     // 从选项生成子节点卡片
  | "write_node"             // 写入单个节点完整正文
  | "rewrite_node"           // 改写节点
  | "polish_node"            // 润色节点
  | "review_node"            // 审查节点
  | "lint_branch_graph"      // 分支检查
  | "extract_node_memory"    // 节点记忆摄取
  | "node_query"             // 节点查询
  | "variable_query"         // 变量/状态查询
  | "clue_query"             // 线索查询
  | "general_chat"           // 一般对话

export interface GalTaskRouteResult {
  intent: GalTaskIntent
  confidence: number
  nodeId?: string
  routeId?: string
  extractedParams: Record<string, string>
}

// ─── 模式定义 ──────────────────────────────────────────────

interface IntentPattern {
  intent: GalTaskIntent
  patterns: RegExp[]
  keywords: string[]
  weight: number
}

const INTENT_PATTERNS: IntentPattern[] = [
  {
    intent: "init_gal_project",
    patterns: [
      /^(初始化|创建|新建|建立)\s*.{0,6}?\s*(gal|GAL|视觉小说|恋爱|剧本|galgame)\s*(项目|工程)?/,
      /^(开始|启动)\s*(gal|视觉小说|恋爱游戏|恋爱模拟|恋爱剧本)/,
    ],
    keywords: ["初始化gal", "创建gal", "新建gal项目", "开始gal"],
    weight: 10,
  },
  {
    intent: "generate_route_graph",
    patterns: [
      /^(生成|创建)\s*(线路|路线|分支)\s*(骨架|图|结构)/,
      /(生成|规划)\s*(线路图|路线图|分支图)/,
    ],
    keywords: ["生成线路", "线路骨架", "路线图", "分支结构"],
    weight: 9,
  },
  {
    intent: "write_entry_node",
    patterns: [
      /^(写|生成|撰写|创作)\s*(入口|开始|第一|开场|起始)\s*(节点|剧情|剧本)/,
      /^(开始|启动)\s*(写|生成)\s*(入口|开场)/,
    ],
    keywords: ["入口节点", "开始写", "写开场", "第一章"],
    weight: 10,
  },
  {
    intent: "expand_child_nodes",
    patterns: [
      /^(根据|按照|基于)\s*(选项|选择).*(生成|创建)\s*(子节点|分支)/,
      /^(展开|生成)\s*(子节点|分支|下一级)/,
      /(选项|选择).*之后.*(生成|创建)/,
    ],
    keywords: ["展开子节点", "生成分支", "选项之后", "子节点卡片"],
    weight: 9,
  },
  {
    intent: "write_node",
    patterns: [
      /^(写|生成|撰写)\s*(当前|这个|该)\s*(节点|剧情|剧本)/,
      /^(写|生成)\s*节点/,
      /(继续|接着)\s*(写|生成)\s*(节点|剧情)/,
    ],
    keywords: ["写节点", "生成节点", "继续写节点", "写当前节点"],
    weight: 12,
  },
  {
    intent: "rewrite_node",
    patterns: [
      /^(改写|重写|重新写)\s*(当前|这个)?\s*(节点|剧情)/,
      /(改写|重写|重新写|换种写法)/,
    ],
    keywords: ["改写节点", "重写", "换种写法"],
    weight: 9,
  },
  {
    intent: "polish_node",
    patterns: [
      /^(润色|优化|精修)\s*(节点|剧本|这个)/,
      /(润色|优化|精修)\s*(一下|这段)/,
    ],
    keywords: ["润色", "优化节点", "精修剧本"],
    weight: 9,
  },
  {
    intent: "review_node",
    patterns: [
      /^(审查|审阅|检查)\s*(节点|剧本|这个)/,
      /(帮我|请)\s*(审查|审阅|检查)\s*(节点)/,
      /有没有.*(问题|错误|矛盾|崩坏)/,
    ],
    keywords: ["审查节点", "审阅", "检查节点", "有问题吗"],
    weight: 9,
  },
  {
    intent: "lint_branch_graph",
    patterns: [
      /^(检查|审查)\s*(分支|线路|路线)\s*(结构|逻辑|完整性)/,
      /(分支|线路)\s*(检查|审查|lint)/,
      /(有没有|是否存在)\s*(断线|死胡同|不可达)/,
    ],
    keywords: ["分支检查", "线路检查", "断线检查", "分支lint"],
    weight: 8,
  },
  {
    intent: "extract_node_memory",
    patterns: [
      /^(提取|摄取|保存)\s*(节点)?\s*(记忆|快照|信息)/,
      /(保存|确认)\s*节点/,
    ],
    keywords: ["提取记忆", "保存节点", "节点摄取", "确认节点"],
    weight: 8,
  },
  {
    intent: "node_query",
    patterns: [
      /^(查看|显示|当前)\s*(节点|剧情|进展)/,
      /(这个|当前)\s*节点.*(是什么|怎么样)/,
    ],
    keywords: ["查看节点", "当前节点", "节点信息", "节点状态"],
    weight: 7,
  },
  {
    intent: "variable_query",
    patterns: [
      /^(查看|显示|当前)\s*(变量|状态|属性|数值)/,
      /(亲密度|恋爱度|好感度|flag).*(多少|怎么样)/,
    ],
    keywords: ["变量", "亲密度", "恋爱度", "好感度", "flag"],
    weight: 7,
  },
  {
    intent: "clue_query",
    patterns: [
      /^(查看|显示|当前)\s*(线索|伏笔)/,
      /(有哪些|还有什么)\s*(线索|未发现)/,
    ],
    keywords: ["线索", "伏笔", "已获线索", "未发现"],
    weight: 7,
  },
]

// ─── 路由函数 ──────────────────────────────────────────────

export function routeGalTask(userInput: string): GalTaskRouteResult {
  const trimmed = userInput.trim()
  if (!trimmed) {
    return { intent: "general_chat", confidence: 1, extractedParams: {} }
  }

  const scores: { intent: GalTaskIntent; score: number }[] = []

  for (const intentDef of INTENT_PATTERNS) {
    let score = 0

    for (const pattern of intentDef.patterns) {
      if (pattern.test(trimmed)) {
        score += intentDef.weight
        break
      }
    }

    for (const keyword of intentDef.keywords) {
      if (trimmed.includes(keyword)) {
        score += intentDef.weight * 0.6
        break
      }
    }

    if (score > 0) {
      scores.push({ intent: intentDef.intent, score })
    }
  }

  if (scores.length === 0) {
    return { intent: "general_chat", confidence: 0.5, extractedParams: {} }
  }

  scores.sort((a, b) => b.score - a.score)
  const best = scores[0]
  const maxPossible = 16
  const confidence = Math.min(best.score / maxPossible, 1)

  return {
    intent: best.intent,
    confidence,
    extractedParams: {},
  }
}

// ─── 指令生成 ──────────────────────────────────────────────

export function buildGalTaskDirective(route: GalTaskRouteResult): string {
  const directives: Record<GalTaskIntent, string> = {
    init_gal_project:
      "用户要求初始化 Galgame 视觉小说项目。请根据设定生成线路骨架和入口节点卡片。",
    generate_route_graph:
      "用户要求生成线路骨架。请根据项目设定规划多条线路的节点结构。",
    write_entry_node:
      "用户要求写入入口节点。请生成该线路第一个节点的完整剧本正文。",
    expand_child_nodes:
      "用户要求从父节点的选项展开子节点。请为每个选项生成一个子节点剧情卡片（仅概要）。",
    write_node:
      "用户要求生成当前节点的完整剧本正文。请根据上下文包中的路径摘要、变量状态和角色认知撰写。",
    rewrite_node:
      "用户要求改写当前节点。请根据修改要求重写指定内容。",
    polish_node:
      "用户要求润色当前节点。请优化文笔，增强画面感和情感表达。",
    review_node:
      "用户要求审查当前节点。请检查人设一致性、剧情连贯性、变量合规性和选项合理性。",
    lint_branch_graph:
      "用户要求检查分支结构。请检测断线、不可达结局、变量冲突、共同节点合流问题。",
    extract_node_memory:
      "用户要求提取节点记忆。请从正文中提取结构化信息（摘要、人物、事件、变量变化等）。",
    node_query:
      "用户正在查询节点信息。请根据当前节点数据回答。",
    variable_query:
      "用户正在查询变量/状态。请列出当前变量的值。",
    clue_query:
      "用户正在查询线索。请列出已获和未获线索。",
    general_chat: "",
  }

  const directive = directives[route.intent]
  if (!directive) return ""

  return `\n## 任务类型识别\n意图：${intentToLabel(route.intent)}（置信度 ${Math.round(route.confidence * 100)}%）\n指令：${directive}\n`
}

function intentToLabel(intent: GalTaskIntent): string {
  const labels: Record<GalTaskIntent, string> = {
    init_gal_project: "GAL项目初始化",
    generate_route_graph: "线路骨架生成",
    write_entry_node: "入口节点生成",
    expand_child_nodes: "子节点展开",
    write_node: "节点生成",
    rewrite_node: "节点改写",
    polish_node: "节点润色",
    review_node: "节点审查",
    lint_branch_graph: "分支检查",
    extract_node_memory: "节点记忆摄取",
    node_query: "节点查询",
    variable_query: "变量查询",
    clue_query: "线索查询",
    general_chat: "一般对话",
  }
  return labels[intent] || "未知"
}
