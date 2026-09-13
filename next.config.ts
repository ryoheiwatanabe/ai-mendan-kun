import type { NextConfig } from "next";

const contentSecurityPolicy = (voice = false) => `default-src 'self'; script-src 'self' 'unsafe-inline'${voice ? " 'wasm-unsafe-eval'" : ""}${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`;

const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
      { key: "Content-Security-Policy", value: contentSecurityPolicy() }
    ] }, { source: "/voice", headers: [
      { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
      { key: "Content-Security-Policy", value: contentSecurityPolicy(true) }
    ] }];
  }
};
export default config;
