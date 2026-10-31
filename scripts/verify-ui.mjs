// Invoke through playwright-cli run-code after opening a replay demo and taking a snapshot.
// This checks the rendered production UI and writes the judge screenshots and CSV evidence.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.reload();
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
  check(queueText.includes('Model ($)') && queueText.includes('$140.00'), 'Queue CSV lacks dollar values');
  check(queueText.trim().split(/\r?\n/).length === 11, 'Queue export does not follow Risky filter');
  await page.getByRole('combobox', { name: 'Policy check filter' }).selectOption('adjusted');
  await total.getByText('1 cases · totals', { exact: true }).waitFor();
  check((await total.innerText()).includes('$72.00'), 'Adjusted case allowance total is wrong');
  await page.reload();
  await page.getByRole('combobox', { name: 'Policy check filter' }).waitFor();
  check(await page.getByRole('combobox', { name: 'Policy check filter' }).inputValue() === 'adjusted', 'Queue native filter did not persist');
  check(await page.getByRole('button', { name: /^Risky/ }).getAttribute('aria-pressed') === 'true', 'Saved view did not persist');
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
  await page.reload();
  await page.getByRole('button', { name: 'Ledger', exact: true }).click();
  await total.getByText('2 orders · totals', { exact: true }).waitFor();
  check(await page.getByRole('textbox', { name: 'Customer Filter Input' }).inputValue() === 'Luis', 'Ledger filter did not persist');
  await page.getByRole('button', { name: /^Approval queue/ }).click();
  await page.getByRole('button', { name: /^Risky/ }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  check(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`);
  return { passed: true, productionChunks: true, savedViews: true, floatingFilters: true, persistedFilters: true, keyboardReview: true, highlightedEvidence: true, filteredTotals: true, csvDollarExports: true, screenshots: 8, browserErrors: errors };
}
