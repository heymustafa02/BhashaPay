import "dotenv/config";

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

type GenerateGeminiContentOptions = {
  model?: string;
  parts: GeminiPart[];
  temperature?: number;
  responseMimeType?: "application/json";
  responseSchema?: Record<string, unknown>;
};

const apiBaseUrl = (process.env.GEMINI_BASE_URL ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
const defaultModel = "gemini-2.5-flash";

export function getGeminiModel(): string {
  return process.env.GEMINI_MODEL ?? defaultModel;
}

export async function generateGeminiContent(options: GenerateGeminiContentOptions): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is required for Gemini model calls.");

  const model = options.model ?? getGeminiModel();
  const response = await fetch(`${apiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts: options.parts }],
      generationConfig: {
        temperature: options.temperature,
        responseMimeType: options.responseMimeType,
        responseSchema: options.responseSchema,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API returned HTTP ${response.status}.`);
  }

  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("candidates" in result) ||
    !Array.isArray(result.candidates) ||
    typeof result.candidates[0] !== "object" ||
    result.candidates[0] === null ||
    !("content" in result.candidates[0]) ||
    typeof result.candidates[0].content !== "object" ||
    result.candidates[0].content === null ||
    !("parts" in result.candidates[0].content) ||
    !Array.isArray(result.candidates[0].content.parts)
  ) {
    throw new Error("Gemini API returned an invalid response.");
  }

  const text = result.candidates[0].content.parts
    .filter((part: unknown): part is { text: string } =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof part.text === "string",
    )
    .map((part: { text: string }) => part.text)
    .join("");

  if (!text) throw new Error("Gemini API response did not contain text.");
  return text;
}
