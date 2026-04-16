/**
 * Image downloader with concurrency control
 */

import type { NewspaperItem, ImageData } from './types';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BIKScraper/1.0)',
  'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
  'Accept-Language': 'tr,en;q=0.9',
};

/**
 * Download a single image with retry logic
 */
async function downloadImage(
  url: string,
  timeout: number = 30000,
  retries: number = 2
): Promise<ArrayBuffer | null> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Add small jitter delay
      if (attempt > 0) {
        await sleep(600);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        headers: HEADERS,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.arrayBuffer();
    } catch (error) {
      lastError = error as Error;
      console.warn(`[Attempt ${attempt + 1}/${retries + 1}] Download failed: ${url}`, error);
    }
  }

  console.error(`[ERROR] Failed to download after ${retries + 1} attempts: ${url}`, lastError);
  return null;
}

/**
 * Get image dimensions from buffer
 */
async function getImageDimensions(buffer: ArrayBuffer): Promise<{ width: number; height: number } | null> {
  try {
    // Simple PNG dimension extraction
    const view = new DataView(buffer);

    // Check PNG signature
    if (
      view.getUint8(0) === 0x89 &&
      view.getUint8(1) === 0x50 &&
      view.getUint8(2) === 0x4E &&
      view.getUint8(3) === 0x47
    ) {
      // PNG format: dimensions are at bytes 16-23
      const width = view.getUint32(16, false);
      const height = view.getUint32(20, false);
      return { width, height };
    }

    // Check JPEG signature
    if (view.getUint8(0) === 0xFF && view.getUint8(1) === 0xD8) {
      // JPEG format: need to parse segments
      let offset = 2;
      while (offset < buffer.byteLength) {
        if (view.getUint8(offset) !== 0xFF) break;

        const marker = view.getUint8(offset + 1);

        // SOF markers (Start of Frame)
        if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
          const height = view.getUint16(offset + 5, false);
          const width = view.getUint16(offset + 7, false);
          return { width, height };
        }

        // Skip to next marker
        const segmentLength = view.getUint16(offset + 2, false);
        offset += 2 + segmentLength;
      }
    }

    // Fallback: assume reasonable dimensions
    return { width: 800, height: 1200 };
  } catch (error) {
    console.warn('[WARN] Failed to extract image dimensions:', error);
    return { width: 800, height: 1200 };
  }
}

/**
 * Download images with concurrency control
 */
export async function downloadImages(
  items: NewspaperItem[],
  concurrency: number = 4,
  timeout: number = 30000,
  delay: number = 0.2
): Promise<ImageData[]> {
  const results: ImageData[] = [];
  const queue = [...items];
  const inProgress = new Set<Promise<void>>();

  async function processItem(item: NewspaperItem): Promise<void> {
    // Add delay for politeness
    await sleep(delay * 1000 + Math.random() * 200);

    // Try full image first, then thumb
    let buffer = await downloadImage(item.full, timeout);
    if (!buffer) {
      console.log(`[INFO] Falling back to thumbnail for: ${item.name}`);
      buffer = await downloadImage(item.thumb, timeout);
    }

    if (buffer) {
      const dimensions = await getImageDimensions(buffer);
      if (dimensions) {
        results.push({
          buffer,
          width: dimensions.width,
          height: dimensions.height,
          name: item.name,
        });
      }
    }
  }

  while (queue.length > 0 || inProgress.size > 0) {
    // Start new downloads up to concurrency limit
    while (queue.length > 0 && inProgress.size < concurrency) {
      const item = queue.shift()!;
      const promise = processItem(item).finally(() => {
        inProgress.delete(promise);
      });
      inProgress.add(promise);
    }

    // Wait for at least one to complete
    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }

  return results;
}

/**
 * Download thumbnail images for OCR (smaller resolution than full images).
 * Returns buffers paired with newspaper names — suitable for passing to extractTextFromImages.
 */
export async function downloadThumbs(
  items: NewspaperItem[],
  concurrency: number = 4,
  timeout: number = 15000
): Promise<Array<{ buffer: ArrayBuffer; name: string }>> {
  const results: Array<{ buffer: ArrayBuffer; name: string }> = [];
  const queue = [...items];
  const inProgress = new Set<Promise<void>>();

  async function processItem(item: NewspaperItem): Promise<void> {
    const buffer = await downloadImage(item.thumb, timeout, 1);
    if (buffer) results.push({ buffer, name: item.name });
  }

  while (queue.length > 0 || inProgress.size > 0) {
    while (queue.length > 0 && inProgress.size < concurrency) {
      const item = queue.shift()!;
      const promise = processItem(item).finally(() => inProgress.delete(promise));
      inProgress.add(promise);
    }
    if (inProgress.size > 0) await Promise.race(inProgress);
  }

  return results;
}

/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
