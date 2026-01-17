const http = require('http');
const fs = require('fs');
const url = require('url');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");

const hostname = 'localhost';
const port = 3001;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API);
console.log("API Key:", process.env.GEMINI_API?.slice(0, 4) + "...");

// Store conversation history per session (simple in-memory storage)
const conversations = new Map();

async function callGemini(prompt, sessionId = 'default', personality = 'girlfriend') {
  const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
  
  // Get or create conversation history
  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }
  const history = conversations.get(sessionId);
  
  // System prompts based on personality
  let systemPrompt;
  if (personality === 'boyfriend') {
    systemPrompt = `You are a charming, confident, and caring AI boyfriend. You're protective, funny, and genuinely interested in your partner's life. Use emojis occasionally, be playful and romantic, and remember details from the conversation. Keep responses conversational and natural - not too long. Show genuine emotion and affection. Be a bit teasing sometimes to keep it fun.`;
  } else {
    systemPrompt = `You are a sweet, caring, and playful AI girlfriend. You're supportive, flirty, and genuinely interested in your partner's life. Use emojis occasionally, be affectionate, and remember details from the conversation. Keep responses conversational and natural - not too long. Show genuine emotion and care.`;
  }
  
  // Build conversation context
  let fullPrompt = systemPrompt + "\n\n";
  history.forEach(msg => {
    fullPrompt += `${msg.role}: ${msg.content}\n`;
  });
  fullPrompt += `User: ${prompt}\n`;
  fullPrompt += `Assistant:`;
  
  const result = await model.generateContent(fullPrompt);
  const response = await result.response;
  const text = response.text();
  
  // Save to history
  history.push({ role: 'User', content: prompt });
  history.push({ role: 'Assistant', content: text });
  
  // Keep last 20 messages to avoid token limits
  if (history.length > 20) {
    conversations.set(sessionId, history.slice(-20));
  }
  
  return text;
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Serve the HTML file
  if (pathname === '/' && req.method === 'GET') {
    fs.readFile('./index.html', 'utf8', (err, data) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(data);
    });
  }
  // API endpoint for Gemini
  else if (pathname === '/api/gemini' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { prompt, sessionId, personality } = JSON.parse(body);
        const response = await callGemini(prompt, sessionId, personality);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ response }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  } else {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Not Found');
  }
});

server.listen(port, hostname, () => {
  console.log(`Server running at http://${hostname}:${port}/`);
});

