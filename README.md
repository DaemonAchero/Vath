# Vath

Vath is a local website cloning and extraction tool built with Node.js and Puppeteer. It can run as a CLI or as a small browser-based UI that queues clone jobs, captures assets, and produces a local replica output.

This project is designed to stay on your machine. It launches a browser locally, visits a target URL, and captures content for replay and export.

## What It Does

Vath can:

- open a target website in an automated browser
- capture HTML, or any frontend site with styles, scripts, images, fonts, media, and other assets
- extract responsive views
- optionally crawl deeper links
- generate a local preview UI
- package the result for download
work with almost any modern sites especially award winning websites


## Requirements

- Node.js 18 or newer
- npm
- Google Chrome or Chromium installed locally, or a browser path provided in `.env`

## Install

From the project folder:

```powershell
npm install
```

Install downloads the JavaScript dependencies only. The browser path is configured separately through the environment.

## Browser Configuration

Vath reads a local `.env` file from the project root.

Set the browser path with:

```env
CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

If `CHROME_PATH` is not set, Vath will try common Windows Chrome locations automatically.

If you are using a different browser build or a non-standard install location, point `CHROME_PATH` to that executable instead.

### Notes

- Do not commit your personal `.env` file if the path is specific to your machine.
- If you want to share a template with other users, update `.env.example` with a safe example path.

## Run the UI

Start the local UI server with:

```powershell
node vath.js --ui --port 3000
```

If you omit `--port`, the UI defaults to `8788`.

## Run From the CLI

Clone a site directly from the terminal:

```powershell
node vath.js https://example.com
```

### CLI Options

- `--headed` - show the browser window instead of running headless
- `--wait` - pause and wait for manual input before continuing
- `--deep` - enable deeper crawling of links
- `--max-depth <n>` - set the maximum crawl depth, default `3`
- `--output <dir>` - set a custom output directory
- `--ui` - start the UI server
- `--port <n>` - set the UI port, default `8788`

### Examples

```powershell
node vath.js https://example.com --headed --wait
node vath.js https://example.com --deep --max-depth 2
node vath.js https://example.com --output output-folder
node vath.js --ui --port 3000
```

## Output

Vath creates a local extraction output directory containing captured assets and generated files for replay and preview.

When you run the UI, it also exposes:

- a preview page
- a downloadable zip package
- job status logs

## Troubleshooting

### Chrome not found

If you see an error about Chrome not being found:

- confirm Chrome is installed
- set `CHROME_PATH` in `.env`
- make sure the path points to the actual `chrome.exe`

### Browser launch fails

If Puppeteer starts but the site does not load correctly:

- try `--headed` so you can watch the browser
- try `--wait` if the page needs manual interaction
- try a different target site if the page blocks automation

### Install issues

If `npm install` fails, run it again after checking your network and local npm cache. The JavaScript dependencies must install before Vath can run.

## Project Structure

- `vath.js` - main CLI and UI server
- `ui/` - local web UI assets
- `package.json` - project metadata and npm scripts
- `.env` - local configuration, not meant to be committed

## Development Notes

- The project uses Puppeteer as the browser automation layer.
- The app reads `CHROME_PATH` from `.env` if present.
- If `CHROME_PATH` is not set, the script attempts common Windows Chrome locations before falling back to Puppeteer defaults.

## Quick Start

1. Run `npm install`
2. Create a `.env` file if needed
3. Set `CHROME_PATH` to your local Chrome executable
4. Run `node vath.js --ui --port 3000`

## Limitations
May not fully work to some sites and is under development of caputuring all endpoints for full lages extractions
