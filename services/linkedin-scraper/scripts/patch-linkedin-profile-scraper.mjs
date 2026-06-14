import fs from "node:fs";
import path from "node:path";

const packageRoot = path.resolve("node_modules/linkedin-profile-scraper");
const targets = [
  path.join(packageRoot, "dist/index.js"),
  path.join(packageRoot, "src/index.ts"),
  path.resolve("node_modules/puppeteer/lib/Launcher.js"),
];

const replacements = [
  {
    from: "...(this.options.headless ? '---single-process' : '---start-maximized'),",
    to: "...(this.options.headless ? [] : ['--start-maximized']),",
  },
  {
    from: "...(this.options.headless ? ['--single-process'] : ['--start-maximized']),",
    to: "...(this.options.headless ? [] : ['--start-maximized']),",
  },
  {
    from: "this.browser = yield puppeteer_1.default.launch({\n                    headless:",
    to: "this.browser = yield puppeteer_1.default.launch({\n                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n                    headless:",
  },
  {
    from: "this.browser = yield puppeteer_1.default.launch({\n                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n                    headless:",
    to: "this.browser = yield puppeteer_1.default.launch({\n                    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n                    userDataDir: process.env.PUPPETEER_USER_DATA_DIR,\n                    headless:",
  },
  {
    from: "this.browser = await puppeteer.launch({\n        headless:",
    to: "this.browser = await puppeteer.launch({\n        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n        headless:",
  },
  {
    from: "this.browser = await puppeteer.launch({\n        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n        headless:",
    to: "this.browser = await puppeteer.launch({\n        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,\n        userDataDir: process.env.PUPPETEER_USER_DATA_DIR,\n        headless:",
  },
  {
    from: "if (os.arch() === 'arm64') {\n            chromeExecutable = '/usr/bin/chromium-browser';\n        }\n        else if (!executablePath) {",
    to: "if (os.arch() === 'arm64' && !executablePath) {\n            chromeExecutable = '/usr/bin/chromium-browser';\n        }\n        else if (!executablePath) {",
  },
  {
    from: "const page = yield this.browser.newPage();\n                const firstPage = (yield this.browser.pages())[0];\n                yield firstPage.close();",
    to: "const page = yield this.browser.newPage();\n                yield page.evaluateOnNewDocument(() => {\n                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });\n                });\n                const firstPage = (yield this.browser.pages()).find(candidate => candidate !== page);\n                if (firstPage)\n                    yield firstPage.close();",
  },
  {
    from: "const page = await this.browser.newPage()\n      const firstPage = (await this.browser.pages())[0]\n      await firstPage.close()",
    to: "const page = await this.browser.newPage()\n      await page.evaluateOnNewDocument(() => {\n        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });\n      })\n      const firstPage = (await this.browser.pages()).find(candidate => candidate !== page)\n      if (firstPage) await firstPage.close()",
  },
  {
    from: "const page = yield this.browser.newPage();\n                const firstPage = (yield this.browser.pages()).find(candidate => candidate !== page);\n                if (firstPage)\n                    yield firstPage.close();",
    to: "const page = yield this.browser.newPage();\n                yield page.evaluateOnNewDocument(() => {\n                    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });\n                });\n                const firstPage = (yield this.browser.pages()).find(candidate => candidate !== page);\n                if (firstPage)\n                    yield firstPage.close();",
  },
  {
    from: "const page = await this.browser.newPage()\n      const firstPage = (await this.browser.pages()).find(candidate => candidate !== page)\n      if (firstPage) await firstPage.close()",
    to: "const page = await this.browser.newPage()\n      await page.evaluateOnNewDocument(() => {\n        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });\n      })\n      const firstPage = (await this.browser.pages()).find(candidate => candidate !== page)\n      if (firstPage) await firstPage.close()",
  },
  {
    from: "'--enable-automation',",
    to: "'--disable-blink-features=AutomationControlled',",
  },
  {
    from: "statusLog(logSection, `Using options: ${JSON.stringify(this.options)}`);",
    to: "statusLog(logSection, `Using options: ${JSON.stringify({ ...this.options, sessionCookieValue: '[redacted]' })}`);",
  },
  {
    from: "statusLog(logSection, `Using options: ${JSON.stringify(this.options)}`)",
    to: "statusLog(logSection, `Using options: ${JSON.stringify({ ...this.options, sessionCookieValue: '[redacted]' })}`)",
  },
  {
    from: "waitUntil: 'networkidle2',",
    to: "waitUntil: 'domcontentloaded',",
  },
  {
    from: "yield this.checkIfLoggedIn();",
    to: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n                    yield this.checkIfLoggedIn();",
  },
  {
    from: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n                    if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n                    yield this.checkIfLoggedIn();",
    to: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n                    yield this.checkIfLoggedIn();",
  },
  {
    from: "await this.checkIfLoggedIn();",
    to: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n        await this.checkIfLoggedIn();",
  },
  {
    from: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n        if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n        await this.checkIfLoggedIn();",
    to: "if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n        await this.checkIfLoggedIn();",
  },
  {
    from: "'domain': '.www.linkedin.com'",
    to: "'domain': '.linkedin.com'",
  },
  {
    from: "utils_1.statusLog(logSection, `Setting session cookie using cookie: ${process.env.LINKEDIN_SESSION_COOKIE_VALUE}`);\n                yield page.setCookie({\n                    'name': 'li_at',\n                    'value': this.options.sessionCookieValue,\n                    'domain': '.linkedin.com'\n                });",
    to: "utils_1.statusLog(logSection, 'Setting LinkedIn session cookie(s)');\n                const cookiesJson = process.env.LINKEDIN_COOKIES_JSON;\n                if (cookiesJson) {\n                    const cookies = JSON.parse(cookiesJson);\n                    yield page.setCookie(...cookies);\n                }\n                else {\n                    yield page.setCookie({\n                        'name': 'li_at',\n                        'value': this.options.sessionCookieValue,\n                        'domain': '.linkedin.com'\n                    });\n                }",
  },
  {
    from: "utils_1.statusLog(logSection, 'Setting LinkedIn session cookie(s)');\n                const cookiesJson = process.env.LINKEDIN_COOKIES_JSON;\n                if (cookiesJson) {\n                    const cookies = JSON.parse(cookiesJson);\n                    yield page.setCookie(...cookies);\n                }\n                else {\n                    yield page.setCookie({\n                        'name': 'li_at',\n                        'value': this.options.sessionCookieValue,\n                        'domain': '.linkedin.com'\n                    });\n                }\n                utils_1.statusLog(logSection, 'Session cookie set!');",
    to: "if (process.env.LINKEDIN_USE_PERSISTENT_PROFILE === 'true') {\n                    utils_1.statusLog(logSection, 'Using persistent Chrome profile; skipping cookie injection.');\n                }\n                else {\n                    utils_1.statusLog(logSection, 'Setting LinkedIn session cookie(s)');\n                    const cookiesJson = process.env.LINKEDIN_COOKIES_JSON;\n                    if (cookiesJson) {\n                        const cookies = JSON.parse(cookiesJson);\n                        yield page.setCookie(...cookies);\n                    }\n                    else {\n                        yield page.setCookie({\n                            'name': 'li_at',\n                            'value': this.options.sessionCookieValue,\n                            'domain': '.linkedin.com'\n                        });\n                    }\n                    utils_1.statusLog(logSection, 'Session cookie set!');\n                }",
  },
  {
    from: "statusLog(logSection, `Setting session cookie using cookie: ${process.env.LINKEDIN_SESSION_COOKIE_VALUE}`)\n\n      await page.setCookie({\n        'name': 'li_at',\n        'value': this.options.sessionCookieValue,\n        'domain': '.linkedin.com'\n      })\n\n      statusLog(logSection, 'Session cookie set!')",
    to: "if (process.env.LINKEDIN_USE_PERSISTENT_PROFILE === 'true') {\n        statusLog(logSection, 'Using persistent Chrome profile; skipping cookie injection.')\n      } else {\n        statusLog(logSection, 'Setting LinkedIn session cookie(s)')\n        const cookiesJson = process.env.LINKEDIN_COOKIES_JSON\n        if (cookiesJson) {\n          const cookies = JSON.parse(cookiesJson)\n          await page.setCookie(...cookies)\n        } else {\n          await page.setCookie({\n            'name': 'li_at',\n            'value': this.options.sessionCookieValue,\n            'domain': '.linkedin.com'\n          })\n        }\n        statusLog(logSection, 'Session cookie set!')\n      }",
  },
  {
    from: "utils_1.statusLog(logSection, 'Getting all the LinkedIn profile data by scrolling the page to the bottom, so all the data gets loaded into the page...', scraperSessionId);\n                yield autoScroll(page);",
    to: "utils_1.statusLog(logSection, 'Getting all the LinkedIn profile data by scrolling the page to the bottom, so all the data gets loaded into the page...', scraperSessionId);\n                yield page.waitFor(2000);\n                try {\n                    yield autoScroll(page);\n                }\n                catch (err) {\n                    utils_1.statusLog(logSection, `Auto scroll failed once: ${err.message}. Retrying after LinkedIn navigation settles.`, scraperSessionId);\n                    yield page.waitFor(3000);\n                    yield autoScroll(page);\n                }",
  },
  {
    from: "statusLog(logSection, 'Getting all the LinkedIn profile data by scrolling the page to the bottom, so all the data gets loaded into the page...', scraperSessionId)\n\n      await autoScroll(page);",
    to: "statusLog(logSection, 'Getting all the LinkedIn profile data by scrolling the page to the bottom, so all the data gets loaded into the page...', scraperSessionId)\n\n      await page.waitFor(2000);\n      try {\n        await autoScroll(page);\n      } catch (err) {\n        statusLog(logSection, `Auto scroll failed once: ${err.message}. Retrying after LinkedIn navigation settles.`, scraperSessionId)\n        await page.waitFor(3000);\n        await autoScroll(page);\n      }",
  },
];

for (const target of targets) {
  if (!fs.existsSync(target)) continue;

  let source = fs.readFileSync(target, "utf8");
  let patched = source;
  for (const { from, to } of replacements) {
    patched = patched.replaceAll(from, to);
  }
  patched = patched
    .replace(
      /(\n[ \t]*)if \(process\.env\.LINKEDIN_SKIP_LOGIN_CHECK !== 'true'\)\n(?:[ \t]*if \(process\.env\.LINKEDIN_SKIP_LOGIN_CHECK !== 'true'\)\n)+([ \t]*yield this\.checkIfLoggedIn\(\);)/g,
      "$1if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n$2",
    )
    .replace(
      /(\n[ \t]*)if \(process\.env\.LINKEDIN_SKIP_LOGIN_CHECK !== 'true'\)\n(?:[ \t]*if \(process\.env\.LINKEDIN_SKIP_LOGIN_CHECK !== 'true'\)\n)+([ \t]*await this\.checkIfLoggedIn\(\);)/g,
      "$1if (process.env.LINKEDIN_SKIP_LOGIN_CHECK !== 'true')\n$2",
    );

  if (patched !== source) {
    fs.writeFileSync(target, patched);
    console.log(`patched ${path.relative(process.cwd(), target)}`);
  }
}
