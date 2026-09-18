const questions = [
  // スマホの幅でも見切れずに収まる長さにする。1行あたり約10〜12字まで。
  "これまでの経験は？",
  "どんな仕事が得意？",
  "大切にしていることは？",
  "事業立ち上げの経験は？",
  "チームでの役割は？",
  "仕事での生成AI活用は？",
  "企画から実行までの経験は？",
  "お客さん対応の経験は？",
  "学んできた分野は？",
  "コミュニティ運営の経験は？",
  "業務改善の経験は？",
  "持っている資格は？",
  "開発者との連携は？",
  "記事や情報発信の経験は？",
  "会社員時代の仕事は？",
  "集客やマーケの担当は？",
  "育成や管理の経験は？",
  "向いていそうな役割は？",
];

// 会話中だけの履歴で候補を巡回する。未質問を優先し、一巡後は古い質問から再提示する。
export function nextQuestions(completedQuestions: string[]): string[] {
  const offset = (completedQuestions.length * 3) % questions.length;
  const rotated = [...questions.slice(offset), ...questions.slice(0, offset)];
  return rotated.sort((a, b) => completedQuestions.lastIndexOf(a) - completedQuestions.lastIndexOf(b)).slice(0, 3);
}
