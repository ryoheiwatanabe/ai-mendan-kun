import test from "node:test";
import assert from "node:assert/strict";
import { detectRecognitionSupport, installJapanesePack, recognitionConstructor } from "../lib/voice/input/probe.ts";
import { preferredMode, usableModes } from "../lib/voice/input/select.ts";
import { browserSpeechProvider } from "../lib/voice/input/providers.ts";
import { WebSpeechRecognizer } from "../lib/voice/input/webspeech.ts";
import { ServerRecognizer } from "../lib/voice/input/server.ts";
import { createRecognizer } from "../lib/voice/input/index.ts";
import type { RecognitionFailure, SpeechRecognitionConstructor } from "../lib/voice/input/types.ts";

// 偽のWeb Speech API。available()の引数とprocessLocallyの指定を検査できるようにする。
function fakeRecognition(options: { local?: string | Error; cloud?: string | Error; install?: boolean | Error } = {}) {
  const state = { instances: [] as any[], available: [] as any[], installs: [] as any[] };
  const answer = (value: string | Error | undefined, fallback: string) => {
    if (value instanceof Error) throw value;
    return value ?? fallback;
  };
  class Recognition {
    lang = ""; continuous = false; interimResults = false; maxAlternatives = 1; processLocally = false;
    onresult: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onend: (() => void) | null = null;
    started = 0; stopped = 0; aborted = 0;
    constructor() { state.instances.push(this); }
    static async available(value: any) {
      state.available.push(value);
      return value.processLocally ? answer(options.local, "available") : answer(options.cloud, "available");
    }
    static async install(value: any) {
      state.installs.push(value);
      if (options.install instanceof Error) throw options.install;
      return options.install ?? true;
    }
    start() { this.started++; }
    stop() { this.stopped++; this.onend?.(); }
    abort() { this.aborted++; }
  }
  return { state, Recognition: Recognition as unknown as SpeechRecognitionConstructor, raw: Recognition };
}

function events() {
  const list: { interim?: { id: string; text: string }; failure?: { reason: RecognitionFailure; fatal: boolean } }[] = [];
  return { list, interim: (id: string, text: string) => list.push({ interim: { id, text } }),
    failure: (reason: RecognitionFailure, fatal: boolean) => list.push({ failure: { reason, fatal } }) };
}

function results(entries: { text: string; final: boolean; others?: string[] }[]) {
  return { resultIndex: 0, results: entries.map(entry => {
    const transcripts = [entry.text, ...(entry.others ?? [])].map(text => ({ transcript: text }));
    return Object.assign(transcripts, { isFinal: entry.final, length: transcripts.length });
  }) };
}

test("返った認識候補は最大3件まで、同じ順位で組み立ててfinishで返す", async () => {
  const fake = fakeRecognition();
  const callbacks = events();
  const recognizer = new WebSpeechRecognizer({ mode: "browser-cloud", constructor: fake.Recognition, callbacks });
  recognizer.begin("u1");
  fake.state.instances.at(-1).onresult(results([
    { text: "さくら", final: true, others: ["さくららぼ", "サクラ"] },
    { text: "ラボの話", final: true, others: ["ラボのはなし", "ラボの話です"] }
  ]));
  assert.deepEqual(await recognizer.finish("u1", null, new AbortController().signal),
    { text: "さくらラボの話", alternatives: ["さくらラボの話", "さくららぼラボのはなし", "サクララボの話です"] });
  // 4件返っても、候補は3件までに留める（全組み合わせは作らない）。
  const second = new WebSpeechRecognizer({ mode: "browser-cloud", constructor: fake.Recognition, callbacks });
  second.begin("u2");
  fake.state.instances.at(-1).onresult(results([{ text: "いち", final: true, others: ["に", "さん", "よん"] }]));
  assert.deepEqual(await second.finish("u2", null, new AbortController().signal),
    { text: "いち", alternatives: ["いち", "に", "さん"] });
});

test("認識方式の対応はブラウザー名ではなくAPIの応答で決める", async () => {
  assert.deepEqual(await detectRecognitionSupport({}), { onDevice: "unavailable", browserCloud: "unavailable", packInstallable: false });

  // available()が無い環境は端末内を確認できないため、クラウドもunknownに留める。
  // available()/install()を持たない従来型の実装。
  class LegacyRecognition {
    lang = ""; continuous = false; interimResults = false; maxAlternatives = 1;
    onresult = null; onerror = null; onend = null;
    start() {} stop() {} abort() {}
  }
  const legacy = { webkitSpeechRecognition: LegacyRecognition as unknown as SpeechRecognitionConstructor };
  assert.deepEqual(await detectRecognitionSupport(legacy), { onDevice: "unavailable", browserCloud: "unknown", packInstallable: false });
  assert.ok(recognitionConstructor(legacy));

  const supported = fakeRecognition({ local: "downloadable" });
  const scope = { SpeechRecognition: supported.Recognition };
  assert.deepEqual(await detectRecognitionSupport(scope), { onDevice: "downloadable", browserCloud: "available", packInstallable: true });
  assert.equal(recognitionConstructor(scope), supported.Recognition);
  assert.deepEqual(supported.state.available, [{ langs: ["ja-JP"], processLocally: true }, { langs: ["ja-JP"] }]);

  const failing = fakeRecognition({ local: new Error("unsupported") });
  assert.deepEqual(await detectRecognitionSupport({ SpeechRecognition: failing.Recognition }),
    { onDevice: "unavailable", browserCloud: "available", packInstallable: true });

  // 準備中の状態はdownloadingとして保持し、端末内の候補には出さない。
  const downloading = fakeRecognition({ local: "downloading" });
  const downloadingSupport = await detectRecognitionSupport({ SpeechRecognition: downloading.Recognition });
  assert.equal(downloadingSupport.onDevice, "downloading");
  assert.deepEqual(usableModes(downloadingSupport, true), ["browser-cloud", "server", "manual"]);

  const unknown = fakeRecognition({ local: "preparing" });
  assert.equal((await detectRecognitionSupport({ SpeechRecognition: unknown.Recognition })).onDevice, "unknown");

  const installable = fakeRecognition({ local: "downloadable" });
  assert.equal((await installJapanesePack({ SpeechRecognition: installable.Recognition })).status, "installed");
  // processLocallyを渡さないとChromeは何もしないため、指定を固定する。
  assert.deepEqual(installable.state.installs, [{ langs: ["ja-JP"], processLocally: true }]);
  assert.equal((await installJapanesePack(legacy)).status, "unsupported");
  assert.equal((await installJapanesePack({ SpeechRecognition: fakeRecognition({ local: "downloadable", install: false }).Recognition })).status, "failed");
  const thrown = await installJapanesePack({ SpeechRecognition: fakeRecognition({ local: "downloadable", install: new Error("not supported") }).Recognition });
  assert.equal(thrown.status, "failed");
  assert.equal(thrown.error, "Error");
});

test("追加不要のブラウザー認識を初期選択と先頭に揃え、利用者の選択は保持する", () => {
  const full = { onDevice: "available" as const, browserCloud: "available" as const, packInstallable: true };
  const none = { onDevice: "unavailable" as const, browserCloud: "unavailable" as const, packInstallable: false };
  assert.deepEqual(usableModes(full, true), ["browser-cloud", "on-device", "server", "manual"]);
  assert.equal(preferredMode(full, true), "browser-cloud");
  assert.equal(preferredMode(full, true, "server"), "server");
  assert.equal(preferredMode(full, true, "on-device"), "on-device");
  // 選んでいた方式が使えなくなった場合も、先頭の利用可能な方式を提示する。
  assert.equal(preferredMode(full, false, "server"), "browser-cloud");
  assert.deepEqual(usableModes(full, false), ["browser-cloud", "on-device", "manual"]);
  assert.equal(preferredMode({ ...full, onDevice: "downloadable" }, true), "browser-cloud");
  assert.equal(preferredMode({ ...none, browserCloud: "unknown" }, false), "browser-cloud");
  assert.equal(preferredMode(none, false), "manual");
  assert.deepEqual(usableModes(none, false), ["manual"]);
  assert.equal(preferredMode(none, true, "on-device"), "server");
  for (const onDevice of ["available", "downloadable", "downloading", "unavailable", "unknown"] as const) {
    for (const browserCloud of ["available", "unavailable", "unknown"] as const) {
      for (const serverAvailable of [true, false]) {
        const support = { onDevice, browserCloud, packInstallable: true };
        assert.equal(preferredMode(support, serverAvailable), usableModes(support, serverAvailable)[0]);
      }
    }
  }
});

test("ブラウザーの提供元を表示し、ChromiumやiOSの別ブラウザーをGoogleやSafariと断定しない", () => {
  const chrome = browserSpeechProvider({ userAgentData: { brands: [{ brand: "Chromium" }, { brand: "Google Chrome" }] } });
  assert.equal(chrome.provider, "Google（Chromeの音声認識）");
  assert.match(chrome.packSource, /Google Chrome/);
  assert.equal(new URL(chrome.packSourceUrl!).hostname, "developer.chrome.com");
  const edge = browserSpeechProvider({ userAgent: "Chrome/140.0 Safari/537.36 Edg/140.0" });
  assert.equal(edge.provider, "Microsoft（Azureの音声認識）");
  const safari = browserSpeechProvider({ userAgent: "Version/18.0 Safari/605.1.15", vendor: "Apple Computer, Inc." });
  assert.equal(safari.provider, "Apple（Safariの音声認識）");
  for (const identity of [{}, { userAgent: "Chrome/140.0 Safari/537.36", userAgentData: { brands: [{ brand: "Chromium" }] } },
    { userAgent: "CriOS/140.0 Version/18.0 Safari/605.1.15", vendor: "Apple Computer, Inc." }]) {
    const unknown = browserSpeechProvider(identity);
    assert.match(unknown.provider, /名称を確認できません/);
    assert.match(unknown.packSource, /配布元名はこの画面から確認できません/);
    assert.equal(unknown.packSourceUrl, null);
  }
});

test("端末内認識はisFinalを質問の終わりにせず、確定結果を蓄積してfinishで一度だけ返す", async () => {
  const fake = fakeRecognition();
  const callbacks = events();
  const recognizer = new WebSpeechRecognizer({ mode: "on-device", constructor: fake.Recognition, callbacks });
  assert.equal(recognizer.location, "device");
  assert.equal(recognizer.needsAudio, false);

  recognizer.begin("u1");
  const instance = fake.state.instances.at(-1);
  assert.deepEqual({ lang: instance.lang, continuous: instance.continuous, interimResults: instance.interimResults, processLocally: instance.processLocally },
    { lang: "ja-JP", continuous: true, interimResults: true, processLocally: true });
  assert.equal(instance.started, 1);

  instance.onresult(results([{ text: "チームでは", final: false }]));
  assert.deepEqual(callbacks.list, [{ interim: { id: "u1", text: "チームでは" } }]);
  instance.onresult(results([{ text: "チームでは", final: true }, { text: "要件を", final: false }]));
  assert.equal(callbacks.list.at(-1)!.interim!.text, "チームでは要件を");
  // 確定結果だけでは送らない。finishを呼ぶまで返らない。
  const stale = instance.onresult;
  const finished = recognizer.finish("u1", null, new AbortController().signal);
  assert.equal(instance.stopped, 1);
  assert.deepEqual(await finished, { text: "チームでは要件を", alternatives: ["チームでは"] });
  assert.equal(callbacks.list.filter(entry => "failure" in entry).length, 0);
  // 停止後に、外れる前のハンドラへ届いた結果は表示にも送信にも使わない。
  stale!(results([{ text: "余計な続き", final: true }]));
  assert.equal(callbacks.list.filter(entry => entry.interim?.text.includes("余計")).length, 0);

  // 破棄した発話の遅着結果も同じく無視する。
  recognizer.begin("u2");
  const second = fake.state.instances.at(-1);
  const staleSecond = second.onresult;
  second.onresult(results([{ text: "消す発話", final: true }]));
  recognizer.discard("u2");
  assert.equal(second.aborted, 1);
  staleSecond!(results([{ text: "消す発話の続き", final: true }]));
  assert.equal(callbacks.list.at(-1)!.interim!.text, "消す発話");
});

test("認識サービスが自動で切れた場合は待機のまま聞き直し、切れ続ければ失敗にする", async () => {
  const fake = fakeRecognition();
  const callbacks = events();
  const recognizer = new WebSpeechRecognizer({ mode: "browser-cloud", constructor: fake.Recognition, callbacks, restartLimit: 1 });
  assert.equal(recognizer.location, "external");
  recognizer.begin("u1");
  const first = fake.state.instances.at(-1);
  first.onresult(results([{ text: "前半は", final: true }]));
  assert.equal(first.processLocally, false);
  // onendは送信の合図ではない。待機のまま聞き直して同じ発話へ足す。
  first.onend!();
  const second = fake.state.instances.at(-1);
  assert.equal(second.started, 1);
  assert.equal(callbacks.list.filter(entry => "failure" in entry).length, 0);
  second.onresult(results([{ text: "後半です", final: true }]));
  const finished = recognizer.finish("u1", null, new AbortController().signal);
  assert.deepEqual(await finished, { text: "前半は後半です", alternatives: ["前半は後半です"] });

  // 再開を使い切ったら、黙って続けずに失敗として知らせる。
  recognizer.begin("u2");
  fake.state.instances.at(-1).onend!();
  fake.state.instances.at(-1).onend!();
  assert.deepEqual(callbacks.list.at(-1), { failure: { reason: "network", fatal: true } });
});

test("認識エンジンは待機中から動かし、発話より前の文字を発話へ含めない", async () => {
  const fake = fakeRecognition();
  const callbacks = events();
  const recognizer = new WebSpeechRecognizer({ mode: "browser-cloud", constructor: fake.Recognition, callbacks });
  recognizer.listen();
  const instance = fake.state.instances.at(-1);
  assert.equal(instance.started, 1);
  // 待機中に拾った確定結果は、発話の区切り前なので表示しない。
  instance.onresult(results([{ text: "んー", final: true }]));
  assert.equal(callbacks.list.length, 0);
  recognizer.begin("u1");
  instance.onresult(results([{ text: "んー", final: true }, { text: "自己紹介お願いします", final: true }]));
  assert.equal(callbacks.list.at(-1)!.interim!.text, "自己紹介お願いします");
  const finished = recognizer.finish("u1", null, new AbortController().signal);
  assert.deepEqual(await finished, { text: "自己紹介お願いします", alternatives: ["自己紹介お願いします"] });
});

test("認識の失敗を理由ごとに分け、no-speechは継続、abortedは無視する", async () => {
  const fake = fakeRecognition();
  const callbacks = events();
  const recognizer = new WebSpeechRecognizer({ mode: "on-device", constructor: fake.Recognition, callbacks });
  recognizer.begin("u1");
  const onError = fake.state.instances.at(-1).onerror!;
  onError({ error: "no-speech" });
  assert.deepEqual(callbacks.list.at(-1), { failure: { reason: "no-speech", fatal: false } });
  onError({ error: "aborted" });
  assert.equal(callbacks.list.filter(entry => "failure" in entry).length, 1);
  onError({ error: "language-not-supported" });
  assert.deepEqual(callbacks.list.at(-1), { failure: { reason: "language-unavailable", fatal: true } });
  // 停止後は同じハンドラへ届いても何も起こさない。
  onError({ error: "not-allowed" });
  assert.equal(callbacks.list.filter(entry => "failure" in entry).length, 2);
});

test("サーバー認識は音声を送り、上限・不正応答・長すぎる文字を区別して失敗にする", async () => {
  const calls: { body: unknown }[] = [];
  const respond = (value: unknown, status = 200) => async (_input: string, init: RequestInit) => {
    calls.push({ body: init.body });
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  };
  const signal = new AbortController().signal;
  const ok = new ServerRecognizer(respond({ text: "  質問です  " }));
  assert.equal(ok.location, "external");
  assert.equal(ok.needsAudio, true);
  assert.deepEqual(await ok.finish("u1", new ArrayBuffer(8), signal), { text: "質問です", alternatives: [] });
  assert.equal(calls.length, 1);

  assert.equal((await new ServerRecognizer(respond({}, 429)).finish("u1", new ArrayBuffer(8), signal).catch(error => error.message)), "transcription_limit");
  assert.equal((await new ServerRecognizer(respond({}, 500)).finish("u1", new ArrayBuffer(8), signal).catch(error => error.message)), "transcription_failed");
  assert.equal((await new ServerRecognizer(respond({ text: 3 })).finish("u1", new ArrayBuffer(8), signal).catch(error => error.message)), "invalid_transcription");
  assert.equal((await new ServerRecognizer(respond({ text: "あ".repeat(1001) })).finish("u1", new ArrayBuffer(8), signal).catch(error => error.message)), "invalid_transcription");
  assert.equal((await ok.finish("u1", null, signal).catch(error => error.message)), "transcription_failed");
});

test("方式から認識器を作る。手入力は音声を使わず、未対応のブラウザーでは作らない", () => {
  assert.equal(createRecognizer("manual", { callbacks: events(), constructor: null }), null);
  const server = createRecognizer("server", { callbacks: events(), constructor: null });
  assert.equal(server?.mode, "server");
  const onDevice = createRecognizer("on-device", { callbacks: events(), constructor: fakeRecognition().Recognition });
  assert.equal(onDevice?.mode, "on-device");
  assert.throws(() => createRecognizer("on-device", { callbacks: events(), constructor: null }), /recognition_unsupported/);
});
