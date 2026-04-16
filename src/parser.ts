/**
 * HTML parser for BİK newspaper website
 */

import { parseHTML } from 'linkedom';
import type { ParseResult, NewspaperItem } from './types';

const BASE_URL = 'https://gazete.bik.gov.tr';

/**
 * Parse HTML and extract newspaper items
 */
export function parseNewspapers(html: string): ParseResult {
  const { document } = parseHTML(html);

  // Extract date label
  const dateElement = document.querySelector('#gallery h3.gazeteler-tarih');
  const dateLabel = dateElement?.textContent?.trim() || '';

  // Extract newspaper items
  const items: NewspaperItem[] = [];
  const figures = document.querySelectorAll('.newspaper-list figure.item');

  for (const fig of figures) {
    const anchor = fig.querySelector('a.newspaper-list-item[href]');
    const img = fig.querySelector('img[itemprop="thumbnail"]');
    const nameElement = fig.querySelector('.figcaption span') || fig.querySelector('span');

    if (!anchor || !img || !nameElement) {
      continue;
    }

    const href = anchor.getAttribute('href')?.trim() || '';
    const src = img.getAttribute('src')?.trim() || '';
    const name = nameElement.textContent?.trim() || '';

    if (href && src && name) {
      items.push({
        name,
        full: makeAbsoluteUrl(href),
        thumb: makeAbsoluteUrl(src),
      });
    }
  }

  return { dateLabel, items };
}

/**
 * Convert relative URL to absolute
 */
function makeAbsoluteUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  if (url.startsWith('//')) {
    return `https:${url}`;
  }

  if (url.startsWith('/')) {
    return `${BASE_URL}${url}`;
  }

  return `${BASE_URL}/${url}`;
}

/**
 * Generate filename from date label
 */
export function generateFilename(dateLabel: string): string {
  // Extract date pattern like "17 Kasım 2024"
  const match = dateLabel.match(/(\d{1,2}\s+\S+\s+\d{4})/);
  const stub = match
    ? match[1].replace(/\s+/g, '-').toLowerCase()
    : 'yaygin';

  return `bik_yaygin_${stub}.pdf`;
}
