/**
 * Cloudflare Worker for BİK newspaper scraper
 * Scrapes Turkish newspaper front pages and generates a PDF.
 * Cron runs daily at 04:00 UTC (07:00 Turkey time).
 * HTTP requests serve the cached PDF from R2.
 */

import type { Env, Config } from './types';
import { parseNewspapers, generateFilename } from './parser';
import { downloadImages } from './downloader';
import { generatePDF } from './pdf';

const BASE_URL = 'https://gazete.bik.gov.tr/Uygulamalar/GazeteIlkSayfalar?kapsam=yaygin';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; BIKScraper/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'tr,en;q=0.9',
};

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

async function fetchHTML(timeout: number): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);
  try {
    const response = await fetch(BASE_URL, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Core pipeline: fetch → parse → download images → generate PDF → upload to R2.
 * Called by the cron trigger (15 min limit — handles all 20 newspapers comfortably).
 */
async function runDailyProcessing(env: Env, config: Config): Promise<string> {
  console.log('[CORE] Starting scrape pipeline...');
  try {
    const html = await fetchHTML(config.timeoutSec);
    const { dateLabel, items } = parseNewspapers(html);

    if (items.length === 0) return 'No newspapers found';

    const processItems = config.limitItems > 0 ? items.slice(0, config.limitItems) : items;
    const filename = generateFilename(dateLabel);

    if (config.skipIfExists) {
      const existing = await env.BUCKET.head(filename);
      if (existing) {
        console.log(`[CORE] Already cached: ${filename}`);
        return `Cached: ${filename}`;
      }
    }

    console.log(`[CORE] Processing ${processItems.length} newspapers for ${dateLabel}...`);

    const images = await downloadImages(
      processItems,
      config.concurrency,
      config.timeoutSec * 1000,
      config.delayBetweenReq
    );

    if (images.length === 0) return 'No images downloaded';

    const pdfBytes = await generatePDF(images, {
      labelBanner: config.labelBanner,
      dateLabel,
      maxWidth: config.maxWidth > 0 ? config.maxWidth : undefined,
      maxHeight: config.maxHeight > 0 ? config.maxHeight : undefined,
    });

    await env.BUCKET.put(filename, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' },
      customMetadata: {
        dateLabel,
        itemCount: images.length.toString(),
        generatedAt: new Date().toISOString(),
      },
    });

    const msg = `OK: ${filename} (${images.length} newspapers, ${pdfBytes.length} bytes)`;
    console.log(`[CORE] ${msg}`);
    return msg;
  } catch (err) {
    const msg = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[CORE] ${msg}`);
    return msg;
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const config = getConfig(env);

    try {
      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      if (url.pathname === '/config') {
        return new Response(JSON.stringify(config, null, 2), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.pathname !== '/' && url.pathname !== '/scrape') {
        return new Response('Not Found', { status: 404 });
      }

      // Check R2 cache first
      const html = await fetchHTML(config.timeoutSec);
      const { dateLabel, items } = parseNewspapers(html);
      const filename = generateFilename(dateLabel);

      if (config.skipIfExists) {
        const existing = await env.BUCKET.head(filename);
        if (existing) {
          console.log(`[INFO] Serving cached PDF: ${filename}`);
          const object = await env.BUCKET.get(filename);
          if (object) {
            return new Response(object.body, {
              headers: {
                'Content-Type': 'application/pdf',
                'Content-Disposition': `inline; filename="${filename}"`,
                'X-BIK-Cached': 'true',
                'X-BIK-Date': dateLabel,
                'X-BIK-Items': items.length.toString(),
              },
            });
          }
        }
      }

      // Not cached — kick off background processing, return 202
      const processItems = config.limitItems > 0 ? items.slice(0, config.limitItems) : items;
      ctx.waitUntil(runDailyProcessing(env, config));
      return new Response(
        JSON.stringify({
          status: 'processing',
          message: 'PDF generation started. Retry in ~60 seconds.',
          filename,
          dateLabel,
          itemCount: processItems.length,
        }),
        {
          status: 202,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
        }
      );

    } catch (error) {
      console.error('[ERROR]', error);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', message: error instanceof Error ? error.message : 'Unknown error' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  },

  /**
   * Daily cron at 04:00 UTC — generates fresh PDF for all 20 newspapers.
   * 15-minute CPU budget; completes in ~30 seconds without OCR.
   */
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`[CRON] Triggered at ${new Date(event.scheduledTime).toISOString()}`);
    const config = getConfig(env);
    const result = await runDailyProcessing(env, { ...config, skipIfExists: false });
    console.log(`[CRON] Done: ${result}`);
  },
};
