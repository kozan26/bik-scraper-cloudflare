/**
 * OCR functionality using Cloudflare Workers AI
 * Model: @cf/meta/llama-3.2-11b-vision-instruct
 *
 * Uses llama-3.2-11b (11B multimodal) via the messages/content format.
 * Images are passed as base64 data-URLs inside the message content array.
 * Thumbnails are used instead of full images to keep payload size manageable.
 *
 * Fallback: change OCR_MODEL to '@cf/llava-hf/llava-1.5-7b-hf' if the 11B
 * model is not available on your account.
 */

import type { Ai } from '@cloudflare/workers-types';

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
 * Extract text from an image using Cloudflare Workers AI (LLaVA 7B).
 */
export async function extractTextFromImage(
  ai: Ai,
  imageBuffer: ArrayBuffer,
  newspaperName: string,
  options: OCROptions = {}
): Promise<OCRResult> {
  const {
    prompt = 'List the main headlines visible on this newspaper front page. Be brief and do not repeat yourself.',
    maxTokens = 256,
  } = options;

  try {
    console.log(`[OCR] Processing image for: ${newspaperName} (model: ${OCR_MODEL})`);

    const input = { image: [...new Uint8Array(imageBuffer)], prompt, max_tokens: maxTokens };

    const response = await ai.run(OCR_MODEL as any, input) as any;

    // llava returns `description`
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

  // Process in batches of 5 concurrently to stay within AI rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < images.length; i += BATCH_SIZE) {
    const batch = images.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(image => extractTextFromImage(ai, image.buffer, image.name, options))
    );
    for (let j = 0; j < batch.length; j++) {
      results.push({ name: batch[j].name, result: batchResults[j] });
    }
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
