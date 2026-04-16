/**
 * Cloudflare Worker for BİK newspaper scraper
 * Scrapes Turkish newspaper front pages and generates PDFs
 */

import type { Env, Config } from './types';
import { parseNewspapers, generateFilename } from './parser';
import { downloadImages, downloadThumbs } from './downloader';
import { generatePDF } from './pdf';
import { extractTextFromImages, formatOCRResults } from './ocr';

const BASE_URL = 'https://gazete.bik.gov.tr/Uygulamalar/GazeteIlkSayfalar?kapsam=yaygin';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BIKScraper/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr,en;q=0.9',
};

/**
 * Parse configuration from environment
 */
function getConfig(env: Env): Config {
  return {
    labelBanner: env.LABEL_BANNER !== 'false',
    maxWidth: parseInt(env.MAX_WIDTH || '2000', 10),
    maxHeight: parseInt(env.MAX_HEIGHT || '0', 10),
    concurrency: parseInt(env.CONCURRENCY || '4', 10),
    delayBetweenReq: parseFloat(env.DELAY_BETWEEN_REQ || '0.2'),
    limitItems: parseInt(env.LIMIT_ITEMS || '0', 10),
    skipIfExists: env.SKIP_IF_EXISTS !== 'false',
    timeoutSec: parseInt(env.TIMEOUT_SEC || '25', 10),
  };
}

/**
 * Fetch HTML from BİK website
 */
async function fetchHTML(timeout: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

  try {
    const response = await fetch(BASE_URL, {
      headers: HEADERS,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Handle scraping with OCR endpoint
 */
async function handleScrapeWithOCR(env: Env, config: Config): Promise<Response> {
  console.log('[INFO] Starting BİK scraper with OCR...');

  // 1. Fetch HTML
  console.log('[INFO] Fetching HTML...');
  const html = await fetchHTML(config.timeoutSec);

  // 2. Parse newspapers
  console.log('[INFO] Parsing newspapers...');
  const { dateLabel, items } = parseNewspapers(html);

  if (items.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'No newspapers found',
        message: 'The website may have changed or is unavailable',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  // Apply limit if set
  const processItems = config.limitItems > 0
    ? items.slice(0, config.limitItems)
    : items;

  console.log(`[INFO] Found ${items.length} newspapers (processing ${processItems.length})`);
  console.log(`[INFO] Date: ${dateLabel}`);

  // Generate filenames
  const pdfFilename = generateFilename(dateLabel).replace('.pdf', '_ocr.pdf');
  const txtFilename = generateFilename(dateLabel).replace('.pdf', '_ocr.txt');

  // 3. Check if files exist in R2
  if (config.skipIfExists) {
    const existingPdf = await env.BUCKET.head(pdfFilename);
    const existingTxt = await env.BUCKET.head(txtFilename);

    if (existingPdf && existingTxt) {
      console.log(`[INFO] Serving cached searchable PDF: ${pdfFilename}`);
      const pdfObject = await env.BUCKET.get(pdfFilename);
      if (pdfObject) {
        return new Response(pdfObject.body, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `inline; filename="${pdfFilename}"`,
            'X-BIK-Cached': 'true',
            'X-BIK-Date': dateLabel,
            'X-BIK-Items': processItems.length.toString(),
            'X-BIK-OCR': 'true',
            'X-BIK-Searchable': 'true',
          },
        });
      }
    }
  }

  // 4. Download images
  console.log('[INFO] Downloading images...');
  const images = await downloadImages(
    processItems,
    config.concurrency,
    config.timeoutSec * 1000,
    config.delayBetweenReq
  );

  if (images.length === 0) {
    return new Response(
      JSON.stringify({
        error: 'Failed to download images',
        message: 'No images could be downloaded successfully',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }

  console.log(`[INFO] Downloaded ${images.length}/${processItems.length} images`);

  // 5. Download thumbnails for OCR (smaller than full images — better for 11B model)
  console.log('[INFO] Downloading thumbnails for OCR...');
  const thumbs = await downloadThumbs(processItems, config.concurrency, 15000);
  console.log(`[INFO] Downloaded ${thumbs.length} thumbnails for OCR`);

  // 6. Run OCR on thumbnails
  console.log('[INFO] Running OCR on thumbnails...');
  const ocrResults = await extractTextFromImages(env.AI, thumbs);

  console.log(`[INFO] OCR completed for ${ocrResults.length} images`);

  // 7. Generate searchable PDF — OCR text embedded as invisible layer
  console.log('[INFO] Generating searchable PDF with OCR text layer...');
  const pdfBytes = await generatePDF(images, {
    labelBanner: config.labelBanner,
    dateLabel,
    maxWidth: config.maxWidth > 0 ? config.maxWidth : undefined,
    maxHeight: config.maxHeight > 0 ? config.maxHeight : undefined,
    ocrResults,   // ← invisible text layer per page
  });

  console.log(`[INFO] Searchable PDF generated: ${pdfBytes.length} bytes`);

  // 7. Format OCR text (plain-text backup alongside the PDF)
  const ocrText = formatOCRResults(ocrResults, dateLabel);
  const txtBytes = new TextEncoder().encode(ocrText);

  console.log(`[INFO] OCR text backup generated: ${txtBytes.length} bytes`);

  // 8. Upload to R2
  console.log('[INFO] Uploading to R2...');

  await env.BUCKET.put(pdfFilename, pdfBytes, {
    httpMetadata: { contentType: 'application/pdf' },
    customMetadata: {
      dateLabel,
      itemCount: images.length.toString(),
      generatedAt: new Date().toISOString(),
      ocr: 'true',
      searchable: 'true',
    },
  });

  await env.BUCKET.put(txtFilename, txtBytes, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
    customMetadata: {
      dateLabel,
      itemCount: images.length.toString(),
      generatedAt: new Date().toISOString(),
      ocr: 'true',
    },
  });

  console.log(`[INFO] Uploaded: ${pdfFilename}, ${txtFilename}`);

  // 9. Return the searchable PDF directly
  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${pdfFilename}"`,
      'Content-Length': pdfBytes.length.toString(),
      'X-BIK-Date': dateLabel,
      'X-BIK-Items': images.length.toString(),
      'X-BIK-Filename': pdfFilename,
      'X-BIK-OCR': 'true',
      'X-BIK-Searchable': 'true',
    },
  });
}

/**
 * Core processing logic shared by HTTP handler and cron trigger.
 * Runs scraping + OCR + uploads searchable PDF to R2.
 * Returns a short summary (used by cron logs, ignored by HTTP fast-path).
 */
async function runDailyProcessing(env: Env, config: Config): Promise<string> {
  console.log('[CORE] Starting full scrape + OCR + searchable PDF pipeline...');
  try {
    const html = await fetchHTML(config.timeoutSec);
    const { dateLabel, items } = parseNewspapers(html);

    if (items.length === 0) {
      return 'No newspapers found';
    }

    const processItems = config.limitItems > 0 ? items.slice(0, config.limitItems) : items;
    const pdfFilename = generateFilename(dateLabel).replace('.pdf', '_ocr.pdf');
    const txtFilename = generateFilename(dateLabel).replace('.pdf', '_ocr.txt');

    // Skip if already cached
    if (config.skipIfExists) {
      const existing = await env.BUCKET.head(pdfFilename);
      if (existing) {
        console.log(`[CORE] Already cached: ${pdfFilename}`);
        return `Cached: ${pdfFilename}`;
      }
    }

    const images = await downloadImages(
      processItems,
      config.concurrency,
      config.timeoutSec * 1000,
      config.delayBetweenReq
    );

    if (images.length === 0) return 'No images downloaded';

    // Download thumbnails for OCR separately (smaller payload for 11B model)
    const thumbs = await downloadThumbs(processItems, config.concurrency, 15000);
    console.log(`[CORE] Downloaded ${thumbs.length} thumbnails for OCR`);

    const ocrResults = await extractTextFromImages(env.AI, thumbs);

    const pdfBytes = await generatePDF(images, {
      labelBanner: config.labelBanner,
      dateLabel,
      maxWidth: config.maxWidth > 0 ? config.maxWidth : undefined,
      maxHeight: config.maxHeight > 0 ? config.maxHeight : undefined,
      ocrResults,
    });

    const ocrText = formatOCRResults(ocrResults, dateLabel);
    const txtBytes = new TextEncoder().encode(ocrText);

    await env.BUCKET.put(pdfFilename, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: { dateLabel, itemCount: images.length.toString(), generatedAt: new Date().toISOString(), ocr: 'true', searchable: 'true' },
    });
    await env.BUCKET.put(txtFilename, txtBytes, {
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { dateLabel, itemCount: images.length.toString(), generatedAt: new Date().toISOString(), ocr: 'true' },
    });

    const msg = `OK: ${pdfFilename} (${images.length} newspapers, ${pdfBytes.length} bytes)`;
    console.log(`[CORE] ${msg}`);
    return msg;
  } catch (err) {
    const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[CORE] ${msg}`);
    return msg;
  }
}

/**
 * Main handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const config = getConfig(env);

    try {
      // Handle different routes
      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      if (url.pathname === '/config') {
        return new Response(JSON.stringify(config, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // OCR endpoint — check R2 cache first; if missing, kick off background
      // processing via ctx.waitUntil() and return 202 so the client can retry.
      // (Cron trigger runs at 04:00 UTC daily so cache is warm for most requests.)
      if (url.pathname === '/scrape-with-ocr') {
        // Quick cache probe before starting heavy work
        const html = await fetchHTML(config.timeoutSec);
        const { dateLabel } = parseNewspapers(html);
        const pdfFilename = generateFilename(dateLabel).replace('.pdf', '_ocr.pdf');
        const existing = await env.BUCKET.head(pdfFilename);

        if (existing) {
          // Serve from cache immediately
          return await handleScrapeWithOCR(env, config);
        }

        // Not cached — start background processing and tell the client to retry
        ctx.waitUntil(runDailyProcessing(env, config));
        return new Response(
          JSON.stringify({
            status: 'processing',
            message: 'OCR processing started in background. Retry in ~60 seconds.',
            filename: pdfFilename,
            dateLabel,
          }),
          {
            status: 202,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '60',
              'X-BIK-Date': dateLabel,
            },
          }
        );
      }

      // Main scraping endpoint
      if (url.pathname !== '/' && url.pathname !== '/scrape') {
        return new Response('Not Found', { status: 404 });
      }

      console.log('[INFO] Starting BİK scraper...');

      // 1. Fetch HTML
      console.log('[INFO] Fetching HTML...');
      const html = await fetchHTML(config.timeoutSec);

      // 2. Parse newspapers
      console.log('[INFO] Parsing newspapers...');
      const { dateLabel, items } = parseNewspapers(html);

      if (items.length === 0) {
        return new Response(
          JSON.stringify({
            error: 'No newspapers found',
            message: 'The website may have changed or is unavailable',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      // Apply limit if set
      const processItems = config.limitItems > 0
        ? items.slice(0, config.limitItems)
        : items;

      console.log(`[INFO] Found ${items.length} newspapers (processing ${processItems.length})`);
      console.log(`[INFO] Date: ${dateLabel}`);

      // Generate filename
      const filename = generateFilename(dateLabel);

      // 3. Check if file exists in R2
      if (config.skipIfExists) {
        const existing = await env.BUCKET.head(filename);
        if (existing) {
          console.log(`[INFO] File already exists: ${filename}`);

          // Return existing file
          const object = await env.BUCKET.get(filename);
          if (object) {
            return new Response(object.body, {
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${filename}"`,
                'X-BIK-Cached': 'true',
                'X-BIK-Date': dateLabel,
                'X-BIK-Items': processItems.length.toString(),
              },
            });
          }
        }
      }

      // 4. Download images
      console.log('[INFO] Downloading images...');
      const images = await downloadImages(
        processItems,
        config.concurrency,
        config.timeoutSec * 1000,
        config.delayBetweenReq
      );

      if (images.length === 0) {
        return new Response(
          JSON.stringify({
            error: 'Failed to download images',
            message: 'No images could be downloaded successfully',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      console.log(`[INFO] Downloaded ${images.length}/${processItems.length} images`);

      // 5. Generate PDF
      console.log('[INFO] Generating PDF...');
      const pdfBytes = await generatePDF(images, {
        labelBanner: config.labelBanner,
        dateLabel,
        maxWidth: config.maxWidth > 0 ? config.maxWidth : undefined,
        maxHeight: config.maxHeight > 0 ? config.maxHeight : undefined,
      });

      console.log(`[INFO] PDF generated: ${pdfBytes.length} bytes`);

      // 6. Upload to R2
      console.log('[INFO] Uploading to R2...');
      await env.BUCKET.put(filename, pdfBytes, {
        httpMetadata: {
          contentType: 'application/pdf',
        },
        customMetadata: {
          dateLabel,
          itemCount: images.length.toString(),
          generatedAt: new Date().toISOString(),
        },
      });

      console.log(`[INFO] Uploaded: ${filename}`);

      // 7. Return PDF
      return new Response(pdfBytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `inline; filename="${filename}"`,
          'Content-Length': pdfBytes.length.toString(),
          'X-BIK-Date': dateLabel,
          'X-BIK-Items': images.length.toString(),
          'X-BIK-Filename': filename,
        },
      });

    } catch (error) {
      console.error('[ERROR]', error);

      return new Response(
        JSON.stringify({
          error: 'Internal Server Error',
          message: error instanceof Error ? error.message : 'Unknown error',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }
      );
    }
  },

  /**
   * Cron trigger — runs daily at 04:00 UTC (07:00 Turkey time).
   * Cloudflare gives scheduled workers up to 15 minutes of CPU time,
   * so the full OCR pipeline runs comfortably without timeout.
   * Subsequent HTTP requests will be served from the R2 cache.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] Triggered at ${new Date(event.scheduledTime).toISOString()}`);
    const config = getConfig(env);
    // Force fresh generation regardless of SKIP_IF_EXISTS for daily cron
    const cronConfig = { ...config, skipIfExists: false };
    const result = await runDailyProcessing(env, cronConfig);
    console.log(`[CRON] Done: ${result}`);
  },
};
