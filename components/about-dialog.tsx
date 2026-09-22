"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { VoiceConfiguration } from "../lib/voice/types.ts";
import { AboutContent } from "./about-content";

export function AboutDialog({ processors = "設定された外部AI API", voice }: { processors?: string; voice?: VoiceConfiguration | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const [open, setOpen] = useState(false);
  const [loadedVoice, setLoadedVoice] = useState<VoiceConfiguration | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || voice || loadedVoice) return;
    const controller = new AbortController(); setFailed(false);
    void fetch("/api/voice/config", { signal: controller.signal, cache: "no-store" }).then(async response => {
      if (!response.ok) throw new Error("configuration_unavailable");
      const value = await response.json() as VoiceConfiguration;
      if (typeof value.enabled !== "boolean" || value.enabled && (typeof value.processors !== "string" || typeof value.voiceName !== "string")) throw new Error("invalid_configuration");
      if (!controller.signal.aborted) setLoadedVoice(value);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [open, voice, loadedVoice]);
  return <>
    <button type="button" className="text-link about-trigger" aria-haspopup="dialog" onClick={() => { dialog.current?.showModal(); setOpen(true); }}>このAIについて</button>
    <dialog className="about-dialog" ref={dialog} aria-labelledby={title} onClose={() => setOpen(false)}>
      <div className="about-dialog-top"><h1 id={title}>このAIについて</h1><button type="button" className="dialog-close" autoFocus onClick={() => dialog.current?.close()}>閉じる <span aria-hidden="true">×</span></button></div>
      {open && <><AboutContent processors={processors} voice={voice ?? loadedVoice} />
        {!voice && !loadedVoice && <p className="input-note" role="status">{failed ? "音声の設定を取得できませんでした。詳しい処理先は、音声画面の開始前に確認できます。" : "音声の設定を確認しています…"}</p>}</>}
    </dialog>
  </>;
}
