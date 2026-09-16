import { OpenAIProvider, type StructuredOutput } from "./openai.ts";

// json_object指定時、このゲートウェイは本文に"json"の語が無いリクエストを400で拒否する。
const jsonReminder = "\n出力はJSONオブジェクト1つだけにしてください。";
// Goはx-opencode-sessionが無いリクエストをMissingSessionIDで拒否する。値は経路の識別にだけ使う。
const defaultSession = "ai-mendan-kun";

// OpenCode Go（opencode.ai/zen/go）はOpenAI互換の/chat/completionsだけを提供する。
// 埋め込みと音声が無いため、検索はGeminiまたはOpenAI、音声はGeminiのまま使う。
// 既定はjson_schema strict。DeepSeek系はこのゲートウェイがjson_schemaを400で拒否し、
// json_objectでも入れ子の形が崩れたため、モデルを変えるときは動作を確認して切り替える。
export class OpenCodeProvider extends OpenAIProvider {
  constructor(key: string, model = "glm-5.3-flash", structuredOutput: StructuredOutput = "schema", sessionId = defaultSession) {
    super(key, model, "text-embedding-3-small", 1536, {
      baseUrl: "https://opencode.ai/zen/go/v1", structuredOutput, includeStore: false, tokenField: "max_tokens",
      systemSuffix: structuredOutput === "object" ? jsonReminder : "",
      headers: { "x-opencode-session": sessionId, "User-Agent": "ai-mendan-kun/0.1" }
    });
  }

  override async embed(): Promise<number[]> {
    throw new Error("unsupported_embedding_provider");
  }
}
