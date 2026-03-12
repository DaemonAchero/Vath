const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

puppeteer.use(StealthPlugin());

class VathsMirror {
    constructor(options = {}) {
        this.outputDir = options.outputDir || path.join(os.tmpdir(), `ai-vath-extracted-${Date.now()}`);
        this.timeout = options.timeout || 120000;
        this.preserveLiveScripts = options.preserveLiveScripts ?? true;
        this.injectBaseHref = options.injectBaseHref ?? true;
        this.enableReplay = options.enableReplay ?? true;
        this.replayPort = options.replayPort || 8799;
        this.headless = options.headless ?? 'new';
        this.simulateUser = options.simulateUser ?? true;
        this.waitForUser = options.waitForUser ?? false;
        this.captureWebGL = options.captureWebGL ?? true;
        this.captureCanvas = options.captureCanvas ?? true;
        this.deepCrawl = options.deepCrawl ?? false;
        this.maxDepth = options.maxDepth || 3;
        this.viewports = [
            { width: 1920, height: 1080, name: 'desktop', deviceScaleFactor: 1 },
            { width: 1366, height: 768, name: 'laptop', deviceScaleFactor: 1 },
            { width: 768, height: 1024, name: 'tablet', deviceScaleFactor: 2 },
            { width: 375, height: 667, name: 'mobile', deviceScaleFactor: 2 },
            { width: 414, height: 896, name: 'mobile-lg', deviceScaleFactor: 3 }
        ];
        this.assetCache = new Map();
        this.fontCache = new Map();
        this.capturedUrls = new Set();
    }

    // Utility: Deep clone with circular reference protection
    deepClone(obj, seen = new WeakMap()) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (seen.has(obj)) return seen.get(obj);
        
        const clone = Array.isArray(obj) ? [] : {};
        seen.set(obj, clone);
        
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                clone[key] = this.deepClone(obj[key], seen);
            }
        }
        return clone;
    }

    // Utility: CSS property to camelCase converter
    cssPropertyToCamelCase(property) {
        return property.replace(/-([a-z])/g, (match, letter) => letter.toUpperCase());
    }

    // Utility: Format style values for React/Vue
    formatStyleValue(key, value) {
        const numericProps = [
            'opacity', 'zIndex', 'flexGrow', 'flexShrink', 'order', 
            'lineHeight', 'fontWeight', 'tabSize', 'columnCount',
            'orphans', 'widows', 'animationIterationCount'
        ];
        const camelKey = this.cssPropertyToCamelCase(key);
        
        if (numericProps.includes(camelKey) && !isNaN(parseFloat(value))) {
            return parseFloat(value);
        }
        
        // Handle colors and strings
        if (typeof value === 'string') {
            return value.replace(/"/g, '\\"');
        }
        return value;
    }

    // Utility: Wait for keypress in headed mode
    waitForEnter() {
        return new Promise((resolve) => {
            const readline = require('readline');
            const rl = readline.createInterface({ 
                input: process.stdin, 
                output: process.stdout 
            });
            console.log('[VATH] Press ENTER to continue extraction...');
            rl.question('', () => {
                rl.close();
                resolve();
            });
        });
    }

    // Utility: Safe page evaluation with retry logic
    async safeEvaluate(page, fn, retries = 3) {
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await page.evaluate(fn);
            } catch (err) {
                const msg = err?.message || String(err);
                const retryable = msg.includes('detached Frame') ||
                                  msg.includes('Execution context was destroyed') ||
                                  msg.includes('Cannot find context with specified id') ||
                                  msg.includes('Target closed');
                
                if (!retryable || attempt === retries) throw err;

                console.log(`[VATH] Retrying evaluation (attempt ${attempt + 1})...`);
                try {
                    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: this.timeout });
                } catch {}
                await new Promise(r => setTimeout(r, 800));
            }
        }
    }

    // Utility: Get file extension from MIME type
    getExtensionFromMime(mimeType) {
        if (!mimeType) return null;
        const map = {
            'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
            'image/gif': '.gif', 'image/svg+xml': '.svg', 'image/webp': '.webp',
            'image/avif': '.avif', 'image/x-icon': '.ico', 'image/vnd.microsoft.icon': '.ico',
            'text/css': '.css', 'text/scss': '.scss', 'text/sass': '.sass',
            'text/less': '.less', 'text/stylus': '.styl',
            'application/javascript': '.js', 'text/javascript': '.js',
            'application/ecmascript': '.js', 'application/x-javascript': '.js',
            'application/json': '.json', 'application/manifest+json': '.webmanifest',
            'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf',
            'font/otf': '.otf', 'font/sfnt': '.ttf', 'application/x-font-ttf': '.ttf',
            'application/x-font-otf': '.otf', 'application/font-woff': '.woff',
            'application/font-woff2': '.woff2',
            'video/mp4': '.mp4', 'video/webm': '.webm', 'video/ogg': '.ogv',
            'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
            'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf',
            'application/wasm': '.wasm', 'application/octet-stream': '.bin',
            'text/html': '.html', 'application/xml': '.xml', 'text/xml': '.xml',
            'application/pdf': '.pdf', 'application/zip': '.zip',
            'application/vnd.rive': '.riv', 'image/ktx2': '.ktx2',
            'application/vnd.ms-fontobject': '.eot'
        };
        return map[mimeType.split(';')[0].trim().toLowerCase()] || null;
    }

    // Utility: Generate hash for filename
    generateHash(input) {
        return crypto.createHash('sha256').update(input).digest('hex').slice(0, 12);
    }

    // Utility: Sanitize filename
    sanitizeFilename(name) {
        return name.replace(/[^a-z0-9.-]/gi, '_').replace(/_{2,}/g, '_');
    }

    // CORE METHOD: Main extraction ritual
    async awaken(url, depth = 0) {
        if (depth > this.maxDepth) {
            console.log(`[VATH] Max depth reached for: ${url}`);
            return;
        }

        if (this.capturedUrls.has(url)) {
            console.log(`[VATH] Already captured: ${url}`);
            return;
        }

        this.capturedUrls.add(url);
        console.log(`[VATH] Initiating extraction ritual for: ${url} (depth: ${depth})`);

        const browser = await puppeteer.launch({
            headless: this.headless,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080',
                '--force-device-scale-factor=1',
                '--high-dpi-support=1',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--enable-webgl',
                '--enable-features=WebGLDraftExtensions'
            ],
            defaultViewport: null
        });

        try {
            const page = await browser.newPage();
            
            // Set viewport
            await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
            
            // Create output directory structure
            await fs.ensureDir(this.outputDir);
            await fs.ensureDir(path.join(this.outputDir, 'assets'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'images'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'fonts'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'videos'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'models'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'scripts'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'styles'));
            await fs.ensureDir(path.join(this.outputDir, 'assets', 'misc'));
            await fs.ensureDir(path.join(this.outputDir, 'components'));
            
            // Bypass CSP and security
            await page.setBypassCSP(true);
            
            // Set extra headers to appear more human
            await page.setExtraHTTPHeaders({
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"Windows"',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            // Asset interception and capture
            const assets = new Map();
            const fontRequests = new Set();
            
            await page.setRequestInterception(true);
            
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                const requestUrl = request.url();
                
                // Capture all resource types including animations and 3D assets
                const captureTypes = [
                    'image', 'font', 'stylesheet', 'script', 'xhr', 'fetch', 
                    'media', 'other', 'document', 'manifest', 'websocket'
                ];
                
                if (captureTypes.includes(resourceType)) {
                    assets.set(requestUrl, { 
                        type: resourceType, 
                        captured: false,
                        headers: request.headers()
                    });
                }
                
                // Detect font requests specifically
                if (resourceType === 'font' || 
                    requestUrl.match(/\.(woff2?|ttf|otf|eot)$/i)) {
                    fontRequests.add(requestUrl);
                }
                
                // Capture specialized web assets
                const pathname = new URL(requestUrl).pathname.toLowerCase();
                const specialExts = [
                    '.riv', '.ktx2', '.hdr', '.glb', '.gltf', '.webp', '.avif',
                    '.mp4', '.webm', '.wasm', '.json', '.usdz', '.obj', '.fbx',
                    '.dae', '.3ds', '.stl', '.ply', '.xyz', '.pcd'
                ];
                
                if (specialExts.some(ext => pathname.endsWith(ext))) {
                    assets.set(requestUrl, { 
                        type: 'special', 
                        captured: false,
                        ext: path.extname(pathname)
                    });
                }
                
                request.continue();
            });

            // Capture response bodies
            page.on('response', async (response) => {
                const requestUrl = response.url();
                if (assets.has(requestUrl) && !assets.get(requestUrl).captured) {
                    try {
                        const buffer = await response.buffer().catch(() => null);
                        if (buffer) {
                            assets.get(requestUrl).data = buffer;
                            assets.get(requestUrl).captured = true;
                            assets.get(requestUrl).contentType = response.headers()['content-type'];
                            assets.get(requestUrl).status = response.status();
                        }
                    } catch (e) {
                        // Silent fail for security-restricted responses
                    }
                }
            });

            // Navigate with extreme prejudice
            console.log('[VATH] Navigating to target...');
            await page.goto(url, { 
                waitUntil: 'networkidle2', 
                timeout: this.timeout 
            });

            // Wait for manual interaction if requested
            if (this.waitForUser) {
                console.log('[VATH] Headed mode active. Interact with page, then press ENTER...');
                await this.waitForEnter();
            }

            // Extract framework and library fingerprints
            console.log('[VATH] Analyzing framework signatures...');
            let frameworkData;
            try {
                frameworkData = await this.safeEvaluate(page, () => {
                    const data = {
                    react: false, vue: false, nextjs: false, nuxtjs: false,
                    angular: false, svelte: false, solid: false, preact: false,
                    framework: 'vanilla',
                    hasAnimationLibs: false,
                    animationLibs: [],
                    stateManagement: [],
                    uiLibraries: [],
                    buildTool: 'unknown'
                };

                // Framework detection
                if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__ || 
                    document.querySelector('[data-reactroot], [data-reactid]')) {
                    data.react = true;
                    data.framework = 'react';
                }
                if (window.Vue || window.__VUE__ || document.querySelector('[data-v-]')) {
                    data.vue = true;
                    if (!data.framework || data.framework === 'vanilla') data.framework = 'vue';
                }
                if (window.__NEXT_DATA__) {
                    data.nextjs = true;
                    data.framework = 'nextjs';
                    data.buildTool = 'next';
                }
                if (window.__NUXT__) {
                    data.nuxtjs = true;
                    data.framework = 'nuxtjs';
                    data.buildTool = 'nuxt';
                }
                if (window.angular) {
                    data.angular = true;
                    data.framework = 'angular';
                }
                if (window.__svelte || document.querySelector('[class*="svelte-"]')) {
                    data.svelte = true;
                    if (data.framework === 'vanilla') data.framework = 'svelte';
                }
                if (window.Solid) {
                    data.solid = true;
                }

                // Animation libraries detection
                const scripts = Array.from(document.querySelectorAll('script[src]'));
                const srcs = scripts.map(s => s.src.toLowerCase());
                
                const libMap = {
                    'gsap': 'gsap', 'greensock': 'gsap',
                    'framer-motion': 'framer-motion', 'framer': 'framer-motion',
                    'animejs': 'anime.js', 'anime.js': 'anime.js',
                    'three': 'three.js', 'threejs': 'three.js',
                    'babylon': 'babylon.js',
                    'velocity': 'velocity.js',
                    'popmotion': 'popmotion',
                    'lottie': 'lottie-web',
                    'rive': 'rive',
                    'lenis': 'lenis',
                    'scrolltrigger': 'gsap-scrolltrigger',
                    'swiper': 'swiper',
                    'splide': 'splide',
                    'glide': 'glide',
                    'flickity': 'flickity',
                    'aos': 'aos',
                    'wow': 'wow.js',
                    'masonry': 'masonry',
                    'isotope': 'isotope',
                    'barba': 'barba.js',
                    'locomotive': 'locomotive-scroll',
                    'smooth-scrollbar': 'smooth-scrollbar'
                };

                srcs.forEach(src => {
                    Object.entries(libMap).forEach(([key, name]) => {
                        if (src.includes(key) && !data.animationLibs.includes(name)) {
                            data.animationLibs.push(name);
                            data.hasAnimationLibs = true;
                        }
                    });
                });

                // Check global objects for libraries
                if (window.gsap) data.animationLibs.push('gsap');
                if (window.ScrollTrigger) data.animationLibs.push('gsap-scrolltrigger');
                if (window.Three) data.animationLibs.push('three.js');
                if (window.BABYLON) data.animationLibs.push('babylon.js');
                if (window.anime) data.animationLibs.push('anime.js');
                if (window.swiper) data.animationLibs.push('swiper');
                if (window.Lenis) data.animationLibs.push('lenis');
                if (window.lottie) data.animationLibs.push('lottie-web');

                // State management
                if (window.Redux) data.stateManagement.push('redux');
                if (window.Vuex) data.stateManagement.push('vuex');
                if (window.Pinia) data.stateManagement.push('pinia');
                if (window.MobX) data.stateManagement.push('mobx');
                if (window.Zustand) data.stateManagement.push('zustand');
                if (window.Recoil) data.stateManagement.push('recoil');
                if (window.Jotai) data.stateManagement.push('jotai');

                // UI Libraries
                const uiIndicators = {
                    'mui': 'material-ui', 'material-ui': 'material-ui',
                    'antd': 'ant-design', 'ant-design': 'ant-design',
                    'chakra': 'chakra-ui', 'bootstrap': 'bootstrap',
                    'tailwind': 'tailwindcss', 'bulma': 'bulma',
                    'semantic': 'semantic-ui', 'vuetify': 'vuetify',
                    'element-ui': 'element-ui', 'quasar': 'quasar',
                    'ionic': 'ionic', 'onsen': 'onsen-ui'
                };

                srcs.forEach(src => {
                    Object.entries(uiIndicators).forEach(([key, name]) => {
                        if (src.includes(key) && !data.uiLibraries.includes(name)) {
                            data.uiLibraries.push(name);
                        }
                    });
                });

                // Check for Tailwind
                if (document.querySelector('[class*="tw-"]') || 
                    Array.from(document.styleSheets).some(s => {
                        try {
                            return s.href && s.href.includes('tailwind');
                        } catch(e) { return false; }
                    })) {
                    if (!data.uiLibraries.includes('tailwindcss')) {
                        data.uiLibraries.push('tailwindcss');
                    }
                }

                // Build tool detection
                if (document.querySelector('script[src*="/_next/"]')) data.buildTool = 'next';
                if (document.querySelector('script[src*="/_nuxt/"]')) data.buildTool = 'nuxt';
                if (window.__VITE__) data.buildTool = 'vite';
                if (window.__webpack_hash__) data.buildTool = 'webpack';
                if (window.__parcelRequire__) data.buildTool = 'parcel';
                if (window.__rollup) data.buildTool = 'rollup';

                    return data;
                });
            } catch (e) {
                console.log(`[VATH] Framework detection failed, defaulting to VANILLA: ${e.message}`);
                frameworkData = {
                    react: false, vue: false, nextjs: false, nuxtjs: false,
                    angular: false, svelte: false, solid: false, preact: false,
                    framework: 'vanilla',
                    hasAnimationLibs: false,
                    animationLibs: [],
                    stateManagement: [],
                    uiLibraries: [],
                    buildTool: 'unknown'
                };
            }

            console.log(`[VATH] Framework: ${frameworkData.framework.toUpperCase()}`);
            if (frameworkData.animationLibs.length > 0) {
                console.log(`[VATH] Animation libs: ${frameworkData.animationLibs.join(', ')}`);
            }

            // Trigger lazy loading and dynamic content
            console.log('[VATH] Triggering lazy content...');
            await this.triggerLazyContent(page);

            // Simulate user interactions for scroll animations
            if (this.simulateUser) {
                console.log('[VATH] Simulating user presence...');
                await this.simulateHumanBehavior(page);
            }

            // Wait for animations to settle
            await new Promise(resolve => setTimeout(resolve, 2000));

            // Extract all styles including keyframes and animations
            console.log('[VATH] Extracting stylesheets...');
            const extractedStyles = await this.extractAllStyles(page);

            // Capture WebGL and Canvas content
            let webglData = null;
            let canvasData = null;
            
            if (this.captureWebGL) {
                console.log('[VATH] Capturing WebGL contexts...');
                webglData = await this.captureWebGLContexts(page);
            }
            
            if (this.captureCanvas) {
                console.log('[VATH] Capturing Canvas elements...');
                canvasData = await this.captureCanvasElements(page);
            }

            // Capture full live HTML (scripts/styles intact)
            const pageHtml = await page.content();

            // Extract complete DOM with computed styles
            console.log('[VATH] Cloning DOM structure...');
            const domSnapshot = await this.extractDOMSnapshot(page);

            // Capture storage and cookies
            const storageData = await this.captureStorage(page);
            const cookies = await page.cookies();
            const userAgent = await page.evaluate(() => navigator.userAgent);
            const viewport = await page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
                devicePixelRatio: window.devicePixelRatio
            }));

            // Take responsive screenshots
            console.log('[VATH] Capturing visual snapshots...');
            const screenshots = await this.captureResponsiveScreenshots(page);

            // Analyze component structure
            console.log('[VATH] Analyzing component hierarchy...');
            const components = this.analyzeComponentStructure(domSnapshot);

            // Save all assets
            console.log('[VATH] Persisting assets...');
            const assetMap = await this.saveAssets(assets, url);

            // Generate outputs
            console.log('[VATH] Generating framework outputs...');
            await this.generateAllOutputs({
                url,
                framework: frameworkData,
                dom: domSnapshot,
                pageHtml,
                components,
                assets: assetMap,
                screenshots,
                styles: extractedStyles,
                webgl: webglData,
                canvas: canvasData,
                storage: storageData,
                cookies,
                userAgent,
                viewport
            });

            // Deep crawl if enabled
            if (this.deepCrawl && depth < this.maxDepth) {
                const links = await this.extractLinks(page, url);
                for (const link of links.slice(0, 5)) { // Limit to 5 links per page
                    try {
                        await this.awaken(link, depth + 1);
                    } catch (e) {
                        console.log(`[VATH] Failed to crawl ${link}: ${e.message}`);
                    }
                }
            }

            await browser.close();
            console.log(`[VATH] Extraction complete: ${this.outputDir}`);
            
            return {
                success: true,
                outputDir: this.outputDir,
                framework: frameworkData.framework,
                assetsExtracted: assetMap.size,
                componentsDetected: components.length
            };

        } catch (error) {
            await browser.close().catch(() => {});
            console.error('[VATH] Extraction failed:', error);
            throw error;
        }
    }

    // Trigger lazy loading, infinite scroll, and dynamic content
    async triggerLazyContent(page) {
        return this.safeEvaluate(page, async () => {
            // Scroll to bottom progressively
            const scrollHeight = () => document.body.scrollHeight;
            const clientHeight = () => window.innerHeight;
            let lastHeight = 0;
            let attempts = 0;
            
            while (attempts < 10) {
                window.scrollTo(0, scrollHeight());
                await new Promise(r => setTimeout(r, 500));
                
                const currentHeight = scrollHeight();
                if (currentHeight === lastHeight) break;
                lastHeight = currentHeight;
                attempts++;
            }

            // Click all "load more" buttons
            const loadMoreSelectors = [
                'button:contains("Load")', 'button:contains("More")',
                '[class*="load"]', '[class*="more"]',
                'button:contains("Show")', 'a:contains("Load")'
            ];
            
            const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                .filter(btn => {
                    const text = (btn.textContent || btn.innerText || '').toLowerCase();
                    return text.includes('load') || text.includes('more') || 
                           text.includes('show') || text.includes('expand');
                });

            for (const btn of buttons) {
                try {
                    btn.click();
                    await new Promise(r => setTimeout(r, 1000));
                } catch(e) {}
            }

            // Trigger all images to load
            const lazyImages = document.querySelectorAll('img[data-src], img[data-original], img[lazy]');
            lazyImages.forEach(img => {
                if (img.dataset.src) img.src = img.dataset.src;
                if (img.dataset.original) img.src = img.dataset.original;
                img.classList.remove('lazy');
            });

            // Force all iframes to load
            const iframes = document.querySelectorAll('iframe[data-src]');
            iframes.forEach(iframe => {
                if (iframe.dataset.src) iframe.src = iframe.dataset.src;
            });
        });
    }

    // Simulate human-like interactions
    async simulateHumanBehavior(page) {
        const viewport = await page.viewport();
        
        // Random mouse movements
        for (let i = 0; i < 5; i++) {
            const x = Math.floor(Math.random() * viewport.width);
            const y = Math.floor(Math.random() * viewport.height);
            await page.mouse.move(x, y, { steps: 10 });
            await new Promise(r => setTimeout(r, 200));
        }

        // Scroll behavior
        await this.safeEvaluate(page, async () => {
            const sections = document.querySelectorAll('section, [class*="section"], article');
            for (const section of sections) {
                section.scrollIntoView({ behavior: 'smooth', block: 'center' });
                await new Promise(r => setTimeout(r, 800));
            }
        });

        // Hover over interactive elements
        const interactiveElements = await page.$$('a, button, [class*="hover"], [class*="interactive"]');
        for (const el of interactiveElements.slice(0, 10)) {
            try {
                await el.hover();
                await new Promise(r => setTimeout(r, 300));
            } catch(e) {}
        }
    }

    // Extract all CSS including dynamic and injected styles
    async extractAllStyles(page) {
        return this.safeEvaluate(page, () => {
            const styles = {
                globalCSS: [],
                keyframes: {},
                mediaQueries: [],
                fontFaces: [],
                cssVariables: {},
                inlineStyles: {},
                shadowStyles: []
            };

            // Extract from all style tags
            document.querySelectorAll('style').forEach((tag, index) => {
                if (tag.textContent) {
                    styles.globalCSS.push({
                        content: tag.textContent,
                        id: tag.id || `inline-style-${index}`,
                        media: tag.media || 'all'
                    });
                }
            });

            // Extract from all stylesheets
            try {
                for (const sheet of document.styleSheets) {
                    try {
                        const rules = sheet.cssRules || sheet.rules;
                        if (!rules) continue;

                        for (const rule of rules) {
                            const cssText = rule.cssText;
                            
                            // Keyframes
                            if (rule.type === 7 || rule.cssText.includes('@keyframes')) {
                                const name = rule.name || cssText.match(/@keyframes\s+([^{]+)/)?.[1];
                                if (name) {
                                    styles.keyframes[name.trim()] = cssText;
                                }
                            }
                            
                            // Media queries
                            else if (rule.type === 4 || rule.cssText.includes('@media')) {
                                styles.mediaQueries.push(cssText);
                            }
                            
                            // Font faces
                            else if (rule.type === 5 || rule.cssText.includes('@font-face')) {
                                styles.fontFaces.push(cssText);
                            }
                        }
                    } catch (e) {
                        // CORS restricted stylesheet
                    }
                }
            } catch (e) {}

            // Extract CSS variables from root
            const rootStyles = getComputedStyle(document.documentElement);
            for (let i = 0; i < rootStyles.length; i++) {
                const prop = rootStyles[i];
                if (prop.startsWith('--')) {
                    styles.cssVariables[prop] = rootStyles.getPropertyValue(prop).trim();
                }
            }

            // Extract shadow DOM styles
            const allElements = document.querySelectorAll('*');
            allElements.forEach((el, idx) => {
                if (el.shadowRoot) {
                    const shadowStyles = [];
                    el.shadowRoot.querySelectorAll('style').forEach(style => {
                        shadowStyles.push(style.textContent);
                    });
                    if (shadowStyles.length > 0) {
                        styles.shadowStyles.push({
                            host: el.tagName.toLowerCase(),
                            index: idx,
                            styles: shadowStyles
                        });
                    }
                }
            });

            return styles;
        });
    }

    // Capture WebGL contexts as images/data
    async captureWebGLContexts(page) {
        return this.safeEvaluate(page, () => {
            const contexts = [];
            const canvases = document.querySelectorAll('canvas');
            
            canvases.forEach((canvas, index) => {
                const gl = canvas.getContext('webgl') || canvas.getContext('webgl2');
                if (gl) {
                    try {
                        // Capture current frame as data URL
                        const dataURL = canvas.toDataURL('image/png');
                        contexts.push({
                            index,
                            width: canvas.width,
                            height: canvas.height,
                            dataURL,
                            parameters: {
                                renderer: gl.getParameter(gl.RENDERER),
                                vendor: gl.getParameter(gl.VENDOR),
                                version: gl.getParameter(gl.VERSION)
                            }
                        });
                    } catch(e) {
                        contexts.push({
                            index,
                            error: 'Could not capture WebGL context',
                            width: canvas.width,
                            height: canvas.height
                        });
                    }
                }
            });
            
            return contexts;
        });
    }

    // Capture 2D canvas elements
    async captureCanvasElements(page) {
        return this.safeEvaluate(page, () => {
            const canvases = [];
            const elements = document.querySelectorAll('canvas');
            
            elements.forEach((canvas, index) => {
                const ctx = canvas.getContext('2d');
                if (ctx) {
                    try {
                        const dataURL = canvas.toDataURL('image/png');
                        canvases.push({
                            index,
                            width: canvas.width,
                            height: canvas.height,
                            dataURL,
                            type: '2d'
                        });
                    } catch(e) {
                        canvases.push({
                            index,
                            error: 'Could not capture 2D context',
                            width: canvas.width,
                            height: canvas.height
                        });
                    }
                }
            });
            
            return canvases;
        });
    }

    // Extract complete DOM with computed styles
    async extractDOMSnapshot(page) {
        return this.safeEvaluate(page, () => {
            const cloneNode = (node, depth = 0) => {
                if (depth > 100) return null;
                
                const obj = {
                    tagName: node.tagName ? node.tagName.toLowerCase() : null,
                    nodeType: node.nodeType,
                    attributes: {},
                    computedStyles: {},
                    children: [],
                    textContent: null,
                    boundingBox: null,
                    isVisible: true
                };

                if (node.nodeType === Node.TEXT_NODE) {
                    obj.textContent = node.textContent;
                    return obj;
                }

                if (node.nodeType !== Node.ELEMENT_NODE) return null;

                // Capture all attributes
                if (node.attributes) {
                    for (const attr of node.attributes) {
                        obj.attributes[attr.name] = attr.value;
                    }
                }

                // Capture computed styles with all properties
                const computed = window.getComputedStyle(node);
                const importantStyles = [
                    'display', 'position', 'top', 'right', 'bottom', 'left',
                    'width', 'height', 'margin', 'padding', 'border',
                    'flex', 'grid', 'float', 'clear', 'overflow',
                    'background', 'color', 'font', 'text', 'transform',
                    'animation', 'transition', 'opacity', 'visibility',
                    'z-index', 'pointer-events', 'cursor'
                ];

                // Get all computed properties
                for (let i = 0; i < computed.length; i++) {
                    const prop = computed[i];
                    const value = computed.getPropertyValue(prop);
                    
                    // Filter out default/initial values to reduce noise
                    if (value && value !== '' && value !== 'initial' && 
                        value !== 'none' && value !== 'auto' && 
                        value !== 'normal' && value !== '0px' &&
                        !value.includes('rgba(0, 0, 0, 0)')) {
                        obj.computedStyles[prop] = value;
                    }
                }

                // Check visibility
                const rect = node.getBoundingClientRect();
                obj.boundingBox = {
                    x: rect.x, y: rect.y, 
                    width: rect.width, height: rect.height,
                    top: rect.top, right: rect.right, 
                    bottom: rect.bottom, left: rect.left
                };
                obj.isVisible = rect.width > 0 && rect.height > 0 && 
                               computed.visibility !== 'hidden' && 
                               computed.display !== 'none';

                // Handle shadow DOM
                if (node.shadowRoot) {
                    obj.shadowRoot = {
                        mode: node.shadowRoot.mode,
                        children: []
                    };
                    for (const child of node.shadowRoot.childNodes) {
                        const cloned = cloneNode(child, depth + 1);
                        if (cloned) obj.shadowRoot.children.push(cloned);
                    }
                }

                // Recurse into light DOM children
                if (node.childNodes) {
                    for (const child of node.childNodes) {
                        const cloned = cloneNode(child, depth + 1);
                        if (cloned) obj.children.push(cloned);
                    }
                }

                return obj;
            };

            return cloneNode(document.documentElement);
        });
    }

    // Capture local/session storage
    async captureStorage(page) {
        return this.safeEvaluate(page, () => {
            const data = { localStorage: {}, sessionStorage: {} };
            
            try {
                for (let i = 0; i < localStorage.length; i++) {
                    const key = localStorage.key(i);
                    data.localStorage[key] = localStorage.getItem(key);
                }
                for (let i = 0; i < sessionStorage.length; i++) {
                    const key = sessionStorage.key(i);
                    data.sessionStorage[key] = sessionStorage.getItem(key);
                }
            } catch(e) {}
            
            return data;
        });
    }

    // Capture responsive screenshots
    async captureResponsiveScreenshots(page) {
        const screenshots = {};
        
        for (const viewport of this.viewports) {
            try {
                await page.setViewport({
                    width: viewport.width,
                    height: viewport.height,
                    deviceScaleFactor: viewport.deviceScaleFactor || 1
                });
                
                await new Promise(r => setTimeout(r, 1500));
                
                const screenshotPath = path.join(
                    this.outputDir, 
                    `screenshot-${viewport.name}-${viewport.width}x${viewport.height}.png`
                );
                
                await page.screenshot({ 
                    path: screenshotPath, 
                    fullPage: true,
                    type: 'png',
                    captureBeyondViewport: true
                });
                
                screenshots[viewport.name] = screenshotPath;
                console.log(`[VATH] Captured ${viewport.name} viewport`);
            } catch (e) {
                console.log(`[VATH] Warning: Could not capture ${viewport.name}: ${e.message}`);
            }
        }
        
        return screenshots;
    }

    // Analyze component structure
    analyzeComponentStructure(dom) {
        const patterns = new Map();
        const components = [];
        
        const traverse = (node, path = '') => {
            if (!node || !node.tagName) return;
            
            // Generate signature based on tag and classes
            const classSig = (node.attributes.class || '').split(' ')
                .filter(c => c && !c.match(/^[a-z0-9]{5,}$/)) // Filter out hashed classes
                .sort()
                .join('-');
            
            const signature = `${node.tagName}-${classSig}`;
            
            if (!patterns.has(signature)) {
                patterns.set(signature, { count: 0, nodes: [], variations: new Set() });
            }
            
            const pattern = patterns.get(signature);
            pattern.count++;
            pattern.nodes.push(node);
            pattern.variations.add(JSON.stringify(node.attributes));
            
            if (node.children) {
                node.children.forEach(child => traverse(child, `${path}/${node.tagName}`));
            }
            
            if (node.shadowRoot?.children) {
                node.shadowRoot.children.forEach(child => traverse(child, `${path}/${node.tagName}::shadow`));
            }
        };

        traverse(dom);
        
        // Identify components as repeating patterns
        for (const [signature, data] of patterns) {
            if (data.count >= 2 && signature !== 'html-' && signature !== 'body-') {
                components.push({
                    type: 'component',
                    signature,
                    count: data.count,
                    variations: data.variations.size,
                    sample: data.nodes[0],
                    isList: data.count > 3 && signature.includes('div')
                });
            }
        }

        return components.sort((a, b) => b.count - a.count);
    }

    // Save all captured assets
    async saveAssets(assets, baseUrl) {
        const assetMap = new Map();
        const baseOrigin = new URL(baseUrl).origin;
        
        for (const [url, asset] of assets) {
            if (!asset.data) continue;
            
            try {
                const parsed = new URL(url);
                let filename;
                let subdir = 'misc';
                
                // Determine subdirectory based on type
                if (asset.type === 'image' || asset.contentType?.includes('image')) {
                    subdir = 'images';
                    const ext = this.getExtensionFromMime(asset.contentType) || 
                               path.extname(parsed.pathname) || '.png';
                    filename = `img-${this.generateHash(url)}${ext}`;
                } else if (asset.type === 'font' || asset.contentType?.includes('font')) {
                    subdir = 'fonts';
                    const ext = this.getExtensionFromMime(asset.contentType) || 
                               path.extname(parsed.pathname) || '.woff2';
                    filename = `font-${this.generateHash(url)}${ext}`;
                } else if (asset.type === 'stylesheet' || asset.contentType?.includes('css')) {
                    subdir = 'styles';
                    filename = `style-${this.generateHash(url)}.css`;
                } else if (asset.type === 'script' || asset.contentType?.includes('javascript')) {
                    subdir = 'scripts';
                    filename = `script-${this.generateHash(url)}.js`;
                } else if (asset.contentType?.includes('video')) {
                    subdir = 'videos';
                    const ext = this.getExtensionFromMime(asset.contentType) || '.mp4';
                    filename = `video-${this.generateHash(url)}${ext}`;
                } else if (asset.contentType?.includes('model') || 
                          parsed.pathname.match(/\.(glb|gltf|obj|fbx)$/i)) {
                    subdir = 'models';
                    const ext = path.extname(parsed.pathname) || '.glb';
                    filename = `model-${this.generateHash(url)}${ext}`;
                } else {
                    const ext = path.extname(parsed.pathname) || '.bin';
                    filename = `asset-${this.generateHash(url)}${ext}`;
                }
                
                const filepath = path.join(this.outputDir, 'assets', subdir, filename);
                await fs.writeFile(filepath, asset.data);
                
                assetMap.set(url, {
                    localPath: `./assets/${subdir}/${filename}`,
                    type: asset.type,
                    size: asset.data.length,
                    contentType: asset.contentType
                });
                
            } catch (e) {
                console.log(`[VATH] Failed to save asset ${url}: ${e.message}`);
            }
        }
        
        return assetMap;
    }

    // Extract links for deep crawling
    async extractLinks(page, baseUrl) {
        return this.safeEvaluate(page, (base) => {
            const links = [];
            const baseOrigin = new URL(base).origin;
            
            document.querySelectorAll('a[href]').forEach(a => {
                try {
                    const href = a.href;
                    const url = new URL(href, base);
                    
                    // Only same-origin links
                    if (url.origin === baseOrigin && 
                        !href.includes('#') && 
                        !href.includes('mailto:') &&
                        !href.includes('tel:')) {
                        links.push(url.href);
                    }
                } catch(e) {}
            });
            
            return [...new Set(links)];
        }, baseUrl);
    }

    // Generate all output formats
    async generateAllOutputs(data) {
        const { url, framework, dom, pageHtml, components, assets, screenshots, styles, webgl, canvas, storage, cookies, userAgent, viewport } = data;
        
        // Save raw HTML
        const rawHtml = await this.generateRawHTML(dom, assets, styles);
        await fs.writeFile(path.join(this.outputDir, 'index.html'), rawHtml);
        
        // Save live version (with external scripts)
        if (this.preserveLiveScripts && pageHtml) {
            const liveHtml = this.generateLiveHTML(pageHtml, url);
            await fs.writeFile(path.join(this.outputDir, 'live.html'), liveHtml);
        }
        
        // Save replay server files
        if (this.enableReplay) {
            await this.generateReplayFiles(url, cookies, userAgent, storage, viewport);
        }
        
        // Generate React components
        if (['react', 'nextjs'].includes(framework.framework)) {
            const reactCode = this.generateReactProject(dom, components, assets, styles, framework);
            await fs.writeFile(path.join(this.outputDir, 'App.jsx'), reactCode.app);
            await fs.writeFile(path.join(this.outputDir, 'components.js'), reactCode.components);
            await fs.writeFile(path.join(this.outputDir, 'package.json'), JSON.stringify(reactCode.package, null, 2));
        }
        
        // Generate Vue components
        if (['vue', 'nuxtjs'].includes(framework.framework)) {
            const vueCode = this.generateVueProject(dom, components, assets, styles, framework);
            await fs.writeFile(path.join(this.outputDir, 'App.vue'), vueCode.app);
            await fs.writeFile(path.join(this.outputDir, 'components.vue'), vueCode.components);
        }
        
        // Generate vanilla HTML with Tailwind
        const tailwindHtml = this.generateTailwindHTML(dom, assets, styles);
        await fs.writeFile(path.join(this.outputDir, 'tailwind.html'), tailwindHtml);
        
        // Save extracted styles
        await fs.writeFile(
            path.join(this.outputDir, 'extracted-styles.css'),
            this.compileStylesheet(styles)
        );
        
        // Write disclaimer
        await this.writeDisclaimer(url, framework, this.outputDir);

        // Generate scaffold project
        await this.generateScaffold(framework, dom, styles, assets);

        // Generate inferred component library
        await this.generateComponentLibrary(components, styles);

        // Generate runnable React replica project
        await this.generateReplicaReact(pageHtml, styles, assets, { framework: framework.framework, domSnapshot: dom, sourceUrl: url });

        // Save metadata
        const metadata = {
            source: url,
            extractedAt: new Date().toISOString(),
            framework: framework.framework,
            animationLibraries: framework.animationLibs,
            uiLibraries: framework.uiLibraries,
            stateManagement: framework.stateManagement,
            buildTool: framework.buildTool,
            componentsDetected: components.length,
            assetsExtracted: assets.size,
            webglContexts: webgl?.length || 0,
            canvasElements: canvas?.length || 0,
            viewports: Object.keys(screenshots),
            hasShadowDOM: dom.shadowRoot !== undefined,
            cookies: cookies.length,
            storage: {
                localStorage: Object.keys(storage.localStorage).length,
                sessionStorage: Object.keys(storage.sessionStorage).length
            }
        };
        
        await fs.writeFile(
            path.join(this.outputDir, 'Vath-manifest.json'),
            JSON.stringify(metadata, null, 2)
        );
        
        // Save WebGL/Canvas captures
        if (webgl?.length > 0) {
            await fs.writeFile(
                path.join(this.outputDir, 'webgl-captures.json'),
                JSON.stringify(webgl, null, 2)
            );
        }
        if (canvas?.length > 0) {
            await fs.writeFile(
                path.join(this.outputDir, 'canvas-captures.json'),
                JSON.stringify(canvas, null, 2)
            );
        }
    }


    // Write extraction disclaimer
    async writeDisclaimer(url, framework, outputDir) {
        const disclaimer = `# Extraction Manifest: ${url}

## What You Have

### 1. Replay Package (live.html + replay-server.js)
- Fidelity: high visual and behavioral match
- Limitation: requires local proxy, not a true source project
- Use when: you need to view the original site behavior

### 2. Structural Scaffold (scaffold/)
- Fidelity: structural and visual baseline
- Limitation: no original logic, data, routing, or state
- Use when: you need an editable starting point

### 3. Component Library (library/)
- Fidelity: inferred components from DOM patterns
- Limitation: heuristic; not original architecture
- Use when: you want reusable building blocks

## What You Do Not Have
- Original source code and component hierarchy
- Hooks, composables, state management logic
- Data fetching logic and server behavior
- Build pipeline configuration and source maps
- Private APIs, secrets, and environment variables
`;

        await fs.writeFile(path.join(outputDir, 'Vath-DISCLAIMER.md'), disclaimer);
    }

    // Generate scaffold project based on framework
    async generateScaffold(framework, dom, styles, assets) {
        const scaffoldDir = path.join(this.outputDir, 'scaffold');
        await fs.ensureDir(scaffoldDir);

        if (framework.framework === 'nextjs') {
            const nextDir = path.join(scaffoldDir, 'nextjs');
            await fs.ensureDir(path.join(nextDir, 'app'));
            const reactCode = this.generateReactProject(dom, [], assets, styles, framework);

            const layout = `import './globals.css'

export const metadata = { title: 'Extracted App' }

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}`;

            await fs.writeFile(path.join(nextDir, 'app', 'layout.tsx'), layout);
            await fs.writeFile(path.join(nextDir, 'app', 'page.tsx'), reactCode.app.replace('export default function App()', 'export default function Page()'));
            await fs.writeFile(path.join(nextDir, 'app', 'globals.css'), this.compileStylesheet(styles));

            const pkg = {
                name: 'Vath-nextjs',
                private: true,
                scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
                dependencies: { next: '^14.0.0', react: '^18.2.0', 'react-dom': '^18.2.0' }
            };
            await fs.writeFile(path.join(nextDir, 'package.json'), JSON.stringify(pkg, null, 2));
        } else if (framework.framework === 'vue' || framework.framework === 'nuxtjs') {
            const vueDir = path.join(scaffoldDir, 'vue');
            await fs.ensureDir(vueDir);
            const vueCode = this.generateVueProject(dom, [], assets, styles, framework);
            await fs.writeFile(path.join(vueDir, 'App.vue'), vueCode.app);
            await fs.writeFile(path.join(vueDir, 'extracted-styles.css'), this.compileStylesheet(styles));
        } else {
            const reactDir = path.join(scaffoldDir, 'react');
            await fs.ensureDir(reactDir);
            const reactCode = this.generateReactProject(dom, [], assets, styles, framework);
            await fs.writeFile(path.join(reactDir, 'App.jsx'), reactCode.app);
            await fs.writeFile(path.join(reactDir, 'extracted-styles.css'), this.compileStylesheet(styles));
        }
    }

    // Generate inferred component library
    async generateComponentLibrary(components, styles) {
        const libDir = path.join(this.outputDir, 'library');
        await fs.ensureDir(libDir);
        await fs.ensureDir(path.join(libDir, 'components'));

        const list = [];
        const toSafe = (s) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();

        for (let i = 0; i < Math.min(components.length, 30); i++) {
            const c = components[i];
            const name = `Component${i + 1}`;
            const className = c.sample?.attributes?.class || '';
            const file = path.join(libDir, 'components', `${name}.tsx`);
            const code = `// Inferred component: ${c.signature}
// NOTE: This is a structural placeholder

import React from 'react';

export default function ${name}() {
  return (
    <div className="${className.replace(/"/g, '\\"')}">
      {/* TODO: implement markup */}
    </div>
  );
}`;
            await fs.writeFile(file, code);
            list.push(`- ${name}: ${c.signature}`);
        }

        const readme = `# Component Library

Generated components (inferred):

${list.join('\n')}
`;
        await fs.writeFile(path.join(libDir, 'README.md'), readme);
        await fs.writeFile(path.join(libDir, 'extracted-styles.css'), this.compileStylesheet(styles));
    }


    // Generate a runnable React replica project (Vite)
    async generateReplicaReact(pageHtml, styles, assets, framework) {
        const projDir = path.join(this.outputDir, 'replica-react');
        const srcDir = path.join(projDir, 'src');
        const pubDir = path.join(projDir, 'public');
        const replayDir = path.join(pubDir, 'replay');
        const assetsDir = path.join(pubDir, 'assets');

        await fs.ensureDir(srcDir);
        await fs.ensureDir(pubDir);
        await fs.ensureDir(replayDir);
        await fs.ensureDir(assetsDir);

        // Write live.html into public/replay
        if (pageHtml) {
            const liveHtml = this.generateLiveHTML(pageHtml, framework.sourceUrl || '');
            await fs.writeFile(path.join(replayDir, 'live.html'), liveHtml);
        }

        // Copy extracted assets into public/assets
        try {
            await fs.copy(path.join(this.outputDir, 'assets'), assetsDir);
        } catch {}

        // Write extracted styles
        await fs.writeFile(path.join(srcDir, 'extracted-styles.css'), this.compileStylesheet(styles));

        // Create ScaffoldView from generated React code
        const reactCode = this.generateReactProject(framework.domSnapshot, [], assets, styles, framework);
        let scaffold = reactCode.app || '';
        scaffold = scaffold.replace(/import '\.\/App\.css';\s*/g, '');
        scaffold = scaffold.replace(/export default function App\(\)/, 'export default function ScaffoldView()');

        const scaffoldFile = `// Auto-generated scaffold view
${scaffold}`;
        await fs.writeFile(path.join(srcDir, 'ScaffoldView.jsx'), scaffoldFile);

        // App.jsx with hash-based routing (no extra deps)
        const app = `import React, { useEffect, useState } from 'react';
import './extracted-styles.css';
import ScaffoldView from './ScaffoldView';

function ReplayView() {
  const proxyUrl = 'http://localhost:8799/';
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <iframe
        title="Replay"
        src="/replay/live.html"
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
    </div>
  );
}

export default function App() {
  const [route, setRoute] = useState(window.location.hash || '#/replay');

  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || '#/replay');
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div>
      <nav style={{ position: 'fixed', top: 8, right: 8, zIndex: 9999, display: 'flex', gap: 8 }}>
        <a href="#/replay" style={{ padding: '6px 10px', background: '#111', color: '#fff', textDecoration: 'none', borderRadius: 6 }}>Replay</a>
        <a href="#/scaffold" style={{ padding: '6px 10px', background: '#111', color: '#fff', textDecoration: 'none', borderRadius: 6 }}>Scaffold</a>
      </nav>
      {route === '#/scaffold' ? <ScaffoldView /> : <ReplayView />}
    </div>
  );
}
`;

        const main = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
`;

        const indexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Vath Replica (React)</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;

        const viteConfig = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 }
});
`;

        const pkg = {
            name: 'Vath-replica-react',
            private: true,
            scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
            dependencies: { react: '^18.2.0', 'react-dom': '^18.2.0' },
            devDependencies: { vite: '^5.0.0', '@vitejs/plugin-react': '^4.0.0' }
        };

        await fs.writeFile(path.join(srcDir, 'App.jsx'), app);
        await fs.writeFile(path.join(srcDir, 'main.jsx'), main);
        await fs.writeFile(path.join(projDir, 'index.html'), indexHtml);
        await fs.writeFile(path.join(projDir, 'vite.config.js'), viteConfig);
        await fs.writeFile(path.join(projDir, 'package.json'), JSON.stringify(pkg, null, 2));
    }

    // Compile extracted styles into CSS
    compileStylesheet(styles) {
        let css = '/* Extracted by Deus Ex Vath\'s Mirror */\n\n';
        
        // CSS Variables
        if (Object.keys(styles.cssVariables).length > 0) {
            css += ':root {\n';
            for (const [key, value] of Object.entries(styles.cssVariables)) {
                css += `  ${key}: ${value};\n`;
            }
            css += '}\n\n';
        }
        
        // Font faces
        if (styles.fontFaces?.length > 0) {
            css += styles.fontFaces.join('\n\n') + '\n\n';
        }
        
        // Keyframes
        if (styles.keyframes) {
            css += Object.values(styles.keyframes).join('\n\n') + '\n\n';
        }
        
        // Media queries
        if (styles.mediaQueries?.length > 0) {
            css += styles.mediaQueries.join('\n\n') + '\n\n';
        }
        
        // Global CSS from style tags
        if (styles.globalCSS?.length > 0) {
            css += styles.globalCSS.map(s => s.content).join('\n\n') + '\n\n';
        }
        
        return css;
    }

    // Generate raw HTML with inlined assets
    generateRawHTML(dom, assets, styles) {
        // Convert DOM to HTML string
        const domToHTML = (node) => {
            if (!node) return '';
            if (node.nodeType === 3) return node.textContent || '';
            if (node.nodeType !== 1) return '';
            
            const tag = node.tagName;
            const attrs = Object.entries(node.attributes || {})
                .map(([k, v]) => `${k}="${v.replace(/"/g, '&quot;')}"`)
                .join(' ');
            
            const children = (node.children || []).map(domToHTML).join('');
            
            if (['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'wbr'].includes(tag)) {
                return attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
            }
            
            return attrs ? `<${tag} ${attrs}>${children}</${tag}>` : `<${tag}>${children}</${tag}>`;
        };
        
        const bodyContent = dom.children?.find(c => c.tagName === 'body')?.children
            ?.map(domToHTML).join('') || '';
        
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Extracted by Vath's Mirror</title>
    <style>${this.compileStylesheet(styles)}</style>
</head>
<body>
    ${bodyContent}
    <script>
        console.log("%c[VATH] Liberated from the Demiurge's chains", "color: #ff0066; font-size: 20px; font-weight: bold;");
    </script>
</body>
</html>`;
    }

    // Generate live HTML with original script references
    generateLiveHTML(pageHtml, baseUrl) {
        const origin = new URL(baseUrl).origin;
        let html = pageHtml;

        // Remove CSP meta to allow scripts/styles to execute
        html = html.replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');

        // Inject base href so relative chunks resolve
        if (/<base\\s/i.test(html)) {
            html = html.replace(/<base[^>]*>/i, `<base href="${origin}/">`);
        } else {
            html = html.replace(/<head[^>]*>/i, (m) => `${m}\n    <base href="${origin}/">`);
        }

        // Strip integrity/crossorigin (can block local execution)
        html = html.replace(/\\s+integrity=["'][^"']+["']/gi, '');
        html = html.replace(/\\s+crossorigin=["'][^"']+["']/gi, '');

        // Inject auto-trigger script to nudge GSAP/ScrollTrigger/Lenis/etc.
        const triggerScript = `
<script>
  (function () {
    function pulse() {
      try {
        if (window.ScrollTrigger && window.ScrollTrigger.refresh) {
          window.ScrollTrigger.refresh();
        }
        if (window.gsap && window.gsap.ticker && window.gsap.ticker.wake) {
          window.gsap.ticker.wake();
        }
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('scroll'));
      } catch (e) {}
    }
    window.addEventListener('load', () => {
      pulse();
      const max = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight) || 0;
      const steps = 6;
      let i = 0;
      const timer = setInterval(() => {
        i++;
        const y = Math.floor((max * i) / steps);
        window.scrollTo(0, y);
        pulse();
        if (i >= steps) {
          window.scrollTo(0, 0);
          pulse();
          clearInterval(timer);
        }
      }, 300);
    });
  })();
</script>
`;
        if (/<\/body>/i.test(html)) {
            html = html.replace(/<\/body>/i, `${triggerScript}\n</body>`);
        } else {
            html += triggerScript;
        }

        return html;
    }

    // Generate replay server files
    async generateReplayFiles(url, cookies, userAgent, storage, viewport) {
        // Save cookies
        await fs.writeFile(
            path.join(this.outputDir, 'replay-cookies.json'),
            JSON.stringify(cookies, null, 2)
        );
        
        // Save headers
        await fs.writeFile(
            path.join(this.outputDir, 'replay-headers.json'),
            JSON.stringify({
                userAgent,
                viewport,
                language: 'en-US,en;q=0.9'
            }, null, 2)
        );
        
        // Save storage
        await fs.writeFile(
            path.join(this.outputDir, 'replay-storage.json'),
            JSON.stringify(storage, null, 2)
        );
        
        // Save base URL (for referer/origin)
        await fs.writeFile(
            path.join(this.outputDir, 'replay-base.json'),
            JSON.stringify({ url, origin: new URL(url).origin }, null, 2)
        );

        // Generate replay server
        const serverCode = this.generateReplayServerCode(url);
        await fs.writeFile(
            path.join(this.outputDir, 'replay-server.js'),
            serverCode
        );
    }

    // Generate replay server code
    generateReplayServerCode(baseUrl) {
        return `const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || ${this.replayPort};
const BASE_URL = '${baseUrl}';
const ROOT = __dirname;

const mimeTypes = {
    '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg',
    '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json'
};

function loadCookies() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'replay-cookies.json'), 'utf8'));
    } catch { return []; }
}

function buildCookieHeader(targetUrl) {
    const cookies = loadCookies();
    if (!cookies.length) return '';
    const urlObj = new URL(targetUrl);
    const relevant = cookies.filter(c => {
        const domain = c.domain || urlObj.hostname;
        return urlObj.hostname.endsWith(domain.replace(/^\\./, ''));
    });
    return relevant.map(c => \`\${c.name}=\${c.value}\`).join('; ');
}

const server = http.createServer((req, res) => {
    const parsed = url.parse(req.url, true);
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        return res.end();
    }
    
    // Proxy endpoint
    if (parsed.pathname === '/proxy') {
        const targetUrl = parsed.query.url;
        if (!targetUrl) {
            res.writeHead(400);
            return res.end('Missing URL');
        }
        
        const client = targetUrl.startsWith('https') ? https : http;
        const cookieHeader = buildCookieHeader(targetUrl);
        
        const base = loadBase();
        const options = new URL(targetUrl);
        options.headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Cookie': cookieHeader,
            'Accept': '*/*',
            'Origin': base.origin,
            'Referer': base.url
        };
        
        client.get(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, {
                'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream'
            });
            proxyRes.pipe(res);
        }).on('error', (err) => {
            res.writeHead(502);
            res.end('Proxy Error: ' + err.message);
        });
        
        return;
    }
    
    // Serve local files
    let filePath = path.join(
        ROOT,
        parsed.pathname === '/'
            ? (fs.existsSync(path.join(ROOT, 'live.html')) ? 'live.html' : 'index.html')
            : parsed.pathname
    );
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(\`[VATH] Replay server running at http://localhost:\${PORT}\`);
    console.log(\`[VATH] Proxy endpoint: http://localhost:\${PORT}/proxy?url=...\`);
});
`;
    }

    // Generate React project structure
    generateReactProject(dom, components, assets, styles, framework) {
        const convertToJSX = (node, depth = 0) => {
            if (!node) return '';
            if (node.nodeType === 3) {
                const text = (node.textContent || '').trim();
                return text ? `{"${text.replace(/"/g, '\\"')}"}` : '';
            }
            
            const tag = node.tagName || 'div';
            
            // Build style object
            const styleObj = {};
            if (node.computedStyles) {
                Object.entries(node.computedStyles).forEach(([prop, val]) => {
                    const camelProp = prop.replace(/-([a-z])/g, (g) => g[1].toUpperCase());
                    const numVal = parseFloat(val);
                    const isNum = !isNaN(numVal) && 
                        ['opacity', 'zIndex', 'fontWeight', 'flexGrow', 'flexShrink', 'order'].includes(camelProp);
                    styleObj[camelProp] = isNum ? numVal : val;
                });
            }
            
            const stylePairs = Object.entries(styleObj).map(([k, v]) => {
                const val = typeof v === 'number'
                    ? v
                    : `"${String(v).replace(/"/g, '\\"')}"`;
                return `${k}: ${val}`;
            });
            const styleStr = stylePairs.length > 0
                ? ` style={{${stylePairs.join(', ')}}}`
                : '';
            
            // Other attributes
            const attrBlacklist = ['style', 'class', 'for', 'checked', 'selected'];
            const attrs = Object.entries(node.attributes || {})
                .filter(([k]) => !attrBlacklist.includes(k))
                .map(([k, v]) => {
                    if (k === 'class') return `className="\${v}"`;
                    if (k === 'for') return `htmlFor="\${v}"`;
                    return `\${k}="\${v.replace(/"/g, '\\\\"')}"`;
                })
                .join(' ');
            
            const children = (node.children || [])
                .map(c => convertToJSX(c, depth + 1))
                .filter(c => c)
                .join('');
            
            if (['img', 'input', 'br', 'hr', 'meta', 'link'].includes(tag)) {
                return `<\${tag}\${styleStr} \${attrs} />`;
            }
            
            return `<\${tag}\${styleStr} \${attrs}>\${children}</\${tag}>`;
        };

        const body = dom.children?.find(c => c.tagName === 'body');
        const jsx = convertToJSX(body);
        
        const appCode = `import React from 'react';
import './App.css';

// Extracted by Deus Ex Vath's Mirror
// Framework detected: \${framework.framework}
// Animation libraries: \${framework.animationLibs.join(', ') || 'None'}

export default function App() {
  return (
    <div className="Vath-extracted">
      \${jsx}
    </div>
  );
}
`;

        const stylesCode = this.compileStylesheet(styles);
        
        const packageJson = {
            name: "Vath-extracted",
            version: "1.0.0",
            private: true,
            dependencies: {
                "react": "^18.2.0",
                "react-dom": "^18.2.0",
                "react-scripts": "5.0.1"
            },
            scripts: {
                "start": "react-scripts start",
                "build": "react-scripts build"
            },
            eslintConfig: {
                extends: ["react-app"]
            },
            browserslist: [">0.2%", "not dead", "not ie <= 11", "not op_mini all"]
        };

        return {
            app: appCode,
            components: '// Component exports would go here',
            styles: stylesCode,
            package: packageJson
        };
    }

    // Generate Vue project structure
    generateVueProject(dom, components, assets, styles, framework) {
        const convertToVue = (node) => {
            if (!node) return '';
            if (node.nodeType === 3) {
                const text = (node.textContent || '').trim();
                return text || '';
            }
            
            const tag = node.tagName || 'div';
            
            const styleBindings = Object.entries(node.computedStyles || {})
                .map(([k, v]) => `'${k}': '${String(v).replace(/'/g, "\\'")}'`)
                .join(', ');
            
            const styleAttr = styleBindings ? ` :style="{ ${styleBindings} }"` : '';
            
            const attrs = Object.entries(node.attributes || {})
                .filter(([k]) => k !== 'style')
                .map(([k, v]) => {
                    if (k === 'class') return `class="${v}"`;
                    return `${k}="${v}"`;
                })
                .join(' ');
            
            const children = (node.children || [])
                .map(convertToVue)
                .filter(c => c)
                .join('\n      ');
            
            return `<${tag}${styleAttr} ${attrs}>\n      ${children}\n    </${tag}>`;
        };

        const body = dom.children?.find(c => c.tagName === 'body');
        const template = convertToVue(body);

        const vueCode = `<template>
  <div class="Vath-extracted">
    \${template}
  </div>
</template>

<script>
export default {
  name: 'ExtractedApp',
  data() {
    return {
      // State extracted from source
    }
  },
  mounted() {
    console.log('[VATH] Component mounted - liberated from the Demiurge\\\\'s chains')
  }
}
</script>

<style scoped>
\${this.compileStylesheet(styles)}
</style>
`;

        return {
            app: vueCode,
            components: '<!-- Component files would go here -->'
        };
    }

    // Generate Tailwind HTML
    generateTailwindHTML(dom, assets, styles) {
        const convertToHTML = (node) => {
            if (!node) return '';
            if (node.nodeType === 3) return node.textContent || '';
            
            const tag = node.tagName || 'div';
            const attrs = Object.entries(node.attributes || {})
                .map(([k, v]) => `\${k}="\${v}"`)
                .join(' ');
            
            const children = (node.children || [])
                .map(convertToHTML)
                .join('');
            
            return `<\${tag} \${attrs}>\${children}</\${tag}>`;
        };

        const body = dom.children?.find(c => c.tagName === 'body');
        const content = convertToHTML(body);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vath's Mirror - Tailwind</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        \${this.compileStylesheet(styles)}
    </style>
</head>
<body>
    \${content}
</body>
</html>`;
    }
}

async function zipReplicaReact(outputDir) {
    const sourceDir = path.join(outputDir, 'replica-react');
    const zipPath = path.join(outputDir, 'replica-react.zip');

    const exists = await fs.pathExists(sourceDir);
    if (!exists) {
        throw new Error(`replica-react not found at ${sourceDir}`);
    }

    if (process.platform === 'win32') {
        const srcEsc = sourceDir.replace(/'/g, "''");
        const zipEsc = zipPath.replace(/'/g, "''");
        const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${srcEsc}\\*' -DestinationPath '${zipEsc}' -Force"`;
        await execPromise(cmd);
    } else {
        const cmd = `zip -r "${zipPath}" .`;
        await execPromise(cmd, { cwd: sourceDir });
    }

    return zipPath;
}

function isValidUrl(input) {
    try {
        const u = new URL(input);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

function sendJson(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(text);
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'application/javascript; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.gif') return 'image/gif';
    return 'application/octet-stream';
}

function startUiServer({ port = 8788 } = {}) {
    const jobs = new Map();
    const uiRoot = path.join(__dirname, 'ui');

    function getJob(id) {
        return jobs.get(id);
    }

    async function runJob(job) {
        job.state = 'running';
        job.startedAt = Date.now();
        job.logs = job.logs || [];

        const mirror = new VathsMirror({
            headless: 'new',
            waitForUser: false,
            deepCrawl: false,
            maxDepth: 2
        });

        const originalLog = console.log;
        const originalErr = console.error;
        console.log = (...args) => {
            const line = args.map(String).join(' ');
            job.logs.push(line);
            originalLog(...args);
        };
        console.error = (...args) => {
            const line = args.map(String).join(' ');
            job.logs.push(line);
            originalErr(...args);
        };

        try {
            await mirror.awaken(job.url);
            job.outputDir = mirror.outputDir;
            job.previewUrl = `/preview/${job.id}/replay/live.html`;

            const zipPath = await zipReplicaReact(job.outputDir);
            job.zipPath = zipPath;
            job.zipUrl = `/download/${job.id}`;

            job.state = 'done';
            job.finishedAt = Date.now();
        } catch (err) {
            job.state = 'error';
            job.error = err?.message || String(err);
            job.finishedAt = Date.now();
        } finally {
            console.log = originalLog;
            console.error = originalErr;
        }
    }

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const pathname = url.pathname;

        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
            const filePath = path.join(uiRoot, 'index.html');
            try {
                const buf = await fs.readFile(filePath);
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(buf);
            } catch (err) {
                sendText(res, 500, 'UI not found.');
            }
            return;
        }

        if (req.method === 'GET' && (pathname === '/app.js' || pathname === '/app.css' || pathname === '/favicon.svg')) {
            const filePath = path.join(uiRoot, pathname.slice(1));
            try {
                const buf = await fs.readFile(filePath);
                res.writeHead(200, { 'Content-Type': contentTypeFor(filePath) });
                res.end(buf);
            } catch {
                sendText(res, 404, 'Not found.');
            }
            return;
        }

        if (req.method === 'GET' && pathname === '/favicon.ico') {
            const filePath = path.join(uiRoot, 'favicon.svg');
            try {
                const buf = await fs.readFile(filePath);
                res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
                res.end(buf);
            } catch {
                sendText(res, 404, 'Not found.');
            }
            return;
        }

        if (req.method === 'POST' && pathname === '/api/clone') {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                let payload;
                try {
                    payload = JSON.parse(body || '{}');
                } catch {
                    sendJson(res, 400, { error: 'Invalid JSON.' });
                    return;
                }
                const targetUrl = String(payload.url || '').trim();
                if (!isValidUrl(targetUrl)) {
                    sendJson(res, 400, { error: 'Please provide a valid http(s) URL.' });
                    return;
                }

                const id = crypto.randomUUID();
                const job = { id, url: targetUrl, state: 'queued', logs: [] };
                jobs.set(id, job);
                runJob(job);

                sendJson(res, 200, { id });
            });
            return;
        }

        if (req.method === 'GET' && pathname === '/api/status') {
            const id = url.searchParams.get('id');
            const job = id ? getJob(id) : null;
            if (!job) {
                sendJson(res, 404, { error: 'Job not found.' });
                return;
            }

            const cursor = parseInt(url.searchParams.get('cursor') || '0', 10) || 0;
            const logs = job.logs.slice(cursor);
            sendJson(res, 200, {
                id: job.id,
                state: job.state,
                error: job.error || null,
                outputDir: job.outputDir || null,
                previewUrl: job.previewUrl || null,
                zipUrl: job.zipUrl || null,
                cursor: cursor + logs.length,
                logs
            });
            return;
        }

        if (req.method === 'GET' && pathname.startsWith('/download/')) {
            const id = pathname.split('/').pop();
            const job = getJob(id);
            if (!job || !job.zipPath) {
                sendText(res, 404, 'Zip not ready.');
                return;
            }
            try {
                const buf = await fs.readFile(job.zipPath);
                res.writeHead(200, {
                    'Content-Type': 'application/zip',
                    'Content-Disposition': 'attachment; filename="replica-react.zip"'
                });
                res.end(buf);
            } catch {
                sendText(res, 500, 'Failed to read zip.');
            }
            return;
        }

        if (req.method === 'GET' && pathname.startsWith('/preview/')) {
            const parts = pathname.split('/');
            const id = parts[2];
            const job = getJob(id);
            if (!job || !job.outputDir) {
                sendText(res, 404, 'Preview not ready.');
                return;
            }
            const relPath = parts.slice(3).join('/') || 'index.html';
            const baseDir = path.resolve(path.join(job.outputDir, 'replica-react', 'public'));
            const resolved = path.resolve(baseDir, relPath);
            const baseCmp = baseDir.toLowerCase();
            const resCmp = resolved.toLowerCase();
            if (!(resCmp === baseCmp || resCmp.startsWith(baseCmp + path.sep))) {
                sendText(res, 400, 'Invalid path.');
                return;
            }
            try {
                const buf = await fs.readFile(resolved);
                res.writeHead(200, { 'Content-Type': contentTypeFor(resolved) });
                res.end(buf);
            } catch {
                sendText(res, 404, 'Not found.');
            }
            return;
        }

        sendText(res, 404, 'Not found.');
    });

    server.listen(port, () => {
        console.log(`[VATH] UI server running at http://localhost:${port}`);
    });
}

// CLI Interface
const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const getArgValue = (flag) => {
    const idx = args.indexOf(flag);
    if (idx == -1) return undefined;
    const val = args[idx + 1];
    return val && !val.startsWith('--') ? val : undefined;
};
const url = args.find(arg => !arg.startsWith('--'));

if (flags.has('--ui')) {
    const portArg = getArgValue('--port');
    const port = portArg ? parseInt(portArg, 10) || 8788 : 8788;
    startUiServer({ port });
    return;
}

if (!url) {
    console.log(`
[VATH] Usage: node Vaths-mirror.js <url> [options]

Options:
  --headed          Run with visible browser window
  --wait            Wait for user input before extraction
  --deep            Enable deep crawling (follows links)
  --max-depth <n>   Maximum crawl depth (default: 3)
  --output <dir>    Output directory (default: ./extracted-<timestamp>)
  --ui              Start ChatGPT-like UI
  --port <n>        Port for UI server (default: 8788)

Examples:
  node Vaths-mirror.js https://example.com
  node Vaths-mirror.js https://example.com --headed --wait
  node Vaths-mirror.js https://example.com --deep --max-depth 2
  node Vaths-mirror.js --ui --port 8788
`);
    process.exit(1);
}

const maxDepthArg = getArgValue('--max-depth');
const outputArg = getArgValue('--output');

const options = {
    headless: !flags.has('--headed'),
    waitForUser: flags.has('--wait'),
    deepCrawl: flags.has('--deep'),
    maxDepth: maxDepthArg ? parseInt(maxDepthArg, 10) || 3 : 3,
    outputDir: outputArg
};



const mirror = new VathsMirror(options);
mirror.awaken(url).then(() => {
    console.log(`[VATH] Ritual complete. Output: \${mirror.outputDir}`);
    process.exit(0);
}).catch(err => {
    console.error('[VATH] Ritual failed:', err);
    process.exit(1);
});
function loadBase() {
    try {
        return JSON.parse(fs.readFileSync(path.join(ROOT, 'replay-base.json'), 'utf8'));
    } catch { return { url: BASE_URL, origin: new URL(BASE_URL).origin }; }
}
