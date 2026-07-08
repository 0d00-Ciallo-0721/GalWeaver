import { describe, expect, it, vi } from "vitest"
import { streamChat } from "@/lib/llm-client"
import { generateNodeChoices } from "./gal-choice-generation"

vi.mock("@/lib/llm-client", () => ({
  streamChat: vi.fn(),
}))

describe("generateNodeChoices", () => {
  it("把用户填写的选项生成提示词注入 LLM 请求", async () => {
    vi.mocked(streamChat).mockImplementation(async (_config, messages, callbacks) => {
      expect(messages[1].content).toContain("用户指定的选项生成方向：偏向吃醋和撒娇，不要走沉重回忆")
      callbacks.onToken?.(
        JSON.stringify({
          choices: [{
            text: "轻轻捏住她的袖口，问她是不是吃醋了",
            emotionalIntent: "用温柔调侃接住妃爱的占有欲",
            nextNodeTitle: "袖口的小脾气",
            nextNodeGoal: "让妃爱在嘴硬中承认自己的在意",
          }],
        }),
      )
      callbacks.onDone?.()
    })

    const choices = await generateNodeChoices({
      count: 1,
      title: "客厅黄昏",
      characters: "妃爱、智宏",
      goal: "制造轻甜分歧",
      scene: "客厅",
      scriptContent: "妃爱鼓起脸，假装不看哥哥。",
      choicePrompt: "偏向吃醋和撒娇，不要走沉重回忆",
      existingChoices: [],
      llmConfigOverride: {
        provider: "custom",
        apiKey: "",
        model: "test",
        ollamaUrl: "",
        customEndpoint: "",
        maxContextSize: 8000,
      },
    })

    expect(choices[0]).toMatchObject({
      text: "轻轻捏住她的袖口，问她是不是吃醋了",
      emotionalIntent: "用温柔调侃接住妃爱的占有欲",
      effects: [],
    })
  })
})
