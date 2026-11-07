
# Claude Browser Automation

Browserbase + Playwright + Express API for n8n.

## Install

npm install

## Start

npm start

## Environment Variables

PORT=3000
BROWSERBASE_API_KEY=your_browserbase_api_key
BROWSERBASE_PROJECT_ID=your_project_id
AUTOMATION_API_KEY=your_own_secret_key

## Endpoints

GET /health

POST /run

Authorization: Bearer YOUR_AUTOMATION_API_KEY

JSON Body:

{
  "title": "Why Casinos Have No Clocks"
}
