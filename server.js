const http = require('http');
const fs = require('fs');
const url = require('url');
require('dotenv').config();
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { PDFParse } = require('pdf-parse');

const hostname = '0.0.0.0';
const port = process.env.PORT || 3001;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API);
console.log("API Key:", process.env.GEMINI_API?.slice(0, 4) + "...");

async function extractTextFromPdf(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  return result.text;
}

async function analyzeResume(resumeContent) {
  const model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
  
  const analysisPrompt = `Analyze this resume and provide a comprehensive summary of:
1. Key Skills (organize by category)
2. Professional Experience (highlight roles, companies, and achievements)
3. Education & Certifications
4. Notable Strengths
5. Career Trajectory

Format the analysis clearly with section headers and bullet points. Be concise but thorough.

Resume:
${resumeContent}`;

  const result = await model.generateContent(analysisPrompt);
  const response = await result.response;
  return response.text();
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // Serve resume analyzer as main page
  if (pathname === '/' && req.method === 'GET') {
    fs.readFile('./resume.html', 'utf8', (err, data) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(data);
    });
  }
  // API endpoint for resume analysis
  else if (pathname === '/api/analyze-resume' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        let resumeContent = data.resumeContent;

        // If it's a base64 encoded PDF, parse it
        if (typeof resumeContent === 'string' && resumeContent.startsWith('JVBERi0')) {
          // Base64 encoded PDF
          const buffer = Buffer.from(resumeContent, 'base64');
          resumeContent = await extractTextFromPdf(buffer);
        }

        if (!resumeContent || resumeContent.trim().length === 0) {
          throw new Error('No resume content found. Please upload a PDF or paste text.');
        }

        const analysis = await analyzeResume(resumeContent);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ analysis }));
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
  console.log(`Server running on port ${port}`);
});

