const express = require('express');
const puppeteer = require('puppeteer');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(__dirname));

const delay = ms => new Promise(r => setTimeout(r, ms));

function calcDamageScore(stars, daysAgo, textLength) {
  const raw = (6 - stars) * Math.max(1, daysAgo) * Math.log(Math.max(10, textLength));
  return Math.min(10, Math.round(raw / 8));
}

function parseDaysAgo(dateText) {
  if (!dateText) return 7;
  const t = dateText.toLowerCase();
  if (t.includes('hour') || t.includes('uur') || t.includes('minute') || t.includes('minuut')) return 1;
  if (t.includes('yesterday') || t.includes('gisteren')) return 1;
  const dayMatch = t.match(/(\d+)\s*(day|dag)/);
  if (dayMatch) return parseInt(dayMatch[1]);
  const weekMatch = t.match(/(\d+)\s*(week)/);
  if (weekMatch) return parseInt(weekMatch[1]) * 7;
  const monthMatch = t.match(/(\d+)\s*(month|maand)/);
  if (monthMatch) return parseInt(monthMatch[1]) * 30;
  if (t.includes('a week') || t.includes('een week')) return 7;
  if (t.includes('a month') || t.includes('een maand')) return 30;
  if (t.includes('year') || t.includes('jaar')) return 365;
  return 14;
}

async function scrapeGoogleMaps(bizType, city, maxResults) {
  console.log(`\n[SCRAPER] Launching browser...`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
    ]
  });

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    const searchQuery = `${bizType} in ${city}`;
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;
    console.log(`[SCRAPER] Searching: ${searchQuery}`);

    await page.goto(mapsUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(3000);

    // Accept cookie consent
    try {
      const btns = await page.$$('button');
      for (const btn of btns) {
        const txt = await btn.evaluate(el => el.textContent.toLowerCase());
        if (txt.includes('accept all') || txt.includes('alles accepteren') || txt.includes('accept')) {
          await btn.click();
          console.log(`[SCRAPER] Accepted cookie consent`);
          await delay(2000);
          break;
        }
      }
    } catch (e) {}

    // Collect business links from search results
    const businessLinks = await page.evaluate(() => {
      const seen = new Set();
      const links = [];
      document.querySelectorAll('a[href*="/maps/place/"]').forEach(a => {
        const base = a.href.split('?')[0];
        if (!seen.has(base) && a.href.includes('/maps/place/')) {
          seen.add(base);
          links.push(a.href);
        }
      });
      return links.slice(0, 10);
    });

    console.log(`[SCRAPER] Found ${businessLinks.length} business links`);
    await page.close();

    if (businessLinks.length === 0) {
      throw new Error('No businesses found. Google may be blocking the request — wait 60 seconds and try again.');
    }

    // Visit each business
    for (let i = 0; i < businessLinks.length; i++) {
      if (results.length >= maxResults) break;

      const bizUrl = businessLinks[i];
      console.log(`\n[SCRAPER] Visiting business ${i + 1}/${businessLinks.length}...`);

      try {
        const bizPage = await browser.newPage();
        await bizPage.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        await bizPage.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

        await bizPage.goto(bizUrl, { waitUntil: 'networkidle2', timeout: 25000 });
        await delay(2500);

        // Business name
        const bizName = await bizPage.evaluate(() => {
          const el = document.querySelector('h1.DUwDvf, h1[class*="fontHeadlineLarge"], h1');
          return el ? el.textContent.trim() : null;
        });

        if (!bizName) { await bizPage.close(); continue; }
        console.log(`[SCRAPER]   → ${bizName}`);

        // Address
        const address = await bizPage.evaluate(() => {
          const selectors = [
            '[data-item-id="address"] .Io6YTe',
            'button[data-item-id="address"] .fontBodyMedium',
            '[aria-label*="ddress"] .Io6YTe',
          ];
          for (const s of selectors) {
            const el = document.querySelector(s);
            if (el) return el.textContent.trim();
          }
          return '';
        });

        // Rating and review count
        const meta = await bizPage.evaluate(() => {
          const ratingEl = document.querySelector('.F7nice span[aria-hidden="true"]');
          const countEl = document.querySelector('.F7nice button span[aria-label]');
          return {
            rating: ratingEl ? parseFloat(ratingEl.textContent) : null,
            countLabel: countEl ? countEl.getAttribute('aria-label') : ''
          };
        });

        const totalMatch = (meta.countLabel || '').match(/[\d,]+/);
        const totalReviews = totalMatch ? parseInt(totalMatch[0].replace(/,/g, '')) : 0;

        // Click reviews tab
        const clickedTab = await bizPage.evaluate(() => {
          const tabs = Array.from(document.querySelectorAll('button[role="tab"]'));
          const tab = tabs.find(t =>
            t.textContent.toLowerCase().includes('review') ||
            t.textContent.toLowerCase().includes('recensie')
          );
          if (tab) { tab.click(); return true; }
          return false;
        });

        if (!clickedTab) { await bizPage.close(); continue; }
        await delay(2500);

        // Try to sort by newest
        try {
          await bizPage.evaluate(() => {
            const all = Array.from(document.querySelectorAll('button, [role="button"]'));
            const sortBtn = all.find(b => {
              const lbl = (b.getAttribute('aria-label') || b.textContent || '').toLowerCase();
              return lbl.includes('sort') || lbl.includes('sorter');
            });
            if (sortBtn) sortBtn.click();
          });
          await delay(1200);
          await bizPage.evaluate(() => {
            const opts = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="option"], li'));
            const newest = opts.find(o =>
              o.textContent.toLowerCase().includes('newest') ||
              o.textContent.toLowerCase().includes('nieuwste')
            );
            if (newest) newest.click();
          });
          await delay(2000);
        } catch (e) {}

        // Scroll to load reviews
        await bizPage.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollTop += 2000;
        });
        await delay(1500);

        // Extract reviews
        const reviews = await bizPage.evaluate(() => {
          const items = document.querySelectorAll('[data-review-id], .jftiEf');
          const out = [];
          items.forEach(el => {
            const starEl = el.querySelector('[role="img"][aria-label*="star"], [role="img"][aria-label*="ster"]');
            let stars = null;
            if (starEl) {
              const m = (starEl.getAttribute('aria-label') || '').match(/(\d)/);
              if (m) stars = parseInt(m[1]);
            }

            const moreBtn = el.querySelector('button.w8nwRe, button[aria-label*="More"]');
            if (moreBtn) moreBtn.click();

            const textEl = el.querySelector('.MyEned span, .wiI7pd, .MyEned');
            const text = textEl ? textEl.textContent.trim() : '';

            const dateEl = el.querySelector('.rsqaWe, .xRkPPb');
            const dateText = dateEl ? dateEl.textContent.trim() : '';

            const responseEl = el.querySelector('.CDe7pd, .d6SCIc, .XlPR6e');
            const hasResponse = !!responseEl && responseEl.textContent.trim().length > 15;

            const nameEl = el.querySelector('.d4r55, .WNxzHc');
            const reviewerName = nameEl ? nameEl.textContent.trim() : 'Customer';

            if (stars && text.length > 15) {
              out.push({ stars, text, dateText, hasResponse, reviewerName });
            }
          });
          return out;
        });

        await bizPage.close();
        console.log(`[SCRAPER]   Reviews found: ${reviews.length}`);

        const unanswered = reviews
          .filter(r => !r.hasResponse && r.stars <= 3)
          .map(r => ({
            ...r,
            daysAgo: parseDaysAgo(r.dateText),
            damageScore: calcDamageScore(r.stars, parseDaysAgo(r.dateText), r.text.length)
          }))
          .sort((a, b) => b.damageScore - a.damageScore)
          .slice(0, 3);

        console.log(`[SCRAPER]   Unanswered low-star: ${unanswered.length}`);

        if (unanswered.length === 0) continue;

        results.push({
          name: bizName,
          address,
          url: bizUrl,
          rating: meta.rating,
          totalReviews,
          unansweredReviews: unanswered,
          scrapedReviewCount: reviews.length
        });

        await delay(3000);

      } catch (err) {
        console.log(`[SCRAPER]   Error: ${err.message}`);
      }
    }

  } finally {
    await browser.close();
    console.log(`\n[SCRAPER] Finished. Prospects with unanswered reviews: ${results.length}`);
  }

  return results.sort((a, b) => {
    const aScore = Math.max(...a.unansweredReviews.map(r => r.damageScore));
    const bScore = Math.max(...b.unansweredReviews.map(r => r.damageScore));
    return bScore - aScore;
  });
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.post('/api/scrape', async (req, res) => {
  const { bizType, city, maxResults = 3 } = req.body;
  if (!bizType || !city) return res.status(400).json({ error: 'bizType and city required' });
  try {
    const data = await scrapeGoogleMaps(bizType, city, parseInt(maxResults));
    res.json({ success: true, results: data, count: data.length });
  } catch (err) {
    console.error('[ERROR]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  ✦ Watchdog Scraper → http://localhost:${PORT}\n`);
});
