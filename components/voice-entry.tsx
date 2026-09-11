"use client";

import { useEffect, useState } from "react";

export function VoiceEntry() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/voice/config", { signal: controller.signal, cache: "no-store" })
      .then(response => response.ok ? response.json() : null)
      .then(config => { if (!controller.signal.aborted) setEnabled(!!config && typeof config === "object" && "enabled" in config && config.enabled === true); })
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return enabled ? <p><a className="text-link" href="/voice">声で話してみる <span aria-hidden="true">→</span></a></p> : null;
}
