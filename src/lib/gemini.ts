import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export interface MatchResult {
  fileId: string;
  isMatch: boolean;
  confidence: number;
}

/**
 * Compares a reference selfie with a batch of candidate images.
 * Uses Gemini 2.0 Flash to detect the person in the candidates.
 */
export async function findPersonInPhotos(
  referenceBase64: string,
  candidates: { id: string; base64: string }[]
): Promise<MatchResult[]> {
  const model = "gemini-3-flash-preview";
  
  const referencePart = {
    inlineData: {
      mimeType: "image/jpeg",
      data: referenceBase64,
    },
  };

  const candidateParts = candidates.slice(0, 10).map((c, index) => ({
    text: `Candidate ${index} (ID: ${c.id}):`,
    inlineData: {
        mimeType: "image/jpeg",
        data: c.base64,
    }
  }));

  const prompt = `
    I am providing a reference photo of a person and 10 candidate photos.
    Your task is to identify which candidate photos feature the EXACT same person as in the reference photo.
    
    Output the results as a JSON array where each object has:
    - fileId: the ID of the candidate photo.
    - isMatch: true if it's the same person, false otherwise.
    - confidence: a number between 0 and 1.
    
    Be strict. Only match if you are confident.
  `;

  const response = await ai.models.generateContent({
    model,
    contents: {
      parts: [
        { text: prompt },
        { text: "Reference Image:" },
        referencePart,
        ...candidateParts as any,
      ],
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            fileId: { type: Type.STRING },
            isMatch: { type: Type.BOOLEAN },
            confidence: { type: Type.NUMBER },
          },
          required: ["fileId", "isMatch", "confidence"],
        },
      },
    },
  });

  try {
    const results = JSON.parse(response.text || "[]");
    return results;
  } catch (e) {
    console.error("Failed to parse Gemini response:", e);
    return [];
  }
}
