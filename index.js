import puppeteer from 'puppeteer-extra'
import axios from 'axios'
import { CookieJar } from 'tough-cookie'
import { wrapper } from 'axios-cookiejar-support'
import yargs from 'yargs'
import nodemailer from 'nodemailer'
import 'dotenv/config'
import fs from 'fs/promises'

const cliArgs = yargs(process.argv.slice(2))
    .option('email', { type: 'string', describe: 'Raleys account email address' })
    .option('password', { type: 'string', describe: 'Raleys account password' })
    .option('headless', { type: 'boolean', default: true, describe: 'Run browser in headless mode' })
    .option('minStartDelay', { type: 'number', describe: 'Minimum random delay before starting the script in milliseconds (default 0)', alias: 'minstartdelay' })
    .option('maxStartDelay', { type: 'number', describe: 'Maximum random delay before starting the script in milliseconds (default 0)', alias: 'maxstartdelay' })
    .option('minRequestDelay', { type: 'number', describe: 'Minimum random delay between clip requests in milliseconds (default 1000)', alias: 'minrequestdelay' })
    .option('maxRequestDelay', { type: 'number', describe: 'Maximum random delay between clip requests in milliseconds (default 5000)', alias: 'maxrequestdelay' })
    .option('saveCookies', { type: 'boolean', describe: 'Save cookies to disk after login (default false)', alias: 'savecookies' })
    .option('loadCookies', { type: 'boolean', describe: 'Load cookies from disk instead of logging in (default false)', alias: 'loadcookies' })
    .option('cookiesFile', { type: 'string', describe: 'Path to cookies JSON file (default ./cookies.json)', alias: 'cookiesfile' })
    .option('asyncClipping', { type: 'boolean', describe: 'Enable async clipping mode. Wont wait for the previous clip request to finish before starting the next one (default false)', alias: 'asyncclipping' })
    .help()
    .parseSync()

function getConfig() {
    const getEnvNumber = (key, fallback) => process.env[key] !== undefined ? parseInt(process.env[key], 10) : fallback
    const getEnvString = (key, fallback) => process.env[key] !== undefined ? process.env[key] : fallback
    const getEnvBoolean = (key, fallback = false) => {
        const val = process.env[key]
        if (val === undefined) return fallback
        return ['true', '1', 'yes'].includes(String(val).toLowerCase())
    }

    return {
        email: cliArgs.email || process.env.RALEYS_EMAIL,
        password: cliArgs.password || process.env.RALEYS_PASSWORD,
        headless: cliArgs.headless,
        minStartDelay: cliArgs.minStartDelay ?? getEnvNumber('MIN_START_DELAY', 0),
        maxStartDelay: cliArgs.maxStartDelay ?? getEnvNumber('MAX_START_DELAY', 0),
        minRequestDelay: cliArgs.minRequestDelay ?? getEnvNumber('MIN_REQUEST_DELAY', 1000),
        maxRequestDelay: cliArgs.maxRequestDelay ?? getEnvNumber('MAX_REQUEST_DELAY', 5000),
        saveCookies: cliArgs.saveCookies ?? getEnvBoolean('SAVE_COOKIES', false),
        loadCookies: cliArgs.loadCookies ?? getEnvBoolean('LOAD_COOKIES', false),
        cookiesFile: cliArgs.cookiesFile || getEnvString('COOKIES_FILE', './cookies.json'),
        asyncClipping: cliArgs.asyncClipping ?? getEnvBoolean('ASYNC_CLIPPING', false),
        logFile: getEnvString('LOG_FILE', 'autoclip.log'),
        logMaxSize: getEnvNumber('LOG_MAX_SIZE', 1024 * 1024),
        smtpHost: getEnvString('SMTP_HOST', ''),
        smtpPort: getEnvNumber('SMTP_PORT', 587),
        smtpSecure: getEnvBoolean('SMTP_SECURE', false),
        smtpUser: getEnvString('SMTP_USER', ''),
        smtpPass: getEnvString('SMTP_PASS', ''),
        alertTo: getEnvString('ALERT_TO', ''),
        alertFrom: getEnvString('ALERT_FROM', getEnvString('SMTP_USER', '')),
        emailOnSuccess: getEnvBoolean('EMAIL_ON_SUCCESS', true),
        loginDebugEnabled: getEnvBoolean('LOGIN_DEBUG_ENABLED', true),
        loginDebugDir: getEnvString('LOGIN_DEBUG_DIR', './debug')
    }
}

const config = getConfig()

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))
const randomSleep = (min, max) => sleep(Math.floor(Math.random() * (max - min + 1)) + min)
const timestamp = () => new Date().toISOString().replace('T', ' ').replace('Z', '')

async function appendLog(level, message) {
    const line = `[${timestamp()}] [${level}] ${message}`
    const outputFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log
    outputFn(level === 'INFO' ? `[Info] ${message}` : level === 'WARN' ? `[Warn] ${message}` : `[Error] ${message}`)
    await fs.appendFile(config.logFile, `${line}\n`, 'utf-8')
}

async function trimLogIfNeeded() {
    try {
        const stat = await fs.stat(config.logFile)
        if (stat.size <= config.logMaxSize) {
            return
        }

        const content = await fs.readFile(config.logFile, 'utf-8')
        const lines = content.split(/\r?\n/).filter(Boolean)
        const keptLines = lines.slice(-20)
        await fs.writeFile(config.logFile, `${keptLines.join('\n')}\n`, 'utf-8')
        await appendLog('INFO', `Log exceeded ${config.logMaxSize} bytes and was trimmed to the newest 20 lines.`)
    } catch (error) {
        if (error.code !== 'ENOENT') {
            await appendLog('WARN', `Unable to trim log file: ${error.message}`)
        }
    }
}

async function readLogContent() {
    try {
        return await fs.readFile(config.logFile, 'utf-8')
    } catch (error) {
        if (error.code === 'ENOENT') return 'No logfile generated.'
        return `Could not read logfile: ${error.message}`
    }
}

async function sendRunEmail({ success, errorMessage }) {
    const smtpReady = config.smtpHost && config.smtpUser && config.smtpPass && config.alertTo && config.alertFrom
    if (!smtpReady) {
        await appendLog('WARN', 'Email notification skipped because SMTP or alert settings are missing.')
        return
    }

    const subject = success ? 'Raleys Auto Clipper: Run Succeeded' : 'Raleys Auto Clipper: Run Failed'
    const logContent = await readLogContent()
    const failureText = String(errorMessage || '')
    const looksLikeAuthFailure = /cookie|cookies|login|captcha|unauthorized|headless mode requires cookie auth|manual login/i.test(failureText)
    const recoveryInstructions = looksLikeAuthFailure
        ? `\n\nCookie recovery steps:\n1) Re-run in visible mode to re-establish auth cookies:\n   node index.js --headless false --loadCookies true --saveCookies true\n2) Complete Sign In + CAPTCHA, then navigate back to home while logged in.\n3) Resume normal automated run:\n   node index.js --headless true --loadCookies true --saveCookies true\n`
        : ''
    const bodyPrefix = success
        ? 'Run completed successfully.'
        : `Run failed with error: ${errorMessage}${recoveryInstructions}`

    const transporter = nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: {
            user: config.smtpUser,
            pass: config.smtpPass
        }
    })

    if (success && !config.emailOnSuccess) {
        await appendLog('INFO', 'Success email disabled; skipping success notification.')
        return
    }

    await transporter.sendMail({
        from: config.alertFrom,
        to: config.alertTo,
        subject,
        text: `${bodyPrefix}\n\nLog output:\n${logContent}`
    })
    await appendLog('INFO', `Email sent to ${config.alertTo} with run status "${success ? 'success' : 'failure'}".`)
}

async function cleanupLogFile() {
    try {
        await fs.unlink(config.logFile)
        console.log(`[Info] Deleted logfile ${config.logFile}`)
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.warn(`[Warn] Failed to delete logfile ${config.logFile}: ${error.message}`)
        }
    }
}

function toFileSafeFragment(value) {
    return String(value).replace(/[^a-zA-Z0-9-_]/g, '_')
}

async function captureLoginDebugArtifacts(page, label) {
    if (!config.loginDebugEnabled) return
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const slug = toFileSafeFragment(label)
    const baseName = `login-debug-${stamp}-${slug}`
    const htmlPath = `${config.loginDebugDir}/${baseName}.html`
    const screenshotPath = `${config.loginDebugDir}/${baseName}.png`
    const metaPath = `${config.loginDebugDir}/${baseName}.txt`

    await fs.mkdir(config.loginDebugDir, { recursive: true })
    const pageUrl = page.url()
    const pageTitle = await page.title().catch(() => '(unable to read title)')
    const pageHtml = await page.content()
    const pageState = await page.evaluate(() => {
        const nextRoot = document.querySelector('#__next')
        return {
            readyState: document.readyState,
            bodyClassName: document.body?.className ?? '',
            nextChildCount: nextRoot?.childElementCount ?? -1,
            scriptCount: document.scripts?.length ?? -1
        }
    }).catch(() => ({
        readyState: '(unavailable)',
        bodyClassName: '(unavailable)',
        nextChildCount: -1,
        scriptCount: -1
    }))
    const visibleText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) || '').catch(() => '')
    const debugState = page.__loginDebugState || { consoleMessages: [], pageErrors: [], failedRequests: [] }

    await fs.writeFile(htmlPath, pageHtml, 'utf-8')
    await page.screenshot({ path: screenshotPath, fullPage: true })
    await fs.writeFile(
        metaPath,
        `URL: ${pageUrl}\nTitle: ${pageTitle}\nReadyState: ${pageState.readyState}\nBodyClass: ${pageState.bodyClassName}\nNextChildCount: ${pageState.nextChildCount}\nScriptCount: ${pageState.scriptCount}\n\nConsoleMessages:\n${debugState.consoleMessages.join('\n') || '(none)'}\n\nPageErrors:\n${debugState.pageErrors.join('\n') || '(none)'}\n\nFailedRequests:\n${debugState.failedRequests.join('\n') || '(none)'}\n\nVisibleText(first 4000 chars):\n${visibleText}\n`,
        'utf-8'
    )
    await appendLog('WARN', `Login debug artifacts saved: ${htmlPath}, ${screenshotPath}, ${metaPath}`)
}

async function typeLikeHuman(page, selector, text) {
    await page.click(selector, { clickCount: 3 })
    await page.keyboard.press('Backspace')
    for (const char of text) {
        await page.type(selector, char)
        await sleep(Math.floor(Math.random() * 120) + 40)
    }
}

async function clickFirstSelector(page, selectors, timeout = 6000) {
    const interval = 250
    const maxAttempts = Math.ceil(timeout / interval)
    for (let i = 0; i < maxAttempts; i++) {
        for (const selector of selectors) {
            const element = await page.$(selector)
            if (!element) continue
            try {
                await page.evaluate((sel) => {
                    const el = document.querySelector(sel)
                    if (el) {
                        el.scrollIntoView({ block: 'center', inline: 'center' })
                    }
                }, selector)
                await page.click(selector)
                return selector
            } catch {
                continue
            }
        }
        await sleep(interval)
    }
    throw new Error(`Unable to find/click any selector: ${selectors.join(', ')}`)
}

async function waitForLoginForm(page, timeout = 15000) {
    await page.waitForFunction(() => {
        const nextRoot = document.querySelector('#__next')
        const isHydrated = !!nextRoot && nextRoot.childElementCount > 0
        const emailInput = document.querySelector('#email, input[type="email"], input[name="email"], input[autocomplete="username"]')
        const passwordInput = document.querySelector('#password, input[type="password"], input[name="password"], input[autocomplete="current-password"]')
        return isHydrated && !!emailInput && !!passwordInput
    }, { timeout })
}

function isNextAuthSessionCookieName(name) {
    if (!name) return false
    return (
        /^__Secure-next-auth\.session-token$/i.test(name) ||
        /^__Host-next-auth\.session-token$/i.test(name) ||
        /^next-auth\.session-token$/i.test(name) ||
        /^__Secure-authjs\.session-token$/i.test(name) ||
        /^__Host-authjs\.session-token$/i.test(name) ||
        /^authjs\.session-token$/i.test(name)
    )
}

/** Raley's often persists storefront auth as Fieldera FLDR cookies without exporting a next-auth.* cookie name into Puppeteer's cookie list. */
function cookieArrayHasFldrWebAuth(cookies) {
    if (!Array.isArray(cookies)) return false
    const active = cookies.filter((c) => c?.name && c?.value)
    const auth = active.find((c) => c.name === 'FLDR.Auth' && String(c.value).length >= 64)
    const session = active.find((c) => c.name === 'FLDR.Session' && String(c.value).length >= 8)
    return Boolean(auth && session)
}

async function readNextAuthSessionPayload(page) {
    return page.evaluate(async () => {
        try {
            const response = await fetch('/api/auth/session', {
                credentials: 'include',
                headers: { Accept: 'application/json' }
            })
            if (!response.ok) {
                return { ok: false, status: response.status }
            }
            const data = await response.json()
            return { ok: true, data }
        } catch (error) {
            return { ok: false, error: String(error?.message || error) }
        }
    })
}

function nextAuthSessionHasUser(payload) {
    const user = payload?.data?.user
    return Boolean(user && (user.email || user.name || user.id))
}

async function waitForValidCookies(page, timeoutMs = 120000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const payload = await readNextAuthSessionPayload(page)
        if (payload?.ok && nextAuthSessionHasUser(payload)) {
            return await page.cookies()
        }
        await sleep(1000)
    }
    return null
}

async function waitForLoginFormOrThrow(page, timeout = 180000) {
    await page.waitForFunction(() => {
        const emailInput = document.querySelector('#email, input[type="email"], input[name="email"], input[autocomplete="username"]')
        const passwordInput = document.querySelector('#password, input[type="password"], input[name="password"], input[autocomplete="current-password"]')
        return !!emailInput && !!passwordInput
    }, { timeout })
}

async function waitForManualLoginCompletion(page, timeoutMs = 300000) {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        const currentUrl = page.url()
        if (/\/login|\/sign-in/i.test(currentUrl)) {
            await sleep(1000)
            continue
        }
        const payload = await readNextAuthSessionPayload(page)
        if (payload?.ok && nextAuthSessionHasUser(payload)) {
            return await page.cookies()
        }
        await sleep(1000)
    }
    return null
}

async function enableRememberMeIfPresent(page) {
    const toggled = await page.evaluate(() => {
        const candidates = Array.from(
            document.querySelectorAll('input[type="checkbox"], button[role="switch"], [role="checkbox"]')
        )
        const textFor = (el) => {
            const id = el.getAttribute('id')
            const labelByFor = id ? document.querySelector(`label[for="${id}"]`)?.textContent || '' : ''
            const parentText = el.closest('label, div, span, p')?.textContent || ''
            const aria = el.getAttribute('aria-label') || ''
            const name = el.getAttribute('name') || ''
            return `${labelByFor} ${parentText} ${aria} ${name}`.toLowerCase()
        }

        const rememberCandidate = candidates.find((el) => {
            const text = textFor(el)
            return /remember|save login|save sign|keep me|stay signed/i.test(text)
        })
        if (!rememberCandidate) return false

        const isInput = rememberCandidate.tagName.toLowerCase() === 'input'
        const isChecked = isInput
            ? rememberCandidate.checked
            : rememberCandidate.getAttribute('aria-checked') === 'true'
        if (isChecked) return true

        rememberCandidate.click()
        return true
    }).catch(() => false)

    if (toggled) {
        await appendLog('INFO', 'Enabled remember-me/save-login toggle.')
    } else {
        await appendLog('INFO', 'Remember-me/save-login toggle not found; continuing.')
    }
}

function validateCookieCollection(cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
        return false
    }
    const now = Date.now() / 1000
    const sessionCandidates = cookies.filter((cookie) => {
        if (!cookie?.name || !cookie?.value) return false
        if (cookie.expires && cookie.expires > 0 && cookie.expires < now) return false
        return true
    })
    if (sessionCandidates.length === 0) return false
    if (sessionCandidates.some((cookie) => isNextAuthSessionCookieName(cookie.name))) return true
    return cookieArrayHasFldrWebAuth(sessionCandidates)
}

async function getLoginCookiesFromBrowser() {
    if (!config.email || !config.password) {
        throw new Error('Missing credentials for browser login.')
    }

    await appendLog('INFO', 'Starting browser login flow...')
    const browser = await puppeteer.launch({
        headless: config.headless
    })
    try {
        const page = await browser.newPage()
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => false })
        })
        page.__loginDebugState = {
            consoleMessages: [],
            pageErrors: [],
            failedRequests: []
        }
        page.on('console', (msg) => {
            if (page.__loginDebugState.consoleMessages.length < 80) {
                const location = msg.location()
                const locText = location?.url ? ` (${location.url}:${location.lineNumber ?? 0})` : ''
                page.__loginDebugState.consoleMessages.push(`[${msg.type()}] ${msg.text()}${locText}`)
            }
        })
        page.on('pageerror', (err) => {
            if (page.__loginDebugState.pageErrors.length < 80) {
                page.__loginDebugState.pageErrors.push(err.message)
            }
        })
        page.on('requestfailed', (req) => {
            if (page.__loginDebugState.failedRequests.length < 120) {
                page.__loginDebugState.failedRequests.push(`${req.failure()?.errorText ?? 'requestfailed'} ${req.method()} ${req.url()}`)
            }
        })
        page.on('response', (res) => {
            if (res.status() >= 400 && page.__loginDebugState.failedRequests.length < 120) {
                page.__loginDebugState.failedRequests.push(`HTTP ${res.status()} ${res.request().method()} ${res.url()}`)
            }
        })
        await page.setViewport({ width: 1366, height: 900 })
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36')
        await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })
        await appendLog('INFO', 'Navigating to raleys.com...')
        await page.goto('https://www.raleys.com/', { waitUntil: 'domcontentloaded', timeout: 45000 })

        if (!config.headless) {
            await appendLog('INFO', 'Manual login assist enabled. Please click Sign In to open the login form.')
            await waitForLoginFormOrThrow(page, 180000)
            await appendLog('INFO', 'Login form detected. Filling email/password and enabling remember login if available...')
            await clickFirstSelector(page, ['#email', 'input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]'])
            await typeLikeHuman(page, '#email, input[type="email"], input[name="email"], input[autocomplete="username"]', config.email)
            await clickFirstSelector(page, ['#password', 'input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]'])
            await typeLikeHuman(page, '#password, input[type="password"], input[name="password"], input[autocomplete="current-password"]', config.password)
            await enableRememberMeIfPresent(page)
            await appendLog(
                'INFO',
                'Please solve captcha, submit login, then stay on www.raleys.com until your account session is fully active (home or offers page while signed in).'
            )
            const manualCookies = await waitForManualLoginCompletion(page, 300000)
            if (!manualCookies) {
                await captureLoginDebugArtifacts(page, 'manual-login-timeout')
                throw new Error(
                    'Timed out waiting for a signed-in NextAuth session. After submitting login, stay on www.raleys.com until the site shows you as signed in (session may take a few seconds after FLDR cookies appear).'
                )
            }
            await appendLog('INFO', 'Manual login completed; auth cookies captured.')
            return manualCookies
        }

        try {
            await clickFirstSelector(page, [
                'a[href*="login"]',
                'a[href*="sign"]',
                'button[data-testid*="login"]',
                '#header a[href*="account"]',
                '#header a:nth-of-type(1)'
            ])
        } catch {
            await appendLog('WARN', 'Homepage login entry not found; trying direct sign-in URLs.')
            const loginUrls = [
                'https://www.raleys.com/account/sign-in',
                'https://www.raleys.com/sign-in',
                'https://www.raleys.com/login'
            ]
            let loginFormFound = false
            for (const loginUrl of loginUrls) {
                await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
                try {
                    await waitForLoginForm(page, 12000)
                    loginFormFound = true
                    await appendLog('INFO', `Detected login form at ${loginUrl}`)
                    break
                } catch {
                    await appendLog('WARN', `Login form did not hydrate at ${loginUrl}. Retrying after reload.`)
                    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 })
                    try {
                        await waitForLoginForm(page, 8000)
                        loginFormFound = true
                        await appendLog('INFO', `Detected login form at ${loginUrl} after reload`)
                        break
                    } catch {
                        continue
                    }
                }
            }
            if (!loginFormFound) {
                if (!config.headless) {
                    await appendLog('WARN', 'Login form not found. Waiting for manual login in visible browser window (up to 2 minutes).')
                    const manualCookies = await waitForValidCookies(page, 120000)
                    if (manualCookies) {
                        await appendLog('INFO', 'Valid cookies detected after manual login.')
                        return manualCookies
                    }
                }
                await captureLoginDebugArtifacts(page, 'login-form-not-found')
                throw new Error('Unable to locate login form from homepage or direct sign-in URLs.')
            }
        }

        await clickFirstSelector(page, ['#email', 'input[type="email"]', 'input[name="email"]', 'input[autocomplete="username"]'])
        await typeLikeHuman(page, '#email, input[type="email"], input[name="email"], input[autocomplete="username"]', config.email)
        await clickFirstSelector(page, ['#password', 'input[type="password"]', 'input[name="password"]', 'input[autocomplete="current-password"]'])
        await typeLikeHuman(page, '#password, input[type="password"], input[name="password"], input[autocomplete="current-password"]', config.password)
        await enableRememberMeIfPresent(page)

        await appendLog('INFO', 'Submitting login form...')
        const submitSelectors = [
            '#auth-modal button[type="submit"]',
            'form button[type="submit"]',
            'button[data-testid*="sign-in"]'
        ]

        const maxRetries = 4
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            await clickFirstSelector(page, submitSelectors, 4000)
            await Promise.race([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => null),
                sleep(2500)
            ])

            const captchaIframe = await page.$('iframe[title="reCAPTCHA"]')
            if (captchaIframe) {
                if (config.headless) {
                    await captureLoginDebugArtifacts(page, 'captcha-detected-headless')
                    throw new Error('Captcha detected in headless mode. Re-run with --headless false and solve manually.')
                }
                await appendLog('WARN', 'Captcha detected. Please solve it manually in browser window.')
                await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => null)
            }

            const cookies = await page.cookies()
            const sessionPayload = await readNextAuthSessionPayload(page)
            if (nextAuthSessionHasUser(sessionPayload)) {
                await appendLog('INFO', 'NextAuth session detected after login submit.')
                return cookies
            }
            if (validateCookieCollection(cookies)) {
                await appendLog(
                    'WARN',
                    `Login submit attempt ${attempt} set cookies but NextAuth session is not ready yet; retrying or wait for manual flow.`
                )
            }
            await appendLog('WARN', `Login submit attempt ${attempt} did not yield an authenticated NextAuth session.`)
        }

        await captureLoginDebugArtifacts(page, 'login-submit-failed')
        throw new Error('Unable to complete login after multiple submit attempts.')
    } catch (error) {
        try {
            const page = (await browser.pages())[0]
            if (page) {
                await captureLoginDebugArtifacts(page, `exception-${error?.name ?? 'unknown'}`)
            }
        } catch (captureError) {
            await appendLog('WARN', `Failed to capture login debug artifacts during exception handling: ${captureError.message}`)
        }
        throw error
    } finally {
        await browser.close()
    }
}

function setCookiesToJar(jar, cookies, url) {
    cookies.forEach(({ name, value, domain, path, expires, httpOnly, secure }) => {
        const expiresToken = expires && expires > 0 ? `Expires=${new Date(expires * 1000).toUTCString()};` : ''
        jar.setCookieSync(
            `${name}=${value}; Domain=${domain}; Path=${path}; ${expiresToken} ${httpOnly ? 'HttpOnly;' : ''} ${secure ? 'Secure;' : ''}`,
            url
        )
    })
}

function buildRalleysClient(cookies) {
    const jar = new CookieJar()
    setCookiesToJar(jar, cookies, 'https://www.raleys.com')
    const browserLikeHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.raleys.com/'
    }
    const client = wrapper(axios.create({
        baseURL: 'https://www.raleys.com',
        jar,
        withCredentials: true,
        headers: browserLikeHeaders
    }))
    return { client, jar }
}

function getCookiesFromJar(jar) {
    const serialized = jar.serializeSync()
    return (serialized.cookies || []).map((cookie) => ({
        name: cookie.key,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || '/',
        expires: cookie.expires === 'Infinity' || !cookie.expires ? -1 : Math.floor(new Date(cookie.expires).getTime() / 1000),
        httpOnly: Boolean(cookie.httpOnly),
        secure: Boolean(cookie.secure)
    }))
}

async function fetchOffers(raleysClient) {
    const response = await raleysClient.get('/api/offers/get-offers?offset=0&rows=999&clipped=Unclipped')
    return response.data?.data || []
}

async function loadCookiesFromDisk() {
    const cookieFile = await fs.readFile(config.cookiesFile, 'utf-8')
    const parsed = JSON.parse(cookieFile)
    if (!validateCookieCollection(parsed)) {
        throw new Error(
            'Cookie file exists but does not contain recognizable auth material (NextAuth session cookie or FLDR.Auth with FLDR.Session). Re-run visible login to refresh cookies.'
        )
    }
    await appendLog('INFO', `Loaded and validated cookies from ${config.cookiesFile}`)
    return parsed
}

async function saveCookiesToDisk(cookies) {
    await fs.writeFile(config.cookiesFile, JSON.stringify(cookies, null, 2), 'utf-8')
    await appendLog('INFO', `Saved cookies to ${config.cookiesFile}`)
}

async function getAuthenticatedClient() {
    let cookies

    if (config.loadCookies) {
        try {
            cookies = await loadCookiesFromDisk()
        } catch (error) {
            await appendLog('WARN', `Failed to load cookies: ${error.message}.`)
        }
    }

    if (!cookies) {
        if (config.headless) {
            throw new Error(`No valid cookies available in headless mode. Export fresh cookies to ${config.cookiesFile} and run with --loadCookies true.`)
        }
        cookies = await getLoginCookiesFromBrowser()
        if (config.saveCookies) {
            await saveCookiesToDisk(cookies)
        }
    }

    let { client, jar } = buildRalleysClient(cookies)

    try {
        await fetchOffers(client)
        await appendLog('INFO', 'Authenticated API access verified.')
    } catch (error) {
        const status = error.response?.status
        const isUnauthorized = status === 401 || status === 403
        if (!isUnauthorized) throw error

        await appendLog('WARN', 'Loaded cookies were unauthorized.')
        if (config.headless) {
            throw new Error('Loaded cookies are unauthorized in headless mode. Refresh cookies manually (run with --headless false), then retry headless run.')
        }
        await appendLog('WARN', 'Re-authenticating via browser login in non-headless mode.')
        cookies = await getLoginCookiesFromBrowser()
        if (config.saveCookies) {
            await saveCookiesToDisk(cookies)
        }
        ;({ client, jar } = buildRalleysClient(cookies))
        await fetchOffers(client)
        await appendLog('INFO', 'Authenticated API access verified after re-login.')
    }

    if (config.saveCookies) {
        const refreshedCookies = getCookiesFromJar(jar)
        if (refreshedCookies.length > 0) {
            await saveCookiesToDisk(refreshedCookies)
            if (validateCookieCollection(refreshedCookies)) {
                await appendLog('INFO', 'Refreshed cookie file from current authenticated session.')
            } else {
                await appendLog('WARN', 'Saved refreshed cookie file, but auth-cookie validation is weak; login may still expire soon.')
            }
        } else {
            await appendLog('WARN', 'Skipped cookie refresh because no cookies were present in current session jar.')
        }
    }

    return client
}

async function clipOffer(raleysClient, offer) {
    try {
        const offerId = offer.ExtPromotionId
        const offerType = offer.ExtBadgeTypeCode
        const isCoupon = offerType === 'mfg'
        await raleysClient.post(`/api/offers/accept${isCoupon ? '-coupons' : ''}`, { offerId, offerType })
        return offer
    } catch (error) {
        error.offer = offer
        throw error
    }
}

async function run() {
    if (config.headless && !config.loadCookies) {
        throw new Error('Headless mode requires cookie auth. Set --loadCookies true and provide a valid cookies file.')
    }
    if (!config.headless && !config.loadCookies && (!config.email || !config.password)) {
        throw new Error('Missing credentials for non-headless login: provide --email and --password or set .env, or use --loadCookies true.')
    }

    const chosenDelay = Math.round(Math.random() * (config.maxStartDelay - config.minStartDelay + 1) + config.minStartDelay)
    await appendLog('INFO', `Waiting ${chosenDelay}ms before starting...`)
    await sleep(chosenDelay)

    const raleysClient = await getAuthenticatedClient()
    const offersUnfiltered = await fetchOffers(raleysClient)
    const offers = offersUnfiltered.filter((offer) => !offer.IsAccepted)

    await appendLog('INFO', `${offers.length} offer${offers.length === 1 ? '' : 's'} found`)
    let successfulClips = 0
    const clipTasks = []

    for (const [i, offer] of offers.entries()) {
        const headline = `${offer.Headline ?? ''} ${offer.SubHeadline?.replace(/[\r\n]+/g, ' ') ?? ''}`.trim()
        if (!offer?.ExtPromotionId || !offer?.ExtBadgeTypeCode) {
            await appendLog('WARN', 'Invalid offer data detected. Skipping.')
            continue
        }

        await appendLog('INFO', `Clipping ${offer.ExtBadgeTypeCode === 'mfg' ? 'Coupon' : offer.ExtBadgeTypeCode}: ${headline}`)
        if (config.asyncClipping) {
            clipTasks.push(clipOffer(raleysClient, offer).then(() => ({ offer })))
        } else {
            await clipOffer(raleysClient, offer).then(async () => {
                successfulClips++
                await appendLog('INFO', `Clipped ${offer.ExtBadgeTypeCode === 'mfg' ? 'Coupon' : offer.ExtBadgeTypeCode}: ${headline}`)
            }).catch(async (error) => {
                await appendLog('WARN', `Error clipping offer "${offer?.Headline}": ${error.response?.data?.message ?? 'Unknown error'}`)
            })

            if (i < offers.length - 1) {
                await randomSleep(config.minRequestDelay, config.maxRequestDelay)
            }
        }
    }

    if (config.asyncClipping && offers.length > 0) {
        await appendLog('INFO', 'Async clipping results:')
        const results = await Promise.allSettled(clipTasks)
        for (const result of results) {
            if (result.status === 'fulfilled') {
                const { offer } = result.value
                const headline = `${offer.Headline ?? ''} ${offer.SubHeadline?.replace(/[\r\n]+/g, ' ') ?? ''}`.trim()
                successfulClips++
                await appendLog('INFO', `Clipped ${offer.ExtBadgeTypeCode === 'mfg' ? 'Coupon' : offer.ExtBadgeTypeCode}: ${headline}`)
            } else {
                const { offer, response } = result.reason
                await appendLog('WARN', `Error clipping ${offer.ExtBadgeTypeCode === 'mfg' ? 'Coupon' : offer.ExtBadgeTypeCode} "${offer?.Headline}": ${response?.data?.message ?? 'Unknown error'}`)
            }
        }
    }

    if (offers.length === 0) {
        await appendLog('INFO', 'No offers available to be clipped. Program exiting.')
    } else {
        await appendLog('INFO', `Done! ${successfulClips} offer${successfulClips === 1 ? '' : 's'} clipped. ${offers.length - successfulClips} offer${offers.length - successfulClips === 1 ? '' : 's'} failed.`)
    }
}

let runError = null
let runSuccessful = false

try {
    await run()
    runSuccessful = true
} catch (error) {
    runError = error
    await appendLog('ERROR', error?.stack || error?.message || 'Unknown runtime error')
    process.exitCode = 1
} finally {
    await trimLogIfNeeded()
    try {
        await sendRunEmail({
            success: runSuccessful,
            errorMessage: runError?.message || 'Unknown error'
        })
    } catch (emailError) {
        await appendLog('ERROR', `Failed to send notification email: ${emailError.message}`)
    }
    await cleanupLogFile()
}
