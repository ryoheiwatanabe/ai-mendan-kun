import { checkOrigin } from "../../../../lib/security/request.ts";
import { readRecording } from "../../../../lib/voice/request.ts";
import { consumeVoiceLimit, createSpeechProvider, getVoiceBindings, voiceError, voiceHeaders } from "../../../../lib/voice/runtime.ts";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const env = await getVoiceBindings();
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(45_000)]);
    const wav = await readRecording(request, signal);
    await consumeVoiceLimit(env, request, "transcribe");
    const result = await createSpeechProvider(env).transcribe(wav, signal);
    return Response.json(result, { headers: voiceHeaders });
  } catch (error) { return voiceError(error); }
}
