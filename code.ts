// Figma Plugin Code

console.log('[Plugin] Plugin code loaded, showing UI...');
figma.showUI(__html__, { width: 320, height: 700 });

const CF_PROXY = 'https://appstore-proxy.jinneng-tools.workers.dev';

/**
 * 通过 CF 代理请求 Apple API，确保所有地区都能正常访问
 */
async function fetchViaProxy(url: string) {
  const proxyUrl = `${CF_PROXY}/?url=${encodeURIComponent(url)}`;
  console.log(`[fetchViaProxy] ${url}`);
  return fetch(proxyUrl);
}

type ScrapeResult = { iphone: string[], ipad: string[], error?: string, stage?: string };

const pendingScrapeRequests = new Map<string, {
  resolve: (result: ScrapeResult) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}>();


function postDiagnostic(message: string, level: 'loading' | 'warning' | 'error' | 'success' = 'loading') {
  figma.ui.postMessage({
    type: 'diagnostic',
    message,
    level
  });
}

// Handle messages from UI
figma.ui.onmessage = async (msg) => {

  if (msg.type === 'scrape-result') {
    const trackId = String(msg.trackId);
    const pending = pendingScrapeRequests.get(trackId);

    if (!pending) {
      console.warn('[Plugin][scrape-result] No pending request for trackId:', trackId);
      return;
    }

    clearTimeout(pending.timeoutId);
    pendingScrapeRequests.delete(trackId);
    console.log('[Plugin][scrape-result] Received UI scrape result — trackId:', trackId, '| iPhone:', msg.iphone?.length ?? 0, '| iPad:', msg.ipad?.length ?? 0);
    pending.resolve({
      iphone: Array.isArray(msg.iphone) ? msg.iphone : [],
      ipad: Array.isArray(msg.ipad) ? msg.ipad : [],
      error: typeof msg.error === 'string' ? msg.error : undefined,
      stage: typeof msg.stage === 'string' ? msg.stage : undefined
    });
    return;
  }

  if (msg.type === 'search-app') {
    console.log('[Plugin][search-app] Start — appName:', msg.appName, '| country:', msg.country);
    try {
      const results = await searchApp(msg.appName, msg.country);
      console.log('[Plugin][search-app] Done — found', results.length, 'apps');
      figma.ui.postMessage({
        type: 'search-results',
        apps: results
      });
    } catch (error) {
      console.error('[Plugin][search-app] ERROR:', error instanceof Error ? error.message : error);
      figma.ui.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Search failed'
      });
    }
  }

  if (msg.type === 'load-rank') {
    try {
      const results = await loadRankData(msg.rank, msg.country, msg.genre, msg.appName, msg.trackId);
      figma.ui.postMessage({
        type: 'rank-results',
        apps: results
      });
    } catch (error) {
      figma.ui.postMessage({
        type: 'rank-results',
        apps: []
      });
    }
  }

  if (msg.type === 'batch-import') {
    const apps = msg.apps;
    console.log('[Plugin][batch-import] Start — total apps:', apps.length, '| device:', msg.device, '| country:', msg.country);
    try {
      let totalCount = 0;

      // Find the bottom of all existing frames on the current page to avoid overlap
      let currentY = 100;
      const existingNodes = figma.currentPage.children;
      console.log('[Plugin][batch-import] Existing nodes on page:', existingNodes.length);
      for (const node of existingNodes) {
        const nodeBottom = node.y + node.height;
        if (nodeBottom + 40 > currentY) {
          currentY = nodeBottom + 40;
        }
      }
      console.log('[Plugin][batch-import] Start Y position:', currentY);

      for (let i = 0; i < apps.length; i++) {
        let appToImport = apps[i];
        console.log(`[Plugin][batch-import] Processing app ${i + 1}/${apps.length}: "${appToImport.trackName}" (trackId: ${appToImport.trackId})`);

        // Fetch full details if needed
        if ((!appToImport.screenshotUrls || appToImport.screenshotUrls.length === 0) && appToImport.trackId) {
          console.log(`[Plugin][batch-import] App ${i + 1} has no screenshotUrls, fetching details from iTunes...`);
          const detailsUrl = `https://itunes.apple.com/lookup?id=${appToImport.trackId}&country=${msg.country}&entity=software`;
          console.log(`[Plugin][batch-import] Details URL:`, detailsUrl);
          const response = await fetchViaProxy(detailsUrl);
          console.log(`[Plugin][batch-import] Details response status:`, response.status);
          const data = await response.json();
          if (data.results && data.results.length > 0) {
            appToImport = data.results[0];
            console.log(`[Plugin][batch-import] Details fetched — screenshotUrls: ${appToImport.screenshotUrls?.length ?? 0}, ipadScreenshotUrls: ${appToImport.ipadScreenshotUrls?.length ?? 0}`);
          } else {
            console.warn(`[Plugin][batch-import] Details fetch returned no results for trackId:`, appToImport.trackId);
          }
        } else {
          console.log(`[Plugin][batch-import] App already has screenshotUrls: ${appToImport.screenshotUrls?.length ?? 0}`);
        }

        const result = await importScreenshots(appToImport, msg.device, msg.country, currentY);
        totalCount += result.count;
        console.log(`[Plugin][batch-import] App ${i + 1} done — imported ${result.count} items, nextY: ${result.nextY}`);
        currentY = result.nextY + 40; // Add 40px spacing between apps
      }

      console.log('[Plugin][batch-import] All done — total imported:', totalCount);
      figma.ui.postMessage({
        type: 'import-complete',
        count: totalCount
      });
    } catch (error) {
      console.error('[Plugin][batch-import] ERROR:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) {
        console.error('[Plugin][batch-import] Stack:', error.stack);
      }
      figma.ui.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Batch import failed'
      });
    }
  }

  if (msg.type === 'import-screenshots') {
    console.log('[Plugin][import-screenshots] Start — app:', msg.app?.trackName, '| device:', msg.device, '| country:', msg.country);
    try {
      // If the app doesn't have full details (from rank list), fetch them first
      let appToImport = msg.app;
      if ((!appToImport.screenshotUrls || appToImport.screenshotUrls.length === 0) && appToImport.trackId) {
        console.log('[Plugin][import-screenshots] No screenshotUrls, fetching full details for trackId:', appToImport.trackId);
        const detailsUrl = `https://itunes.apple.com/lookup?id=${appToImport.trackId}&country=${msg.country}&entity=software`;
        console.log('[Plugin][import-screenshots] Details URL:', detailsUrl);
        const response = await fetchViaProxy(detailsUrl);
        console.log('[Plugin][import-screenshots] Details response status:', response.status);
        const data = await response.json();
        if (data.results && data.results.length > 0) {
          appToImport = data.results[0];
          console.log('[Plugin][import-screenshots] Details fetched — screenshotUrls:', appToImport.screenshotUrls?.length ?? 0);
        } else {
          console.warn('[Plugin][import-screenshots] No results returned from details API');
        }
      }

      const result = await importScreenshots(appToImport, msg.device, msg.country);
      console.log('[Plugin][import-screenshots] Done — imported:', result.count);
      figma.ui.postMessage({
        type: 'import-complete',
        count: result.count
      });
    } catch (error) {
      console.error('[Plugin][import-screenshots] ERROR:', error instanceof Error ? error.message : error);
      if (error instanceof Error && error.stack) {
        console.error('[Plugin][import-screenshots] Stack:', error.stack);
      }
      figma.ui.postMessage({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
};

/**
 * Search for apps in App Store
 */
async function searchApp(appName: string, country: string) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(appName)}&country=${country}&entity=software&limit=20`;
  console.log('[searchApp] Request URL:', url);

  const response = await fetchViaProxy(url);
  console.log('[searchApp] Response status:', response.status, response.statusText);

  const data = await response.json();
  console.log('[searchApp] Raw result count:', data.results?.length ?? 0);

  return data.results;
}

/**
 * Load similar apps: iTunes RSS ranking + keyword search, merged and deduplicated
 */
async function loadRankData(rank: string, country: string, genre: number, appName?: string, trackId?: number) {
  const allApps = new Map<string, any>();

  const rankTypeMap: Record<string, string> = {
    'free': 'top-free',
    'paid': 'top-paid',
    'grossing': 'top-grossing'
  };
  const rankType = rankTypeMap[rank] || 'top-free';

  // 按照文档：三步并行
  // 1. RSS 同类别排行榜 (getTopApps_RSS)
  // 2. iTunes lookup 关联应用
  // 3. 搜索 App 名称关键词

  // 畅销榜使用旧版 iTunes RSS（新版 API 不支持 top-grossing）
  let rssUrl: string;
  let isLegacyRss = false;
  if (rank === 'grossing') {
    isLegacyRss = true;
    const legacyRankMap: Record<string, string> = { 'grossing': 'topgrossingapplications' };
    const legacyType = legacyRankMap[rank];
    rssUrl = `https://itunes.apple.com/${country.toLowerCase()}/rss/${legacyType}/limit=50${genre ? '/genre=' + genre : ''}/json`;
  } else {
    rssUrl = `https://rss.marketingtools.apple.com/api/v2/${country.toLowerCase()}/apps/${rankType}/50/apps.json${genre ? '?genreId=' + genre : ''}`;
  }

  const rssPromise = new Promise<any>((resolve) => {
    const handler = (msg: any) => {
      if (msg?.type === 'rss-result') {
        figma.ui.off('message', handler);
        resolve(msg.data);
      }
    };
    figma.ui.on('message', handler);
    figma.ui.postMessage({ type: 'fetch-rss', url: rssUrl });
    setTimeout(() => { figma.ui.off('message', handler); resolve(null); }, 8000);
  });

  const lookupPromise = trackId
    ? fetchViaProxy(`https://itunes.apple.com/lookup?id=${trackId}&entity=software&country=${country}&limit=50`)
        .then(r => r.json()).catch(() => null)
    : Promise.resolve(null);

  const searchPromise = appName
    ? fetchViaProxy(`https://itunes.apple.com/search?term=${encodeURIComponent(appName.split(/[\s\-:]+/).slice(0, 2).join(' '))}&media=software&entity=software&limit=30&country=${country}`)
        .then(r => r.json()).catch(() => null)
    : Promise.resolve(null);

  const [rssData, lookupData, searchData] = await Promise.all([rssPromise, lookupPromise, searchPromise]);

  // 1. RSS 排行榜：拿到 ID 列表后用 getAppsByIds 批量查详情
  let appIds: string[] = [];
  if (isLegacyRss && rssData?.feed?.entry) {
    // 旧版 iTunes RSS 格式
    appIds = rssData.feed.entry
      .map((e: any) => e?.id?.attributes?.['im:id'])
      .filter((id: string) => id && (!trackId || id !== String(trackId)));
    console.log('[loadRankData] Legacy RSS entries:', rssData.feed.entry.length, '| IDs extracted:', appIds.length);
  } else if (rssData?.feed?.results) {
    // 新版 marketingtools RSS 格式
    appIds = rssData.feed.results
      .map((r: any) => r.id)
      .filter((id: string) => !trackId || id !== String(trackId));
    console.log('[loadRankData] New RSS results:', rssData.feed.results.length, '| IDs extracted:', appIds.length);
  }

  if (appIds.length > 0) {
    try {
      const batchUrl = `https://itunes.apple.com/lookup?id=${appIds.slice(0, 50).join(',')}&country=${country}`;
      const batchResponse = await fetchViaProxy(batchUrl);
      const batchData = await batchResponse.json();
      if (batchData.results) {
        for (const app of batchData.results) {
          if (app.trackId && app.trackId !== trackId) {
            allApps.set(String(app.trackId), app);
          }
        }
      }
    } catch (error) {
      console.error('[loadRankData] RSS batch lookup failed:', error instanceof Error ? error.message : error);
    }
  }
  console.log('[loadRankData] RSS rank apps:', allApps.size);

  // 2. iTunes lookup 关联应用（只保留同类别）
  if (lookupData?.results) {
    for (let i = 1; i < lookupData.results.length; i++) {
      const app = lookupData.results[i];
      if (app.trackId && !allApps.has(String(app.trackId)) && app.primaryGenreId === genre) {
        allApps.set(String(app.trackId), app);
      }
    }
  }

  // 3. 搜索关键词（只保留同类别）
  if (searchData?.results) {
    for (const app of searchData.results) {
      if (app.trackId && !allApps.has(String(app.trackId)) && (!trackId || app.trackId !== trackId)) {
        if (app.primaryGenreId === genre) {
          allApps.set(String(app.trackId), app);
        }
      }
    }
  }

  console.log('[loadRankData] Total apps:', allApps.size, '| rank:', rank);

  // 排序：同类别优先，再按评分
  const result = Array.from(allApps.values());
  result.sort((a: any, b: any) => {
    const aSame = a.primaryGenreId === genre ? 1 : 0;
    const bSame = b.primaryGenreId === genre ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame;
    return (b.averageUserRating || 0) - (a.averageUserRating || 0);
  });

  return result.slice(0, 20);
}

async function scrapeAppStoreScreenshots(trackId: string, country: string): Promise<ScrapeResult> {
  console.log('[scrapeAppStoreScreenshots] Asking UI to scrape trackId:', trackId, 'country:', country);
  postDiagnostic(`正在抓取 App Store 页面截图: ${trackId}`, 'loading');

  try {
    const result = await new Promise<ScrapeResult>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        pendingScrapeRequests.delete(trackId);
        reject(new Error(`Timed out waiting for UI scrape result for trackId ${trackId}`));
      }, 15000);

      pendingScrapeRequests.set(trackId, { resolve, reject, timeoutId });

      figma.ui.postMessage({
        type: 'scrape-appstore',
        trackId,
        country
      });
    });

    console.log('[scrapeAppStoreScreenshots] UI scrape completed — iPhone:', result.iphone.length, 'iPad:', result.ipad.length);

    if (result.error) {
      postDiagnostic(`截图 fallback 失败: ${result.error}`, 'error');
    } else if (result.iphone.length > 0 || result.ipad.length > 0) {
      postDiagnostic(`截图 fallback 成功: iPhone ${result.iphone.length} 张, iPad ${result.ipad.length} 张`, 'success');
    } else {
      postDiagnostic('App Store 页面可访问，但没有解析出截图', 'warning');
    }

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[scrapeAppStoreScreenshots] Failed:', message);
    postDiagnostic(`等待 UI 抓取结果超时: ${message}`, 'error');
    return { iphone: [], ipad: [], error: message, stage: 'plugin-timeout' };
  }
}

/**
 * Import screenshots to Figma
 */
async function importScreenshots(app: any, device: string, country: string, startY?: number) {
  console.log('[importScreenshots] Start — app:', app.trackName, '| device:', device, '| country:', country, '| startY:', startY);

  // Load Inter font - this is the default font in Figma
  console.log('[importScreenshots] Loading fonts...');
  await figma.loadFontAsync({ family: "Inter", style: "Regular" });
  await figma.loadFontAsync({ family: "Inter", style: "Bold" });
  console.log('[importScreenshots] Fonts loaded');

  // Only fetch details if app doesn't already have screenshot data
  let appDetails = app;
  if ((!app.screenshotUrls || app.screenshotUrls.length === 0) && app.trackId) {
    const detailsUrl = `https://itunes.apple.com/lookup?id=${app.trackId}&country=${country}&entity=software`;
    console.log('[importScreenshots] Fetching app details:', detailsUrl);
    const response = await fetchViaProxy(detailsUrl);
    console.log('[importScreenshots] Details response status:', response.status);
    const data = await response.json();
    if (data.results && data.results.length > 0) {
      appDetails = data.results[0];
      console.log('[importScreenshots] Details received — screenshotUrls:', appDetails.screenshotUrls?.length ?? 0, '| ipadScreenshotUrls:', appDetails.ipadScreenshotUrls?.length ?? 0, '| genres:', appDetails.genres);
    } else {
      console.warn('[importScreenshots] Details API returned no results');
    }
  } else {
    console.log('[importScreenshots] App already has details — screenshotUrls:', app.screenshotUrls?.length ?? 0);
  }

  // If iTunes API returned no screenshots at all, scrape App Store page as fallback
  const noScreenshots = (!appDetails.screenshotUrls || appDetails.screenshotUrls.length === 0) &&
                        (!appDetails.ipadScreenshotUrls || appDetails.ipadScreenshotUrls.length === 0);
  if (noScreenshots) {
    console.log('[importScreenshots] iTunes API has no screenshots, trying App Store scrape fallback...');

    if (appDetails.trackId) {
      const scraped = await scrapeAppStoreScreenshots(String(appDetails.trackId), country);
      if (scraped.iphone.length > 0 || scraped.ipad.length > 0) {
        console.log('[importScreenshots] Scrape fallback found — iPhone:', scraped.iphone.length, 'iPad:', scraped.ipad.length);
        appDetails = {
          ...appDetails,
          screenshotUrls: scraped.iphone.length > 0 ? scraped.iphone : scraped.ipad,
          ipadScreenshotUrls: scraped.ipad
        };
      } else {
        console.warn('[importScreenshots] Scrape fallback also found no screenshots');
        console.warn('[importScreenshots] Note: iTunes API no longer returns screenshot URLs for many apps.');
        if (scraped.error) {
          postDiagnostic(`截图未导入: ${scraped.error}`, 'error');
        } else {
          postDiagnostic('截图未导入: App Store 页面解析后仍然没有截图', 'warning');
        }
      }
    } else {
      console.warn('[importScreenshots] Cannot run scrape fallback without trackId');
    }
  }

  // If device is iphone but no iPhone screenshots, fall back to iPad screenshots
  const hasIphoneScreenshots = appDetails.screenshotUrls && appDetails.screenshotUrls.length > 0;
  const hasIpadScreenshots = appDetails.ipadScreenshotUrls && appDetails.ipadScreenshotUrls.length > 0;
  if ((device === 'iphone' || device === 'all') && !hasIphoneScreenshots && hasIpadScreenshots) {
    console.log('[importScreenshots] No iPhone screenshots, falling back to iPad screenshots');
    appDetails = { ...appDetails, screenshotUrls: appDetails.ipadScreenshotUrls };
  }

  // Create a frame for the app
  console.log('[importScreenshots] Creating frame for:', app.trackName);
  const frame = figma.createFrame();
  frame.name = `${app.trackName} - ${country}`;
  frame.resize(1200, 800);
  frame.fills = [{ type: 'SOLID', color: { r: 0.98, g: 0.98, b: 0.98 } }];

  // Position frames: if startY is provided (batch import), use it; otherwise center in viewport
  if (startY !== undefined) {
    // Batch import: stack vertically from top-left
    frame.x = 100;
    frame.y = startY;
    console.log('[importScreenshots] Frame positioned (batch) at x:100 y:', startY);
  } else {
    // Single import: center in viewport
    frame.x = figma.viewport.center.x - 600;
    frame.y = figma.viewport.center.y - 400;
    console.log('[importScreenshots] Frame positioned (single) at x:', frame.x, 'y:', frame.y);
  }

  let yOffset = 32;
  let importCount = 0;
  let maxWidth = 1200;

  // Import app icon
  if (appDetails.artworkUrl512 || appDetails.artworkUrl100) {
    const iconUrl = appDetails.artworkUrl512 || appDetails.artworkUrl100;
    console.log('[importScreenshots] Loading app icon:', iconUrl);
    const iconNode = await createImageNode(iconUrl, 'App Icon');

    if (iconNode) {
      iconNode.x = 32;
      iconNode.y = yOffset;
      iconNode.resize(120, 120);

      // Add rounded corners (App Store icon style: 22.37% radius)
      iconNode.cornerRadius = 26.8; // 120 * 0.2237 ≈ 26.8

      frame.appendChild(iconNode);
      console.log('[importScreenshots] App icon added to frame');

      // Add app name text
      try {
        console.log('[importScreenshots] Creating text nodes for app:', app.trackName);

        // 计算文字块垂直居中于图标
        const iconHeight = 120;
        const titleSize = 28;
        const subSize = 14;
        const devSize = 13;
        const lineGap = 4;
        const titleGap = 12;
        let totalTextHeight = titleSize + titleGap + devSize;
        const hasGenre = appDetails.genres && appDetails.genres.length > 0;
        if (hasGenre) totalTextHeight += subSize + lineGap;
        const textStartY = yOffset + Math.round((iconHeight - totalTextHeight) / 2);

        const textNode = figma.createText();
        textNode.fontName = { family: "Inter", style: "Bold" };
        textNode.characters = app.trackName || 'Unknown App';
        textNode.fontSize = titleSize;
        textNode.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
        textNode.x = 168;
        textNode.y = textStartY;
        frame.appendChild(textNode);
        console.log('[importScreenshots] App name text created');

        let textYOffset = textStartY + titleSize + titleGap;

        // Add subtitle if available
        if (hasGenre) {
          const subtitleNode = figma.createText();
          subtitleNode.characters = appDetails.genres[0];
          subtitleNode.fontSize = subSize;
          subtitleNode.fills = [{ type: 'SOLID', color: { r: 0.56, g: 0.56, b: 0.58 } }];
          subtitleNode.x = 168;
          subtitleNode.y = textYOffset;
          frame.appendChild(subtitleNode);
          console.log('[importScreenshots] Genre subtitle created:', appDetails.genres[0]);
          textYOffset += subSize + lineGap;
        }

        // Add developer name
        const developerNode = figma.createText();
        developerNode.characters = `${app.artistName || 'Unknown'} · v${app.version || '1.0'}`;
        developerNode.fontSize = devSize;
        developerNode.fills = [{ type: 'SOLID', color: { r: 0.56, g: 0.56, b: 0.58 } }];
        developerNode.x = 168;
        developerNode.y = textYOffset;
        frame.appendChild(developerNode);
        console.log('[importScreenshots] Developer info created:', developerNode.characters);
      } catch (textError) {
        console.error('[importScreenshots] Failed to create text nodes:', textError instanceof Error ? textError.message : textError);
        const errorMsg = textError instanceof Error ? textError.message : String(textError);
        const errorStack = textError instanceof Error ? textError.stack : '';
        console.error('[importScreenshots] Text error details:', errorMsg, errorStack);
      }

      yOffset += 152;
      importCount++;
    } else {
      console.warn('[importScreenshots] Icon failed to load, skipping icon node');
    }
  } else {
    console.log('[importScreenshots] No artwork URL found, skipping icon');
  }

  // Import iPhone screenshots
  if ((device === 'all' || device === 'iphone') && appDetails.screenshotUrls && appDetails.screenshotUrls.length > 0) {
    const count = appDetails.screenshotUrls.length;
    console.log('[importScreenshots] Loading iPhone screenshots:', count);

    // Create section label
    try {
      const sectionLabel = figma.createText();
      sectionLabel.fontName = { family: "Inter", style: "Bold" };
      sectionLabel.characters = '预览';
      sectionLabel.fontSize = 24;
      sectionLabel.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      sectionLabel.x = 32;
      sectionLabel.y = yOffset;
      frame.appendChild(sectionLabel);
      yOffset += 48;
      console.log('[importScreenshots] iPhone section label created');
    } catch (error) {
      console.error('[importScreenshots] Failed to create iPhone section label:', error instanceof Error ? error.message : error);
      yOffset += 48;
    }

    let xOffset = 32;
    const screenshotSpacing = 16; // Spacing between screenshots
    for (let i = 0; i < count; i++) {
      const screenshotUrl = appDetails.screenshotUrls[i];
      console.log(`[importScreenshots] Loading iPhone screenshot ${i + 1}/${count}:`, screenshotUrl);
      const imageNode = await createImageNode(screenshotUrl, `iPhone Screenshot ${i + 1}`);

      if (imageNode) {
        imageNode.x = xOffset;
        imageNode.y = yOffset;

        // Resize to fit (App Store uses ~392pt height for iPhone screenshots)
        const maxHeight = 500;
        const scale = maxHeight / imageNode.height;
        const newWidth = imageNode.width * scale;
        imageNode.resize(newWidth, maxHeight);
        console.log(`[importScreenshots] iPhone screenshot ${i + 1} resized to ${newWidth.toFixed(0)}x${maxHeight}`);

        // Add rounded corners (App Store screenshot style)
        imageNode.cornerRadius = 12;

        // Add subtle border instead of shadow
        imageNode.strokes = [{
          type: 'SOLID',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.08
        }];
        imageNode.strokeWeight = 0.5;
        imageNode.strokeAlign = 'INSIDE';

        frame.appendChild(imageNode);
        xOffset += imageNode.width + screenshotSpacing;
        importCount++;
      } else {
        console.warn(`[importScreenshots] iPhone screenshot ${i + 1} failed to load, skipping`);
      }
    }
    // Update max width
    maxWidth = Math.max(maxWidth, xOffset + 32);
    yOffset += 532; // 500 + 32 spacing
    console.log('[importScreenshots] iPhone screenshots done, xOffset:', xOffset, 'maxWidth:', maxWidth);
  } else {
    console.log('[importScreenshots] No iPhone screenshotUrls available');

    // Add a helpful message with App Store link
    try {
      const helpText = figma.createText();
      helpText.fontName = { family: "Inter", style: "Regular" };
      helpText.characters = `📱 截图不可用\n\n由于 Apple API 限制，无法自动获取截图。\n请访问 App Store 手动复制截图：\n\nhttps://apps.apple.com/${country.toLowerCase()}/app/id${appDetails.trackId}`;
      helpText.fontSize = 14;
      helpText.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
      helpText.x = 32;
      helpText.y = yOffset;
      helpText.textAlignHorizontal = 'LEFT';
      frame.appendChild(helpText);
      yOffset += 150;
      console.log('[importScreenshots] Added help text for manual screenshot download');
    } catch (error) {
      console.error('[importScreenshots] Failed to create help text:', error instanceof Error ? error.message : error);
      yOffset += 150;
    }
  }

  // Import iPad screenshots
  if ((device === 'all' || device === 'ipad') && appDetails.ipadScreenshotUrls && appDetails.ipadScreenshotUrls.length > 0) {
    const count = appDetails.ipadScreenshotUrls.length;
    console.log('[importScreenshots] Loading iPad screenshots:', count);

    // Create section label
    try {
      const sectionLabel = figma.createText();
      sectionLabel.fontName = { family: "Inter", style: "Bold" };
      sectionLabel.characters = 'iPad 预览';
      sectionLabel.fontSize = 24;
      sectionLabel.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }];
      sectionLabel.x = 32;
      sectionLabel.y = yOffset;
      frame.appendChild(sectionLabel);
      yOffset += 48;
      console.log('[importScreenshots] iPad section label created');
    } catch (error) {
      console.error('[importScreenshots] Failed to create iPad section label:', error instanceof Error ? error.message : error);
      yOffset += 48;
    }

    let xOffset = 32;
    const screenshotSpacing = 16;
    for (let i = 0; i < count; i++) {
      const screenshotUrl = appDetails.ipadScreenshotUrls[i];
      console.log(`[importScreenshots] Loading iPad screenshot ${i + 1}/${count}:`, screenshotUrl);
      const imageNode = await createImageNode(screenshotUrl, `iPad Screenshot ${i + 1}`);

      if (imageNode) {
        imageNode.x = xOffset;
        imageNode.y = yOffset;

        // Resize to fit (iPad screenshots are wider)
        const maxHeight = 450;
        const scale = maxHeight / imageNode.height;
        const newWidth = imageNode.width * scale;
        imageNode.resize(newWidth, maxHeight);
        console.log(`[importScreenshots] iPad screenshot ${i + 1} resized to ${newWidth.toFixed(0)}x${maxHeight}`);

        // Add rounded corners
        imageNode.cornerRadius = 12;

        // Add subtle border instead of shadow
        imageNode.strokes = [{
          type: 'SOLID',
          color: { r: 0, g: 0, b: 0 },
          opacity: 0.08
        }];
        imageNode.strokeWeight = 0.5;
        imageNode.strokeAlign = 'INSIDE';

        frame.appendChild(imageNode);
        xOffset += imageNode.width + screenshotSpacing;
        importCount++;
      } else {
        console.warn(`[importScreenshots] iPad screenshot ${i + 1} failed to load, skipping`);
      }
    }
    // Update max width
    maxWidth = Math.max(maxWidth, xOffset + 32);
    yOffset += 482; // 450 + 32 spacing
    console.log('[importScreenshots] iPad screenshots done, xOffset:', xOffset, 'maxWidth:', maxWidth);
  } else if (device === 'all' || device === 'ipad') {
    console.log('[importScreenshots] No iPad ipadScreenshotUrls available');
  }

  // Resize frame to fit content
  frame.resize(maxWidth, yOffset + 32);
  console.log('[importScreenshots] Frame resized to', maxWidth, 'x', yOffset + 32);

  // Select the frame
  figma.currentPage.selection = [frame];
  figma.viewport.scrollAndZoomIntoView([frame]);

  console.log('[importScreenshots] Done — total import count:', importCount, '| frame bottom Y:', frame.y + frame.height);

  return {
    count: importCount,
    nextY: frame.y + frame.height // Return the Y position for next frame
  };
}

/**
 * Create an image node from URL
 */
async function createImageNode(url: string, name: string): Promise<RectangleNode | null> {
  console.log(`[createImageNode] Fetching: "${name}" from`, url);
  try {
    const response = await fetchViaProxy(url);

    const arrayBuffer = await response.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    console.log(`[createImageNode] Downloaded ${uint8Array.byteLength} bytes for "${name}"`);

    const image = figma.createImage(uint8Array);
    const rect = figma.createRectangle();
    rect.name = name;

    // Get image dimensions
    const { width, height } = await image.getSizeAsync();
    console.log(`[createImageNode] Image size for "${name}": ${width}x${height}`);
    rect.resize(width, height);

    rect.fills = [{
      type: 'IMAGE',
      scaleMode: 'FILL',
      imageHash: image.hash
    }];

    console.log(`[createImageNode] Node created for "${name}" (hash: ${image.hash})`);
    return rect;
  } catch (error) {
    console.error(`[createImageNode] FAILED to load "${name}" from: ${url}`);
    console.error(`[createImageNode] Error:`, error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) {
      console.error(`[createImageNode] Stack:`, error.stack);
    }
    return null;
  }
}
