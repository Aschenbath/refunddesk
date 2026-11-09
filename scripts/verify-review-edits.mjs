// Run with playwright-cli run-code on a fresh replay demo. This changes only seed-06/seed-08 in replay memory.
// Restart replay before combining this with checks that depend on unchanged seed amounts, replies or dates.
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const endpoint = (path) => new URL(`/api${path}`, page.url()).href;
  const get = async (path) => {
    const response = await page.request.get(endpoint(path));
    check(response.ok(), `GET ${path} failed: ${response.status()}`);
    return response.json();
  };
  check((await get('/health')).demoMode === 'replay', 'Review-edit verification requires the network-free replay demo');
  const errors = [], routes = [], releases = [], paymentCalls = [];
  const onError = (error) => errors.push(error.message);
  page.on('pageerror', onError);
  const route = async (pattern, handler) => { await page.route(pattern, handler); routes.push([pattern, handler]); };
  const unroute = async (pattern, handler) => {
    await page.unroute(pattern, handler);
    const index = routes.findIndex((entry) => entry[0] === pattern && entry[1] === handler);
    if (index >= 0) routes.splice(index, 1);
  };
  const gate = () => {
    let arrive, release;
    const arrived = new Promise((resolve) => { arrive = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    releases.push(release);
    return { arrive, release, arrived, released };
  };
  const arrived = async (pending, label) => {
    let timer;
    try { await Promise.race([pending.arrived, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} request did not arrive`)), 10_000); })]); }
    finally { clearTimeout(timer); }
  };
  const dialog = page.getByRole('dialog');
  const idle = async () => page.waitForFunction(() => {
    const button = [...document.querySelectorAll('[role="dialog"] button')].find((element) => element.textContent.trim() === 'Export case report');
    return button && !button.disabled;
  });
  const openCase = async (value) => {
    await page.reload();
    await page.getByRole('button', { name: 'Reset layout', exact: true }).click();
    await page.getByRole('button', { name: /^All\d*$/ }).click();
    await page.getByRole('textbox', { name: 'Search queue' }).fill(value.subject);
    await page.locator(`[row-id="${value.id}"] [col-id="sender"]`).click();
    await dialog.waitFor();
    await idle();
  };
  const patchResponse = (id) => page.waitForResponse((response) => response.url() === endpoint(`/cases/${id}`) && response.request().method() === 'PATCH');
  const patchClick = async (id, button) => {
    const response = patchResponse(id);
    await button.click();
    const result = await response;
    await idle();
    return result;
  };
  const replyCase = await get('/cases/case-seed-06');
  const dateCase = await get('/cases/case-seed-08');
  check(replyCase.status === 'ready' && !replyCase.attempt && dateCase.status === 'ready' && !dateCase.attempt && dateCase.confirmedFacts.deliveryDates,
    'Restart replay: these checks require unapproved seed-06 and seed-08 with confirmed seed dates');
  let synthetic = null;
  // Even an unexpected UI payment action is intercepted; this script never forwards a payment POST.
  const paymentPattern = /\/api\/cases\/[^/]+\/(?:approve|retry-new-id)(?:\?.*)?$/;
  await route(paymentPattern, async (requestRoute) => {
    const request = requestRoute.request();
    const value = { path: new URL(request.url()).pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null };
    paymentCalls.push(value);
    const expected = synthetic && value.path === `/api/cases/${replyCase.id}/approve` && value.method === 'POST';
    await requestRoute.fulfill({ status: expected ? 200 : 503, contentType: 'application/json', body: JSON.stringify(expected ? synthetic : { error: { message: 'Unexpected payment action intercepted by UI verification' } }) });
  });
  try {
    await page.setViewportSize({ width: 1600, height: 900 });
    await openCase(replyCase);
    const reply = dialog.getByRole('textbox', { name: 'Customer reply draft', exact: true });
    const draftA = 'Review-edit check: this unsaved reply must survive an amount and fact update.';
    await reply.fill(draftA);
    const amount = dialog.getByRole('textbox', { name: 'Approved amount', exact: true });
    const chosenCents = Math.max(1, Math.min(2000, replyCase.check.approvedCents - 100));
    await amount.fill((chosenCents / 100).toFixed(2));
    check((await patchClick(replyCase.id, dialog.getByRole('button', { name: 'Save amount', exact: true }))).ok(), 'Amount update failed');
    check(await reply.inputValue() === draftA, 'Saving an amount discarded the unsaved customer reply');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === replyCase.replyDraft, 'Amount update unexpectedly saved the reply');
    const damage = dialog.getByRole('checkbox', { name: 'Photo or clear damage description verified', exact: true });
    check(await damage.isChecked(), 'Fresh seed-06 damage evidence should be confirmed');
    check((await patchClick(replyCase.id, damage)).ok(), 'Fact update failed');
    check(await reply.inputValue() === draftA, 'Saving a fact discarded the unsaved customer reply');
    check((await patchClick(replyCase.id, damage)).ok(), 'Restoring the fact failed');
    check(await reply.inputValue() === draftA, 'Fact refresh replaced the local reply buffer');

    const replyPattern = endpoint(`/cases/${replyCase.id}`);
    const failReply = async (requestRoute) => {
      if (requestRoute.request().method() !== 'PATCH') return requestRoute.continue();
      await requestRoute.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected reply-save failure' } }) });
    };
    await route(replyPattern, failReply);
    check((await patchClick(replyCase.id, dialog.getByRole('button', { name: 'Save draft', exact: true }))).status() === 503, 'Reply failure injection did not run');
    check(await reply.inputValue() === draftA, 'A failed save discarded the reply');
    check(await dialog.getByRole('button', { name: 'Save draft', exact: true }).isEnabled(), 'Failed reply cannot be retried');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === replyCase.replyDraft, 'A rejected save changed the server reply');
    await unroute(replyPattern, failReply);
    check((await patchClick(replyCase.id, dialog.getByRole('button', { name: 'Save draft', exact: true }))).ok(), 'Reply retry failed');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === draftA, 'Reply retry did not persist the input');

    const draftB = 'Review-edit check: first version submitted for saving.';
    const draftC = 'Review-edit check: newer text typed while that save is still pending.';
    const replyGate = gate();
    const delayReply = async (requestRoute) => {
      if (requestRoute.request().method() !== 'PATCH') return requestRoute.continue();
      replyGate.arrive();
      await replyGate.released;
      await requestRoute.fulfill({ response: await requestRoute.fetch() });
    };
    await route(replyPattern, delayReply);
    await reply.fill(draftB);
    const delayedReplyResponse = patchResponse(replyCase.id);
    await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
    await arrived(replyGate, 'Reply save');
    check(await reply.isEnabled(), 'Reply input must remain available while its earlier version saves');
    await reply.fill(draftC);
    replyGate.release();
    check((await delayedReplyResponse).ok(), 'Delayed reply save failed');
    await idle();
    check(await reply.inputValue() === draftC, 'Earlier save completion overwrote newer typed text');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === draftB, 'Earlier save did not preserve its submitted version');
    check(await dialog.getByRole('button', { name: 'Save draft', exact: true }).isEnabled(), 'Newer reply is incorrectly shown as already saved');
    await unroute(replyPattern, delayReply);
    check((await patchClick(replyCase.id, dialog.getByRole('button', { name: 'Save draft', exact: true }))).ok(), 'Saving newer reply failed');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === draftC, 'Newer reply was not saved');

    // Reverting to the previously saved text is still a newer edit while another save is pending.
    const draftD = 'Review-edit check: a pending version that the owner then deliberately undoes.';
    const undoGate = gate();
    const delayUndo = async (requestRoute) => {
      if (requestRoute.request().method() !== 'PATCH') return requestRoute.continue();
      undoGate.arrive();
      await undoGate.released;
      await requestRoute.fulfill({ response: await requestRoute.fetch() });
    };
    await route(replyPattern, delayUndo);
    await reply.fill(draftD);
    const undoResponse = patchResponse(replyCase.id);
    await dialog.getByRole('button', { name: 'Save draft', exact: true }).click();
    await arrived(undoGate, 'Reply save before local undo');
    await reply.fill(draftC);
    undoGate.release();
    check((await undoResponse).ok(), 'Delayed reply save before undo failed');
    await idle();
    check(await reply.inputValue() === draftC, 'Save completion discarded a newer edit that reverted to the prior saved text');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === draftD && await dialog.getByRole('button', { name: 'Save draft', exact: true }).isEnabled(), 'Locally undone text is incorrectly treated as already saved');
    await unroute(replyPattern, delayUndo);
    check((await patchClick(replyCase.id, dialog.getByRole('button', { name: 'Save draft', exact: true }))).ok(), 'Saving the local undo failed');
    check((await get(`/cases/${replyCase.id}`)).replyDraft === draftC, 'The local undo did not persist');

    await openCase(dateCase);
    const facts = dialog.getByRole('region', { name: 'Confirm refund facts', exact: true });
    const delivered = facts.getByLabel('Delivered date', { exact: true });
    const confirmation = facts.getByRole('checkbox', { name: 'I verified these delivery dates', exact: true });
    const approve = dialog.locator('.drawer-footer button.primary');
    const savedDates = structuredClone(dateCase.confirmedFacts.deliveryDates);
    check(await confirmation.isChecked() && await approve.isEnabled(), 'Fresh date case must start confirmed and approvable');
    let datePatches = 0, dateMode = 'observe';
    const dateGate = gate();
    const datePattern = endpoint(`/cases/${dateCase.id}`);
    const dateHandler = async (requestRoute) => {
      if (requestRoute.request().method() !== 'PATCH') return requestRoute.continue();
      datePatches++;
      if (dateMode === 'fail') return requestRoute.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Injected date-confirmation failure' } }) });
      if (dateMode === 'delay') { dateGate.arrive(); await dateGate.released; }
      await requestRoute.fulfill({ response: await requestRoute.fetch() });
    };
    await route(datePattern, dateHandler);
    await delivered.fill(savedDates.promisedAt);
    check(!(await confirmation.isChecked()), 'Changed dates still appear confirmed');
    check(await approve.isDisabled(), 'Unsaved dates leave approval enabled');
    await dialog.getByText('Unsaved dates', { exact: true }).waitFor();
    await dialog.getByText('Last saved allowance', { exact: true }).waitFor();
    check(datePatches === 0, 'Editing a date should not send an automatic mutation');
    dateMode = 'fail';
    check((await patchClick(dateCase.id, confirmation)).status() === 503, 'Date failure injection did not run');
    check(datePatches === 1, 'Date confirmation made extra writes');
    check(await delivered.inputValue() === savedDates.promisedAt, 'Failed confirmation discarded the new date');
    check(!(await confirmation.isChecked()) && await approve.isDisabled(), 'Failed confirmation permits approval using old saved dates');
    check(await confirmation.isEnabled(), 'Date confirmation cannot be retried');
    await facts.getByRole('alert').waitFor();
    check(JSON.stringify((await get(`/cases/${dateCase.id}`)).confirmedFacts.deliveryDates) === JSON.stringify(savedDates), 'Rejected date update changed saved facts');
    await facts.scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/playwright/review-edits-recovery.png' });

    dateMode = 'delay';
    const delayedDateResponse = patchResponse(dateCase.id);
    await confirmation.click();
    await arrived(dateGate, 'Date confirmation');
    check(await approve.isDisabled(), 'Approval became available before date confirmation finished');
    dateGate.release();
    check((await delayedDateResponse).ok(), 'Retried date confirmation failed');
    await idle();
    check(await confirmation.isChecked(), 'Successful confirmation was not displayed');
    check(await delivered.inputValue() === savedDates.promisedAt, 'Successful confirmation changed the entered date');
    const noDelay = await get(`/cases/${dateCase.id}`);
    check(noDelay.confirmedFacts.deliveryDates.deliveredAt === savedDates.promisedAt && noDelay.check.kind === 'blocked', 'Confirmed zero-delay delivery still uses the old late-delivery allowance');
    check(await approve.isDisabled(), 'The newly ineligible dates permit approval');
    check(await facts.getByRole('alert').count() === 0, 'Successful retry leaves a stale date-save error');
    dateMode = 'observe';
    await delivered.fill(savedDates.deliveredAt);
    check(!(await confirmation.isChecked()) && await approve.isDisabled(), 'Restoring dates bypassed explicit reconfirmation');
    check((await patchClick(dateCase.id, confirmation)).ok(), 'Restoring confirmed dates failed');
    check(await confirmation.isChecked() && await approve.isEnabled(), 'Successfully reconfirmed eligible dates remain stuck');
    await unroute(datePattern, dateHandler);
    check(paymentCalls.length === 0, 'Editing reviews triggered a payment action');

    const actual = await get(`/cases/${replyCase.id}`);
    const beforePaymentCheck = JSON.stringify(actual);
    const frozenAmount = Math.max(1, Math.floor(actual.check.approvedCents / 2));
    synthetic = { ...structuredClone(actual), revision: actual.revision + 100, status: 'failed', error: 'Synthetic lost-response recovery case', attempt: {
      id: 'review-ui-uncertain-attempt', state: 'uncertain', createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      amountCents: frozenAmount, currency: 'USD', refundId: null, retryOriginalAllowed: false, retryAllowed: false,
    } };
    const casesPattern = endpoint('/cases');
    const casesHandler = async (requestRoute) => {
      if (requestRoute.request().method() !== 'GET') return requestRoute.continue();
      const response = await requestRoute.fetch();
      const values = await response.json();
      await requestRoute.fulfill({ response, json: values.map((value) => value.id === synthetic.id ? synthetic : value) });
    };
    await route(casesPattern, casesHandler);
    await openCase(actual);
    check(await dialog.getByRole('button', { name: 'Retry original request', exact: true }).count() === 0, 'Original-request retry ignores the server eligibility flag');
    synthetic.attempt.retryOriginalAllowed = true;
    await openCase(actual);
    const retryOriginal = dialog.getByRole('button', { name: 'Retry original request', exact: true });
    check(await retryOriginal.count() === 1 && await retryOriginal.isEnabled(), 'Eligible uncertain attempt lacks one usable original-request retry');
    check(await dialog.getByRole('button', { name: 'Retry with a new request id', exact: true }).count() === 0, 'Original-request recovery incorrectly offers a new request ID');
    check(paymentCalls.length === 0, 'Original request was retried without an owner click');
    const retryResponse = page.waitForResponse((response) => response.url() === endpoint(`/cases/${replyCase.id}/approve`) && response.request().method() === 'POST');
    await retryOriginal.click();
    check((await retryResponse).ok(), 'Synthetic retry response failed');
    await idle();
    check(paymentCalls.length === 1 && paymentCalls[0].path.endsWith('/approve'), 'Original-request retry sent extra or new-ID payment actions');
    const retryBody = paymentCalls[0].body;
    check(Object.keys(retryBody).length === 2 && retryBody.revision === synthetic.revision && retryBody.approvedCents === frozenAmount, 'Original-request retry did not send only the current revision and frozen amount');
    check(JSON.stringify(await get(`/cases/${replyCase.id}`)) === beforePaymentCheck, 'Synthetic recovery UI check changed the real replay case');
    await unroute(casesPattern, casesHandler);
    synthetic = null;
    await page.reload();
    await page.getByRole('button', { name: 'Reset layout', exact: true }).waitFor();
    check(errors.length === 0, `Browser runtime errors: ${errors.join('; ')}`);
    return { passed: true, unsavedReplySurvivesAmountAndFacts: true, failedReplyRetry: true, newerReplySurvivesPendingSave: true, localUndoSurvivesPendingSave: true,
      dateEditsStayLocal: true, failedDateConfirmationBlocksApproval: true, pendingDateConfirmationBlocksApproval: true,
      dateReconfirmationRecovery: true, originalRequestEligibility: true, originalRequestPayload: true,
      paymentPostsForwarded: 0, screenshots: 1, browserErrors: errors };
  } finally {
    for (const release of releases) release();
    for (const [pattern, handler] of [...routes].reverse()) await page.unroute(pattern, handler);
    page.off('pageerror', onError);
  }
}
