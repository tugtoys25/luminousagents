const notice = document.getElementById('notice');
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
async function loadGrants() {
  try {
    const response = await fetch('/dashboard/access-grants');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Unable to load grants.');
    document.getElementById('grants').innerHTML = (data.data || []).map((grant) => {
      const expired = new Date(grant.expiresAt).getTime() <= Date.now();
      const active = !grant.revokedAt && !expired;
      return `<article class="grant"><div><span class="state">${active ? 'Active' : grant.revokedAt ? 'Revoked' : 'Expired'}</span><h2>${escapeHtml(grant.opportunityTitle)}</h2><p>${escapeHtml(grant.buyerName || grant.buyerEmail)} · ${escapeHtml(grant.buyerEmail)}</p><p>Tier ${escapeHtml(grant.tier)} · Granted ${escapeHtml(grant.grantedAt)} · Expires ${escapeHtml(grant.expiresAt)}</p>${grant.revokedAt ? `<p>Revoked ${escapeHtml(grant.revokedAt)}</p>` : ''}</div>${active ? `<form data-id="${escapeHtml(grant.id)}"><label for="reason-${escapeHtml(grant.id)}">Revocation reason</label><textarea id="reason-${escapeHtml(grant.id)}" name="reason" minlength="3" maxlength="1000" required placeholder="Record why this access should end"></textarea><button type="submit">Revoke access</button></form>` : '<p>No action available.</p>'}</article>`;
    }).join('') || '<p>No access grants have been created yet.</p>';
    document.querySelectorAll('form[data-id]').forEach((form) => form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = form.querySelector('button'); button.disabled = true;
      try {
        const response = await fetch(`/dashboard/access-grants/${encodeURIComponent(form.dataset.id)}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: new FormData(form).get('reason') }) });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message || 'Unable to revoke access.');
        notice.textContent = 'Access revoked and audit event recorded.';
        await loadGrants();
      } catch (error) { notice.textContent = error instanceof Error ? error.message : 'Unable to revoke access.'; button.disabled = false; }
    }));
  } catch (error) { notice.textContent = error instanceof Error ? error.message : 'Unable to load grants.'; }
}
loadGrants();
