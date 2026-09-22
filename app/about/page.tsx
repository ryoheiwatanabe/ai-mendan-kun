import Link from "next/link";
import { getProcessorNames } from "../../lib/runtime.ts";
import { getVoiceConfiguration } from "../../lib/voice/runtime.ts";
import { AboutContent } from "../../components/about-content";

export const dynamic = "force-dynamic";
export default async function About() {
  const [textProcessors, voice] = await Promise.all([getProcessorNames(), getVoiceConfiguration()]);
  const processors = voice.enabled ? voice.processors : textProcessors;
  return <main className="about-page"><Link className="text-link" href="/">← 面談へ戻る</Link><h1>このAIについて</h1>
    <AboutContent processors={processors} voice={voice} />
    <Link className="primary-button" href="/">AI面談をはじめる <span aria-hidden="true">→</span></Link>
  </main>;
}
