/**
 * PDF generator with labels and optional invisible OCR text layer
 */

import { PDFDocument, PDFPage, PDFFont, rgb, StandardFonts } from 'pdf-lib';
import type { ImageData } from './types';
import type { OCRResult } from './ocr';

const FONT_REGULAR_URL = 'https://cdn.jsdelivr.net/gh/google/fonts@main/apache/opensans/static/OpenSans-Regular.ttf';
const FONT_BOLD_URL    = 'https://cdn.jsdelivr.net/gh/google/fonts@main/apache/opensans/static/OpenSans-Bold.ttf';

async function embedFont(pdfDoc: PDFDocument, url: string, fallback: StandardFonts): Promise<PDFFont> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    return await pdfDoc.embedFont(bytes);
  } catch (err) {
    console.warn(`[PDF] Font fetch failed (${url}): ${err} — falling back to built-in`);
    return await pdfDoc.embedFont(fallback);
  }
}

function sanitizeTurkish(text: string): string {
  return text
    .replace(/ş/g, 's').replace(/Ş/g, 'S')
    .replace(/ğ/g, 'g').replace(/Ğ/g, 'G')
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/ü/g, 'u').replace(/Ü/g, 'U')
    .replace(/ö/g, 'o').replace(/Ö/g, 'O')
    .replace(/ç/g, 'c').replace(/Ç/g, 'C');
}

interface PDFOptions {
  labelBanner: boolean;
  dateLabel: string;
  maxWidth?: number;
  maxHeight?: number;
  ocrResults?: Array<{ name: string; result: OCRResult }>;
}

function calculateResizedDimensions(width: number, height: number, maxWidth?: number, maxHeight?: number): { width: number; height: number } {
  if (!maxWidth && !maxHeight) return { width, height };
  let scale = 1.0;
  if (maxWidth && width > maxWidth) scale = Math.min(scale, maxWidth / width);
  if (maxHeight && height > maxHeight) scale = Math.min(scale, maxHeight / height);
  if (scale < 1.0) return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) };
  return { width, height };
}

function detectImageFormat(buffer: ArrayBuffer): 'png' | 'jpeg' | null {
  const view = new DataView(buffer);
  if (view.byteLength >= 8 && view.getUint8(0) === 0x89 && view.getUint8(1) === 0x50 && view.getUint8(2) === 0x4E && view.getUint8(3) === 0x47) return 'png';
  if (view.byteLength >= 2 && view.getUint8(0) === 0xFF && view.getUint8(1) === 0xD8) return 'jpeg';
  return null;
}

function addInvisibleTextLayer(page: PDFPage, text: string, font: PDFFont, pageWidth: number, pageHeight: number, bannerHeight: number): void {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  if (lines.length === 0) return;
  const margin = 12;
  const usableHeight = pageHeight - bannerHeight - margin * 2;
  const lineStep = usableHeight / lines.length;
  const fontSize = Math.min(11, Math.max(6, lineStep * 0.75));
  for (let i = 0; i < lines.length; i++) {
    const y = pageHeight - margin - fontSize - i * lineStep;
    if (y < bannerHeight + margin) break;
    page.drawText(lines[i], { x: margin, y, size: fontSize, font, color: rgb(1, 1, 1), opacity: 0.01, maxWidth: pageWidth - margin * 2 });
  }
}

export async function generatePDF(images: ImageData[], options: PDFOptions): Promise<Uint8Array> {
  if (images.length === 0) throw new Error('No images to generate PDF');

  const pdfDoc = await PDFDocument.create();
  const [font, boldFont] = await Promise.all([
    embedFont(pdfDoc, FONT_REGULAR_URL, StandardFonts.Helvetica),
    embedFont(pdfDoc, FONT_BOLD_URL,    StandardFonts.HelveticaBold),
  ]);
  const needsSanitize = (font as any).name?.includes('Helvetica') ?? false;

  for (const imageData of images) {
    const { width: originalWidth, height: originalHeight } = imageData;
    const { width: targetWidth, height: targetHeight } = calculateResizedDimensions(originalWidth, originalHeight, options.maxWidth, options.maxHeight);
    const bannerHeight = options.labelBanner ? Math.max(80, Math.floor(targetHeight * 0.06)) : 0;
    const page = pdfDoc.addPage([targetWidth, targetHeight + bannerHeight]);

    try {
      const format = detectImageFormat(imageData.buffer);
      let image;
      if (format === 'png') image = await pdfDoc.embedPng(imageData.buffer);
      else if (format === 'jpeg') image = await pdfDoc.embedJpg(imageData.buffer);
      else { try { image = await pdfDoc.embedJpg(imageData.buffer); } catch { image = await pdfDoc.embedPng(imageData.buffer); } }
      page.drawImage(image, { x: 0, y: bannerHeight, width: targetWidth, height: targetHeight });
    } catch (error) {
      console.error(`[ERROR] Failed to embed image for ${imageData.name}:`, error);
      page.drawRectangle({ x: 0, y: bannerHeight, width: targetWidth, height: targetHeight, color: rgb(0.95, 0.95, 0.95) });
      page.drawText(`Failed to load image: ${imageData.name}`, { x: 50, y: targetHeight / 2 + bannerHeight, size: 20, font, color: rgb(0.5, 0, 0) });
    }

    if (options.labelBanner) {
      page.drawRectangle({ x: 0, y: 0, width: targetWidth, height: bannerHeight, color: rgb(1, 1, 1) });
      const rawLabel = options.dateLabel ? `${imageData.name} — ${options.dateLabel}` : imageData.name;
      const labelText = needsSanitize ? sanitizeTurkish(rawLabel) : rawLabel;
      const fontSize = Math.max(18, bannerHeight - 30);
      page.drawText(labelText, { x: 20, y: Math.floor((bannerHeight - fontSize) / 2), size: fontSize, font: boldFont, color: rgb(0, 0, 0), maxWidth: targetWidth - 40 });
    }

    if (options.ocrResults) {
      const entry = options.ocrResults.find(r => r.name === imageData.name);
      if (entry?.result.text) {
        const ocrText = needsSanitize ? sanitizeTurkish(entry.result.text) : entry.result.text;
        addInvisibleTextLayer(page, ocrText, font, targetWidth, targetHeight + bannerHeight, bannerHeight);
        console.log(`[PDF] Invisible text layer added for: ${imageData.name} (${entry.result.text.length} chars)`);
      }
    }
  }

  return await pdfDoc.save();
}

export function generateMetadata(dateLabel: string, itemCount: number) {
  return {
    title: `BİK Newspapers - ${dateLabel}`,
    subject: `Turkish Newspaper Front Pages - ${dateLabel}`,
    author: 'BİK Scraper',
    creator: 'Cloudflare Worker',
    producer: 'pdf-lib',
    keywords: ['newspaper', 'bik', 'turkey', dateLabel],
    creationDate: new Date(),
    modificationDate: new Date(),
  };
}
