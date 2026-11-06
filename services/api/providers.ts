import "dotenv/config";

const apiBaseUrl = (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");

export async function transcribeAudio(input: {
  audioBase64: string;
  fileName: string;
  mimeType: string;
  language?: string;
}): Promise<string> {
  const audio = decodeBase64(input.audioBase64);
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is required for speech-to-text.");
  const audioBytes = Uint8Array.from(audio);
  const form = new FormData();
  form.set("model", process.env.STT_MODEL ?? process.env.LLM_MODEL ?? "whisper-1");
  if (input.language) form.set("language", input.language);
  form.set("file", new Blob([audioBytes.buffer], { type: input.mimeType }), input.fileName);

  const response = await fetch(`${apiBaseUrl}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Speech-to-text provider returned HTTP ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("text" in result) ||
    typeof result.text !== "string"
  ) {
    throw new Error("Speech-to-text provider returned an invalid response.");
  }
  return result.text;
}

export async function extractDocumentText(input: {
  imageBase64: string;
  mimeType: string;
  sourceLanguage?: string;
}): Promise<string> {
  decodeBase64(input.imageBase64);
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) throw new Error("LLM_API_KEY is required for document OCR.");
  const response = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OCR_MODEL ?? process.env.LLM_MODEL ?? "gpt-4o-mini",
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract all legible text from this document image. Preserve its original script and line breaks. ${input.sourceLanguage ? `The document is likely in ${input.sourceLanguage}.` : ""} Return only extracted text.`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${input.mimeType};base64,${input.imageBase64}`,
              },
            },
          ],
        },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Document OCR provider returned HTTP ${response.status}.`);
  }
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("choices" in result) ||
    !Array.isArray(result.choices) ||
    typeof result.choices[0] !== "object" ||
    result.choices[0] === null ||
    !("message" in result.choices[0]) ||
    typeof result.choices[0].message !== "object" ||
    result.choices[0].message === null ||
    !("content" in result.choices[0].message) ||
    typeof result.choices[0].message.content !== "string"
  ) {
    throw new Error("Document OCR provider returned an invalid response.");
  }
  return result.choices[0].message.content;
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
