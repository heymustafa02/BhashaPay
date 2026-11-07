import "dotenv/config";
import { generateGeminiContent, getGeminiModel } from "./gemini";

export async function transcribeAudio(input: {
  audioBase64: string;
  fileName: string;
  mimeType: string;
  language?: string;
}): Promise<string> {
  const audio = decodeBase64(input.audioBase64);
  const language = input.language
    ? ` Transcribe in the original language (${input.language}) and preserve the original words.`
    : " Transcribe in the original language and preserve the original words.";
  return generateGeminiContent({
    model: process.env.GEMINI_STT_MODEL ?? getGeminiModel(),
    temperature: 0,
    parts: [
      { text: `Transcribe all spoken words in this audio. Return only the transcription.${language}` },
      {
        inlineData: {
          mimeType: input.mimeType,
          data: Buffer.from(audio).toString("base64"),
        },
      },
    ],
  });
}

export async function extractDocumentText(input: {
  imageBase64: string;
  mimeType: string;
  sourceLanguage?: string;
}): Promise<string> {
  const image = decodeBase64(input.imageBase64);
  return generateGeminiContent({
    model: process.env.GEMINI_OCR_MODEL ?? getGeminiModel(),
    temperature: 0,
    parts: [
      {
        text: `Extract all legible text from this document image. Preserve its original script and line breaks. ${input.sourceLanguage ? `The document is likely in ${input.sourceLanguage}.` : ""} Return only extracted text.`,
      },
      {
        inlineData: {
          mimeType: input.mimeType,
          data: Buffer.from(image).toString("base64"),
        },
      },
    ],
  });
}

function decodeBase64(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (
    normalized.length === 0 ||
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new Error("Media input must be valid base64.");
  }
  return Buffer.from(normalized, "base64");
}
