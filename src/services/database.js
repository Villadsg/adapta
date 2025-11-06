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
        embedding FLOAT[]
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
  }

  /**
   * Create indexes for better query performance
   */
  async createIndexes() {
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_category ON articles(category)',
      'CREATE INDEX IF NOT EXISTS idx_domain ON articles(domain)',
      'CREATE INDEX IF NOT EXISTS idx_saved_at ON articles(saved_at)',
      'CREATE INDEX IF NOT EXISTS idx_chunks_article_id ON article_chunks(article_id)',
      'CREATE INDEX IF NOT EXISTS idx_chunks_category ON article_chunks(category)'
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

      console.log('✓ Database migrations completed');
    } catch (error) {
      console.error('Error running migrations:', error);
      throw error;
    }
  }

  /**
   * Ensure database connection is active and reconnect if necessary
   */
  ensureConnection() {
    if (!this.connection && this.db) {
      console.log('⚠️  Reconnecting to database...');
      this.connection = this.db.connect();
    }
    if (!this.connection) {
      throw new Error('Database connection is not available');
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
   * Get all chunking settings (DEPRECATED - chunking removed)
   *
   * @deprecated Chunking has been removed. This method is kept for backward compatibility.
   * @returns {Promise<Object>} Chunking settings object
   */
  async getChunkingSettings() {
    // Return dummy values for backward compatibility
    return {
      chunkSize: 512,
      chunkOverlap: 50,
      chunkStrategy: 'paragraph'
    };
  }

  /**
   * Save an article to the database with embedding
   */
  async saveArticle(url, title, content, category, options = {}) {
    const { generateEmbedding = true } = options;

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

    const sql = `
      INSERT INTO articles (url, title, content, category, domain, word_count, embedding)
      VALUES ($1, $2, $3, $4, $5, $6, $7::FLOAT[])
      RETURNING id
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, url, title, content, category, domain, wordCount, embeddingValue, (err, result) => {
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
          wordCount
        });
      });
    });
  }

  /**
   * Get all articles, optionally filtered by category
   */
  async getAllArticles(categoryFilter = null, limit = 100) {
    let sql = `
      SELECT id, url, title, category, domain, saved_at, word_count
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
      this.connection.all(sql, params, (err, rows) => {
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
      SELECT id, url, title, content, category, domain, saved_at, word_count, embedding
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
      SELECT id, url, title, category, domain, saved_at, word_count
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
      this.connection.all(sql, params, (err, rows) => {
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

  // ===== Chunk-related methods (DEPRECATED - kept for backward compatibility) =====

  /**
   * Save text chunks for an article with embeddings (DEPRECATED)
   *
   * @deprecated Chunking has been removed. Articles now store full-text embeddings.
   * @param {number} articleId - Article ID
   * @param {string[]} chunks - Array of chunk texts
   * @param {string} category - Article category
   * @param {Object} options - Save options
   * @param {boolean} options.generateEmbeddings - Generate embeddings (default: true)
   * @param {string} options.title - Article title for embedding context
   * @returns {Promise<void>}
   */
  async saveChunks(articleId, chunks, category, options = {}) {
    const { generateEmbeddings = true, title } = options;

    // Generate embeddings if enabled
    let embeddings = [];
    if (generateEmbeddings) {
      const embeddingService = require('./embeddings');
      console.log(`  Generating embeddings for ${chunks.length} chunks...`);

      // Get article title if not provided
      const articleTitle = title || (await this.getArticleById(articleId))?.title || '';

      // Generate embeddings for all chunks
      embeddings = [];
      for (const chunk of chunks) {
        const embedding = await embeddingService.embed(chunk, {
          task: 'search_document',
          title: articleTitle,
        });
        embeddings.push(embedding);
      }

      if (chunks.length > 20) {
        console.log(`✓ Generated ${chunks.length} embeddings`);
      }
    }

    const sql = `
      INSERT INTO article_chunks (article_id, chunk_text, chunk_index, category, embedding)
      VALUES ($1, $2, $3, $4, $5::FLOAT[])
    `;

    for (let i = 0; i < chunks.length; i++) {
      // Convert embedding array to DuckDB array format
      const embedding = embeddings.length > 0 ? embeddings[i] : null;
      const embeddingValue = embedding ? `[${embedding.join(',')}]` : null;

      await new Promise((resolve, reject) => {
        this.connection.run(sql, articleId, chunks[i], i, category, embeddingValue, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    console.log(`  ✓ Saved ${chunks.length} chunks for article ${articleId}`);
  }

  /**
   * Delete all chunks from the database
   *
   * @returns {Promise<void>}
   */
  async deleteAllChunks() {
    const sql = 'DELETE FROM article_chunks';

    return new Promise((resolve, reject) => {
      this.connection.run(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Re-chunk all articles with new parameters
   *
   * @param {number} chunkSize - Target chunk size in tokens
   * @param {number} overlap - Overlap between chunks in tokens
   * @param {string} strategy - Chunking strategy ('sentence' or 'paragraph')
   * @returns {Promise<void>}
   */
  async rechunkAllArticles(chunkSize = 512, overlap = 50, strategy = 'paragraph') {
    const { chunkText, chunkTextByParagraph } = require('./chunking');

    console.log(`\nRe-chunking all articles with chunkSize=${chunkSize}, overlap=${overlap}, strategy=${strategy}...`);

    // Choose chunking function based on strategy
    const chunkFunction = strategy === 'paragraph' ? chunkTextByParagraph : chunkText;

    // Get all articles
    const articles = await new Promise((resolve, reject) => {
      this.connection.all('SELECT id, title, content, category FROM articles', (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });

    if (articles.length === 0) {
      console.log('No articles to re-chunk.');
      return;
    }

    console.log(`Found ${articles.length} articles to re-chunk.`);

    // Delete all existing chunks
    await this.deleteAllChunks();
    console.log('✓ Deleted all existing chunks.');

    // Re-chunk each article
    let processedCount = 0;
    for (const article of articles) {
      const chunks = chunkFunction(article.content, article.title, chunkSize, overlap);
      if (chunks.length > 0) {
        await this.saveChunks(article.id, chunks, article.category, { title: article.title });
      }
      processedCount++;
      if (processedCount % 10 === 0) {
        console.log(`  Progress: ${processedCount}/${articles.length} articles`);
      }
    }

    console.log(`✓ Re-chunking complete! Processed ${articles.length} articles.\n`);
  }

  /**
   * Get chunks for a specific article
   *
   * @param {number} articleId - Article ID
   * @returns {Promise<Array>} Array of chunks
   */
  async getChunksByArticle(articleId) {
    const sql = `
      SELECT chunk_id, article_id, chunk_text, chunk_index, embedding, category
      FROM article_chunks
      WHERE article_id = $1
      ORDER BY chunk_index
    `;

    return new Promise((resolve, reject) => {
      this.connection.all(sql, articleId, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
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

    // Ensure connection is active
    this.ensureConnection();

    const embeddingService = require('./embeddings');

    // Generate embedding for query using 'search_query' task
    console.log(`\n🔍 Searching for: "${queryText.substring(0, 100)}..."`);
    const queryEmbedding = await embeddingService.embed(queryText, {
      task: 'search_query'
    });

    // Ensure connection is still active after async operation
    this.ensureConnection();

    // Get all articles with embeddings
    let sql = `
      SELECT id, url, title, content, category, domain, saved_at, word_count, embedding
      FROM articles
      WHERE embedding IS NOT NULL
    `;

    if (categoryFilter) {
      sql += ` AND category = '${categoryFilter}'`;
    }

    const articles = await new Promise((resolve, reject) => {
      this.connection.all(sql, (err, rows) => {
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
   * Clear all data (articles, chunks, embeddings)
   */
  async clearAllData() {
    console.log('\n🗑️  Clearing ALL database data...');

    try {
      // Delete all chunks first
      await new Promise((resolve, reject) => {
        this.connection.run('DELETE FROM article_chunks', (err) => {
          if (err) {
            console.error('❌ Error clearing chunks:', err);
            return reject(err);
          }
          console.log('  ✓ Chunks deleted');
          resolve();
        });
      });

      // Delete all articles
      await new Promise((resolve, reject) => {
        this.connection.run('DELETE FROM articles', (err) => {
          if (err) {
            console.error('❌ Error clearing articles:', err);
            return reject(err);
          }
          console.log('  ✓ Articles deleted');
          resolve();
        });
      });

      console.log('✓ All data cleared from database\n');
    } catch (err) {
      console.error('❌ Error clearing data:', err);
      throw err;
    }
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
