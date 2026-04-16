# BİK Newspaper Scraper - Cloudflare Workers

A TypeScript implementation of the BİK (Basın İlan Kurumu) newspaper front page scraper, ported to run on Cloudflare Workers. This service scrapes Turkish newspaper front pages from the BİK website and generates PDFs stored in Cloudflare R2.

## Features

- ✅ **Scrapes BİK 'yaygın' (mainstream) newspapers** from the official website
- ✅ **Parallel image downloading** with configurable concurrency
- ✅ **PDF generation** with optional labeled banners
- ✅ **OCR text extraction** using Cloudflare Workers AI (uform-gen2-qwen-500m)
- ✅ **R2 storage** for generated PDFs and OCR text files
- ✅ **Automatic caching** - skips regeneration if today's file exists
- ✅ **Image resizing** to optimize file size
- ✅ **Retry logic** for reliable downloads
- ✅ **TypeScript** for type safety

## Architecture

```
┌─────────────┐
│   Request   │
└──────┬──────┘
       │
┌──────▼──────────────────┐
│  Cloudflare Worker      │
│  1. Fetch HTML          │
│  2. Parse newspapers    │
│  3. Download images     │
│  4. Generate PDF        │
│  5. Upload to R2        │
└──────┬──────────────────┘
       │
┌──────▼──────┐
│  R2 Storage │ → Return PDF
└─────────────┘
```

## Prerequisites

- [Node.js](https://nodejs.org/) 18+ and npm
- [Cloudflare account](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

## Installation

1. **Clone the repository:**

```bash
git clone <repository-url>
cd mansetler
```

2. **Install dependencies:**

```bash
npm install
```

3. **Set up Cloudflare R2 bucket:**

```bash
# Login to Cloudflare
npx wrangler login

# Create R2 bucket
npx wrangler r2 bucket create bik-newspapers
```

4. **Configure environment (optional):**

Edit `wrangler.toml` to customize settings:

```toml
[vars]
LABEL_BANNER = "true"        # Add newspaper name + date banner
MAX_WIDTH = "2000"           # Max image width (0 = no limit)
MAX_HEIGHT = "0"             # Max image height (0 = no limit)
CONCURRENCY = "4"            # Parallel downloads
DELAY_BETWEEN_REQ = "0.2"   # Delay between requests (seconds)
LIMIT_ITEMS = "0"            # Limit newspapers (0 = all, useful for testing)
SKIP_IF_EXISTS = "true"      # Skip if PDF exists in R2
TIMEOUT_SEC = "25"           # Request timeout
```

## Development

**Run locally:**

```bash
npm run dev
```

This starts a local development server. Visit:
- `http://localhost:8787/` - Generate PDF (no OCR)
- `http://localhost:8787/scrape-with-ocr` - Generate PDF with OCR
- `http://localhost:8787/health` - Health check
- `http://localhost:8787/config` - View configuration

## Deployment

**Deploy to Cloudflare Workers:**

```bash
npm run deploy
```

Your worker will be available at: `https://bik-scraper.<your-subdomain>.workers.dev`

## Usage

### Generate PDF

**HTTP Request:**

```bash
curl https://bik-scraper.<your-subdomain>.workers.dev/ \
  --output newspapers.pdf
```

**Response:**

- Returns a PDF file with all newspaper front pages
- PDF filename format: `bik_yaygin_<date>.pdf`
- Cached in R2 for subsequent requests

### Health Check

```bash
curl https://bik-scraper.<your-subdomain>.workers.dev/health
```

### View Configuration

```bash
curl https://bik-scraper.<your-subdomain>.workers.dev/config
```

### Generate PDF with OCR

**NEW!** Extract text from newspaper images using Cloudflare Workers AI.

**HTTP Request:**

```bash
curl https://bik-scraper.<your-subdomain>.workers.dev/scrape-with-ocr
```

**Response (JSON):**

```json
{
  "message": "OCR processing complete",
  "pdf": "bik_yaygin_18-kasim-2024_ocr.pdf",
  "text": "bik_yaygin_18-kasim-2024_ocr.txt",
  "pdfSize": 2453678,
  "textSize": 45821,
  "items": 15,
  "dateLabel": "18 Kasım 2024",
  "ocrModel": "@cf/unum/uform-gen2-qwen-500m"
}
```

The endpoint returns JSON with information about the generated files. Both PDF and text files are stored in R2 and can be retrieved separately.

**OCR Features:**
- Uses Cloudflare Workers AI model: `@cf/unum/uform-gen2-qwen-500m`
- Extracts headlines, article text, and captions
- Generates both PDF and `.txt` file with extracted text
- Sequential processing to manage Workers AI rate limits
- Cached results to avoid reprocessing

**Performance Note:** OCR processing is slower than regular PDF generation (adds ~1-3 seconds per newspaper). Consider using `LIMIT_ITEMS` for testing.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` or `/scrape` | GET | Generate and return PDF (no OCR) |
| `/scrape-with-ocr` | GET | Generate PDF + OCR text extraction |
| `/health` | GET | Health check |
| `/config` | GET | View current configuration |

## Response Headers

Successful PDF generation includes these headers:

```
Content-Type: application/pdf
Content-Disposition: inline; filename="bik_yaygin_<date>.pdf"
X-BIK-Date: <newspaper date>
X-BIK-Items: <number of newspapers>
X-BIK-Filename: <filename>
X-BIK-Cached: true (if served from R2 cache)
```

## Configuration Options

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LABEL_BANNER` | `true` | Add newspaper name + date banner to each page |
| `MAX_WIDTH` | `2000` | Maximum image width in pixels (0 = no limit) |
| `MAX_HEIGHT` | `0` | Maximum image height in pixels (0 = no limit) |
| `CONCURRENCY` | `4` | Number of parallel image downloads |
| `DELAY_BETWEEN_REQ` | `0.2` | Delay between requests in seconds |
| `LIMIT_ITEMS` | `0` | Limit number of newspapers (0 = all) |
| `SKIP_IF_EXISTS` | `true` | Skip generation if file exists in R2 |
| `TIMEOUT_SEC` | `25` | HTTP request timeout in seconds |

### Cloudflare Bindings

The worker requires the following bindings configured in `wrangler.toml`:

**R2 Bucket Binding:**
```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "bik-newspapers"
```

**Workers AI Binding (for OCR):**
```toml
[ai]
binding = "AI"
```

The AI binding enables access to Cloudflare Workers AI models for OCR text extraction.

## Project Structure

```
mansetler/
├── src/
│   ├── worker.ts       # Main worker entry point
│   ├── types.ts        # TypeScript type definitions
│   ├── parser.ts       # HTML parsing logic
│   ├── downloader.ts   # Image downloading with concurrency
│   ├── ocr.ts          # OCR text extraction with Workers AI
│   └── pdf.ts          # PDF generation logic
├── wrangler.toml       # Cloudflare Workers configuration
├── package.json        # Dependencies
├── tsconfig.json       # TypeScript configuration
└── README.md           # This file
```

## Comparison with Python Version

### ✅ Ported Features

- HTML fetching and parsing
- Image downloading with retry logic
- Parallel downloads with concurrency control
- PDF generation with labels
- Image resizing
- Configurable via environment variables
- Daily file naming based on date
- **OCR functionality** - Using Cloudflare Workers AI instead of Tesseract

### ⚠️ Implementation Differences

- **OCR Engine** - Uses Cloudflare AI (uform-gen2-qwen-500m) instead of Tesseract
  - Different accuracy profile (better for headlines, may miss fine print)
  - No training data needed
  - Cloud-based inference
- **Local filesystem** - Uses R2 object storage instead
- **Jupyter notebook format** - Standard TypeScript project

### 🎯 Improvements

- Runs on serverless infrastructure (no VM needed)
- Automatic scaling
- Global edge deployment
- Built-in caching with R2
- Lower operational costs
- TypeScript type safety

## Limitations

### Cloudflare Workers Constraints

1. **CPU Time Limit:**
   - ~30-50s wall time for standard Workers
   - For larger batches, consider using Cloudflare Queues

2. **Memory Limit:**
   - 128MB RAM
   - Images are processed sequentially to avoid memory issues

3. **Request Timeout:**
   - Default 50s for Workers
   - Adjust `TIMEOUT_SEC` and `CONCURRENCY` if needed

### Workarounds

- **For longer execution:** Use Cloudflare Queues (not implemented yet)
- **For OCR:** Integrate Cloudflare AI or external OCR service
- **For large batches:** Set `LIMIT_ITEMS` to process in chunks

## Troubleshooting

### "No newspapers found"

- The BİK website structure may have changed
- Check if `https://gazete.bik.gov.tr/Uygulamalar/GazeteIlkSayfalar?kapsam=yaygin` is accessible

### "Failed to download images"

- Increase `TIMEOUT_SEC` value
- Reduce `CONCURRENCY` to avoid rate limiting
- Check network connectivity

### "Internal Server Error"

- Check worker logs: `npm run tail`
- Verify R2 bucket exists and binding is correct
- Check configuration values are valid

## Monitoring

**View real-time logs:**

```bash
npm run tail
```

**Check R2 bucket contents:**

```bash
npx wrangler r2 object list bik-newspapers
```

## Future Enhancements

- [x] OCR integration with Cloudflare AI ✅ **DONE!**
- [ ] Cloudflare Queues for long-running tasks
- [ ] Cron trigger for daily automatic scraping
- [ ] Email/webhook notifications
- [ ] Multiple newspaper categories (not just 'yaygın')
- [ ] Historical archive browsing
- [ ] Custom date selection
- [ ] Improve OCR accuracy with better prompts or multiple models
- [ ] Add endpoint to retrieve stored files from R2

## License

MIT

## Credits

Ported from the original Python implementation to Cloudflare Workers with TypeScript.

---

**Questions or Issues?**

Please open an issue on the repository or check the Cloudflare Workers documentation at https://developers.cloudflare.com/workers/
