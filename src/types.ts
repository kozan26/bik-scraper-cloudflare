/**
 * Type definitions for BİK scraper
 */

import type { Ai } from '@cloudflare/workers-types';

export interface Env {
  BUCKET: R2Bucket;
  AI: Ai;
  LABEL_BANNER?: string;
  MAX_WIDTH?: string;
  MAX_HEIGHT?: string;
  CONCURRENCY?: string;
  DELAY_BETWEEN_REQ?: string;
  LIMIT_ITEMS?: string;
  SKIP_IF_EXISTS?: string;
  TIMEOUT_SEC?: string;
}

export interface NewspaperItem {
  name: string;
  full: string;
  thumb: string;
}

export interface ParseResult {
  dateLabel: string;
  items: NewspaperItem[];
}

export interface Config {
  labelBanner: boolean;
  maxWidth: number;
  maxHeight: number;
  concurrency: number;
  delayBetweenReq: number;
  limitItems: number;
  skipIfExists: boolean;
  timeoutSec: number;
}

export interface ImageData {
  buffer: ArrayBuffer;
  width: number;
  height: number;
  name: string;
}
