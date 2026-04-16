/**
 * OCR functionality using Cloudflare Workers AI
 * Model: @cf/llava-hf/llava-1.5-7b-hf
 *
 * Switched from uform-gen2-qwen-500m (VQA model, poor OCR accuracy)
 * to llava-1.5-7b-hf (7B multimodal, much better at text extraction).
 * To use the even stronger llama-3.2-11b-vision-instruct, change OCR_MODEL below.
 */

import type { Ai } from '@cloudflare/workers-types';

// Change this to '@cf/meta/llama-3.2-11b-vision-instruct' for highest accuracy (slower)
const OCR_MODEL = '@cf/llava-hf/llava-1.5-7b-hf';

export interface OCROptions {
  prompt?: string;
  maxTokens?: number;
}

export interface OCRResult {
  text: string;
  model: string;
  tokens?: number;
}

/**
 * Extract text from an image using Cloudflare Workers AI
 */
export async function extractTextFromImage(
  ai: Ai,
  imageBuffer: ArrayBuffer,
  newspaperName: string,
  options: OCROptions = {}
): Promise<OCRResult> {
  const {
    prompt = [
      'You are an OCR engine. Extract ALL visible text from this Turkish newspaper front page exactly as it appears.',
      'Include every headline, subheadline, article snippet, caption, date, and page number.',
      'Preserve the reading order (top to bottom, left to right).',
      'Output only the extracted text — no commentary, no descriptions.',
    ].join(' '),
    maxTokens = 4096,
  } = options;

  try {
    // Convert buffer to array format expected by Workers AI
    const imageArray = [...new Uint8Array(imageBuffer)];

    const input = {
      image: imageArray,
      prompt,
      max_tokens: maxTokens,
    };

    console.log(`[OCR] Processing image for: ${newspaperName} (model: ${OCR_MODEL})`);

    const response = await ai.run(OCR_MODEL as any, input) as any;

    // llava returns `description`; llama-3.2-vision returns `response`
    const extractedText = response?.description || response?.response || '';

    if (!extractedText) {
      console.warn(`[OCR] No text extracted for: ${newspaperName}`);
    }

    return {
      text: extractedText,
      model: OCR_MODEL,
      tokens: maxTokens,
    };
  } catch (error) {
    console.error(`[OCR] Failed to extract text for ${newspaperName}:`, error);
    return {
      text: `[OCR Error: ${error instanceof Error ? error.message : 'Unknown error'}]`,
      model: OCR_MODEL,
    };
  }
}

/**
 * Process multiple images with OCR
 */
export async function extractTextFromImages(
  ai: Ai,
  images: Array<{ buffer: ArrayBuffer; name: string }>,
  options: OCROptions = {}
): Promise<Array<{ name: string; result: OCRResult }>> {
  const results: Array<{ name: string; result: OCRResult }> = [];

  // Process sequentially to avoid overwhelming the AI service
  for (const image of images) {
    const result = await extractTextFromImage(ai, image.buffer, image.name, options);
    results.push({
      name: image.name,
      result,
    });

    // Small delay between requests to be polite
    await sleep(100);
  }

  return results;
}

/**
 * Format OCR results as a readable text file
 */
export function formatOCRResults(
  results: Array<{ name: string; result: OCRResult }>,
  dateLabel: string
): string {
  const header = `BİK Newspaper OCR Extraction
Date: ${dateLabel}
Model: ${results[0]?.result.model || 'Unknown'}
Generated: ${new Date().toISOString()}
Total Newspapers: ${results.length}

${'='.repeat(80)}

`;

  const content = results
    .map(({ name, result }, index) => {
      const separator = '='.repeat(80);
      return `
${separator}
PAGE ${index + 1}: ${name}
${separator}

${result.text}

`;
    })
    .join('\n');

  return header + content;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
