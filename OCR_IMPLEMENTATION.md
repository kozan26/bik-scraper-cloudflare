# OCR Implementation Guide

This document describes the OCR (Optical Character Recognition) implementation using Cloudflare Workers AI.

## Overview

The OCR feature extracts text from newspaper front page images using Cloudflare's Workers AI platform, specifically the `@cf/unum/uform-gen2-qwen-500m` model.

## Architecture

```
┌─────────────────────┐
│  /scrape-with-ocr   │
└──────────┬──────────┘
           │
           ├──► 1. Fetch & Parse HTML
           ├──► 2. Download Images
           ├──► 3. Run OCR on Each Image
           │    └─► Cloudflare Workers AI
           │        @cf/unum/uform-gen2-qwen-500m
           ├──► 4. Generate PDF
           ├──► 5. Format OCR Text
           ├──► 6. Upload Both to R2
           └──► 7. Return JSON Response
```

## Model Information

### uform-gen2-qwen-500m

**Purpose:** Image captioning and Visual Question Answering (VQA)

**Strengths:**
- Fast inference (500M parameters)
- Good for headlines and large text
- Efficient for newspaper front pages
- No training required

**Limitations:**
- May miss small fine print
- Not as accurate as Tesseract for dense documents
- Better for understanding than raw OCR

**Input Format:**
```typescript
{
  image: [...new Uint8Array(imageBuffer)],
  prompt: "Extract all visible text from this newspaper...",
  max_tokens: 2048
}
```

**Output:**
```typescript
{
  description: "extracted text content"
}
```

## Implementation Details

### File Structure

**src/ocr.ts**
- `extractTextFromImage()` - Single image OCR
- `extractTextFromImages()` - Batch OCR processing
- `formatOCRResults()` - Format results as readable text

### Processing Flow

1. **Download Images** - Same as regular endpoint
2. **Sequential OCR** - Process one image at a time to avoid rate limits
3. **Text Formatting** - Create structured text output
4. **Storage** - Upload both PDF and TXT to R2
5. **Response** - Return JSON with file metadata

### Rate Limiting

OCR processing includes:
- 100ms delay between AI requests
- Sequential processing (not parallel)
- Prevents overwhelming Workers AI service

## API Usage

### Endpoint

```
GET /scrape-with-ocr
```

### Response Format

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

### Example Usage

```bash
# Basic usage
curl https://your-worker.workers.dev/scrape-with-ocr

# With limited items for testing
# (Set LIMIT_ITEMS=3 in wrangler.toml)
curl https://your-worker.workers.dev/scrape-with-ocr
```

## File Output

### PDF File
- Filename: `bik_yaygin_<date>_ocr.pdf`
- Same as regular PDF but marked with OCR metadata
- Stored in R2 with `ocr: 'true'` metadata

### Text File
- Filename: `bik_yaygin_<date>_ocr.txt`
- Structured format with headers
- One section per newspaper
- UTF-8 encoded

**Example Text Output:**
```
BİK Newspaper OCR Extraction
Date: 18 Kasım 2024
Model: @cf/unum/uform-gen2-qwen-500m
Generated: 2024-11-18T10:30:00.000Z
Total Newspapers: 15

================================================================================

================================================================================
PAGE 1: Hürriyet
================================================================================

[Extracted headline text and article content here...]

================================================================================
PAGE 2: Sabah
================================================================================

[Extracted content...]
```

## Configuration

### Environment Variables

All existing environment variables work with OCR endpoint:
- `LIMIT_ITEMS` - Recommended for testing (set to 3-5)
- `CONCURRENCY` - Controls image downloads only
- `SKIP_IF_EXISTS` - Works for both PDF and TXT files

### Cloudflare Bindings

**Required in wrangler.toml:**

```toml
[ai]
binding = "AI"
```

This binding must be present for OCR to work.

## Performance Considerations

### Timing

| Operation | Time (per newspaper) |
|-----------|---------------------|
| Image Download | ~0.2-0.5s |
| OCR Processing | ~1-3s |
| PDF Generation | ~0.1s per page |
| Total (15 newspapers) | ~20-50s |

### Cost Implications

**Cloudflare Workers AI Pricing:**
- Neurons (compute units) consumed per request
- Check Cloudflare dashboard for current usage
- Free tier includes generous limits
- OCR adds ~2-4 neurons per image

**Recommendation:** Use `LIMIT_ITEMS` during development to minimize costs.

### Workers Time Limits

Standard Workers have ~50s wall time limit. For many newspapers:
- Set `LIMIT_ITEMS=10` or less
- OR implement Cloudflare Queues (future enhancement)
- Monitor logs for timeout warnings

## Error Handling

### OCR Failures

If OCR fails for an image, the error is logged but processing continues:

```typescript
{
  text: "[OCR Error: Model timeout]",
  model: "@cf/unum/uform-gen2-qwen-500m"
}
```

### Retry Logic

- No automatic retries for AI inference
- If entire endpoint fails, client can retry request
- Cached results returned immediately on subsequent requests

## Troubleshooting

### "AI binding not found"

**Problem:** Worker can't access AI binding

**Solution:**
1. Ensure `wrangler.toml` has AI binding
2. Redeploy: `npm run deploy`
3. Check Cloudflare dashboard for AI access

### "OCR timeout"

**Problem:** AI model taking too long

**Solution:**
1. Reduce `LIMIT_ITEMS` in config
2. Check Cloudflare Workers AI status
3. Retry request

### Poor OCR Quality

**Problem:** Text extraction missing content

**Solution:**
1. Adjust prompt in `src/ocr.ts`
2. Try different prompts for different content types
3. Consider using llava-1.5-7b-hf for better accuracy (slower)

### "Memory exceeded"

**Problem:** Processing too many images

**Solution:**
1. Set `LIMIT_ITEMS=5` or lower
2. Images processed sequentially to avoid this
3. Check image sizes aren't too large

## Alternative Models

### Other Cloudflare AI Models for OCR

| Model | Size | Speed | Accuracy | Cost |
|-------|------|-------|----------|------|
| uform-gen2-qwen-500m | 500M | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ | $ |
| llava-1.5-7b-hf | 7B | ⭐⭐⭐ | ⭐⭐⭐⭐ | $$ |
| llama-3.2-11b-vision | 11B | ⭐⭐ | ⭐⭐⭐⭐⭐ | $$$ |

### Switching Models

Edit `src/ocr.ts`:

```typescript
const response = await ai.run(
  '@cf/llava-hf/llava-1.5-7b-hf', // Change model here
  input
);
```

**Note:** Different models may have different input/output formats.

## Caching Behavior

### Cache Check

Before processing, the endpoint checks R2 for existing files:
- `bik_yaygin_<date>_ocr.pdf`
- `bik_yaygin_<date>_ocr.txt`

If both exist and `SKIP_IF_EXISTS=true`, returns cached metadata immediately.

### Cache Invalidation

To regenerate OCR for today:
1. Delete files from R2: `npx wrangler r2 object delete bik-newspapers/<filename>`
2. OR set `SKIP_IF_EXISTS=false` in config
3. Make new request

## Testing

### Local Development

```bash
# Start dev server
npm run dev

# Test OCR endpoint
curl http://localhost:8787/scrape-with-ocr
```

### Test with Limited Items

Edit `wrangler.toml`:
```toml
LIMIT_ITEMS = "2"  # Process only 2 newspapers
```

Then:
```bash
npm run deploy
curl https://your-worker.workers.dev/scrape-with-ocr
```

### Monitor Logs

```bash
npm run tail
```

Look for:
```
[OCR] Processing image for: Hürriyet
[OCR] No text extracted for: <name>  # Warning
[OCR] Failed to extract text: ...    # Error
```

## Future Enhancements

- [ ] Parallel OCR with rate limiting
- [ ] Multiple model support (user-selectable)
- [ ] OCR confidence scores
- [ ] Language detection
- [ ] Searchable PDF generation (embed OCR text in PDF)
- [ ] OCR result caching in KV for faster lookups
- [ ] Webhook notifications when OCR complete

## Related Documentation

- [Cloudflare Workers AI Docs](https://developers.cloudflare.com/workers-ai/)
- [uform-gen2-qwen-500m Model](https://developers.cloudflare.com/workers-ai/models/uform-gen2-qwen-500m/)
- [Workers AI Pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)

---

**Last Updated:** 2024-11-18
