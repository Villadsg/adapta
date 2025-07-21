#!/bin/bash

# Start Ollama-based Semantic Interest Tracking System
echo "🚀 Starting Ollama Semantic Interest Tracking System..."

# Check if Node modules are installed
if [ ! -d "node_modules" ]; then
    echo "📦 Installing Node.js dependencies..."
    npm install
fi

echo ""
echo "📋 Prerequisites Check:"
echo "   1. Ollama should be running: ollama serve"
echo "   2. Required models should be available:"
echo "      - Chat: ollama pull deepseek-r1:14b" 
echo "      - Embeddings: ollama pull dengcao/Qwen3-Embedding-8B:Q5_K_M"
echo ""

# Check if Ollama is running
if ! curl -s http://localhost:11434/api/tags >/dev/null 2>&1; then
    echo "⚠️  WARNING: Ollama doesn't seem to be running on localhost:11434"
    echo "   Please start Ollama first: ollama serve"
    echo ""
fi

# Start the SvelteKit development server
echo "🌐 Starting SvelteKit app with integrated embeddings..."
echo "   - App URL: http://localhost:5173"
echo "   - Embeddings: Ollama dengcao/Qwen3-Embedding-8B:Q5_K_M"
echo "   - Chat Model: deepseek-r1:14b"
echo ""

npm run dev

echo ""
echo "📖 Usage:"
echo "   1. Open http://localhost:5173 in your browser"
echo "   2. Chat with DeepSeek R1 - interests are tracked automatically"
echo "   3. Use ⚙️ Config button to adjust semantic weights"
echo "   4. Click 'Interest Summary' to see your semantic interests"
echo ""
echo "📁 Data files created:"
echo "   - user_embeddings.json (semantic embeddings storage)"
echo "   - interest_config.json (configuration)"