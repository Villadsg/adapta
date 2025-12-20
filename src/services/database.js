const duckdb = require('duckdb');
const path = require('path');

class ArticleDatabase {
  constructor(dbPath = 'articles.db') {
    this.dbPath = dbPath;
    this.db = null;
    this.connection = null;
  }

  /**
   * Initialize database connection and create tables
   */
  async initialize() {
    return new Promise((resolve, reject) => {
      // Create database instance
      this.db = new duckdb.Database(this.dbPath, {
        access_mode: 'READ_WRITE'
      }, (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Create connection - store reference to prevent garbage collection
        this.connection = this.db.connect();

        // Keep connection alive by storing it
        if (!this.connection) {
          reject(new Error('Failed to create database connection'));
          return;
        }

        // Prevent garbage collection of connection and database
        // This is critical for DuckDB to maintain the connection
        global.__duckdb_instance = this.db;
        global.__duckdb_connection = this.connection;

        console.log('✓ Database connection established');

        // Create tables
        this.createTables()
          .then(() => {
            console.log('Database initialized successfully');
            resolve();
          })
          .catch(reject);
      });
    });
  }

  /**
   * Create database tables if they don't exist
   */
  async createTables() {
    const createArticlesSequence = `
      CREATE SEQUENCE IF NOT EXISTS articles_id_seq START 1
    `;

    const createArticlesTable = `
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY DEFAULT nextval('articles_id_seq'),
        url TEXT NOT NULL,
        title TEXT,
        content TEXT,
        category TEXT,
        domain TEXT,
        saved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        word_count INTEGER,
        embedding FLOAT[],
        published_date TIMESTAMP,
        tickers TEXT[]
      )
    `;

    const createChunksSequence = `
      CREATE SEQUENCE IF NOT EXISTS chunks_id_seq START 1
    `;

    const createChunksTable = `
      CREATE TABLE IF NOT EXISTS article_chunks (
        chunk_id INTEGER PRIMARY KEY DEFAULT nextval('chunks_id_seq'),
        article_id INTEGER NOT NULL,
        chunk_text TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        embedding FLOAT[],
        category TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (article_id) REFERENCES articles(id)
      )
    `;

    const createSettingsTable = `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `;

    const createNewsVolumeSequence = `
      CREATE SEQUENCE IF NOT EXISTS news_volume_id_seq START 1
    `;

    const createNewsVolumeTable = `
      CREATE TABLE IF NOT EXISTS news_volume (
        id INTEGER PRIMARY KEY DEFAULT nextval('news_volume_id_seq'),
        ticker TEXT NOT NULL,
        recorded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        article_count INTEGER NOT NULL,
        source TEXT,
        page_url TEXT
      )
    `;

    const createStockPricesSequence = `
      CREATE SEQUENCE IF NOT EXISTS stock_prices_id_seq START 1
    `;

    const createStockPricesTable = `
      CREATE TABLE IF NOT EXISTS stock_prices (
        id INTEGER PRIMARY KEY DEFAULT nextval('stock_prices_id_seq'),
        ticker TEXT NOT NULL,
        date DATE NOT NULL,
        open DECIMAL(10,2),
        high DECIMAL(10,2),
        low DECIMAL(10,2),
        close DECIMAL(10,2),
        volume BIGINT,
        source TEXT,
        fetched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(ticker, date, source)
      )
    `;

    const createWatchedTickersSequence = `
      CREATE SEQUENCE IF NOT EXISTS watched_tickers_id_seq START 1
    `;

    const createWatchedTickersTable = `
      CREATE TABLE IF NOT EXISTS watched_tickers (
        id INTEGER PRIMARY KEY DEFAULT nextval('watched_tickers_id_seq'),
        ticker TEXT NOT NULL UNIQUE,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        auto_update BOOLEAN DEFAULT true
      )
    `;

    return new Promise((resolve, reject) => {
      // Create articles sequence
      this.connection.run(createArticlesSequence, (err) => {
        if (err) {
          reject(err);
          return;
        }

        // Create articles table
        this.connection.run(createArticlesTable, (err) => {
          if (err) {
            reject(err);
            return;
          }

          // Create chunks sequence
          this.connection.run(createChunksSequence, (err) => {
            if (err) {
              reject(err);
              return;
            }

            // Create chunks table
            this.connection.run(createChunksTable, (err) => {
              if (err) {
                reject(err);
                return;
              }

              // Create settings table
              this.connection.run(createSettingsTable, (err) => {
                if (err) {
                  reject(err);
                  return;
                }

                // Create news_volume sequence
                this.connection.run(createNewsVolumeSequence, (err) => {
                  if (err) {
                    reject(err);
                    return;
                  }

                  // Create news_volume table
                  this.connection.run(createNewsVolumeTable, (err) => {
                    if (err) {
                      reject(err);
                      return;
                    }

                    // Create stock_prices sequence
                    this.connection.run(createStockPricesSequence, (err) => {
                      if (err) {
                        reject(err);
                        return;
                      }

                      // Create stock_prices table
                      this.connection.run(createStockPricesTable, (err) => {
                        if (err) {
                          reject(err);
                          return;
                        }

                        // Create watched_tickers sequence
                        this.connection.run(createWatchedTickersSequence, (err) => {
                          if (err) {
                            reject(err);
                            return;
                          }

                          // Create watched_tickers table
                          this.connection.run(createWatchedTickersTable, (err) => {
                            if (err) {
                              reject(err);
                              return;
                            }

                            // Initialize default settings
                            this.initializeSettings()
                              .then(() => {
                                // Run migrations
                                this.runMigrations()
                                  .then(() => {
                                    // Create indexes
                                    this.createIndexes()
                                      .then(resolve)
                                      .catch(reject);
                                  })
                                  .catch(reject);
                              })
                              .catch(reject);
                          });
                        });
                      });
                    });
                  });
                });
              });
            });
          });
        });
      });
    });
  }

  /**
   * Create indexes for better query performance
   */
  async createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_category ON articles(category)',
      'CREATE INDEX IF NOT EXISTS idx_domain ON articles(domain)',
      'CREATE INDEX IF NOT EXISTS idx_saved_at ON articles(saved_at)',
      'CREATE INDEX IF NOT EXISTS idx_published_date ON articles(published_date)',
      'CREATE INDEX IF NOT EXISTS idx_chunks_article_id ON article_chunks(article_id)',
      'CREATE INDEX IF NOT EXISTS idx_chunks_category ON article_chunks(category)',
      'CREATE INDEX IF NOT EXISTS idx_news_volume_ticker ON news_volume(ticker)',
      'CREATE INDEX IF NOT EXISTS idx_news_volume_recorded_at ON news_volume(recorded_at)',
      'CREATE INDEX IF NOT EXISTS idx_stock_prices_ticker ON stock_prices(ticker)',
      'CREATE INDEX IF NOT EXISTS idx_stock_prices_date ON stock_prices(date)',
      'CREATE INDEX IF NOT EXISTS idx_stock_prices_ticker_date ON stock_prices(ticker, date)',
      'CREATE INDEX IF NOT EXISTS idx_watched_tickers_ticker ON watched_tickers(ticker)'
    ];

    for (const indexSQL of indexes) {
      await new Promise((resolve, reject) => {
        this.connection.run(indexSQL, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
  }

  /**
   * Run database migrations to handle schema changes
   */
  async runMigrations() {
    try {
      // Migration 1: Add embedding column to articles table if it doesn't exist
      await this.addColumnIfNotExists('articles', 'embedding', 'FLOAT[]');

      // Migration 2: Add published_date column for article publication dates
      await this.addColumnIfNotExists('articles', 'published_date', 'TIMESTAMP');

      // Migration 3: Add tickers column for stock ticker associations
      await this.addColumnIfNotExists('articles', 'tickers', 'TEXT[]');

      console.log('✓ Database migrations completed');
    } catch (error) {
      console.error('Error running migrations:', error);
      throw error;
    }
  }

  /**
   * Ensure database connection is active
   */
  ensureConnection() {
    if (!this.connection || !this.db) {
      throw new Error('Database connection is not available. Please restart the application.');
    }
  }

  /**
   * Add a column to a table if it doesn't already exist
   * @param {string} tableName - Name of the table
   * @param {string} columnName - Name of the column to add
   * @param {string} columnType - SQL type of the column
   */
  async addColumnIfNotExists(tableName, columnName, columnType) {
    return new Promise((resolve) => {
      // Attempt to select the column - if it works, column exists
      const testSQL = `SELECT ${columnName} FROM ${tableName} LIMIT 0`;

      this.connection.all(testSQL, (testErr) => {
        if (testErr) {
          // Column doesn't exist, try to add it
          const alterSQL = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;

          this.connection.run(alterSQL, (alterErr) => {
            if (alterErr) {
              // If error contains "already exists", that's fine
              if (alterErr.message && alterErr.message.includes('already exists')) {
                console.log(`✓ Column '${columnName}' already exists in table '${tableName}'`);
                resolve();
              } else {
                console.error(`⚠️  Error adding column ${columnName} to ${tableName}:`, alterErr.message);
                // Don't reject - just resolve to allow app to continue
                resolve();
              }
            } else {
              console.log(`✓ Added column '${columnName}' to table '${tableName}'`);
              resolve();
            }
          });
        } else {
          // Column already exists
          console.log(`✓ Column '${columnName}' already exists in table '${tableName}'`);
          resolve();
        }
      });
    });
  }

  // ===== Settings methods =====

  /**
   * Initialize default settings if they don't exist
   */
  async initializeSettings() {
    // No default settings needed anymore (chunking removed)
    // This method is kept for backward compatibility
  }

  /**
   * Get a setting value
   *
   * @param {string} key - Setting key
   * @param {string} defaultValue - Default value if not found
   * @returns {Promise<string|null>} Setting value or default
   */
  async getSetting(key, defaultValue = null) {
    const sql = 'SELECT value FROM settings WHERE key = $1';

    return new Promise((resolve, reject) => {
      this.connection.all(sql, key, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.length > 0 ? rows[0].value : defaultValue);
      });
    });
  }

  /**
   * Set a setting value
   *
   * @param {string} key - Setting key
   * @param {string} value - Setting value
   * @returns {Promise<void>}
   */
  async setSetting(key, value) {
    const sql = `
      INSERT INTO settings (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) DO UPDATE SET value = $2
    `;

    return new Promise((resolve, reject) => {
      this.connection.run(sql, key, value, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Save an article to the database with embedding
   */
  async saveArticle(url, title, content, category, options = {}) {
    const { generateEmbedding = true, publishedDate = null, tickers = [] } = options;

    // Extract domain from URL
    let domain = '';
    try {
      const urlObj = new URL(url);
      domain = urlObj.hostname;
    } catch (e) {
      domain = 'unknown';
    }

    // Calculate word count
    const wordCount = content.split(/\s+/).length;

    // Generate embedding for full article if enabled
    let embedding = null;
    if (generateEmbedding) {
      const embeddingService = require('./embeddings');
      console.log(`  Generating embedding for full article...`);
      embedding = await embeddingService.embed(content, {
        task: 'search_document',
        title: title,
      });
    }

    // Convert embedding array to DuckDB array format
    const embeddingValue = embedding ? `[${embedding.join(',')}]` : null;

    // Convert tickers array to DuckDB array format
    const tickersValue = tickers && tickers.length > 0 ? `[${tickers.map(t => `'${t}'`).join(',')}]` : null;

    const sql = `
      INSERT INTO articles (url, title, content, category, domain, word_count, embedding, published_date, tickers)
      VALUES ($1, $2, $3, $4, $5, $6, $7::FLOAT[], $8, $9::TEXT[])
      RETURNING id
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, url, title, content, category, domain, wordCount, embeddingValue, publishedDate, tickersValue, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        const articleId = result[0]?.id;
        resolve({
          id: articleId,
          url,
          title,
          category,
          domain,
          wordCount,
          publishedDate,
          tickers
        });
      });
    });
  }

  /**
   * Get all articles, optionally filtered by category
   */
  async getAllArticles(categoryFilter = null, limit = 100) {
    let sql = `
      SELECT id, url, title, category, domain, saved_at, word_count, published_date, tickers
      FROM articles
    `;

    const params = [];

    if (categoryFilter) {
      sql += ' WHERE category = ?';
      params.push(categoryFilter);
    }

    sql += ' ORDER BY saved_at DESC LIMIT ?';
    params.push(limit);

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Get article by ID
   */
  async getArticleById(articleId) {
    const sql = `
      SELECT id, url, title, content, category, domain, saved_at, word_count, embedding, published_date, tickers
      FROM articles
      WHERE id = ?
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, [articleId], (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0] || null);
      });
    });
  }

  /**
   * Search articles by title or content
   */
  async searchArticles(searchTerm, categoryFilter = null) {
    let sql = `
      SELECT id, url, title, category, domain, saved_at, word_count, published_date, tickers
      FROM articles
      WHERE (title ILIKE ? OR content ILIKE ?)
    `;

    const params = [`%${searchTerm}%`, `%${searchTerm}%`];

    if (categoryFilter) {
      sql += ' AND category = ?';
      params.push(categoryFilter);
    }

    sql += ' ORDER BY saved_at DESC LIMIT 100';

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Search articles by ticker symbol
   * @param {string} ticker - Stock ticker symbol (e.g., 'AAPL', 'TSLA')
   * @param {Object} options - Search options
   * @param {string} options.categoryFilter - Filter by category
   * @param {string} options.startDate - Start date for published_date filter (ISO string)
   * @param {string} options.endDate - End date for published_date filter (ISO string)
   * @param {number} options.limit - Maximum number of results (default: 100)
   * @returns {Promise<Array>} Array of articles containing the ticker
   */
  async searchByTicker(ticker, options = {}) {
    const {
      categoryFilter = null,
      startDate = null,
      endDate = null,
      limit = 100
    } = options;

    let sql = `
      SELECT id, url, title, category, domain, saved_at, word_count, published_date, tickers
      FROM articles
      WHERE (list_contains(tickers, ?) OR list_contains(tickers, '*'))
    `;

    const params = [ticker];

    if (categoryFilter) {
      sql += ' AND category = ?';
      params.push(categoryFilter);
    }

    if (startDate) {
      sql += ' AND published_date >= ?';
      params.push(startDate);
    }

    if (endDate) {
      sql += ' AND published_date <= ?';
      params.push(endDate);
    }

    sql += ' ORDER BY published_date DESC NULLS LAST LIMIT ?';
    params.push(limit);

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Get all unique tickers in the database with article counts
   * @returns {Promise<Array>} Array of {ticker, count} objects
   */
  async getAllTickers() {
    const sql = `
      SELECT UNNEST(tickers) as ticker, COUNT(*) as count
      FROM articles
      WHERE tickers IS NOT NULL AND array_length(tickers) > 0
      GROUP BY ticker
      ORDER BY count DESC
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Get statistics about saved articles
   */
  async getStats() {
    const queries = {
      total: 'SELECT COUNT(*) as count FROM articles',
      good: "SELECT COUNT(*) as count FROM articles WHERE category = 'good'",
      not_good: "SELECT COUNT(*) as count FROM articles WHERE category = 'not_good'",
      top_domains: `
        SELECT domain, COUNT(*) as count
        FROM articles
        GROUP BY domain
        ORDER BY count DESC
        LIMIT 5
      `
    };

    const stats = {};

    // Get total count
    const total = await new Promise((resolve, reject) => {
      this.connection.all(queries.total, (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0]?.count || 0);
      });
    });
    stats.total = total;

    // Get good count
    const good = await new Promise((resolve, reject) => {
      this.connection.all(queries.good, (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0]?.count || 0);
      });
    });
    stats.good = good;

    // Get not_good count
    const not_good = await new Promise((resolve, reject) => {
      this.connection.all(queries.not_good, (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0]?.count || 0);
      });
    });
    stats.not_good = not_good;

    // Get top domains
    const top_domains = await new Promise((resolve, reject) => {
      this.connection.all(queries.top_domains, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
    stats.top_domains = top_domains;

    return stats;
  }

  /**
   * Get detailed statistics for enhanced dashboard
   * @returns {Promise<Object>} Comprehensive statistics object
   */
  async getDetailedStats() {
    // Total articles
    const total = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM articles', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    // Word count statistics
    const wordStats = await new Promise((resolve, reject) => {
      this.connection.all(
        'SELECT AVG(word_count) as avg, MIN(word_count) as min, MAX(word_count) as max FROM articles',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0] || { avg: 0, min: 0, max: 0 });
        }
      );
    });

    // Unique domains count
    const uniqueDomains = await new Promise((resolve, reject) => {
      this.connection.all(
        'SELECT COUNT(DISTINCT domain) as count FROM articles',
        (err, rows) => {
          if (err) reject(err);
          else resolve(Number(rows[0]?.count || 0));
        }
      );
    });

    // Date range (first and last saved)
    const dateRange = await new Promise((resolve, reject) => {
      this.connection.all(
        'SELECT MIN(saved_at) as first, MAX(saved_at) as last FROM articles',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0] || { first: null, last: null });
        }
      );
    });

    // Top 5 domains
    const topDomains = await new Promise((resolve, reject) => {
      this.connection.all(
        `SELECT domain, COUNT(*) as count
         FROM articles
         GROUP BY domain
         ORDER BY count DESC
         LIMIT 5`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Get embedding stats
    const embeddingStats = await this.getEmbeddingStats();

    // Get database file size
    const fs = require('fs');
    const path = require('path');
    let dbSize = 0;
    try {
      const stats = fs.statSync(this.dbPath);
      dbSize = stats.size;
    } catch (err) {
      console.error('Error getting database size:', err);
    }

    return {
      total,
      avgWordCount: Math.round(wordStats.avg || 0),
      minWordCount: wordStats.min || 0,
      maxWordCount: wordStats.max || 0,
      uniqueDomains,
      firstSaved: dateRange.first,
      lastSaved: dateRange.last,
      topDomains,
      embeddingCoverage: embeddingStats.embeddingCoverage,
      articlesWithEmbeddings: embeddingStats.articlesWithEmbeddings,
      articlesWithoutEmbeddings: embeddingStats.articlesWithoutEmbeddings,
      dbSizeBytes: dbSize,
      dbSizeMB: (dbSize / (1024 * 1024)).toFixed(2)
    };
  }

  /**
   * Delete an article by ID
   */
  async deleteArticle(articleId) {
    const sql = 'DELETE FROM articles WHERE id = ?';

    return new Promise((resolve, reject) => {
      this.connection.run(sql, [articleId], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Execute raw SQL query
   * @param {string} sqlQuery - SQL query to execute
   * @returns {Promise<Object>} Query results with metadata
   */
  async executeRawSQL(sqlQuery) {
    // Check connection
    if (!this.connection || !this.db) {
      throw new Error('Database connection is not available');
    }

    // Trim and validate query
    const query = sqlQuery.trim();
    if (!query) {
      throw new Error('Empty query');
    }

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      this.connection.all(query, (err, rows) => {
        const executionTime = Date.now() - startTime;

        if (err) {
          reject({
            error: err.message,
            executionTime
          });
          return;
        }

        // Determine query type
        const queryType = query.toUpperCase().trim().split(/\s+/)[0];
        const isSelectQuery = queryType === 'SELECT' ||
                             queryType === 'SHOW' ||
                             queryType === 'DESCRIBE' ||
                             queryType === 'EXPLAIN';

        if (isSelectQuery) {
          // Return rows with column metadata
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          resolve({
            type: 'select',
            rows: rows,
            columns: columns,
            rowCount: rows.length,
            executionTime
          });
        } else {
          // For INSERT/UPDATE/DELETE/etc.
          resolve({
            type: 'mutation',
            success: true,
            message: `Query executed successfully`,
            executionTime
          });
        }
      });
    });
  }

  /**
   * Search articles by semantic similarity using embeddings
   *
   * @param {string} queryText - Query text to search for
   * @param {Object} options - Search options
   * @param {string} options.categoryFilter - Filter by category ('good', 'not_good', or null for all)
   * @param {number} options.limit - Maximum number of results (default: 10)
   * @param {number} options.minSimilarity - Minimum similarity threshold 0-1 (default: 0.5)
   * @returns {Promise<Array>} Array of articles with similarity scores
   */
  async searchBySimilarity(queryText, options = {}) {
    const {
      categoryFilter = null,
      limit = 10,
      minSimilarity = 0.5
    } = options;

    // Check connection before starting
    if (!this.connection || !this.db) {
      throw new Error('Database connection is not available');
    }

    const embeddingService = require('./embeddings');

    // Generate embedding for query using 'search_query' task
    console.log(`\n🔍 Searching for: "${queryText.substring(0, 100)}..."`);
    const queryEmbedding = await embeddingService.embed(queryText, {
      task: 'search_query'
    });

    // Get all articles with embeddings
    let sql = `
      SELECT id, url, title, content, category, domain, saved_at, word_count, embedding
      FROM articles
      WHERE embedding IS NOT NULL
    `;

    const params = [];
    if (categoryFilter) {
      sql += ` AND category = ?`;
      params.push(categoryFilter);
    }

    const articles = await new Promise((resolve, reject) => {
      // Check connection again right before query
      if (!this.connection) {
        reject(new Error('Database connection lost'));
        return;
      }

      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (articles.length === 0) {
      console.log('⚠️  No articles with embeddings found in database.');
      return [];
    }

    console.log(`   Comparing against ${articles.length} articles...`);

    // Calculate similarity for each article (skip mismatched dimensions)
    const results = articles
      .filter(article => {
        // Skip articles with different embedding dimensions
        if (article.embedding.length !== queryEmbedding.length) {
          return false;
        }
        return true;
      })
      .map(article => {
        const similarity = embeddingService.cosineSimilarity(queryEmbedding, article.embedding);
        return {
          id: article.id,
          article_id: article.id,
          url: article.url,
          article_url: article.url,
          title: article.title,
          article_title: article.title,
          category: article.category,
          domain: article.domain,
          word_count: article.word_count,
          similarity: similarity
        };
      });

    // Filter by minimum similarity and sort by similarity descending
    const filteredResults = results
      .filter(r => r.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    console.log(`✓ Found ${filteredResults.length} results above ${minSimilarity} similarity\n`);

    return filteredResults;
  }

  /**
   * Get statistics about embeddings
   *
   * @returns {Promise<Object>} Embedding statistics
   */
  async getEmbeddingStats() {
    const totalArticles = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM articles', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const articlesWithEmbeddings = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM articles WHERE embedding IS NOT NULL', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    return {
      totalArticles,
      articlesWithEmbeddings,
      articlesWithoutEmbeddings: totalArticles - articlesWithEmbeddings,
      embeddingCoverage: totalArticles > 0 ? ((articlesWithEmbeddings / totalArticles) * 100).toFixed(1) : '0.0'
    };
  }

  /**
   * Clear all embeddings (vectors only, keep articles)
   */
  async clearVectors() {
    console.log('\n🗑️  Clearing all embeddings...');

    return new Promise((resolve, reject) => {
      this.connection.run(
        'UPDATE articles SET embedding = NULL',
        (err) => {
          if (err) {
            console.error('❌ Error clearing vectors:', err);
            reject(err);
          } else {
            console.log('✓ All embeddings cleared\n');
            resolve();
          }
        }
      );
    });
  }

  /**
   * Clear comparison data only (good/not_good categories)
   * Does NOT delete scraped news articles
   */
  async clearAllData() {
    console.log('\n🗑️  Clearing comparison data (good/not_good articles)...');

    // Ensure connection is active
    this.ensureConnection();

    try {
      // Get IDs of comparison articles first
      const comparisonArticleIds = await new Promise((resolve, reject) => {
        this.connection.all(
          "SELECT id FROM articles WHERE category IN ('good', 'not_good')",
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows.map(r => r.id));
          }
        );
      });

      if (comparisonArticleIds.length === 0) {
        console.log('  No comparison articles to delete');
        return;
      }

      console.log(`  Found ${comparisonArticleIds.length} comparison articles to delete`);

      // Delete chunks for these articles (if any exist)
      if (comparisonArticleIds.length > 0) {
        await new Promise((resolve, reject) => {
          const placeholders = comparisonArticleIds.map(() => '?').join(',');
          const sql = `DELETE FROM article_chunks WHERE article_id IN (${placeholders})`;

          this.connection.run(sql, comparisonArticleIds, (err) => {
            if (err) {
              console.error('❌ Error clearing chunks:', err);
              return reject(err);
            }
            console.log('  ✓ Comparison chunks deleted');
            resolve();
          });
        });
      }

      // Delete comparison articles only
      await new Promise((resolve, reject) => {
        this.connection.run(
          "DELETE FROM articles WHERE category IN ('good', 'not_good')",
          (err) => {
            if (err) {
              console.error('❌ Error clearing comparison articles:', err);
              return reject(err);
            }
            console.log('  ✓ Comparison articles deleted');
            resolve();
          }
        );
      });

      console.log('✓ Comparison data cleared (scraped news preserved)\n');
    } catch (err) {
      console.error('❌ Error clearing data:', err);
      throw err;
    }
  }

  // ===== News Volume Tracking Methods =====

  /**
   * Save news count for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {number} articleCount - Number of articles found
   * @param {string} source - Source of the count (e.g., 'yahoo_finance')
   * @param {string} pageUrl - URL of the page where count was taken
   * @returns {Promise<Object>} Saved record with id
   */
  async saveNewsCount(ticker, articleCount, source, pageUrl) {
    const sql = `
      INSERT INTO news_volume (ticker, article_count, source, page_url)
      VALUES ($1, $2, $3, $4)
      RETURNING id, recorded_at
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ticker.toUpperCase(), articleCount, source, pageUrl, (err, result) => {
        if (err) {
          reject(err);
          return;
        }

        resolve({
          id: result[0]?.id,
          ticker: ticker.toUpperCase(),
          articleCount: articleCount,
          recordedAt: result[0]?.recorded_at,
          source: source
        });
      });
    });
  }

  /**
   * Get news count history for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {number} days - Number of days to look back (default: 30)
   * @returns {Promise<Array>} Array of news count records
   */
  async getNewsCountHistory(ticker, days = 30) {
    const sql = `
      SELECT id, ticker, recorded_at, article_count, source, page_url
      FROM news_volume
      WHERE ticker = $1
        AND recorded_at >= datetime('now', '-${days} days')
      ORDER BY recorded_at DESC
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ticker.toUpperCase(), (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  /**
   * Get all news count stats (for dashboard/overview)
   * @returns {Promise<Object>} Statistics about news volume tracking
   */
  async getAllNewsCountStats() {
    const totalRecords = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM news_volume', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const uniqueTickers = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(DISTINCT ticker) as count FROM news_volume', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const recentCounts = await new Promise((resolve, reject) => {
      this.connection.all(
        `SELECT ticker, recorded_at, article_count, source
         FROM news_volume
         ORDER BY recorded_at DESC
         LIMIT 10`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    return {
      totalRecords,
      uniqueTickers,
      recentCounts
    };
  }

  /**
   * Get comprehensive stock statistics for settings page
   * @returns {Promise<Object>} Stock news statistics
   */
  async getStockStats() {
    // Get basic article counts
    const total = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM articles', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const stockNews = await new Promise((resolve, reject) => {
      this.connection.all("SELECT COUNT(*) as count FROM articles WHERE category = 'stock_news'", (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const notGood = await new Promise((resolve, reject) => {
      this.connection.all("SELECT COUNT(*) as count FROM articles WHERE category = 'not_good'", (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    // Get ticker statistics
    const uniqueTickers = await new Promise((resolve, reject) => {
      this.connection.all(`
        SELECT COUNT(DISTINCT UNNEST(tickers)) as count
        FROM articles
        WHERE tickers IS NOT NULL AND array_length(tickers) > 0
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const articlesWithTickers = await new Promise((resolve, reject) => {
      this.connection.all(`
        SELECT COUNT(*) as count
        FROM articles
        WHERE tickers IS NOT NULL AND array_length(tickers) > 0
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const articlesWithDates = await new Promise((resolve, reject) => {
      this.connection.all(`
        SELECT COUNT(*) as count
        FROM articles
        WHERE published_date IS NOT NULL
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    // Get top tickers
    const topTickers = await new Promise((resolve, reject) => {
      this.connection.all(`
        SELECT UNNEST(tickers) as ticker, COUNT(*) as count
        FROM articles
        WHERE tickers IS NOT NULL AND array_length(tickers) > 0
        GROUP BY ticker
        ORDER BY count DESC
        LIMIT 10
      `, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });

    // Get news volume records count
    const newsVolumeRecords = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM news_volume', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    // Get database size
    const dbSizeMB = await this.getDatabaseSize();

    return {
      total,
      stockNews,
      notGood,
      uniqueTickers,
      articlesWithTickers,
      articlesWithDates,
      topTickers,
      newsVolumeRecords,
      dbSizeMB
    };
  }

  /**
   * Get recent news volume records
   * @param {number} limit - Number of records to return (default: 20)
   * @returns {Promise<Array>} Recent news volume records
   */
  async getRecentNewsVolume(limit = 20) {
    const sql = `
      SELECT ticker, recorded_at, article_count, source, page_url
      FROM news_volume
      ORDER BY recorded_at DESC
      LIMIT $1
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, limit, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Clear all news volume records
   * @returns {Promise<void>}
   */
  async clearNewsVolume() {
    const sql = 'DELETE FROM news_volume';

    return new Promise((resolve, reject) => {
      this.connection.run(sql, (err) => {
        if (err) reject(err);
        else {
          console.log('✓ News volume data cleared');
          resolve();
        }
      });
    });
  }

  /**
   * Get database file size in MB
   * @returns {Promise<number>} Database size in MB
   */
  async getDatabaseSize() {
    const fs = require('fs');
    try {
      const stats = fs.statSync(this.dbPath);
      return (stats.size / (1024 * 1024)).toFixed(2);
    } catch (err) {
      console.error('Error getting database size:', err);
      return 0;
    }
  }

  // ===== Stock Price Tracking Methods =====

  /**
   * Save stock price data to database
   * @param {string} ticker - Stock ticker symbol
   * @param {string} date - Date in YYYY-MM-DD format
   * @param {Object} priceData - Price data object {open, high, low, close, volume}
   * @param {string} source - Data source (e.g., 'yahoo_finance')
   * @returns {Promise<Object>} Saved record
   */
  async saveStockPrice(ticker, date, priceData, source = 'yahoo_finance') {
    const sql = `
      INSERT INTO stock_prices (ticker, date, open, high, low, close, volume, source)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (ticker, date, source) DO UPDATE SET
        open = $3,
        high = $4,
        low = $5,
        close = $6,
        volume = $7,
        fetched_at = CURRENT_TIMESTAMP
      RETURNING id
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(
        sql,
        ticker.toUpperCase(),
        date,
        priceData.open,
        priceData.high,
        priceData.low,
        priceData.close,
        priceData.volume,
        source,
        (err, result) => {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            id: result[0]?.id,
            ticker: ticker.toUpperCase(),
            date,
            ...priceData
          });
        }
      );
    });
  }

  /**
   * Get price history for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Query options
   * @param {string} options.startDate - Start date (YYYY-MM-DD)
   * @param {string} options.endDate - End date (YYYY-MM-DD)
   * @param {number} options.limit - Max number of records
   * @param {string} options.source - Data source filter
   * @returns {Promise<Array>} Array of price records
   */
  async getPriceHistory(ticker, options = {}) {
    const {
      startDate = null,
      endDate = null,
      limit = 365,
      source = 'yahoo_finance'
    } = options;

    let sql = `
      SELECT ticker, date, open, high, low, close, volume, source, fetched_at
      FROM stock_prices
      WHERE ticker = $1 AND source = $2
    `;

    const params = [ticker.toUpperCase(), source];

    if (startDate) {
      sql += ` AND date >= $${params.length + 1}`;
      params.push(startDate);
    }

    if (endDate) {
      sql += ` AND date <= $${params.length + 1}`;
      params.push(endDate);
    }

    sql += ` ORDER BY date DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get latest price for a ticker
   * @param {string} ticker - Stock ticker symbol
   * @param {string} source - Data source
   * @returns {Promise<Object|null>} Latest price record or null
   */
  async getLatestPrice(ticker, source = 'yahoo_finance') {
    const sql = `
      SELECT ticker, date, open, high, low, close, volume, source, fetched_at
      FROM stock_prices
      WHERE ticker = $1 AND source = $2
      ORDER BY date DESC
      LIMIT 1
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ticker.toUpperCase(), source, (err, rows) => {
        if (err) reject(err);
        else resolve(rows.length > 0 ? rows[0] : null);
      });
    });
  }

  /**
   * Add a ticker to watchlist
   * @param {string} ticker - Stock ticker symbol
   * @param {boolean} autoUpdate - Enable automatic updates
   * @returns {Promise<Object>} Added ticker record
   */
  async addWatchedTicker(ticker, autoUpdate = true) {
    const sql = `
      INSERT INTO watched_tickers (ticker, auto_update)
      VALUES ($1, $2)
      ON CONFLICT (ticker) DO UPDATE SET auto_update = $2
      RETURNING id, ticker, added_at, auto_update
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ticker.toUpperCase(), autoUpdate, (err, result) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(result[0]);
      });
    });
  }

  /**
   * Remove a ticker from watchlist
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<void>}
   */
  async removeWatchedTicker(ticker) {
    const sql = 'DELETE FROM watched_tickers WHERE ticker = $1';

    return new Promise((resolve, reject) => {
      this.connection.run(sql, ticker.toUpperCase(), (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Get all watched tickers
   * @param {boolean} autoUpdateOnly - Only return tickers with auto_update enabled
   * @returns {Promise<Array>} Array of watched ticker records
   */
  async getWatchedTickers(autoUpdateOnly = false) {
    let sql = 'SELECT id, ticker, added_at, auto_update FROM watched_tickers';

    if (autoUpdateOnly) {
      sql += ' WHERE auto_update = true';
    }

    sql += ' ORDER BY ticker ASC';

    return new Promise((resolve, reject) => {
      this.connection.all(sql, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Check if ticker is being watched
   * @param {string} ticker - Stock ticker symbol
   * @returns {Promise<boolean>} True if watched
   */
  async isTickerWatched(ticker) {
    const sql = 'SELECT COUNT(*) as count FROM watched_tickers WHERE ticker = $1';

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ticker.toUpperCase(), (err, rows) => {
        if (err) reject(err);
        else resolve(rows[0]?.count > 0);
      });
    });
  }

  /**
   * Get stock price statistics
   * @returns {Promise<Object>} Price data statistics
   */
  async getPriceStats() {
    const totalPrices = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM stock_prices', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const uniqueTickers = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(DISTINCT ticker) as count FROM stock_prices', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    const dateRange = await new Promise((resolve, reject) => {
      this.connection.all(
        'SELECT MIN(date) as earliest, MAX(date) as latest FROM stock_prices',
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0] || { earliest: null, latest: null });
        }
      );
    });

    const watchedCount = await new Promise((resolve, reject) => {
      this.connection.all('SELECT COUNT(*) as count FROM watched_tickers', (err, rows) => {
        if (err) reject(err);
        else resolve(Number(rows[0]?.count || 0));
      });
    });

    return {
      totalPrices,
      uniqueTickers,
      earliestDate: dateRange.earliest,
      latestDate: dateRange.latest,
      watchedCount
    };
  }

  // ===== News Harvesting Support Methods =====

  /**
   * Get articles with embeddings for a ticker (for uniqueness calculation)
   * @param {string} ticker - Stock ticker symbol
   * @param {Object} options - Query options
   * @param {string} options.excludeArticleId - Article ID to exclude from results
   * @param {number} options.limit - Max articles to return (default: 100)
   * @returns {Promise<Array>} Articles with embeddings
   */
  async getArticlesWithEmbeddingsByTicker(ticker, options = {}) {
    const { excludeArticleId = null, limit = 100 } = options;

    let sql = `
      SELECT id, url, title, published_date, embedding
      FROM articles
      WHERE embedding IS NOT NULL
        AND (list_contains(tickers, ?) OR list_contains(tickers, '*'))
    `;

    const params = [ticker.toUpperCase()];

    if (excludeArticleId) {
      sql += ' AND id != ?';
      params.push(excludeArticleId);
    }

    sql += ' ORDER BY published_date DESC NULLS LAST LIMIT ?';
    params.push(limit);

    return new Promise((resolve, reject) => {
      this.connection.all(sql, ...params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  /**
   * Get articles by ticker within a date range (with embeddings for similarity)
   * @param {string} ticker - Stock ticker symbol
   * @param {Date} centerDate - Center date for range
   * @param {number} dayRange - Days before/after center date
   * @returns {Promise<Array>} Articles within date range
   */
  async getArticlesByTickerAndDateRange(ticker, centerDate, dayRange = 3) {
    const startDate = new Date(centerDate);
    startDate.setDate(startDate.getDate() - dayRange);
    const endDate = new Date(centerDate);
    endDate.setDate(endDate.getDate() + dayRange);

    const sql = `
      SELECT id, url, title, content, published_date, embedding, tickers
      FROM articles
      WHERE (list_contains(tickers, ?) OR list_contains(tickers, '*'))
        AND published_date >= ?
        AND published_date <= ?
      ORDER BY published_date DESC
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(
        sql,
        ticker.toUpperCase(),
        startDate.toISOString(),
        endDate.toISOString(),
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Get all articles by category
   * @param {string} category - Category to filter by ('not_good', 'stock_news', etc.)
   * @returns {Promise<Array>} Articles in that category
   */
  async getArticlesByCategory(category) {
    return new Promise((resolve, reject) => {
      this.connection.all(
        'SELECT id, title, content FROM articles WHERE category = ?',
        category,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  /**
   * Update article content and regenerate embedding
   * Used for boilerplate cleaning
   * @param {number} articleId - Article ID to update
   * @param {string} newContent - New cleaned content
   * @param {string} title - Article title for embedding context
   */
  async updateArticleContent(articleId, newContent, title = null) {
    const embeddingService = require('./embeddings');

    // Generate new embedding for cleaned content
    const embedding = await embeddingService.embed(newContent, {
      task: 'search_document',
      title: title
    });

    // Convert embedding array to DuckDB array format (same as saveArticle)
    const embeddingValue = embedding ? `[${embedding.join(',')}]` : null;

    // Update article
    return new Promise((resolve, reject) => {
      this.connection.run(
        'UPDATE articles SET content = ?, embedding = ?::FLOAT[], word_count = ? WHERE id = ?',
        newContent,
        embeddingValue,
        newContent.split(/\s+/).length,
        articleId,
        (err) => {
          if (err) reject(err);
          else resolve({ success: true, embeddingRegenerated: true });
        }
      );
    });
  }

  /**
   * Get corpus statistics for the news harvesting feature
   * @returns {Promise<Object>} Corpus statistics
   */
  async getCorpusStats() {
    const totalStockNews = await new Promise((resolve, reject) => {
      this.connection.all(
        "SELECT COUNT(*) as count FROM articles WHERE category = 'stock_news'",
        (err, rows) => {
          if (err) reject(err);
          else resolve(Number(rows[0]?.count || 0));
        }
      );
    });

    const withEmbeddings = await new Promise((resolve, reject) => {
      this.connection.all(
        "SELECT COUNT(*) as count FROM articles WHERE category = 'stock_news' AND embedding IS NOT NULL",
        (err, rows) => {
          if (err) reject(err);
          else resolve(Number(rows[0]?.count || 0));
        }
      );
    });

    const dateRange = await new Promise((resolve, reject) => {
      this.connection.all(
        `SELECT MIN(published_date) as earliest, MAX(published_date) as latest
         FROM articles
         WHERE category = 'stock_news' AND published_date IS NOT NULL`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows[0] || { earliest: null, latest: null });
        }
      );
    });

    const tickerCounts = await new Promise((resolve, reject) => {
      this.connection.all(
        `SELECT ticker, COUNT(*) as count
         FROM (
           SELECT UNNEST(tickers) as ticker
           FROM articles
           WHERE category = 'stock_news' AND tickers IS NOT NULL AND array_length(tickers) > 0
         )
         GROUP BY ticker
         ORDER BY count DESC
         LIMIT 20`,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });

    // Calculate date span in days
    let dateSpanDays = 0;
    if (dateRange.earliest && dateRange.latest) {
      const earliest = new Date(dateRange.earliest);
      const latest = new Date(dateRange.latest);
      dateSpanDays = Math.ceil((latest - earliest) / (1000 * 60 * 60 * 24));
    }

    return {
      totalStockNews,
      withEmbeddings,
      earliestArticle: dateRange.earliest,
      latestArticle: dateRange.latest,
      dateSpanDays,
      tickerCounts,
      isReadyForAnalysis: totalStockNews >= 50 && dateSpanDays >= 7
    };
  }

  /**
   * Close database connection
   */
  async close() {
    return new Promise((resolve) => {
      if (this.connection) {
        this.connection.close(() => {
          if (this.db) {
            this.db.close(() => {
              resolve();
            });
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = ArticleDatabase;
