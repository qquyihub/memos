import { Hono } from "hono";
import type { Env, UserPayload } from "../types";
import { authRequired } from "../middleware/auth";
import * as settingDB from "../db/setting";

type AIApp = { Bindings: Env; Variables: { user: UserPayload } };

export const aiRoutes = new Hono<AIApp>();

function decodeBase64Content(content: string): ArrayBuffer {
  const base64 = content.includes(",") ? content.slice(content.indexOf(",") + 1) : content;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

aiRoutes.post("/ai\\:transcribe", authRequired, async (c) => {
  const contentType = c.req.header("content-type") || "";

  if (!c.env.AI) {
    return c.json({ error: "AI binding not configured" }, 501);
  }

  let audioData: ArrayBuffer;
  let requestedLanguage = "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) return c.json({ error: "No audio file provided" }, 400);
    audioData = await file.arrayBuffer();
    requestedLanguage = String(formData.get("language") || "");
  } else {
    const body = await c.req.json<{ audio?: { content?: string; uri?: string; filename?: string; contentType?: string }; language?: string }>();
    const audio = body.audio;
    if (!audio?.content) {
      return c.json({ error: "No audio content provided" }, 400);
    }
    audioData = decodeBase64Content(audio.content);
    requestedLanguage = String(body.language || "");
  }

  // Get AI settings for model/language config
  let model = "@cf/openai/whisper";
  let language = requestedLanguage;
  const aiSettingRow = await settingDB.getInstanceSetting(c.env.DB, "AI");
  if (aiSettingRow) {
    try {
      const parsed = JSON.parse(aiSettingRow.value);
      if (parsed.transcription?.model) model = parsed.transcription.model;
      if (!language && parsed.transcription?.language) language = parsed.transcription.language;
    } catch {}
  }

  const payload: Record<string, unknown> = {
    audio: [...new Uint8Array(audioData)],
  };
  if (language) {
    payload.language = language;
  }

  const result = await c.env.AI.run(model as any, payload as any);

  return c.json({ text: (result as any).text || "" });
});
