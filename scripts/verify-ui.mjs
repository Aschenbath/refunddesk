// Invoke through playwright-cli run-code after opening a fresh replay demo and taking a snapshot.
// This checks the replay UI (dev or production) and writes screenshots and CSV evidence.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const url = (path) => new URL(path, page.url()).href;
  const csvRows = (source) => {
    const rows = [], text = source.replace(/^\uFEFF/, '');
    let row = [], field = '', quoted = false;
    for (let index = 0; index < text.length; index++) {
      const character = text[index];
      if (character === '"') {
        if (quoted && text[index + 1] === '"') { field += '"'; index++; }
        else quoted = !quoted;
      } else if (!quoted && character === ',') { row.push(field); field = ''; }
      else if (!quoted && character === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (quoted || character !== '\r') field += character;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
  };
  const outcomeHeader = ['Case', 'Revision', 'Customer', 'Order', 'Status', 'Approved', 'Refunded', 'Approved currency', 'Refund IDs', 'Blocking reasons', 'Refunded currency'];
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
  const health = await (await page.request.get(url('/api/health'))).json();
  check(health.demoMode === 'replay', 'UI verification requires the network-free replay demo');
  const foreignOrigin = await page.request.post(url('/api/cases/missing/triage'), { headers: { Origin: 'https://other.example.test' } });
  check(foreignOrigin.status() === 403, 'Local proxy no longer rejects foreign-origin mutations');
  await page.getByRole('button', { name: /^Risky/ }).waitFor();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await page.getByRole('button', { name: /^Risky/ }).click();
  const total = page.locator('.ag-grid-pinned-bottom-rows').first();
  await total.getByText('10 cases · totals', { exact: true }).waitFor();
  // Let AG Grid's row animation settle; otherwise the screenshot catches leaving rows mid-fade.
  await page.waitForTimeout(1000);
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `output/playwright/queue-risky-${width}.png` });
    await page.screenshot({ path: `output/playwright/demo-badge-${width}.png` });
    const box = await total.boundingBox();
    check(box && box.y + box.height <= height, `Queue totals below ${width} viewport`);
  }
  const queueDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export view CSV ↓' }).click();
  const queueCsv = await queueDownload;
  await queueCsv.saveAs('output/playwright/queue-risky.csv');
  let queueText = '';
  for await (const chunk of await queueCsv.createReadStream()) queueText += chunk.toString();
  const queueRows = csvRows(queueText);
  check(['Model', 'Allowed', 'Approved', 'Refunded'].every((name) => queueRows[0].includes(name)) && queueText.includes('$140.00'), 'Queue CSV lacks currency-neutral amount headings or its USD values');
  check(!queueRows[0].some((name) => name.includes('($)')), 'Queue CSV headings incorrectly assume all rows use dollars');
  check(queueText.trim().split(/\r?\n/).length === 11, 'Queue export does not follow Risky filter');
  const batch = page.getByRole('region', { name: 'Review batch' });
  const headerCheckbox = page.getByRole('checkbox', { name: 'Column with Header Selection', exact: true });
  check(await batch.count() === 0, 'Batch bar visible without a selection');
  await headerCheckbox.check();
  await batch.getByText('10 selected', { exact: true }).waitFor();
  check(await page.getByRole('dialog').count() === 0, 'Checkbox selection opened the drawer');
  check((await batch.innerText()).includes('9 blocked · 1 ready · 0 already refunded'), 'Batch workflow counts are wrong');
  check((await batch.innerText()).includes('Approval stays per case · revision-bound'), 'Batch does not explain individual approval');
  for (const name of ['Triage selected', 'Reconcile selected orders', 'Export outcomes']) check(await page.getByRole('button', { name, exact: true }).count() === 1, `Duplicate ${name} control`);
  check(await page.getByRole('button', { name: 'Triage new messages' }).count() === 0, 'Queue still offers a second bulk triage control');
  check(await page.getByRole('button', { name: 'Export view CSV ↓' }).count() === 0, 'Selection offers duplicate export controls');
  check(await total.getByRole('checkbox').count() === 0, 'Pinned totals are selectable');
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `output/playwright/queue-batch-${width}.png` });
    const box = await total.boundingBox(), barBox = await batch.boundingBox();
    check(box && box.y + box.height <= height && barBox && barBox.y + barBox.height < box.y, `Batch or totals below ${width} viewport`);
  }
  await page.getByRole('combobox', { name: 'Policy check filter' }).selectOption('adjusted');
  await total.getByText('1 cases · totals', { exact: true }).waitFor();
  check((await total.innerText()).includes('$72.00'), 'Adjusted case allowance total is wrong');
  await batch.getByText('9 outside this view', { exact: true }).waitFor();
  await batch.getByRole('button', { name: 'Clear selection' }).click();
  const adjustedCheckbox = page.locator('[row-id="case-seed-06"]').getByRole('checkbox');
  await adjustedCheckbox.check();
  check(await page.getByRole('dialog').count() === 0, 'Row checkbox opened the drawer');
  await batch.getByText('1 selected', { exact: true }).waitFor();
  check((await batch.innerText()).includes('Model $140.00') && (await batch.innerText()).includes('Allowed $72.00'), 'Batch amounts do not follow selection');
  await page.locator('[row-id="case-seed-06"] [col-id="sender"]').click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Close case' }).click();
  await batch.getByText('1 selected', { exact: true }).waitFor();
  const outcomeDownload = page.waitForEvent('download');
  await batch.getByRole('button', { name: 'Export outcomes' }).click();
  const outcomeCsv = await outcomeDownload;
  await outcomeCsv.saveAs('output/playwright/queue-outcomes.csv');
  let outcomeText = '';
  for await (const chunk of await outcomeCsv.createReadStream()) outcomeText += chunk.toString();
  check(outcomeText.includes('"case-seed-06"') && outcomeText.includes('"72.00"') && outcomeText.includes('"Refund IDs","Blocking reasons"'), 'Selected outcome export is incomplete');
  const outcomeRows = csvRows(outcomeText);
  check(JSON.stringify(outcomeRows[0]) === JSON.stringify(outcomeHeader), 'Outcome CSV lost the explicit approved/refunded currency columns or changed the existing field order');
  check(outcomeRows[1][0] === 'case-seed-06' && outcomeRows[1][5] === '72.00' && outcomeRows[1][6] === '0.00' && outcomeRows[1][7] === 'USD' && outcomeRows[1][10] === 'USD', 'Selected outcome amounts are not paired with their own currencies');
  check(outcomeText.trim().split(/\r?\n/).length === 2, 'Outcome export includes unselected rows');
  await page.reload();
  await page.getByRole('combobox', { name: 'Policy check filter' }).waitFor();
  check(await page.getByRole('combobox', { name: 'Policy check filter' }).inputValue() === 'adjusted', 'Queue native filter did not persist');
  check(await page.getByRole('button', { name: /^Risky/ }).getAttribute('aria-pressed') === 'true', 'Saved view did not persist');
  check(await batch.count() === 0, 'A previous review batch was restored after reload');
  await page.locator('.column-picker summary').click();
  await page.getByLabel('Subject', { exact: true }).check();
  await page.locator('.column-picker summary').click();
  await page.getByRole('textbox', { name: 'Subject Filter Input' }).fill('I WANT');
  await total.getByText('1 cases · totals', { exact: true }).waitFor();
  await page.locator('[row-id="case-seed-06"] [col-id="sender"]').focus();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog').waitFor();
  await page.locator('.ai-trace summary').click();
  check(await page.getByText('Demo fixture, not a live model call', { exact: true }).isVisible(), 'Fixture trace is not labelled');
  check((await page.locator('.ai-trace').innerText()).includes('$140.00'), 'Original model proposal missing');
  check(await page.locator('.message mark').count() > 0, 'Evidence spans are not highlighted');
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `output/playwright/drawer-trace-${width}.png` });
  }
  await page.getByRole('button', { name: 'Close case' }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await page.getByRole('button', { name: /^Risky/ }).click();
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  await page.getByRole('textbox', { name: 'Customer Filter Input' }).fill('Luis');
  await total.getByText('2 orders · totals', { exact: true }).waitFor();
  const ledgerTotals = await total.innerText();
  check(ledgerTotals.includes('$128.00') && ledgerTotals.includes('$12.00') && ledgerTotals.includes('$116.00'), 'Ledger filtered totals are wrong');
  for (const [width, height] of [[1440, 900], [1280, 800]]) {
    await page.setViewportSize({ width, height });
    await page.screenshot({ path: `output/playwright/ledger-filtered-${width}.png` });
    const box = await total.boundingBox();
    check(box && box.y + box.height <= height, `Ledger totals below ${width} viewport`);
  }
  const ledgerDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export ledger CSV ↓' }).click();
  const ledgerCsv = await ledgerDownload;
  await ledgerCsv.saveAs('output/playwright/ledger-filtered.csv');
  let ledgerText = '';
  for await (const chunk of await ledgerCsv.createReadStream()) ledgerText += chunk.toString();
  check(ledgerText.includes('$12.00') && ledgerText.trim().split(/\r?\n/).length === 3, 'Ledger CSV does not export the filtered dollar amounts');
  const ledgerRows = csvRows(ledgerText);
  check(['Captured', 'Refunded', 'Net', 'Pending'].every((name) => ledgerRows[0].includes(name)) && !ledgerRows[0].some((name) => name.includes('($)')), 'Ledger CSV amount headings incorrectly assume one currency');
  await page.reload();
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await total.getByText('2 orders · totals', { exact: true }).waitFor();
  check(await page.getByRole('textbox', { name: 'Customer Filter Input' }).inputValue() === 'Luis', 'Ledger filter did not persist');
  await page.getByRole('button', { name: /^Approval queue/ }).click();
  await page.getByRole('button', { name: /^Refunded/ }).click();
  await headerCheckbox.check();
  await batch.getByText('2 selected', { exact: true }).waitFor();
  check((await batch.innerText()).includes('0 blocked · 0 ready · 2 already refunded'), 'Refunded batch counts are wrong');
  const refundedDownload = page.waitForEvent('download');
  await batch.getByRole('button', { name: 'Export outcomes' }).click();
  const refundedCsv = await refundedDownload;
  await refundedCsv.saveAs('output/playwright/queue-refunded-outcomes.csv');
  let refundedText = '';
  for await (const chunk of await refundedCsv.createReadStream()) refundedText += chunk.toString();
  const completedCases = (await (await page.request.get(url('/api/cases'))).json()).filter((value) => value.status === 'refunded');
  const refundedRows = csvRows(refundedText);
  check(JSON.stringify(refundedRows[0]) === JSON.stringify(outcomeHeader), 'Refunded outcome CSV lost its currency headings');
  for (const value of completedCases) for (const refund of value.refunds.filter((refund) => refund.caseId === value.id && refund.status === 'COMPLETED')) check(refundedText.includes(refund.id), 'Outcome CSV omits a case refund receipt');
  for (const value of completedCases) {
    const row = refundedRows.find((entry) => entry[0] === value.id);
    check(row && row[10] === 'USD' && /^\d+\.\d{2}$/.test(row[6]), 'Completed USD receipts lost their separate currency or decimal total');
  }
  check(refundedText.trim().split(/\r?\n/).length === 3, 'Refunded outcomes contain unselected rows');
  await batch.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
  const post = async (path, data) => {
    const response = await page.request.post(url(path), { data, headers: { Origin: new URL(page.url()).origin } });
    check(response.ok(), `Replay fixture request failed: ${path} (${response.status()})`);
    return response.json();
  };
  const created = [];
  for (let index = 1; index <= 3; index++) created.push(await post('/api/cases', {
    sender: 'Maya Chen', email: 'maya@example.test', subject: `Batch verification ${index}`,
    message: `Batch verification ${index}: order FC-1001 arrived with a cracked mug. Please refund the damaged mug.`,
  }));
  await page.reload();
  await page.getByRole('textbox', { name: 'Search queue' }).fill('Batch verification');
  await total.getByText('3 cases · totals', { exact: true }).waitFor();
  await headerCheckbox.check();
  await batch.getByText('3 selected', { exact: true }).waitFor();
  await post(`/api/cases/${created[0].id}/triage`);
  const triageRequests = [];
  let inFlight = 0, maxInFlight = 0;
  await page.route('**/api/cases/*/triage', async (route) => {
    triageRequests.push(route.request().url().split('/').at(-2));
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (route.request().url().includes(created[1].id)) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected triage failure' } }) });
      else await route.fulfill({ response: await route.fetch() });
    } finally { inFlight--; }
  });
  await batch.getByRole('button', { name: 'Triage selected' }).click();
  await batch.getByText(/Triage: 1 triaged · 1 skipped · 1 failed/).waitFor();
  await batch.locator('.batch-report summary').click();
  check((await batch.innerText()).includes(`Skipped ${created[0].id}: needs human`), 'Triage did not recheck and report the stale selected case');
  check((await batch.innerText()).includes('Injected triage failure'), 'Partial failure was not reported');
  check(triageRequests.length === 2 && !triageRequests.includes(created[0].id) && maxInFlight === 1, 'Triage requests are not sequential or retriaged a non-new case');
  await page.unroute('**/api/cases/*/triage');
  await batch.getByRole('button', { name: 'Triage selected' }).click();
  await batch.getByText('Triage: 1 triaged · 2 skipped · 0 failed', { exact: true }).waitFor();
  await batch.getByText('3 selected', { exact: true }).waitFor();
  const reviewed = (await (await page.request.get(url('/api/cases'))).json()).filter((value) => created.some((item) => item.id === value.id));
  check(reviewed.every((value) => value.orderId === 'FC-1001'), 'Batch fixtures did not match their shared order');
  const allowance = reviewed.reduce((sum, value) => sum + (value.check?.computedCents ?? 0), 0);
  check((await batch.innerText()).includes(`Allowed $${(allowance / 100).toFixed(2)}`), 'Selected totals are stale after triage refresh');
  const unmatched = (await (await page.request.get(url('/api/cases'))).json()).find((value) => !value.orderId);
  check(unmatched, 'Replay lacks an unmatched case for skip verification');
  await page.getByRole('textbox', { name: 'Search queue' }).fill(unmatched.subject);
  await page.locator(`[row-id="${unmatched.id}"]`).getByRole('checkbox').check();
  await batch.getByText('4 selected', { exact: true }).waitFor();
  const reconciled = [];
  await page.route('**/api/orders/*/reconcile', async (route) => { reconciled.push(route.request().url().split('/').at(-2)); await route.fulfill({ response: await route.fetch() }); });
  await batch.getByRole('button', { name: 'Reconcile selected orders' }).click();
  await batch.getByText('Reconciliation: 1 order matched · 1 skipped · 0 failed', { exact: true }).waitFor();
  check((await batch.innerText()).includes(`Skipped ${unmatched.id}: no matched order`), 'Unmatched order skip was not reported');
  check(reconciled.length === 1 && reconciled[0] === 'FC-1001', 'Reconciliation did not deduplicate selected orders');
  await page.unroute('**/api/orders/*/reconcile');
  await batch.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('textbox', { name: 'Search queue' }).fill('');
  // A failed session lookup must show an error and recover without reloading the tab.
  await page.route('**/api/session', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected connection failure' } }) }));
  await page.reload();
  await page.getByRole('alert').filter({ hasText: 'Injected connection failure' }).waitFor();
  await page.getByRole('button', { name: 'Retry connection', exact: true }).waitFor();
  await page.screenshot({ path: 'output/playwright/connection-retry.png' });
  await page.unroute('**/api/session');
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await page.getByRole('button', { name: /^Risky/ }).waitFor();

  // Persisted creation survives a later triage failure; returning to the form must not resubmit it.
  let createRequests = 0;
  await page.route('**/api/cases', async (route) => {
    if (route.request().method() === 'POST') createRequests++;
    await route.continue();
  });
  await page.route('**/api/cases/*/triage', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected saved-message triage failure' } }) }));
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByLabel('Customer name', { exact: true }).fill('Maya Chen');
  await page.getByLabel('Email address', { exact: true }).fill('maya@example.test');
  await page.getByLabel('Subject', { exact: true }).fill('Saved-message recovery check');
  await page.getByLabel('Customer message', { exact: true }).fill('FC-1001 arrived with a cracked mug. Please refund the damaged mug.');
  await page.getByRole('button', { name: 'Add & triage message →', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Message saved. Triage did not finish' }).waitFor();
  check(createRequests === 1, 'Saving and triaging created more than one message');
  const savedCases = (await (await page.request.get(url('/api/cases'))).json()).filter((value) => value.subject === 'Saved-message recovery check');
  check(savedCases.length === 1 && savedCases[0].status === 'new', 'Failed triage did not retain exactly one new case');
  await page.screenshot({ path: 'output/playwright/saved-message-recovery.png' });
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  for (const label of ['Customer name', 'Email address', 'Subject', 'Customer message']) check(await page.getByLabel(label, { exact: true }).inputValue() === '', `Saved message left ${label} in the form`);
  await page.getByRole('button', { name: 'Add & triage message →', exact: true }).click();
  check(createRequests === 1, 'Submitting the cleared form duplicated the saved message');
  await page.unroute('**/api/cases');
  await page.unroute('**/api/cases/*/triage');

  // Exercise the actual UI/API retry path with a short injected server cooldown.
  await page.getByRole('button', { name: /^Approval queue/ }).click();
  await page.getByRole('button', { name: /^All\d*$/ }).click();
  await page.getByRole('textbox', { name: 'Search queue' }).fill('Saved-message recovery check');
  await total.getByText('1 cases · totals', { exact: true }).waitFor();
  await headerCheckbox.check();
  const retryTimes = [];
  await page.route('**/api/cases/*/triage', async (route) => {
    retryTimes.push(Date.now());
    if (retryTimes.length === 1) await route.fulfill({ status: 429, headers: { 'Retry-After': '1' }, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected rate limit' } }) });
    else await route.fulfill({ response: await route.fetch() });
  });
  await batch.getByRole('button', { name: 'Triage selected' }).click();
  await batch.getByText(/rate limited; waiting 1s before retry 1\/2/).waitFor();
  await page.screenshot({ path: 'output/playwright/batch-rate-limit-wait.png' });
  await batch.getByText('Triage: 1 triaged · 0 skipped · 0 failed', { exact: true }).waitFor();
  check(retryTimes.length === 2 && retryTimes[1] - retryTimes[0] >= 950, 'Batch ignored Retry-After or retried excessively');
  await page.unroute('**/api/cases/*/triage');
  await batch.getByRole('button', { name: 'Clear selection' }).click();
  await page.getByRole('textbox', { name: 'Search queue' }).fill('');
  await page.getByRole('button', { name: /^Risky/ }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  check(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`);
  const productionChunks = await page.locator('script[src^="/assets/"]').count() > 0;
  return { passed: true, productionChunks, savedViews: true, floatingFilters: true, persistedFilters: true, keyboardReview: true, highlightedEvidence: true, filteredTotals: true, csvDollarExports: true, csvCurrencyLabels: true, filteredSelection: true, batchSummary: true, outcomeExports: true, sequentialTriage: true, staleCaseSkipped: true, partialFailure: true, distinctOrderReconciliation: true, unmatchedOrderSkipped: true, connectionRecovery: true, savedMessageRecovery: true, rateLimitRecovery: true, screenshots: 13, browserErrors: errors };
}
