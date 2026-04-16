/**
 * PDF generator with labels and optional invisible OCR text layer
 */

import { PDFDocument, PDFPage, PDFFont, rgb, StandardFonts } from 'pdf-lib';
import type { ImageData } from './types';
import type { OCRResult } from './ocr';

interface PDFOptions {
  labelBanner: boolean;
  dateLabel: string;
  maxWidth?: number;
  maxHeight?: number;
  /** OCR results keyed by newspaper name — when provided, each page gets an invisible text layer */
  ocrResults?: Array<{ name: string; result: OCRResult }>;
}

/**
 * Resize image dimensions to fit within max constraints
 */
function calculateResizedDimensions(
  width: number,
  height: number,
  maxWidth?: number,
  maxHeight?: number
): { width: number; height: number } {
  if (!maxWidth && !maxHeight) {
    return { width, height };
  }

  let scale = 1.0;

  if (maxWidth && width > maxWidth) {
    scale = Math.min(scale, maxWidth / width);
  }

  if (maxHeight && height > maxHeight) {
    scale = Math.min(scale, maxHeight / height);
  }

  if (scale < 1.0) {
    return {
      width: Math.max(1, Math.floor(width * scale)),
      height: Math.max(1, Math.floor(height * scale)),
    };
  }

  return { width, height };
}

/**
 * Detect image format from buffer
 */
function detectImageFormat(buffer: ArrayBuffer): 'png' | 'jpeg' | null {
  const view = new DataView(buffer);

  // PNG signature
  if (
    view.byteLength >= 8 &&
    view.getUint8(0) === 0x89 &&
    view.getUint8(1) === 0x50 &&
    view.getUint8(2) === 0x4E &&
    view.getUint8(3) === 0x47
  ) {
    return 'png';
  }

  // JPEG signature
  if (
    view.byteLength >= 2 &&
    view.getUint8(0) === 0xFF &&
    view.getUint8(1) === 0xD8
  ) {
    return 'jpeg';
  }

  return null;
}

/**
 * Overlay OCR text as an invisible layer on a PDF page.
 *
 * PDF viewers (Adobe, Chrome, macOS Preview, etc.) index content-stream text
 * for Ctrl+F search regardless of its visual opacity. Drawing with opacity 0.01
 * and white color makes the text effectively invisible while keeping it
 * fully searchable and copy-pasteable.
 *
 * Since the LLM gives us a plain text blob (no bounding boxes), we distribute
 * lines evenly across the image area so they span the full page — good enough
 * for Ctrl+F; copy-paste order mirrors reading order.
 */
function addInvisibleTextLayer(
  page: PDFPage,
  text: string,
  font: PDFFont,
  pageWidth: number,
  pageHeight: number,
  bannerHeight: number
): void {
  const lines = text
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  if (lines.length === 0) return;

  const margin = 12;
  const usableHeight = pageHeight - bannerHeight - margin * 2;
  // Distribute lines evenly so text spans the whole image area
  const lineStep = usableHeight / lines.length;
  const fontSize = Math.min(11, Math.max(6, lineStep * 0.75));

  for (let i = 0; i < lines.length; i++) {
    const y = pageHeight - margin - fontSize - i * lineStep;
    if (y < bannerHeight + margin) break;

    page.drawText(lines[i], {
      x: margin,
      y,
      size: fontSize,
      font,
      // White + near-zero opacity → visually gone, still indexed by PDF readers
      color: rgb(1, 1, 1),
      opacity: 0.01,
      maxWidth: pageWidth - margin * 2,
    });
  }
}

/**
 * Generate PDF from images with optional labels
 */
export async function generatePDF(
  images: ImageData[],
  options: PDFOptions
): Promise<Uint8Array> {
  if (images.length === 0) {
    throw new Error('No images to generate PDF');
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  for (const imageData of images) {
    // Determine dimensions
    const { width: originalWidth, height: originalHeight } = imageData;
    const { width: targetWidth, height: targetHeight } = calculateResizedDimensions(
      originalWidth,
      originalHeight,
      options.maxWidth,
      options.maxHeight
    );

    // Calculate banner height if needed
    const bannerHeight = options.labelBanner
      ? Math.max(80, Math.floor(targetHeight * 0.06))
      : 0;

    // Create page
    const page = pdfDoc.addPage([targetWidth, targetHeight + bannerHeight]);

    // Embed image
    try {
      const format = detectImageFormat(imageData.buffer);
      let image;

      if (format === 'png') {
        image = await pdfDoc.embedPng(imageData.buffer);
      } else if (format === 'jpeg') {
        image = await pdfDoc.embedJpg(imageData.buffer);
      } else {
        // Try both formats as fallback
        try {
          image = await pdfDoc.embedJpg(imageData.buffer);
        } catch {
          image = await pdfDoc.embedPng(imageData.buffer);
        }
      }

      // Draw image
      page.drawImage(image, {
        x: 0,
        y: bannerHeight,
        width: targetWidth,
        height: targetHeight,
      });
    } catch (error) {
      console.error(`[ERROR] Failed to embed image for ${imageData.name}:`, error);
      // Draw error placeholder
      page.drawRectangle({
        x: 0,
        y: bannerHeight,
        width: targetWidth,
        height: targetHeight,
        color: rgb(0.95, 0.95, 0.95),
      });
      page.drawText(`Failed to load image: ${imageData.name}`, {
        x: 50,
        y: targetHeight / 2 + bannerHeight,
        size: 20,
        font: font,
        color: rgb(0.5, 0, 0),
      });
    }

    // Add label banner
    if (options.labelBanner) {
      // White background
      page.drawRectangle({
        x: 0,
        y: 0,
        width: targetWidth,
        height: bannerHeight,
        color: rgb(1, 1, 1),
      });

      // Label text
      const labelText = options.dateLabel
        ? `${imageData.name} — ${options.dateLabel}`
        : imageData.name;

      const fontSize = Math.max(18, bannerHeight - 30);
      const textWidth = boldFont.widthOfTextAtSize(labelText, fontSize);
      const padding = 20;

      page.drawText(labelText, {
        x: padding,
        y: Math.floor((bannerHeight - fontSize) / 2),
        size: fontSize,
        font: boldFont,
        color: rgb(0, 0, 0),
        maxWidth: targetWidth - padding * 2,
      });
    }

    // Invisible OCR text layer — makes the PDF searchable (Ctrl+F)
    if (options.ocrResults) {
      const entry = options.ocrResults.find(r => r.name === imageData.name);
      if (entry?.result.text) {
        addInvisibleTextLayer(
          page,
          entry.result.text,
          font,
          targetWidth,
          targetHeight + bannerHeight,
          bannerHeight
        );
        console.log(`[PDF] Invisible text layer added for: ${imageData.name} (${entry.result.text.length} chars)`);
      }
    }
  }

  return await pdfDoc.save();
}

/**
 * Generate simple metadata for the PDF
 */
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
