# OmniVoiceの一次資料比較

確認日：2026年9月10日

Phase 2の比較対象は、Han Zhu・Daniel Poveyらによる **k2-fsa/OmniVoice** とする。日本語のゼロショット音声クローンとApple Siliconでの実行経路を公式資料で確認できた。ただし、これは資料比較であり、本人声や速度の実測結果ではない。現在の標準声MVPはGemini 3.1 Flash TTSを使用する方針で、OmniVoiceの採用決定ではない。

## 確認できたこと

| 項目 | 一次資料の内容と、このプロジェクトでの扱い |
| --- | --- |
| 対象の識別 | [公式実装](https://github.com/k2-fsa/OmniVoice)と[論文「OmniVoice: Towards Omnilingual Zero-Shot Text-to-Speech with Diffusion Language Models」](https://arxiv.org/abs/2604.00688)を対象とする。同名のStreaming版やサーバー版には第三者forkがあり、その機能を公式実装の機能として扱わない。 |
| 日本語 | [公式言語一覧](https://github.com/k2-fsa/OmniVoice/blob/master/docs/languages.md)に日本語（`ja` / `jpn`）がある。[論文](https://arxiv.org/html/2604.00688v1)には日本語の認識誤り率・話者類似度の評価もあるが、面談の文章を使った自然さ、固有名詞や数字の読みは未評価。 |
| 本人声 | [公式API](https://github.com/k2-fsa/OmniVoice#voice-cloning)は短い参照音声によるゼロショット音声クローンに対応する。推奨は3〜10秒の参照音声と、その書き起こし。標準的な発音には生成先と同じ言語の参照音声を推奨している。本人の声の再現度は未実測。 |
| Apple Silicon | [公式README](https://github.com/k2-fsa/OmniVoice#installation)はPyTorchと`device_map="mps"`を案内する。ただし[実装](https://github.com/k2-fsa/OmniVoice/blob/master/omnivoice/models/omnivoice.py)では音声tokenizerをCPUへ退避する。MPS対応だけでMac上の対話速度を保証することはできない。 |
| GPU・メモリ | 一般的な最低VRAM・Macの最低メモリは、確認した公式資料では明示されていない。[モデルカード](https://huggingface.co/k2-fsa/OmniVoice)の本体は0.6Bパラメータ、論文のtokenizer等を含む全体は0.8B。[配布ファイル](https://huggingface.co/k2-fsa/OmniVoice/tree/main)は合計3.27GBだが、これは必要RAM／VRAMではない。手元のMacでのピークメモリは未実測。 |
| Streaming | 確認した[公式`generate()`実装](https://github.com/k2-fsa/OmniVoice/blob/master/omnivoice/models/omnivoice.py)は生成完了後に音声配列を返す。長文の内部チャンク処理も最終的に結合するため、そのまま先頭音声を逐次配信できるAPIとは扱わない。文単位の分割生成を追加する場合は、先頭音声までの時間と継ぎ目を別途評価する。 |
| ライセンス | [公式モデルカード](https://huggingface.co/k2-fsa/OmniVoice#license)は、コードをApache 2.0、事前学習済み重みを学習データの制約によるCC-BY-NCと明記する。コードのライセンスだけから、重みも商用利用可能とは判断できない。 |

## 未実測の項目

本人参照音声の利用と、新しいツール・モデルのインストールは現時点で未承認のため、ダウンロード、インストール、本人音声の取得・投入、音声生成は実施していない。Phase 2で必要な実測比較は、以下を残している。

- **音声品質**：同じ承認済み日本語文章で、自然さ、固有名詞・数字の読み、長めの回答の安定性を確認する。本人声の再現度は、本人による評価と機械的な話者類似度を区別する。
- **速度**：音声合成要求から再生可能な先頭音声までの時間（First Audio）、全体の生成時間、音声の長さに対する生成時間の比率（RTF）を測る。初回のモデル読み込みと、読み込み済みの生成を分ける。
- **運用負荷**：ピークメモリ、連続生成でのメモリ増加、エラー、再試行の必要性を確認する。論文のGPU測定値をMacの速度や運用費へ転用しない。
- **会話への適合**：分割生成を試す場合は、発話の継ぎ目、割り込み後の再生停止、生成中の中断処理を確認する。

音声クローンの評価では参照音声の書き起こしを明示し、自動書き起こし用Whisperの追加ロードを避けた条件を基本とする。この方法は[公式API](https://github.com/k2-fsa/OmniVoice#voice-cloning)で案内されている。
