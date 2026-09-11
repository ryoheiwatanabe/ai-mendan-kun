import { getVoiceConfiguration, voiceHeaders } from "../../../../lib/voice/runtime.ts";

export const dynamic = "force-dynamic";
export async function GET() {
  return Response.json(await getVoiceConfiguration(), { headers: voiceHeaders });
}
