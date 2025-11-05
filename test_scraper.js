const WebScraper = require('./src/services/scraper');

async function test() {
  console.log('🧪 Testing Yahoo Finance Press Release Scraper\n');

  const scraper = new WebScraper();

  try {
    // Test with Apple ticker
    const ticker = 'AAPL';
    console.log(`Testing with ticker: ${ticker}`);
    console.log('-------------------------------------------\n');

    const results = await scraper.scrapeYahooFinancePressReleases(
      ticker,
      3, // Just test with 3 to save time
      (progress) => {
        console.log(`\n📊 Progress: ${progress.current}/${progress.total}`);
        console.log(`   Link: ${progress.linkText.substring(0, 80)}...`);
      }
    );

    console.log('\n\n✅ Test Results:');
    console.log('===================');
    console.log(`Total scraped: ${results.length}`);
    console.log(`Successful: ${results.filter(r => r.success).length}`);
    console.log(`Failed: ${results.filter(r => !r.success).length}`);

    results.forEach((result, i) => {
      console.log(`\n${i + 1}. ${result.success ? '✓' : '✗'} ${result.title || result.linkText}`);
      if (result.success) {
        console.log(`   URL: ${result.url}`);
        console.log(`   Word count: ${result.wordCount}`);
        console.log(`   Text preview: ${result.text.substring(0, 100)}...`);
      } else {
        console.log(`   Error: ${result.error}`);
      }
    });

  } catch (error) {
    console.error('\n❌ Test failed:', error);
  } finally {
    await scraper.close();
    console.log('\n\n✨ Test complete');
  }
}

test();
