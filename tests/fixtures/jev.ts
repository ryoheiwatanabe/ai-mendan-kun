import { setup } from "../helpers.ts";
import { embeddingSignature } from "../../lib/ai/providers.ts";
import type { Bindings } from "../../lib/types.ts";

// 実在人物の資料・過去の会話を使わない本体APIの結合確認。
export const jevFixture = {
  version: 1, ownerId: "jev-fixture", documentId: "profile", title: "架空人物アオイの公開プロフィール",
  visibility: "public", verification: "self_reported", entities: ["ナギサ社", "コハク社", "ホタル企画"],
  content: `# 会社員歴と独立後

2016年から2019年までナギサ社で営業を担当しました。

2020年から2023年までコハク社で業務改善を担当しました。

2024年に独立し、個人事業として小規模事業者の業務整理を支援しています。

# 強みと実務例

強みは、複雑な課題を小さく分けることです。ホタル企画では、問い合わせ対応を三つの作業に分け、確認担当と期限を整理しました。実装は外部エンジニアが担当しました。

# 読書の始まり

家にあった辞書を毎日読んだことが、読書を好きになったきっかけです。

# 幼少期の背景

子供のころは図書館で過ごすことが多くありました。課題を小さく分ける強みを身につけた経緯は、この資料では説明していません。

# ホタル企画の利益

ホタル企画の年間利益は300万円です。これはプロジェクト全体の利益で、本人の個人収入ではありません。本人は要件整理を担当しました。`,
  facts: [
    { id: "job-one", key: "career.first", value: "2016-2019", statement: "2016年から2019年までナギサ社で営業を担当しました。", aliases: ["経歴", "会社員歴", "ナギサ社"], validFrom: "2016-01-01", validTo: "2019-12-31" },
    { id: "job-two", key: "career.second", value: "2020-2023", statement: "2020年から2023年までコハク社で業務改善を担当しました。", aliases: ["経歴", "会社員歴", "コハク社"], validFrom: "2020-01-01", validTo: "2023-12-31" }
  ]
};

export async function jevBindings(keys: { generation?: string; jev?: string; speech?: string } = {}) {
  const data = await setup(jevFixture);
  const env: Bindings = { DB: data.db, VECTORIZE: data.vector, OWNER_ID: jevFixture.ownerId,
    AI: { async run() { return { data: [[1, 0, 0]] }; } }, EMBEDDING_PROVIDER: "workersai", EMBEDDING_DIMENSIONS: "3",
    ANSWER_PROVIDER: "opencode", ANSWER_MODEL: "glm-5.3-flash", OPENCODE_API_KEY: keys.generation ?? "test-dummy",
    ANSWER_PIPELINE: "jev_v1", TYPESAFE_API_KEY: keys.jev ?? "test-dummy", DEBUG_TRACE: "1",
    VOICE_ENABLED: "true", GEMINI_API_KEY: keys.speech ?? "test-dummy", VOICE_TTS_MODE: "buffered",
    DAILY_REQUEST_LIMIT: "100", IP_HOURLY_LIMIT: "100", VOICE_DAILY_REQUEST_LIMIT: "100", VOICE_IP_HOURLY_LIMIT: "100" };
  await data.db.prepare("INSERT INTO knowledge_index_configuration(owner_id,embedding_signature) VALUES(?,?)")
    .bind(jevFixture.ownerId, embeddingSignature(env)).run();
  return { ...data, env };
}
