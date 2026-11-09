// Run through playwright-cli run-code after opening the local replay demo and taking a snapshot.
// Only GET responses are replaced in browser memory. Google Fonts CSS is stubbed locally;
// all writes and other external requests are blocked.
// Produces three CSV downloads and one screenshot in output/playwright; restores routes and layouts.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const origin = new URL(page.url()).origin;
  check(['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname), 'Currency verification requires a local replay URL');
  const get = async (path) => {
    const response = await page.request.get(new URL(`/api${path}`, origin).href);
    check(response.ok(), `GET ${path} failed: ${response.status()}`);
    return response.json();
  };
  check((await get('/health')).demoMode === 'replay', 'Currency verification requires the network-free replay demo');
  const [originalCases, originalLedger] = await Promise.all([get('/cases'), get('/ledger')]);
  const priya = originalCases.find((value) => value.id === 'case-seed-06');
  check(priya?.order && priya.proposal && priya.check && priya.triageTrace, 'Replay lacks the Priya proposal and review data');
  const bases = [priya];
  for (const value of originalCases) {
    if (bases.length === 4) break;
    if (value.order && value.proposal && value.check && !bases.some((base) => base.orderId === value.orderId)) bases.push(value);
  }
  check(bases.length === 4, 'Replay needs four distinct orders for the currency display fixtures');
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const makeCase = (base, currency, proposed, allowed, label) => {
    const value = clone(base);
    value.subject = `Currency verification: ${label}`;
    value.order.currency = currency;
    value.proposal.currency = currency;
    value.proposal.proposed_total = proposed;
    value.check = { ...value.check, kind: 'adjusted', modelCents: proposed, computedCents: allowed, approvedCents: allowed, reasons: [], lines: [] };
    value.proposedCheck = clone(value.check);
    value.approvedCents = allowed;
    value.status = 'ready';
    value.attempt = null;
    delete value.approvalCheck;
    value.refunds = [];
    value.error = null;
    if (value.triageTrace) value.triageTrace.proposal = clone(value.proposal);
    return value;
  };
  // Deliberately mismatched proposal: display its EUR unit, while the USD order remains blocked.
  const mismatch = makeCase(bases[0], 'USD', 14000, 0, 'EUR proposal against USD order');
  mismatch.proposal.currency = 'EUR';
  mismatch.triageTrace.proposal = clone(mismatch.proposal);
  mismatch.check.kind = 'blocked';
  mismatch.check.reasons = ['Currency mismatch: EUR proposal for a USD order.'];
  mismatch.status = 'needs_human';
  const usd = makeCase(bases[1], 'USD', 1000, 800, 'USD review');
  const complete = (base, currency, cents) => {
    const value = makeCase(base, currency, cents, cents, `${currency} completed refund`);
    value.status = 'refunded';
    value.check.kind = 'pass';
    value.approvalCheck = clone(value.check);
    value.attempt = { id: `currency-${currency}`, state: 'completed', createdAt: value.createdAt, amountCents: cents, currency, retryAllowed: false };
    value.refunds = [{ id: `REPLAY-CURRENCY-${currency}`, caseId: value.id, orderId: value.orderId, amountCents: cents, currency, status: 'COMPLETED', requestId: `currency-${currency}`, allocations: [], createdAt: value.createdAt }];
    return value;
  };
  const euroRefund = complete(bases[2], 'EUR', 1800);
  const dollarRefund = complete(bases[3], 'USD', 500);
  const cases = [mismatch, usd, euroRefund, dollarRefund];
  const makeLedger = (value, captured, refunded, pending) => {
    const source = originalLedger.find((row) => row.orderId === value.orderId);
    check(source, `Replay lacks ledger row ${value.orderId}`);
    return { ...clone(source), currency: value.order.currency, capturedCents: captured, refundedCents: refunded, netCents: captured - refunded, pendingCents: pending, remoteCapturedCents: captured, remoteRefundedCents: refunded, refundIds: value.refunds.map((receipt) => receipt.id), match: true, error: null, unexpectedRefundIds: [] };
  };
  const ledger = [makeLedger(euroRefund, 10000, 1800, 700), makeLedger(dollarRefund, 8000, 500, 300)];
  const viewport = page.viewportSize();
  const layouts = await page.evaluate(() => ['refunddesk.queue.v1', 'refunddesk.ledger.v1'].map((key) => [key, localStorage.getItem(key)]));
  const errors = [], writes = [], external = [], downloads = [], stubbedFonts = [];
  const onError = (error) => errors.push(error.message);
  const routeHandler = async (route) => {
    const request = route.request(), address = new URL(request.url());
    if (address.origin === 'https://fonts.googleapis.com' && /^\/css2?$/.test(address.pathname) && request.method() === 'GET' && request.resourceType() === 'stylesheet') {
      stubbedFonts.push(request.url());
      await route.fulfill({ status: 200, contentType: 'text/css', body: '/* Font stylesheet replaced locally for currency verification. */' });
      return;
    }
    if (address.origin !== origin) { external.push(request.url()); await route.abort('blockedbyclient'); return; }
    if (!['GET', 'HEAD'].includes(request.method())) { writes.push(`${request.method()} ${address.pathname}`); await route.abort('blockedbyclient'); return; }
    if (address.pathname === '/api/cases') { await route.fulfill({ json: cases }); return; }
    if (address.pathname === '/api/ledger') { await route.fulfill({ json: ledger }); return; }
    const detail = cases.find((value) => address.pathname === `/api/cases/${value.id}`);
    if (detail) { await route.fulfill({ json: detail }); return; }
    await route.fallback();
  };
  const normal = (text) => text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  const expectText = async (locator, expected, label) => {
    await locator.waitFor({ state: 'visible' });
    const actual = normal(await locator.innerText());
    check(actual === expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  };
  const rowCell = (id, column) => page.locator(`[row-id="${id}"] [col-id="${column}"]`);
  const pinnedCell = (column) => page.locator('.ag-grid-pinned-bottom-rows').first().locator(`[col-id="${column}"]`);
  const parseCsv = (text) => {
    const rows = []; let row = [], cell = '', quoted = false;
    text = text.replace(/^\uFEFF/, '');
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (char === '"') {
        if (quoted && text[index + 1] === '"') { cell += '"'; index++; }
        else quoted = !quoted;
      } else if (char === ',' && !quoted) { row.push(cell); cell = ''; }
      else if ((char === '\r' || char === '\n') && !quoted) {
        if (char === '\r' && text[index + 1] === '\n') index++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    check(!quoted && rows.length > 1, 'Downloaded CSV is incomplete');
    const [headers, ...values] = rows;
    check(values.every((value) => value.length === headers.length), 'Downloaded CSV has inconsistent column counts');
    return { headers, rows: values.map((value) => Object.fromEntries(headers.map((header, index) => [header, value[index]]))) };
  };
  const downloadCsv = async (button, filename) => {
    const pending = page.waitForEvent('download');
    await button.click();
    const download = await pending;
    check(download.suggestedFilename().endsWith('.csv'), 'Expected a CSV download');
    const filenameOnDisk = `output/playwright/${filename}.csv`;
    await download.saveAs(filenameOnDisk);
    let text = '';
    for await (const chunk of await download.createReadStream()) text += chunk.toString();
    downloads.push(filenameOnDisk);
    return parseCsv(text);
  };
  const fieldsMatch = (row, expected, label) => {
    check(row, `${label}: exported row missing`);
    for (const [field, value] of Object.entries(expected)) check(row[field] === value, `${label} ${field}: expected ${JSON.stringify(value)}, got ${JSON.stringify(row[field])}`);
  };
  page.on('pageerror', onError);
  await page.route('**/*', routeHandler);
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload();
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await page.locator('.ag-grid-pinned-bottom-rows').first().getByText('4 cases · totals', { exact: true }).waitFor();
    const queueColumns = ['modelDollars', 'allowedDollars', 'amount', 'refundedDollars'];
    for (const [value, amounts] of [
      [mismatch, ['EUR 140.00', '$0.00', '$0.00', '$0.00']],
      [usd, ['$10.00', '$8.00', '$8.00', '$0.00']],
      [euroRefund, ['EUR 18.00', 'EUR 18.00', 'EUR 18.00', 'EUR 18.00']],
      [dollarRefund, ['$5.00', '$5.00', '$5.00', '$5.00']],
    ]) for (const [index, column] of queueColumns.entries()) await expectText(rowCell(value.id, column), amounts[index], `Queue ${value.id} ${column}`);
    for (const [index, expected] of ['EUR 158.00 + $15.00', 'EUR 18.00 + $13.00', 'EUR 18.00 + $13.00', 'EUR 18.00 + $5.00'].entries()) await expectText(pinnedCell(queueColumns[index]), expected, `Queue total ${queueColumns[index]}`);
    check(!(await page.locator('.ag-header').innerText()).includes('($)'), 'Currency-neutral columns still claim every value is dollars');
    await expectText(page.locator('.money-metric strong'), 'EUR 18.00 + $5.00', 'Returned-to-customers metric');
    const queueCsv = await downloadCsv(page.getByRole('button', { name: 'Export view CSV ↓', exact: true }), 'currency-queue');
    check(queueCsv.rows.length === 4, 'Queue CSV includes a total or omits a case');
    fieldsMatch(queueCsv.rows.find((row) => row.Order === mismatch.orderId), { Model: 'EUR 140.00', Allowed: '$0.00', Approved: '$0.00', Refunded: '$0.00' }, 'Mismatch queue CSV');
    fieldsMatch(queueCsv.rows.find((row) => row.Order === euroRefund.orderId), { Model: 'EUR 18.00', Allowed: 'EUR 18.00', Approved: 'EUR 18.00', Refunded: 'EUR 18.00' }, 'EUR queue CSV');
    await page.locator(`[row-id="${mismatch.id}"]`).getByRole('checkbox').check();
    await page.locator(`[row-id="${usd.id}"]`).getByRole('checkbox').check();
    const batch = page.getByRole('region', { name: 'Review batch' });
    await batch.getByText('2 selected', { exact: true }).waitFor();
    await batch.getByText('Model EUR 140.00 + $10.00', { exact: true }).waitFor();
    await batch.getByText('Allowed $8.00', { exact: true }).waitFor();
    check(!(await batch.innerText()).includes('$150.00'), 'Batch silently added EUR and USD as dollars');
    await page.getByRole('textbox', { name: 'Search queue' }).fill(mismatch.subject);
    await page.locator('.ag-grid-pinned-bottom-rows').first().getByText('1 cases · totals', { exact: true }).waitFor();
    await expectText(pinnedCell('modelDollars'), 'EUR 140.00', 'Filtered queue total');
    await batch.getByText('1 outside this view', { exact: true }).waitFor();
    await batch.getByText('Model EUR 140.00 + $10.00', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search queue' }).fill('');
    await page.locator('.ag-grid-pinned-bottom-rows').first().getByText('4 cases · totals', { exact: true }).waitFor();
    await page.screenshot({ path: 'output/playwright/currency-mixed.png' });
    await rowCell(mismatch.id, 'sender').click();
    const drawer = page.getByRole('dialog');
    await drawer.waitFor();
    await drawer.locator('.ai-trace summary').click();
    await expectText(drawer.locator('.ai-trace .amount-compare > div').filter({ has: page.getByText('Model proposal', { exact: true }) }).locator('strong'), 'EUR 140.00', 'Original model proposal');
    await expectText(drawer.locator('.amount-compare > div').filter({ has: page.getByText('AI proposal', { exact: true }) }).locator('strong'), 'EUR 140.00', 'Current model proposal');
    await expectText(drawer.locator('.amount-compare > div').filter({ has: page.getByText('Confirmed allowance', { exact: true }) }).locator('strong'), '$0.00', 'USD allowance for mismatched proposal');
    await page.getByRole('button', { name: 'Close case', exact: true }).click();
    await batch.getByRole('button', { name: 'Clear selection', exact: true }).click();
    await page.locator(`[row-id="${euroRefund.id}"]`).getByRole('checkbox').check();
    await page.locator(`[row-id="${dollarRefund.id}"]`).getByRole('checkbox').check();
    await batch.getByText('2 selected', { exact: true }).waitFor();
    const outcomes = await downloadCsv(batch.getByRole('button', { name: 'Export outcomes', exact: true }), 'currency-outcomes');
    check(outcomes.rows.length === 2, 'Outcome CSV does not follow selection');
    fieldsMatch(outcomes.rows.find((row) => row.Case === euroRefund.id), { Approved: '18.00', Refunded: '18.00', 'Approved currency': 'EUR', 'Refunded currency': 'EUR', 'Refund IDs': 'REPLAY-CURRENCY-EUR' }, 'EUR outcome');
    fieldsMatch(outcomes.rows.find((row) => row.Case === dollarRefund.id), { Approved: '5.00', Refunded: '5.00', 'Approved currency': 'USD', 'Refunded currency': 'USD', 'Refund IDs': 'REPLAY-CURRENCY-USD' }, 'USD outcome');
    await page.getByRole('button', { name: 'Ledger', exact: true }).click();
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await page.locator('.ag-grid-pinned-bottom-rows').first().getByText('2 orders · totals', { exact: true }).waitFor();
    const ledgerColumns = ['capturedDollars', 'refundedDollars', 'netDollars', 'pendingDollars'];
    for (const [id, amounts] of [
      [euroRefund.orderId, ['EUR 100.00', 'EUR 18.00', 'EUR 82.00', 'EUR 7.00']],
      [dollarRefund.orderId, ['$80.00', '$5.00', '$75.00', '$3.00']],
    ]) for (const [index, column] of ledgerColumns.entries()) await expectText(rowCell(id, column), amounts[index], `Ledger ${id} ${column}`);
    for (const [index, expected] of ['EUR 100.00 + $80.00', 'EUR 18.00 + $5.00', 'EUR 82.00 + $75.00', 'EUR 7.00 + $3.00'].entries()) await expectText(pinnedCell(ledgerColumns[index]), expected, `Ledger total ${ledgerColumns[index]}`);
    const ledgerCsv = await downloadCsv(page.getByRole('button', { name: 'Export ledger CSV ↓', exact: true }), 'currency-ledger');
    check(ledgerCsv.rows.length === 2, 'Ledger CSV includes a total or omits an order');
    fieldsMatch(ledgerCsv.rows.find((row) => row.Order === euroRefund.orderId), { Captured: 'EUR 100.00', Refunded: 'EUR 18.00', Net: 'EUR 82.00', Pending: 'EUR 7.00' }, 'EUR ledger CSV');
    fieldsMatch(ledgerCsv.rows.find((row) => row.Order === dollarRefund.orderId), { Captured: '$80.00', Refunded: '$5.00', Net: '$75.00', Pending: '$3.00' }, 'USD ledger CSV');
    await page.getByRole('textbox', { name: 'Search ledger' }).fill(euroRefund.orderId);
    await page.locator('.ag-grid-pinned-bottom-rows').first().getByText('1 orders · totals', { exact: true }).waitFor();
    await expectText(pinnedCell('refundedDollars'), 'EUR 18.00', 'Filtered ledger total');
    const [unchangedCases, unchangedLedger] = await Promise.all([get('/cases'), get('/ledger')]);
    check(JSON.stringify(unchangedCases) === JSON.stringify(originalCases) && JSON.stringify(unchangedLedger) === JSON.stringify(originalLedger), 'Currency display verification changed server data');
    check(writes.length === 0, `Unexpected write requests were blocked: ${writes.join('; ')}`);
    check(external.length === 0, `Unexpected external requests were blocked: ${external.join('; ')}`);
    check(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`);
    return { passed: true, syntheticGetResponsesOnly: true, queueCurrencies: true, groupedTotals: true, selectionCurrencies: true, originalAndCurrentProposalCurrencies: true, ledgerCurrencies: true, filteredTotals: true, csvExports: downloads, screenshot: 'output/playwright/currency-mixed.png', serverDataUnchanged: true, writes: 0, externalRequests: 0, stubbedFonts: stubbedFonts.length, browserErrors: errors };
  } finally {
    await page.unroute('**/*', routeHandler);
    page.removeListener('pageerror', onError);
    await page.evaluate((saved) => { for (const [key, value] of saved) if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); }, layouts);
    if (viewport) await page.setViewportSize(viewport);
    await page.reload();
  }
}
