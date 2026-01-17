# ResuMate

ResuMate is an AI-powered job matching application that helps users find targeted job opportunities based on their uploaded resumes. The app leverages **AI (Gemini via OpenRouter)** and **web scraping (Yellowcake.dev)** to recommend relevant jobs efficiently.

---

## Features

- Upload your resume
- Fetch job listings from multiple websites
- AI-powered resume-to-job matching
- View recommended jobs on your dashboard

---

## Tech Stack

- **Frontend:** React / HTML / CSS
- **Backend:** Node.js + Express
- **Database:** MongoDB
- **External APIs:** 
  - OpenRouter → Gemini (AI processing)
  - Yellowcake.dev (web scraping)

---

## Project Structure

[User Frontend]
    │
    │ Upload Resume
    ▼
[Backend / Express]
    │
    ├─ Store resume → MongoDB
    │
    ├─ Call Yellowcake.dev → fetch jobs
    │
    └─ Call Gemini AI → match resume to jobs
           │
           ▼
   Store recommendations → MongoDB
           │
           ▼
[Frontend] fetches recommendations → display to user

**********
Flow

[User Frontend]
    │
    │ Upload Resume
    ▼
[Backend / Express]
    │
    ├─ Store resume → MongoDB
    │
    ├─ Call Yellowcake.dev → fetch jobs
    │
    └─ Call Gemini AI → match resume to jobs
           │
           ▼
   Store recommendations → MongoDB
           │
           ▼
[Frontend] fetches recommendations → display to user
