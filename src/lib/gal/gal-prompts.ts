/** Galgame script LLM prompt templates. */

export function buildGalInitPrompt(params: {
  title: string
  projectContext: string
  language: string
}): string {
  return `你是 Galgame 视觉小说结构规划师。请基于项目上下文，为《${params.title}》初始化 Gal 创作树。

## 项目上下文（最高优先级）
${params.projectContext}

## 初始化约束
1. 只允许输出 1 条顶层 route。
2. route.id 必须是 "main"，route.title 必须是 "主线路"。
3. 初始化只创建一个开头入口节点 entryNode，作为后续节点树的起点。
4. 不要把大纲里的角色线、感情线、分支线拆成多个顶层 route；它们只能体现在入口节点的目标、摘要或选项建议中。
5. 入口节点要严格使用项目上下文中的角色、开场、关系和风格，不要套用通用校园模板。
6. 只输出 JSON，不要输出解释。

## 输出格式
\`\`\`json
{
  "routes": [
    {
      "id": "main",
      "title": "主线路",
      "theme": "主线树",
      "entryNode": {
        "id": "main_001_entry",
        "title": "开头节点标题",
        "goal": "剧情目标",
        "summary": "节点概要",
        "scene": "场景描述",
        "characters": ["角色名"],
        "choices": [
          {
            "id": "c1",
            "text": "选项文本",
            "emotionalIntent": "选项情感意图",
            "effects": [{ "variable": "变量ID", "op": "add", "value": 1 }],
            "nextNodeTitle": "后续节点建议标题",
            "nextNodeGoal": "后续节点剧情目标"
          }
        ]
      }
    }
  ],
  "variables": [
    {
      "id": "变量ID",
      "name": "变量显示名",
      "type": "intimacy",
      "defaultValue": 0,
      "min": 0,
      "max": 100,
      "description": "变量描述"
    }
  ],
  "globalRules": "不可违背的全局规则"
}
\`\`\`

请用${params.language}撰写。`
}

export function buildEntryNodePrompt(params: {
  nodeTitle: string
  nodeGoal: string
  scene: string
  characters: string
  childBeginnings: string
  soulDoc: string
  outline: string
  language: string
}): string {
  return `你是 Galgame 剧本作者。请为入口节点撰写完整正文。

## 项目灵魂文档
${params.soulDoc || "（无）"}

## 项目大纲
${params.outline || "（无）"}

## 节点信息
- 标题：${params.nodeTitle}
- 剧情目标：${params.nodeGoal}
- 场景：${params.scene}
- 出场人物：${params.characters}

## 后继节点前文
${params.childBeginnings}

## 写作要求
1. 使用视觉小说剧本格式：场景描写、心理、对话。
2. 人物对话前标注角色名。
3. 严格遵守项目上下文，不要新增上下文不存在的人物关系。
4. 已存在后继节点时，正文结尾必须直接衔接“后继节点前文”，不得写成与后继节点冲突或无关的收尾。
5. 如果当前节点已有手动选项，正文结尾要自然导向这些选项。
6. 如果有多个后继节点，正文应停在能共同通向这些后继节点的自然分岔点；没有后继节点时才自由收尾。

请用${params.language}撰写。`
}

export function buildChildNodeCardPrompt(params: {
  parentNodeTitle: string
  parentNodeGoal: string
  parentNodeScene: string
  parentNodeSummary: string
  parentCharacters: string
  parentEndingText: string
  choiceText: string
  choiceIntent: string
  choiceNextNodeTitle: string
  choiceNextNodeGoal: string
  routeTheme: string
  premise: string
  globalRules: string
  contextText: string
  variableState: string
  language: string
}): string {
  return `你是 Galgame 剧情节点规划师。请基于父节点结尾和玩家选项，生成一个后续节点卡片。

## 全局设定
${params.premise}

## 全局规则
${params.globalRules}

## 当前主线主题
${params.routeTheme}

## 父节点
标题：${params.parentNodeTitle}
剧情目标：${params.parentNodeGoal || "（无）"}
当前场景：${params.parentNodeScene || "（无）"}
节点摘要：${params.parentNodeSummary || "（无）"}
出场人物：${params.parentCharacters || "（无）"}
结尾内容：${params.parentEndingText}

## 玩家选项
选项：${params.choiceText}
情感意图：${params.choiceIntent}
人工建议标题：${params.choiceNextNodeTitle || "（无）"}
人工建议目标：${params.choiceNextNodeGoal || "（无）"}

## 当前变量状态
${params.variableState}

## 完整上下文参考
${params.contextText}

## 生成要求
1. 后续节点必须承接父节点结尾和玩家选项，不得跳到上下文中不存在的地点、人物或事件。
2. scene 字段必须优先沿用或自然延伸“父节点当前场景”；只有选项文本或父节点结尾明确发生转场时，才可以填写新场景，并在 goal/summary 中体现转场原因。
3. characters 字段只填写该后续节点实际出场人物，优先从父节点人物、角色档案和大纲中选择，不要创造新角色。
4. title、goal、summary 应优先尊重人工建议标题和人工建议目标；如果它们与父节点结尾冲突，则以父节点结尾和完整上下文为准。
5. 只规划节点卡片，不编写完整正文。

## 输出格式
\`\`\`json
{
  "id": "唯一节点ID",
  "title": "节点标题",
  "type": "daily",
  "goal": "剧情目标",
  "summary": "节点概要",
  "scene": "场景描述",
  "characters": ["角色名"],
  "effects": [{ "variable": "变量ID", "op": "add", "value": 1 }],
  "choices": [
    {
      "id": "choice_id",
      "text": "后续选项文本",
      "emotionalIntent": "情感意图",
      "effects": [],
      "nextNodeTitle": "下一个节点建议标题",
      "nextNodeGoal": "下一个节点剧情目标"
    }
  ]
}
\`\`\`

请用${params.language}撰写，只输出 JSON。`
}

export function buildChoiceLongLinePrompt(params: {
  parentNodeTitle: string
  parentNodeGoal: string
  parentNodeScene: string
  parentNodeSummary: string
  parentCharacters: string
  parentEndingText: string
  choiceText: string
  choiceIntent: string
  choiceNextNodeTitle: string
  choiceNextNodeGoal: string
  routeTheme: string
  premise: string
  globalRules: string
  contextText: string
  variableState: string
  nodeCount: number
  userPrompt: string
  language: string
}): string {
  return `你是 Galgame 长线剧情结构规划师。请基于父节点结尾和玩家选项，生成一条连续剧情线的节点卡片数组。

## 全局设定
${params.premise}

## 全局规则
${params.globalRules}

## 当前主线主题
${params.routeTheme}

## 父节点
标题：${params.parentNodeTitle}
剧情目标：${params.parentNodeGoal || "（无）"}
当前场景：${params.parentNodeScene || "（无）"}
节点摘要：${params.parentNodeSummary || "（无）"}
出场人物：${params.parentCharacters || "（无）"}
结尾内容：${params.parentEndingText}

## 玩家选项
选项：${params.choiceText}
情感意图：${params.choiceIntent || "（无）"}
人工建议标题：${params.choiceNextNodeTitle || "（无）"}
人工建议目标：${params.choiceNextNodeGoal || "（无）"}

## 当前变量状态
${params.variableState}

## 完整上下文参考
${params.contextText}

## 用户对这条长线的补充要求
${params.userPrompt || "（无）"}

## 生成要求
1. 必须生成 exactly ${params.nodeCount} 个连续节点卡片，形成一条单线剧情：第 1 个节点承接玩家选项，后续节点逐个承接前一个节点。
2. 这是长线剧情，不要每个节点都再次分大叉；除最后一个节点外，每个节点最多给 1 个自然推进选项。
3. 第 1 个节点优先尊重人工建议标题和目标；后续节点要形成明确的事件推进、情绪变化或信息揭露。
4. scene 字段必须沿用或自然延伸父节点场景；只有剧情明确转场时才改场景，并在 goal/summary 中说明原因。
5. characters 字段只填写实际出场人物，优先从父节点人物、角色档案和大纲中选择，不要创造新角色。
6. effects 只能使用已存在变量；不要创建新变量。
7. 只规划节点卡片，不编写完整正文。

## 输出格式
\`\`\`json
{
  "nodes": [
    {
      "title": "节点标题",
      "type": "daily",
      "goal": "剧情目标",
      "summary": "节点概要",
      "scene": "场景描述",
      "characters": ["角色名"],
      "effects": [{ "variable": "变量ID", "op": "add", "value": 1 }],
      "choices": [
        {
          "id": "choice_id",
          "text": "通向下一个节点的选项文本",
          "emotionalIntent": "情感意图",
          "effects": [],
          "nextNodeTitle": "下一个节点建议标题",
          "nextNodeGoal": "下一个节点剧情目标"
        }
      ]
    }
  ]
}
\`\`\`

请用${params.language}撰写，只输出 JSON。`
}

export function buildRelayNodeCardPrompt(params: {
  parentTitle: string
  parentEnding: string
  childTitle: string
  childBeginning: string
  edgeLabel: string
  routeTheme: string
  premise: string
  globalRules: string
  language: string
}): string {
  return `你是 Galgame 剧情结构规划师。请在父节点与子节点之间设计一个自然的中继过渡节点。

## 项目设定
${params.premise || "（无）"}

## 全局规则
${params.globalRules || "（无）"}

## 线路主题
${params.routeTheme || "（无）"}

## 父节点
标题：${params.parentTitle}
正文结尾或卡片信息：
${params.parentEnding}

## 子节点
标题：${params.childTitle}
正文开头或卡片信息：
${params.childBeginning}

## 原连接含义
${params.edgeLabel || "（默认出口）"}

## 生成要求
1. 中继节点必须自然承接父节点，并明确铺垫到子节点，不能改变两端既定事实。
2. 只规划节点卡片，不编写完整正文。
3. entryChoiceText 是中继节点进入原子节点的固定入口选项，必须与子节点开头直接衔接。
4. 不生成变量影响；后续可由作者在中继节点详情页添加其他选项。
5. 只输出下列 JSON，不要添加解释或 Markdown。

{
  "title": "中继节点标题",
  "goal": "中继节点剧情目标",
  "summary": "中继节点内容摘要",
  "scene": "中继节点场景",
  "characters": ["角色名"],
  "entryChoiceText": "进入原子节点的固定入口选项",
  "entryChoiceIntent": "该入口选项的情感意图"
}

请用${params.language}撰写。`
}

export function buildNodeGenerationPrompt(params: {
  nodeTitle: string
  nodeGoal: string
  nodeType: string
  scene: string
  characters: string
  parentEndings: string
  childBeginnings: string
  soulDoc: string
  outline: string
  variableState: string
  characterMoods: string
  routeContext: string
  clueContext: string
  language: string
}): string {
  return `你是 Galgame 剧本作者。请根据上下文为当前节点撰写完整正文。

## 项目灵魂文档
${params.soulDoc || "（无）"}

## 项目大纲
${params.outline || "（无）"}

## 当前主线/路线上下文
${params.routeContext}

## 当前节点
- 标题：${params.nodeTitle}
- 类型：${params.nodeType}
- 剧情目标：${params.nodeGoal}
- 场景：${params.scene}
- 出场人物：${params.characters}

## 父节点结尾
${params.parentEndings}

## 后继节点前文
${params.childBeginnings}

## 变量状态
${params.variableState}

## 角色情绪
${params.characterMoods}

## 已获线索
${params.clueContext}

## 写作要求
1. 用视觉小说剧本格式写正文。
2. 严格承接父节点结尾和当前节点目标。
3. 遵守项目大纲、角色认知和变量状态。
4. 已存在后继节点时，正文结尾必须直接衔接“后继节点前文”，不得写成与后继节点冲突或无关的收尾。
5. 如果有多个后继节点，正文应停在能共同通向这些后继节点的自然分岔点；没有后继节点时才自由收尾。

请用${params.language}撰写。`
}

export function buildNodeReviewPrompt(params: {
  nodeTitle: string
  nodeScript: string
  nodeGoal: string
  premise: string
  globalRules: string
  characterProfiles: string
  variableState: string
  language: string
}): string {
  return `你是 Galgame 剧本审查员。请审查节点正文是否存在人设、剧情、变量和选项问题。

## 节点
标题：${params.nodeTitle}
目标：${params.nodeGoal}

## 正文
${params.nodeScript}

## 全局设定
${params.premise}

## 全局规则
${params.globalRules}

## 角色档案
${params.characterProfiles}

## 变量状态
${params.variableState}

返回 JSON 数组：
\`\`\`json
[
  {
    "severity": "error",
    "type": "character_consistency",
    "message": "问题描述",
    "evidence": "证据",
    "suggestion": "修改建议"
  }
]
\`\`\`

如果没有问题，返回 []。请用${params.language}。`
}

export function buildBranchLintPrompt(params: {
  routeTitle: string
  nodesSummary: string
  choices: string
  variables: string
  endings: string
  language: string
}): string {
  return `你是 Galgame 分支结构检查员。请检查以下主线树是否存在断线、死胡同、不可达结局、变量越界或认知冲突。

## 主线
${params.routeTitle}

## 节点摘要
${params.nodesSummary}

## 选项列表
${params.choices}

## 变量定义
${params.variables}

## 结局节点
${params.endings}

返回 JSON 数组：
\`\`\`json
[
  {
    "severity": "medium",
    "type": "dead_end",
    "nodeId": "节点ID",
    "message": "问题描述",
    "detail": "详细分析",
    "suggestion": "修改建议"
  }
]
\`\`\`

如果没有问题，返回 []。请用${params.language}。`
}
