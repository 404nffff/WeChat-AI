import type { ChatflowGraph } from "./types.js";

/** Default: start → llm → answer */
export function createDefaultChatflowGraph(): ChatflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "start",
        type: "start",
        label: "开始",
        data: {},
      },
      {
        id: "llm",
        type: "llm",
        label: "LLM",
        data: {
          system: "{{system_prompt}}",
          prompt:
            "对话历史：\n{{history}}\n\n相关记忆：\n{{memories}}\n\n用户：{{query}}",
          temperature: 0.8,
        },
      },
      {
        id: "answer",
        type: "answer",
        label: "回复",
        data: {
          answer: "{{llm.text}}",
        },
      },
    ],
    edges: [
      { id: "e1", source: "start", target: "llm" },
      { id: "e2", source: "llm", target: "answer" },
    ],
  };
}
