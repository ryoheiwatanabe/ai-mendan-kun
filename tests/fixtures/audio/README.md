# 発話検出用の合成音声

`hai-kyoko.wav` は「はい」、`un-kyoko.wav` は「うん」です。2026-09-14に、既存のmacOS標準音声Kyokoを `/usr/bin/say` で合成し、既存の `/usr/bin/afconvert` で24 kHz・mono・PCM16のWAVへ変換しました。外部API・追加ダウンロードは使用していません。人の録音や個人情報は含みません。

ブラウザテストでは、これらと公開済みの `public/audio/checking.wav` をChromeの偽マイクへ入力します。無音、環境雑音、打鍵音のfixtureはテスト内の固定乱数と波形で作ります。合成fixtureに対する回帰確認であり、実際のマイク、小声、雑音環境、相槌の検出精度を保証するものではありません。STTと回答APIはモックです。
