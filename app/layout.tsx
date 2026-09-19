import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI面談くん | 会う前に、少し話そう。",
  description: "本人が公開用に承認した経歴や考え方をもとに、面談前の疑問にお答えします。",
  robots: { index: false, follow: false }
};

// iPhoneのノッチとSafariのツールバーを踏まえ、実際の表示領域いっぱいを使う。
export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="ja"><body>{children}</body></html>;
}
