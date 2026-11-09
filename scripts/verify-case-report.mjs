// Run through playwright-cli run-code against a replay demo; this changes only replay memory.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const endpoint = (path) => new URL(`/api${path}`, page.url()).href;
  const get = async (path) => {
    const response = await page.request.get(endpoint(path));
    check(response.ok(), `GET ${path} failed: ${response.status()}`);
    return response.json();
  };
  const mutate = async (path, method, data) => {
    const response = await page.request.fetch(endpoint(path), { method, data, headers: { Origin: new URL(page.url()).origin } });
    check(response.ok(), `${method} ${path} failed: ${response.status()}`);
    return response.json();
  };
  check((await get('/health')).demoMode === 'replay', 'This check requires the network-free replay demo');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const openCase = async (id, subject) => {
    await page.reload();
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await page.getByRole('button', { name: /^All\d*$/ }).click();
    await page.getByRole('textbox', { name: 'Search queue' }).fill(subject);
    await page.locator(`[row-id="${id}"] [col-id="sender"]`).click();
    await page.getByRole('dialog').waitFor();
    check(await page.getByRole('button', { name: 'Export case report', exact: true }).count() === 1, 'Report export must have one entry');
  };
  const downloadReport = async (filename) => {
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export case report', exact: true }).click();
    const download = await pending;
    check(/^refunddesk-[A-Za-z0-9._-]+\.html$/.test(download.suggestedFilename()), 'Unsafe report filename');
    await download.saveAs(`output/playwright/${filename}.html`);
    let html = '';
    for await (const chunk of await download.createReadStream()) html += chunk.toString();
    return html;
  };
  const inspectOffline = async (html, filename, expectedText) => {
    const reportPage = await page.context().newPage();
    const external = [];
    reportPage.on('request', (request) => { if (/^https?:/.test(request.url())) external.push(request.url()); });
    try {
      await page.context().setOffline(true);
      await reportPage.setContent(html);
      const text = await reportPage.locator('body').innerText();
      for (const fragment of expectedText) check(text.includes(fragment), `Report omits ${fragment}`);
      check(await reportPage.locator('script, iframe, img, link, object, embed').count() === 0, 'Report contains active or external content');
      check(await reportPage.locator('meta[http-equiv="Content-Security-Policy"]').count() === 1, 'Report lacks its offline CSP');
      for (const width of [320, 390, 1440]) {
        await reportPage.setViewportSize({ width, height: 900 });
        check(await reportPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Report overflows at ${width}px`);
        if (width !== 320) await reportPage.screenshot({ path: `output/playwright/${filename}-${width}.png`, fullPage: true });
      }
      await reportPage.emulateMedia({ media: 'print' });
      check(await reportPage.getByText(expectedText[0], { exact: false }).count() > 0, 'Report loses its content when printed');
      check(external.length === 0, 'Offline report attempted an external request');
      check(await reportPage.evaluate(() => !window.reportInjected), 'Report executed injected code');
    } finally {
      await page.context().setOffline(false);
      await reportPage.close();
    }
  };

  const id = 'case-seed-06';
  const initial = await get(`/cases/${id}`);
  check(initial.status === 'ready', 'Restart replay before running report verification again');
  await openCase(id, initial.subject);
  await page.route(`**/api/cases/${id}/report`, (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Report download unavailable' } }) }));
  await page.getByRole('button', { name: 'Export case report', exact: true }).click();
  await page.getByRole('dialog').getByRole('alert').filter({ hasText: 'Report download unavailable' }).waitFor();
  await page.unroute(`**/api/cases/${id}/report`);
  // The drawer stays open at its older revision while the server receives a saved edit.
  await mutate(`/cases/${id}`, 'PATCH', { replyDraft: 'Saved review for the exported case.' });
  const saved = await get(`/cases/${id}`);
  check(saved.revision > initial.revision, 'Fixture edit did not create a newer saved revision');
  const report = await get(`/cases/${id}/report`);
  const html = await downloadReport('case-review');
  check(report.case.revision === saved.revision && report.triage.proposal.proposed_total === 14000 && report.review.check.computedCents === 7200, 'Report did not use the latest saved review and original proposal');
  check(report.approval === null && report.mode === 'replay', 'Unapproved replay report invents an approval or live payment');
  check(JSON.stringify(await get(`/cases/${id}`)) === JSON.stringify(saved), 'Report export changed the case');
  await inspectOffline(html, 'case-review', [id, 'USD 140.00', 'USD 72.00', 'Replay', String(saved.revision)]);

  await page.getByRole('button', { name: 'Close case', exact: true }).click();
  await mutate(`/cases/${id}/approve`, 'POST', { revision: saved.revision, approvedCents: 7200 });
  const completed = await get(`/cases/${id}/report`);
  check(completed.approval?.reviewedRevision === saved.revision && completed.approval.amountCents === 7200, 'Report lost the frozen approval revision or amount');
  check(completed.receipts.some((receipt) => receipt.source === 'simulated-replay' && receipt.status === 'COMPLETED' && receipt.amountCents === 7200), 'Report failed to identify the simulated receipt');
  await openCase(id, initial.subject);
  await page.getByText('Refund recorded in replay', { exact: true }).waitFor();
  await page.getByText('Simulated replay receipt', { exact: true }).waitFor();
  check(await page.getByText('Refund completed with PayPal', { exact: true }).count() === 0, 'Replay drawer implies a live PayPal refund');
  const completedHtml = await downloadReport('case-approved');
  await inspectOffline(completedHtml, 'case-approved', [id, 'USD 72.00', 'Replay', completed.receipts[0].id]);
  await page.getByRole('button', { name: 'Close case', exact: true }).click();

  const payload = '<img src="https://example.invalid/probe" onerror="window.reportInjected=1"><script>window.reportInjected=1</script>';
  const injected = await mutate('/cases', 'POST', { sender: 'Report safety fixture', email: 'review@example.test', subject: 'Report text escaping', message: payload });
  await openCase(injected.id, injected.subject);
  const escapedHtml = await downloadReport('case-escaped');
  await inspectOffline(escapedHtml, 'case-escaped', [payload, 'Report safety fixture', 'Replay']);
  check(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`);
  return { passed: true, exports: 3, latestSavedRevision: true, frozenApproval: true, replayLabels: true, noCaseMutationOnExport: true, exportFailureRecovery: true, offlineRequests: 0, escapedContent: true, widths: [320, 390, 1440], printContent: true, browserErrors: errors };
}
