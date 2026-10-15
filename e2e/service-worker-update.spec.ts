import { expect, test } from "@playwright/test";

test.use({ serviceWorkers: "allow" });

test("a failed shell update keeps the previous release and a complete update works offline", async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: "http://127.0.0.1:4173",
    serviceWorkers: "allow",
  });
  const page = await context.newPage();
  let release: "A" | "B" | "C" | "D" | "E" = "A";
  let releaseBAssetMode: "unavailable" | "html" | "available" = "unavailable";
  let failedReleaseBAssetRequests = 0;
  let delayedRelease: "C" | null = null;
  let delayedReleaseRootRequests = 0;

  await context.route("**/__legacy-bootstrap", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><html><body>Legacy client is open</body></html>",
    });
  });
  await context.route("**/", async (route) => {
    const servedRelease = release;
    const response = await route.fetch();
    if (servedRelease === delayedRelease) {
      delayedReleaseRootRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    let html = await response.text();
    html = html.replace("</head>", `<meta name="test-release" content="${servedRelease}"></head>`);
    html = html.replace(
      "</body>",
      `<script type="module" src="/assets/release-${servedRelease.toLowerCase()}-12345678.js"></script></body>`,
    );
    await route.fulfill({ response, body: html });
  });
  await context.route("**/assets/release-*-12345678.js", async (route) => {
    const requestedRelease = new URL(route.request().url()).pathname.match(/release-([a-e])-/)?.[1]?.toUpperCase() ?? "A";
    if (requestedRelease === "B" && releaseBAssetMode === "unavailable") {
      failedReleaseBAssetRequests += 1;
      await route.fulfill({ status: 503, body: "release B asset unavailable" });
      return;
    }
    if (requestedRelease === "B" && releaseBAssetMode === "html") {
      failedReleaseBAssetRequests += 1;
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body>SPA fallback</body></html>" });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/javascript",
      body: `document.documentElement.dataset.release = "${requestedRelease}";`,
    });
  });

  const inspectShell = (inspectionPage = page) => inspectionPage.evaluate(async () => {
    const control = await caches.open("nearlink-shell-control-v1");
    const activeResponse = await control.match(new URL("/__nearlink_shell__/active", location.origin).href);
    const active = activeResponse ? await activeResponse.text() : null;
    const cacheNames = await caches.keys();
    const entries = active ? await (await caches.open(active)).keys() : [];
    return {
      active,
      cacheNames,
      paths: entries.map((entry) => new URL(entry.url).pathname),
      shell: active ? await (await caches.open(active)).match(new URL("/", location.origin).href)?.then((r) => r?.text()) : null,
    };
  });

  try {
    const legacyTab = await context.newPage();
    await legacyTab.goto("/__legacy-bootstrap");
    await legacyTab.evaluate(async () => {
      const legacy = await caches.open("nearlink-shell-v1");
      await legacy.put(new URL("/", location.origin).href, new Response(
        "<!doctype html><html><body>Legacy cached shell</body></html>",
        { headers: { "Content-Type": "text/html" } },
      ));
      await legacy.put(new URL("/assets/legacy-lazy-12345678.js", location.origin).href, new Response(
        "globalThis.legacyShellAsset = true;",
        { headers: { "Content-Type": "text/javascript" } },
      ));
      await navigator.serviceWorker.register("/sw.js");
    });
    await legacyTab.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });

    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-release", "A");
    await page.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-release", "A");
    await expect.poll(async () => (await inspectShell()).active).toMatch(/^nearlink-shell-release-/);
    const releaseA = await inspectShell();
    expect(releaseA.paths).toContain("/");
    expect(releaseA.paths).toContain("/manifest.webmanifest");
    expect(releaseA.paths).toContain("/icon.svg");
    expect(releaseA.paths).toContain("/assets/release-a-12345678.js");
    expect(releaseA.paths.some((path) => /^\/assets\/.+\.wasm$/.test(path))).toBe(true);

    const updatePage = await context.newPage();
    await updatePage.goto("/");
    await updatePage.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    await updatePage.reload();
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "A");

    release = "B";
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "A");
    await expect.poll(() => failedReleaseBAssetRequests).toBeGreaterThan(0);
    await expect.poll(async () => (await inspectShell()).cacheNames.filter((name) => name.startsWith("nearlink-shell-release-")).length)
      .toBe(1);
    const afterFailure = await inspectShell();
    expect(afterFailure.active).toBe(releaseA.active);
    expect(afterFailure.shell).toContain('content="A"');

    await context.setOffline(true);
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "A");
    await expect(updatePage.getByText("Messages save locally until a hub is connected")).toBeVisible();

    await context.setOffline(false);
    releaseBAssetMode = "html";
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "A");
    await expect.poll(() => failedReleaseBAssetRequests).toBeGreaterThan(1);
    const afterHtmlFallback = await inspectShell();
    expect(afterHtmlFallback.active).toBe(releaseA.active);
    expect(afterHtmlFallback.shell).toContain('content="A"');

    releaseBAssetMode = "available";
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "B");
    await expect.poll(async () => (await inspectShell()).active).not.toBe(releaseA.active);
    const releaseB = await inspectShell();
    expect(releaseB.paths).toContain("/");
    expect(releaseB.paths).toContain("/manifest.webmanifest");
    expect(releaseB.paths).toContain("/icon.svg");
    expect(releaseB.paths).toContain("/assets/release-b-12345678.js");
    expect(releaseB.paths.some((path) => /^\/assets\/.+\.js$/.test(path))).toBe(true);
    expect(releaseB.paths.some((path) => /^\/assets\/.+\.css$/.test(path))).toBe(true);
    expect(releaseB.paths.some((path) => /^\/assets\/.+\.wasm$/.test(path))).toBe(true);
    const retainedReleases = releaseB.cacheNames.filter((name) => name.startsWith("nearlink-shell-release-"));
    expect(retainedReleases).toHaveLength(2);
    expect(retainedReleases).toContain(releaseA.active);
    expect(retainedReleases).toContain(releaseB.active);
    expect(releaseB.shell).toContain('content="B"');

    await context.setOffline(true);
    const priorAsset = await page.evaluate(async (path) => {
      const response = await fetch(path);
      return { ok: response.ok, source: await response.text() };
    }, "/assets/release-a-12345678.js");
    expect(priorAsset.ok).toBe(true);
    expect(priorAsset.source).toContain('dataset.release = "A"');
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "B");
    await expect(updatePage.getByText("Messages save locally until a hub is connected")).toBeVisible();

    await context.setOffline(false);
    const secondTab = await context.newPage();
    await secondTab.goto("/");
    await secondTab.waitForFunction(async () => {
      await navigator.serviceWorker.ready;
      return Boolean(navigator.serviceWorker.controller);
    });
    await secondTab.reload();
    await expect.poll(async () => (await inspectShell()).active).toMatch(/^nearlink-shell-release-/);
    delayedRelease = "C";
    release = "C";
    const olderNavigation = updatePage.goto("/");
    await expect.poll(() => delayedReleaseRootRequests).toBeGreaterThan(0);
    release = "D";
    await secondTab.goto("/");
    await expect(secondTab.locator("html")).toHaveAttribute("data-release", "D");
    await expect.poll(async () => (await inspectShell()).shell).toContain('content="D"');
    await olderNavigation;
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "D");
    await expect(secondTab.locator("html")).toHaveAttribute("data-release", "D");
    const latestRelease = await inspectShell();
    expect(latestRelease.shell).toContain('content="D"');
    expect(latestRelease.paths).toContain("/assets/release-d-12345678.js");
    expect(latestRelease.paths).not.toContain("/assets/release-c-12345678.js");
    await context.setOffline(true);
    const oldTabAsset = await page.evaluate(async () => {
      const response = await fetch("/assets/release-a-12345678.js");
      return { ok: response.ok, source: await response.text() };
    });
    expect(oldTabAsset.ok).toBe(true);
    expect(oldTabAsset.source).toContain('dataset.release = "A"');
    const legacyLazyAsset = await legacyTab.evaluate(async () => {
      const response = await fetch("/assets/legacy-lazy-12345678.js");
      return { ok: response.ok, source: await response.text() };
    });
    expect(legacyLazyAsset.ok).toBe(true);
    expect(legacyLazyAsset.source).toContain("legacyShellAsset = true");
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "D");

    await page.close();
    await legacyTab.close();
    await context.setOffline(false);
    release = "E";
    await updatePage.goto("/");
    await expect(updatePage.locator("html")).toHaveAttribute("data-release", "E");
    await expect.poll(async () => (await inspectShell(updatePage)).cacheNames.filter((name) => name.startsWith("nearlink-shell-release-")).length)
      .toBe(2);
    const afterClose = await inspectShell(updatePage);
    expect(afterClose.cacheNames.filter((name) => name.startsWith("nearlink-shell-release-"))).not.toContain(releaseA.active);
    expect(afterClose.cacheNames).not.toContain("nearlink-shell-v1");
  } finally {
    await context.close();
  }
});
