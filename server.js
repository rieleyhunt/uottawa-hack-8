const http = require('http');
const fs = require('fs');
const url = require('url');
require('dotenv').config();
const { PDFParse } = require('pdf-parse');
const mongoose = require('mongoose');
const hostname = '0.0.0.0';
const port = process.env.PORT || 3001;

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const YELLOWCAKE_API_KEY = process.env.YELLOWCAKE_API_KEY;
const MONGO_URI = process.env.MONGO_URI;

if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch(err => console.error('MongoDB connection error:', err));
}

// MongoDB schema: one document per city with an array of job listings
const JobSchema = new mongoose.Schema({
  title: String,
  company: String,
  location: String,
  city: String,
  url: String,
  description: String,
  skills: [String],
  lastUpdated: { type: Date, default: Date.now }
}, { _id: false });

const CityJobsSchema = new mongoose.Schema({
  city: { type: String, required: true },
  normalizedCity: { type: String, required: true, index: true },
  jobs: [JobSchema],
  lastRefreshed: { type: Date, default: Date.now }
});

const CityJobs = mongoose.models.CityJobs || mongoose.model('CityJobs', CityJobsSchema);
// YellowCake extraction
async function extractStream(url, prompt) {
  if (!YELLOWCAKE_API_KEY) {
    throw new Error('YELLOWCAKE_API_KEY is not set in environment variables');
  }

  const res = await fetch("https://api.yellowcake.dev/v1/extract-stream", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": YELLOWCAKE_API_KEY,
    },
    body: JSON.stringify({ url, prompt }),
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`YellowCake API error: ${errorData.error?.message || res.statusText}`);
  }

  // Read the stream
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}

// Call OpenRouter Gemini
async function callGemini(prompt, model = 'google/gemini-3-pro-preview') {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is not set in environment variables');
  }

  const response = await fetch(OPENROUTER_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'http://localhost:3001',
      'X-Title': process.env.OPENROUTER_X_TITLE || 'Resume Analyzer'
    },
    body: JSON.stringify({
      model: model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(`OpenRouter API error: ${errorData.error?.message || response.statusText}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

// Process YellowCake result with Gemini
async function processWithGemini(yellowCakeResult, processingPrompt) {
  const prompt = `${processingPrompt}\n\nData from YellowCake:\n${yellowCakeResult}`;
  return await callGemini(prompt);
}

// Extract text from PDF (using your original PDFParse helper)
async function extractTextFromPdf(pdfBuffer) {
  const parser = new PDFParse({ data: pdfBuffer });
  const result = await parser.getText();
  return result.text;
}

// Helper: normalize city key
function normalizeCityName(city) {
  return (city || '').trim().toLowerCase();
}

// Helper: parse JSON content that may be wrapped in markdown or text
function extractJsonFromText(text) {
  let jsonText = (text || '').trim();

  if (jsonText.includes('```json')) {
    const match = jsonText.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) jsonText = match[1].trim();
  } else if (jsonText.includes('```')) {
    const match = jsonText.match(/```\s*([\s\S]*?)\s*```/);
    if (match) jsonText = match[1].trim();
  }

  const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonText = jsonMatch[0];
  }

  const firstBrace = jsonText.indexOf('{');
  if (firstBrace > 0) {
    jsonText = jsonText.substring(firstBrace);
  }

  return JSON.parse(jsonText);
}

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }

  // Serve resume analyzer as main page
  if (pathname === '/' && req.method === 'GET') {
    fs.readFile('./resume.html', 'utf8', (err, data) => {
      if (err) {
        res.statusCode = 500;
        res.end('Error loading page');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html');
      res.end(data);
    });
  }
  // API endpoint: YellowCake + Gemini (generic)
  else if (pathname === '/api/scrape-and-process' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        const { url, extractPrompt, processPrompt } = data;

        if (!url || !extractPrompt) {
          throw new Error('URL and extractPrompt are required');
        }

        // Step 1: Extract with YellowCake
        const yellowCakeResult = await extractStream(url, extractPrompt);

        // Step 2: Process with Gemini (if processPrompt provided)
        let result = yellowCakeResult;
        if (processPrompt) {
          result = await processWithGemini(yellowCakeResult, processPrompt);
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result }));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
  // API endpoint: refresh internships database from GitHub via YellowCake + Gemini
  else if (pathname === '/api/refresh-jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        // Optional simple auth token
        const data = body ? JSON.parse(body) : {};
        const authToken = data.authToken;
        if (process.env.REFRESH_JOBS_TOKEN && authToken !== process.env.REFRESH_JOBS_TOKEN) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const githubUrl = 'https://github.com/SimplifyJobs/Summer2026-Internships?tab=readme-ov-file';

        const extractPrompt = `You are an expert data extractor.
From this GitHub internships listing page and any job links it references, extract a concise structured list of internship jobs.

Return ONLY valid JSON in the following format:
{
  "jobs": [
    {
      "title": "Software Engineer Intern",
      "company": "Example Corp",
      "location": "Toronto, ON, Canada",
      "city": "Toronto",
      "url": "https://careers.example.com/job/123",
      "description": "Short summary of responsibilities and requirements.",
      "skills": ["Python", "JavaScript", "SQL"]
    }
  ]
}

Requirements:
- city must be a simple city name (e.g., "Toronto", "Ottawa", "New York").
- skills should be a short list of key technologies or skills.
- Include as many jobs as you can, but keep descriptions reasonably short.`;

        const yellowCakeResult = await extractStream(githubUrl, extractPrompt);

        const processingPrompt = `You are a helpful assistant.
You will receive raw extracted text from an internships listing page.
Convert it into STRICT JSON following this schema:
{
  "jobs": [
    {
      "title": string,
      "company": string,
      "location": string,
      "city": string,
      "url": string,
      "description": string,
      "skills": string[]
    }
  ]
}

Rules:
- Respond with JSON ONLY, no explanations.
- Ensure the JSON parses successfully in JavaScript.
- city should be a simple city name (no country, no state codes).`;

        const geminiResult = await processWithGemini(yellowCakeResult, processingPrompt);
        const parsed = extractJsonFromText(geminiResult);
        const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];

        if (!jobs.length) {
          throw new Error('No jobs found in extracted data');
        }

        // Group jobs by normalized city
        const byCity = new Map();
        for (const job of jobs) {
          const rawCity = job.city || job.location || 'Unknown';
          const normalizedCity = normalizeCityName(rawCity.split(',')[0]);
          const cityName = rawCity.split(',')[0].trim() || 'Unknown';
          if (!byCity.has(normalizedCity)) {
            byCity.set(normalizedCity, { city: cityName, normalizedCity, jobs: [] });
          }

          byCity.get(normalizedCity).jobs.push({
            title: job.title || '',
            company: job.company || '',
            location: job.location || cityName,
            city: cityName,
            url: job.url || '',
            description: job.description || '',
            skills: Array.isArray(job.skills) ? job.skills : [],
            lastUpdated: new Date()
          });
        }

        // Clear existing city jobs collection and insert new data
        await CityJobs.deleteMany({});

        const docs = [];
        for (const value of byCity.values()) {
          docs.push({
            city: value.city,
            normalizedCity: value.normalizedCity,
            jobs: value.jobs,
            lastRefreshed: new Date()
          });
        }

        if (docs.length) {
          await CityJobs.insertMany(docs);
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          message: 'Jobs database refreshed',
          totalCities: docs.length,
          totalJobs: jobs.length
        }));
      } catch (error) {
        console.error('Error refreshing jobs:', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  }
  // API endpoint to compare resume to internships
  else if (pathname === '/api/compare-resume' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body);
        let resumeContent = data.resumeContent;
        const city = data.city;
        const jobTitle = data.jobTitle;

        if (!city) {
          throw new Error('City is required');
        }

        // If it's a base64 encoded PDF, parse it
        if (typeof resumeContent === 'string' && resumeContent.startsWith('JVBERi0')) {
          const buffer = Buffer.from(resumeContent, 'base64');
          resumeContent = await extractTextFromPdf(buffer);
        }

        if (!resumeContent || resumeContent.trim().length === 0) {
          throw new Error('No resume content found. Please upload a PDF or paste text.');
        }

        const normalizedCity = normalizeCityName(city);
        const cityDoc = await CityJobs.findOne({ normalizedCity });

        if (!cityDoc || !cityDoc.jobs || cityDoc.jobs.length === 0) {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ message: `No jobs found in database for city: ${city}` }));
          return;
        }

        // Optionally filter by job title before sending to Gemini to reduce context
        let jobsForModel = cityDoc.jobs;
        if (jobTitle && jobTitle.trim()) {
          const titleLower = jobTitle.toLowerCase();
          jobsForModel = jobsForModel.filter(j =>
            (j.title || '').toLowerCase().includes(titleLower)
          );
        }

        // Limit number of jobs sent to model to keep prompt size manageable
        const MAX_JOBS = 60;
        if (jobsForModel.length > MAX_JOBS) {
          jobsForModel = jobsForModel.slice(0, MAX_JOBS);
        }

        const jobsJson = JSON.stringify(jobsForModel);

        const processPrompt = `You are an expert career coach and matching engine.

You will receive:
1) A student's resume text.
2) A JSON array of internship job listings for the city "${city}".

Your task: compare the resume to these jobs and return the best matches.

Jobs JSON:
${jobsJson}

Resume:
${resumeContent}

Respond in STRICT JSON with this exact schema:
{
  "matches": [
    {
      "title": string,
      "company": string,
      "location": string,
      "url": string,
      "matchScore": number,
      "explanation": string,
      "matchingSkills": string[],
      "missingSkills": string[]
    }
  ]
}

Rules:
- matchScore is between 0 and 100.
- Sort matches by matchScore descending.
- Only include jobs that are reasonably relevant to the resume.
- If nothing matches well, return an empty matches array.`;

        const result = await callGemini(processPrompt);
        const comparison = extractJsonFromText(result);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(comparison));
      } catch (error) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
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
          const buffer = Buffer.from(resumeContent, 'base64');
          resumeContent = await extractTextFromPdf(buffer);
        }

        if (!resumeContent || resumeContent.trim().length === 0) {
          throw new Error('No resume content found. Please upload a PDF or paste text.');
        }

        const analysis = await callGemini(`Analyze this resume and provide a comprehensive summary:\n${resumeContent}`);
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
