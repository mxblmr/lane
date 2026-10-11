import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatOpenAI } from "@langchain/openai";

// Same builder in every Lane agent. The provider follows the LLM_API_KEY secret:
// an Anthropic key (sk-ant-...) selects Claude, any other key selects OpenAI.
const OPENAI_MODEL = "gpt-5.4-mini";
const ANTHROPIC_MODEL = "claude-sonnet-4-5";

export function buildLLM(opts: { temperature?: number } = {}): BaseChatModel {
  const apiKey = process.env.LLM_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("LLM_API_KEY is missing; set it as an Agent Engine secret or in .env for local runs");
  }
  const temperature = opts.temperature ?? 0;
  if (apiKey.startsWith("sk-ant-")) {
    return new ChatAnthropic({ model: ANTHROPIC_MODEL, apiKey, temperature });
  }
  return new ChatOpenAI({ model: OPENAI_MODEL, apiKey, temperature });
}
