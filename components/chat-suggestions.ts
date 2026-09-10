const questions = [
  "これまでの経験を教えて",
  "どんな仕事が得意？",
  "仕事で大切にしていることは？",
  "新しい事業を立ち上げた経験は？",
  "チームではどんな役割を担当した？",
  "生成AIを仕事でどう使っている？",
  "企画から実行まで、どんな仕事をしてきた？",
  "お客さんへの対応経験を教えて",
  "どんな分野を学んできた？",
  "コミュニティ運営では何をしていた？",
  "業務の改善に関わった経験は？",
  "どんな資格を持っている？",
  "開発者やデザイナーとはどう連携していた？",
  "記事制作や情報発信の経験は？",
  "会社員時代はどんな仕事をしていた？",
  "集客やマーケティングでは何を担当した？",
  "スタッフの育成や管理の経験は？",
  "これまでの経験から、どんな役割に向いていそう？",
];

// 会話中だけの履歴で候補を巡回する。未質問を優先し、一巡後は古い質問から再提示する。
export function nextQuestions(completedQuestions: string[]): string[] {
  const offset = (completedQuestions.length * 3) % questions.length;
  const rotated = [...questions.slice(offset), ...questions.slice(0, offset)];
  return rotated.sort((a, b) => completedQuestions.lastIndexOf(a) - completedQuestions.lastIndexOf(b)).slice(0, 3);
}
