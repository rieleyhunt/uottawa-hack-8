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
const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const TAVILY_API_URL = 'https://api.tavily.com/search';
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
const TAVILY_MAX_QUERY_LENGTH = 390; // Tavily max is 400 chars; keep a small safety margin
// Tavily-powered extraction
async function extractStream(url, prompt) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set in environment variables');
  }

  let tavilyQuery = `${prompt}\n\nTarget URL: ${url}\nPlease open this URL and any relevant links it contains, and include raw content from those pages.`;

  if (tavilyQuery.length > TAVILY_MAX_QUERY_LENGTH) {
    tavilyQuery = tavilyQuery.slice(0, TAVILY_MAX_QUERY_LENGTH);
  }

  console.log('[extractStream] Tavily query length:', tavilyQuery.length);

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query: tavilyQuery,
      search_depth: 'advanced',
      include_answer: true,
      include_raw_content: true,
      max_results: 20
    })
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
    console.error('[extractStream] Tavily error payload:', errorData);
    throw new Error(`Tavily API error: ${JSON.stringify(errorData) || res.statusText}`);
  }

  const data = await res.json();

  let combined = '';
  if (data.answer) {
    combined += `Answer:\n${data.answer}\n\n`;
  }

  if (Array.isArray(data.results)) {
    combined += data.results.map(r => {
      const title = r.title || '';
      const content = r.content || '';
      const resultUrl = r.url || '';
      return `URL: ${resultUrl}\nTitle: ${title}\nContent:\n${content}`;
    }).join('\n\n---\n\n');
  }

  return combined || JSON.stringify(data);
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

// Process extracted result with Gemini
async function processWithGemini(extractedResult, processingPrompt) {
  const prompt = `${processingPrompt}\n\nExtracted Data:\n${extractedResult}`;
  return await callGemini(prompt);
}

// Tavily helper: directly ask for jobs JSON from a URL
async function tavilyExtractJobsFromGithubReadme(url) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set in environment variables');
  }

  let query = `Summer 2026 internships from GitHub README at ${url}. ` +
    `Open the README and all job posting links. ` +
    `Return STRICT JSON: {"jobs":[{"title":string,"company":string,"location":string,"city":string,"url":string,"description":string,"skills":string[]}]}.`;

  if (query.length > TAVILY_MAX_QUERY_LENGTH) {
    query = query.slice(0, TAVILY_MAX_QUERY_LENGTH);
  }

  console.log('[tavilyExtractJobsFromGithubReadme] Tavily query length:', query.length);

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'advanced',
      include_answer: true,
      include_raw_content: false,
      max_results: 50
    })
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
    console.error('[tavilyExtractJobsFromGithubReadme] Tavily error payload:', errorData);
    throw new Error(`Tavily jobs API error: ${JSON.stringify(errorData) || res.statusText}`);
  }

  const data = await res.json();
  const answer = typeof data.answer === 'string' ? data.answer : JSON.stringify(data);

  console.log('[tavilyExtractJobsFromGithubReadme] Raw Tavily answer (first 5000 chars):', answer.slice(0, 5000));
  
  const processingPrompt = `You are an expert internships data formatter.

You will receive text about internship listings scraped from a GitHub README and job posting pages.
Convert it into STRICT JSON with this exact schema:
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
- city should be a simple city name (no country, no state codes).
- Include as many distinct internship jobs as possible, up to 200 entries.
- For the 'skills' array, extract a VERY LARGE and COMPREHENSIVE list of all technical skills, programming languages, frameworks, libraries, tools, platforms, and relevant keywords mentioned in the job description and requirements.
- Include not just the main skills, but also any secondary or related technologies, tools, and keywords.
- Do NOT include soft skills like 'communication' or 'teamwork'.`;

  const geminiInput = `${processingPrompt}\n\nTavily answer:\n${answer}`;
  const geminiResult = await callGemini(geminiInput);
  console.log('[tavilyExtractJobsFromGithubReadme] Gemini raw result (first 5000 chars):', geminiResult.slice(0, 5000));

  let parsed;
  try {
    parsed = extractJsonFromText(geminiResult);
  } catch (err) {
    console.error('[tavilyExtractJobsFromGithubReadme] Failed to parse Gemini JSON:', err);
    throw new Error(`Failed to parse jobs JSON from Gemini: ${err.message}`);
  }

  const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  console.log('[tavilyExtractJobsFromGithubReadme] Parsed jobs length:', jobs.length);

  return jobs;
}

// Fetch README.md and extract up to maxUrls unique job posting URLs
async function fetchGithubReadmeJobUrls(readmeUrl, maxUrls = 200) {
  console.log('[fetchGithubReadmeJobUrls] Fetching README from:', readmeUrl);

  const res = await fetch(readmeUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch README: ${res.status} ${res.statusText}`);
  }

  let text = await res.text();
  console.log('[fetchGithubReadmeJobUrls] README length:', text.length);

  // Limit to first 20,000 characters to avoid Gemini context overflow
  if (text.length > 20000) {
    text = text.slice(0, 20000);
    console.log('[fetchGithubReadmeJobUrls] Truncated README to 20,000 characters for Gemini extraction.');
  }

  // Use Gemini to extract all job listing URLs from the README text
  const geminiPrompt = `You are an expert at parsing markdown and extracting job listing URLs.\n\nGiven the following README.md content, extract a VERY LARGE and COMPREHENSIVE list of all unique external job posting URLs (not internal GitHub links).\n\nReturn STRICT JSON: {\n  "urls": [string]\n}\n\nREADME.md content:\n${text}`;

  let urlList = [];
  try {
    const geminiResult = await callGemini(geminiPrompt);
    const parsed = extractJsonFromText(geminiResult);
    if (Array.isArray(parsed.urls)) {
      urlList = parsed.urls.filter(url => typeof url === 'string');
    }
  } catch (err) {
    console.error('[fetchGithubReadmeJobUrls] Gemini URL extraction failed:', err);
    // fallback: return empty list
    urlList = [];
  }

  // Remove internal GitHub links and limit to maxUrls
  urlList = urlList.filter(url => !url.includes('github.com/SimplifyJobs'));
  if (urlList.length > maxUrls) {
    urlList = urlList.slice(0, maxUrls);
  }

  console.log('[fetchGithubReadmeJobUrls] Extracted job URLs count (Gemini):', urlList.length);
  console.log('[fetchGithubReadmeJobUrls] Sample URLs:', urlList.slice(0, 10));
  return urlList;
}

// Summarize a single job posting page into a job object using Tavily
async function summarizeJobWithTavily(jobUrl) {
  if (!TAVILY_API_KEY) {
    throw new Error('TAVILY_API_KEY is not set in environment variables');
  }

  let query = `Job posting at ${jobUrl}. Extract STRICT JSON {"title":string,"company":string,"location":string,"city":string,"url":string,"description":string,"skills":string[]}.`;
  if (query.length > TAVILY_MAX_QUERY_LENGTH) {
    query = query.slice(0, TAVILY_MAX_QUERY_LENGTH);
  }

  console.log('[summarizeJobWithTavily] Tavily query length:', query.length, 'for URL:', jobUrl);

  const res = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: 'basic',
      include_answer: true,
      include_raw_content: false,
      max_results: 2
    })
  });

  if (!res.ok) {
    const errorData = await res.json().catch(() => ({ error: 'Unknown error' }));
    console.error('[summarizeJobWithTavily] Tavily error payload:', errorData);
    return null;
  }

  const data = await res.json();
  const answer = typeof data.answer === 'string' ? data.answer : JSON.stringify(data);

  console.log('[summarizeJobWithTavily] Raw Tavily answer (first 1000 chars):', answer.slice(0, 1000));

  const processingPrompt = `You are an expert internships data formatter.

You will receive text about a single internship job posting.
Convert it into STRICT JSON with this exact schema:
{
  "title": string,
  "company": string,
  "location": string,
  "city": string,
  "url": string,
  "description": string,
  "skills": string[]
}

Rules:
- Respond with JSON ONLY, no explanations.
- Ensure the JSON parses successfully in JavaScript.
- city should be a simple city name (no country, no state codes).
- For the 'skills' array, extract a VERY LARGE and COMPREHENSIVE list of all technical skills, programming languages, frameworks, libraries, tools, platforms, and relevant keywords mentioned in the job description and requirements.
- Include not just the main skills, but also any secondary or related technologies, tools, and keywords.
- Do NOT include soft skills like 'communication' or 'teamwork'.`;

  const geminiInput = `${processingPrompt}\n\nTavily answer for job page:\n${answer}`;
  const geminiResult = await callGemini(geminiInput);
  console.log('[summarizeJobWithTavily] Gemini raw result (first 1000 chars):', geminiResult.slice(0, 1000));

  let parsed;
  try {
    parsed = extractJsonFromText(geminiResult);
  } catch (err) {
    console.error('[summarizeJobWithTavily] Failed to parse Gemini JSON for URL', jobUrl, err);
    return null;
  }

  // Gemini may return either a single job object or { jobs: [job] }
  let job = parsed;
  if (Array.isArray(parsed.jobs) && parsed.jobs.length > 0) {
    job = parsed.jobs[0];
  }

  if (!job || typeof job !== 'object') {
    console.warn('[summarizeJobWithTavily] Parsed result is not a job object for URL', jobUrl);
    return null;
  }

  if (!job.url) {
    job.url = jobUrl;
  }

  return job;
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
  // API endpoint: Tavily + Gemini (generic)
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

        // Step 1: Extract with Tavily
        const extractedResult = await extractStream(url, extractPrompt);

        // Step 2: Process with Gemini (if processPrompt provided)
        let result = extractedResult;
        if (processPrompt) {
          result = await processWithGemini(extractedResult, processPrompt);
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
  // API endpoint: refresh internships database from GitHub via Tavily
  else if (pathname === '/api/refresh-jobs' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        // Optional simple auth token
        console.log('[refresh-jobs] Raw request body:', body || '(empty)');
        const data = body ? JSON.parse(body) : {};
        const authToken = data.authToken;
        if (process.env.REFRESH_JOBS_TOKEN && authToken !== process.env.REFRESH_JOBS_TOKEN) {
          res.statusCode = 401;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const readmeUrl = 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/refs/heads/dev/README.md';

        console.log('[refresh-jobs] Starting refresh using README URL:', readmeUrl);

        // Increase to 200 URLs to maximize job count
        const jobUrls = await fetchGithubReadmeJobUrls(readmeUrl, 200);
        console.log('[refresh-jobs] Total job URLs to process:', jobUrls.length);

        const jobs = [];
        for (let i = 0; i < jobUrls.length; i++) {
          const jobUrl = jobUrls[i];
          console.log(`[refresh-jobs] Summarizing job ${i + 1}/${jobUrls.length}:`, jobUrl);
          const job = await summarizeJobWithTavily(jobUrl);
          if (job) {
            jobs.push(job);
          } else {
            console.warn('[refresh-jobs] Skipped job due to summarization failure for URL:', jobUrl);
          }
        }

        console.log('[refresh-jobs] Final jobs array length from Tavily per-URL:', jobs.length);
        if (jobs.length < 50) {
          console.warn(`[refresh-jobs] WARNING: Only ${jobs.length} jobs were fetched. Consider increasing maxUrls or checking source data.`);
        }
        if (!jobs.length) {
          throw new Error('No jobs could be summarized from job URLs');
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

        console.log('[refresh-jobs] Grouped jobs by city. Total cities:', byCity.size);
        for (const [cityKey, value] of byCity.entries()) {
          console.log('[refresh-jobs] City group:', cityKey, 'displayName:', value.city, 'jobCount:', value.jobs.length);
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
          console.log('[refresh-jobs] Inserting documents into MongoDB. Total docs:', docs.length);
          await CityJobs.insertMany(docs);
        }

        console.log('[refresh-jobs] Refresh completed successfully. totalCities:', docs.length, 'totalJobs:', jobs.length);

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
- If nothing matches well, then at least return some jobs that are similar.`;

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
