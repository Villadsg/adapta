# 📰 Interest-Based News Search

This feature uses your conversation history embeddings to find the top 3 news articles that have the highest probability of matching your interests.

## How It Works

1. **Interest Analysis**: Extracts your top 5 interests from stored embeddings
2. **Search Query Generation**: Creates search terms from your interest keywords
3. **News Retrieval**: Fetches recent articles using NewsAPI
4. **Relevance Scoring**: Uses cosine similarity between article embeddings and your interest embeddings
5. **Ranking**: Returns the top 3 articles with highest relevance scores

## Prerequisites

### 1. NewsAPI Key
- Get a free API key from [NewsAPI.org](https://newsapi.org/register)
- Free tier includes 1,000 requests per month

### 2. Ollama Setup
- Install Ollama: [https://ollama.ai/download](https://ollama.ai/download)
- Pull the embedding model: `ollama pull dengcao/Qwen3-Embedding-8B:Q5_K_M`
- Start Ollama: `ollama serve`

### 3. User Interest History
- Have conversations with the system to build your interest profile
- The system stores embeddings from your conversations in `user_embeddings.json`

## Usage

### Option 1: Direct Function Call

```typescript
import { embeddingsStore } from './src/lib/embeddings.js';

const newsApiKey = 'your-newsapi-key-here';
const results = await embeddingsStore.searchPersonalizedNews(newsApiKey);

console.log('Top 3 News Articles:');
results.articles.forEach((article, i) => {
  console.log(`${i + 1}. ${article.title} (Relevance: ${(article.relevanceScore * 100).toFixed(1)}%)`);
});

console.log('\nFormatted Summary:');
console.log(results.summary);
```

### Option 2: API Endpoint

**POST** `/api/news`

**Request Body:**
```json
{
  "newsApiKey": "your-newsapi-key-here",
  "options": {
    "maxArticles": 20,
    "topInterestsCount": 5
  }
}
```

**Response:**
```json
{
  "success": true,
  "results": {
    "articles": [
      {
        "title": "Article Title",
        "snippet": "Article description...",
        "url": "https://example.com/article",
        "source": "Source Name",
        "publishDate": "2025-01-21T12:00:00Z",
        "relevanceScore": 0.785,
        "matchedInterests": ["reinforcement learning", "AI applications"]
      }
    ],
    "searchQuery": "reinforcement learning OR AI applications OR machine learning",
    "userInterests": ["list of your interests"],
    "totalFound": 15
  },
  "formattedResults": "# 📰 Top News Matches..."
}
```

## Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `maxArticles` | 20 | Maximum articles to fetch from NewsAPI |
| `daysBack` | 7 | Search articles from the last N days |
| `topInterestsCount` | 5 | Number of top interests to use for search |

## Error Handling

The system handles various error conditions:

- **Missing API Key**: Returns 400 with instructions to get a NewsAPI key
- **Invalid API Key**: Returns 401 with link to NewsAPI dashboard  
- **Ollama Not Running**: Returns 503 with instructions to start Ollama
- **No User Interests**: Returns empty results with suggestion to have more conversations

## Example Flow

1. **User has conversations about AI, robotics, and machine learning**
2. **System stores embeddings** in `user_embeddings.json`
3. **User calls news search** with their NewsAPI key
4. **System analyzes interests**: "AI", "robotics", "machine learning"
5. **Searches NewsAPI** for: "AI OR robotics OR machine learning"
6. **Calculates relevance** using embedding similarity
7. **Returns top 3 articles** most relevant to user's interests

## File Structure

```
src/
├── lib/
│   ├── embeddings.ts          # Main embeddings store (now includes searchPersonalizedNews)
│   └── newsSearch.ts          # News search implementation
└── routes/
    └── api/
        └── news/
            └── +server.ts     # API endpoint
```

## Sample Output

```markdown
# 📰 Top News Matches for Your Interests

**Search Query:** reinforcement learning OR AI applications OR robotics

**Found:** 15 articles, showing top 3

## 1. Breakthrough in Autonomous Robot Learning
**Source:** TechCrunch | **Relevance:** 87.5%
**Published:** January 21, 2025

Researchers have developed a new reinforcement learning approach that allows robots to learn complex tasks with minimal human supervision...

**Matched Interests:** reinforcement learning, robotics applications

🔗 [Read more](https://example.com/robot-learning)

---

## 2. AI Safety in Machine Learning Systems
**Source:** MIT Technology Review | **Relevance:** 76.2%
**Published:** January 20, 2025

New guidelines for ensuring ethical AI deployment in critical systems...

**Matched Interests:** AI safety, machine learning ethics

🔗 [Read more](https://example.com/ai-safety)

---

## 3. Multi-Agent Systems in Smart Cities
**Source:** IEEE Spectrum | **Relevance:** 71.8%
**Published:** January 19, 2025

How distributed AI systems are optimizing traffic flow and energy consumption...

**Matched Interests:** multi-agent systems, AI applications

🔗 [Read more](https://example.com/smart-cities)

---

💡 *These articles were selected based on your conversation history and interests.*
```

## Tips for Better Results

1. **Have varied conversations** to build a rich interest profile
2. **Use specific technical terms** in your conversations  
3. **Ask follow-up questions** about topics you find interesting
4. **Configure interest weights** in the settings to prioritize certain topics
5. **Regular usage** improves the system's understanding of your preferences

## Troubleshooting

### No articles found
- Check if you have conversation history stored
- Verify your interests are diverse enough for news matching
- Try different NewsAPI keywords manually first

### Low relevance scores
- Have more conversations about specific topics you want news about
- Use more technical/specific language in conversations
- Adjust similarity thresholds in the embeddings configuration

### API errors  
- Verify NewsAPI key is valid and has remaining quota
- Check Ollama is running on localhost:11434
- Ensure the embedding model is downloaded: `ollama list`

## Future Enhancements

- Support for multiple news sources (Reddit, Hacker News, etc.)
- Time-based interest weighting (recent interests weighted higher)
- Category-based filtering (tech, science, business, etc.)
- Sentiment analysis for article matching
- User feedback to improve relevance scoring