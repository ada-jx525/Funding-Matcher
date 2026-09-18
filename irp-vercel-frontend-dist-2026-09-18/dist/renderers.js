function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatDate(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Not specified";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Not specified";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

function profileTypeLabel(sourceType) {
  return sourceType === "programme_profile" ? "Programme" : "Support organisation";
}

function compactList(values, limit = 3) {
  const items = Array.isArray(values) ? values.filter(Boolean).slice(0, limit) : [];
  return items.map((value) => `<span class="tag">${escapeHtml(value)}</span>`).join("");
}

function renderProfile(profile) {
  if (!profile) return `<p class="profile-empty">No profile selected.</p>`;
  const location = profile.location === "Location not specified" ? "Location not specified" : profile.location;
  const programmeSemantics = profile.sourceType === "programme_profile"
    ? '<span class="visually-hidden">Programme operator location. Programme support. Participant stages. Participant geographies.</span>'
    : "";
  return `
    ${programmeSemantics}
    <div class="selected-profile-status"><span aria-hidden="true">✓</span> Profile selected</div>
    <div class="selected-profile-main">
      <div><h3>${escapeHtml(profile.name)}</h3><p>${escapeHtml(profileTypeLabel(profile.sourceType))} · ${escapeHtml(location)}</p></div>
      <button class="change-profile-button" type="button" data-action="change-profile">Change</button>
    </div>
    <div class="tag-row">${compactList(profile.focus, 3)}</div>
  `;
}

function renderProfileOptions(profiles, selectedId) {
  return profiles.map((profile, index) => `
    <button class="profile-option${profile.id === selectedId ? " selected" : ""}" id="profile-option-${index}" type="button" role="option" tabindex="-1"
      aria-selected="${profile.id === selectedId}" data-action="choose-profile" data-profile-id="${escapeHtml(profile.id)}">
      <span class="profile-option-copy"><strong>${escapeHtml(profile.name)}</strong><small>${escapeHtml(profileTypeLabel(profile.sourceType))} · ${escapeHtml(profile.location)}</small></span>
      <span class="profile-option-focus">${escapeHtml(profile.focus.slice(0, 2).join(" · ") || "Focus not specified")}</span>
    </button>
  `).join("");
}

function deadlineInfo(result) {
  if (!result.closingDate) return { value: "Not specified", tone: "unknown" };
  const parsed = new Date(`${result.closingDate}T23:59:59Z`);
  if (Number.isNaN(parsed.getTime())) return { value: "Not specified", tone: "unknown" };
  if (parsed.getTime() < Date.now()) return { value: formatDate(result.closingDate), tone: "neutral" };
  const daysRemaining = (parsed.getTime() - Date.now()) / 86_400_000;
  return {
    value: formatDate(result.closingDate),
    tone: daysRemaining <= 30 ? "soon" : "dated"
  };
}

function renderOpportunityFields(result, deadline) {
  const fields = [
    { label: "Status", value: result.status, show: result.status !== "Status unknown" },
    { label: "Funding type", value: result.fundingType, show: result.fundingType !== "Not specified" },
    { label: "Opening date", value: formatDate(result.openingDate), show: Boolean(result.openingDate) },
    { label: "Deadline", value: deadline.value, show: true, tone: `deadline ${deadline.tone}` },
    { label: "Total fund", value: result.totalFund, show: result.totalFund !== "Not specified" },
    { label: "Award", value: result.awardScope, show: result.awardScope !== "Not specified" },
    { label: "Source", value: result.sourceProvider, show: result.sourceProvider !== "Official source" }
  ].filter((field) => field.show);
  return `
    <dl class="opportunity-fields">
      ${fields.map((field) => `<div><dt>${escapeHtml(field.label)}</dt><dd class="${field.tone || ""}">${escapeHtml(field.value)}</dd></div>`).join("")}
    </dl>
  `;
}

function recommendationLabel(value) {
  return ({ recommended: "Recommended", reference: "Potential match", not_suitable: "No clear match" })[value] || "AI assessment";
}

// Source-derived, not model-generated, so it is styled apart from the AI block.
// When an activity is known but applicant eligibility is not, the neutral tone
// exposes that review boundary without turning activity into an eligibility claim.
const ACTIONABILITY_TONE = {
  open_to_ventures: "open",
  research_only: "closed",
  land_partners_only: "closed"
};

function actionabilityTone(actionability) {
  if (ACTIONABILITY_TONE[actionability?.code]) return ACTIONABILITY_TONE[actionability.code];
  if (actionability?.code === "unstated" && actionability.evidence?.length) return "review";
  return "";
}

function renderActionabilityBadge(actionability) {
  if (!actionability) return "";
  const tone = actionabilityTone(actionability);
  if (!tone) return "";
  return `<span class="actionability-badge ${escapeHtml(tone)}">${escapeHtml(actionability.label)}</span>`;
}

function renderActionabilityDetail(actionability) {
  if (!actionability) return "";
  const knownRoute = Boolean(ACTIONABILITY_TONE[actionability.code]);
  // Do not add a badge for an unknown route. In the expanded card, however,
  // activity evidence is still useful as long as it is clearly separated from
  // applicant eligibility. Completely evidence-free unknowns stay hidden.
  if (!knownRoute && !(actionability.code === "unstated" && actionability.evidence.length)) {
    return "";
  }
  const basis = actionability.basis.length
    ? `<p class="actionability-basis">${escapeHtml(actionability.basis.join("; "))}</p>`
    : "";
  const quotes = actionability.evidence.length ? `
    <details class="actionability-evidence">
      <summary>Source evidence</summary>
      <div class="actionability-evidence-content">${actionability.evidence.map((item) => `
        <blockquote>${escapeHtml(item.text)}</blockquote>
      `).join("")}</div>
    </details>` : "";
  if (!basis && !quotes) return "";
  return `
    <section class="actionability" aria-label="Participation route">
      <h4>Participation route${actionability.label ? ` · ${escapeHtml(actionability.label)}` : ""}</h4>
      ${basis}
      ${quotes}
    </section>
  `;
}

function renderEvidence(citations) {
  if (!Array.isArray(citations) || !citations.length) return "";
  const quotes = citations.map((item) => `
    <li>
      <span class="evidence-source">${escapeHtml(item.sourceField)}</span>
      <blockquote>${escapeHtml(item.text)}</blockquote>
    </li>
  `).join("");
  const label = citations.length === 1 ? "1 source quote" : `${citations.length} source quotes`;
  return `
    <details class="decision-evidence">
      <summary>Show the evidence this is based on (${escapeHtml(label)})</summary>
      <ol class="evidence-list">${quotes}</ol>
    </details>
  `;
}

function renderDecision(decision) {
  if (!decision) return "";
  const reasonLabel = decision.recommendation === "not_suitable" ? "Assessment" : "Why this match";
  return `
    <section class="ai-assessment" aria-label="AI match explanation">
      <div class="ai-heading">
        <div>
          <span class="ai-kicker">AI match review</span>
          <strong class="recommendation ${escapeHtml(decision.recommendation.replace("_", "-"))}">${escapeHtml(recommendationLabel(decision.recommendation))}</strong>
        </div>
        <span class="ai-label" title="Generated by AI"><span aria-hidden="true">✦</span> AI</span>
      </div>
      <dl class="decision-summary">
        <div><dt>Suitable for</dt><dd>${escapeHtml(decision.suitableFor)}</dd></div>
        <div><dt>${reasonLabel}</dt><dd>${escapeHtml(decision.summary)}</dd></div>
      </dl>
      ${(decision.matchPoints.length || decision.requiredChecks.length) ? `<div class="decision-support">
        ${decision.matchPoints.length ? `<div class="decision-list"><strong>Match points</strong><ul>${decision.matchPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
        ${decision.requiredChecks.length ? `<div class="decision-list checks"><strong>Check before acting</strong><ul>${decision.requiredChecks.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : ""}
      </div>` : ""}
      ${renderEvidence(decision.evidence)}
      <p class="ai-disclaimer">AI-generated guidance. Confirm requirements with the official source.</p>
    </section>
  `;
}

function renderResult(result) {
  const deadline = deadlineInfo(result);
  const sourceUrl = result.externalDetailsUrl || result.sourceUrl;
  const funder = result.funders.join(", ") || "Funder not specified";
  const schedule = result.closingDate ? ` · Deadline ${deadline.value}` : "";
  const reviewState = result.reviewStatus || "idle";
  const expanded = result.expanded === true || (result.expanded == null && result.rank === 1);
  return `
    <details class="result-card" data-result-id="${escapeHtml(result.id)}"${expanded ? " open" : ""}>
      <summary class="result-summary-row">
        <span class="result-rank" aria-label="Rank ${escapeHtml(result.rank)}">${escapeHtml(result.rank)}</span>
        <span class="result-heading">
          <h3 class="result-title">${escapeHtml(result.title)}</h3>
          <span class="result-facts">${escapeHtml(funder)}${escapeHtml(schedule)}${renderActionabilityBadge(result.actionability)}</span>
        </span>
        <span class="result-chevron" aria-hidden="true"></span>
      </summary>
      <div class="result-expanded">
        <section class="result-description-block" aria-label="Description">
          <h4>Description</h4>
          <p class="result-description">${escapeHtml(result.summaryPreview)}</p>
        </section>
        ${result.summaryTruncated ? '<p class="preview-note">Summary preview — full details are available at source.</p>' : ""}
        ${renderActionabilityDetail(result.actionability)}
        ${renderOpportunityFields(result, deadline)}
        ${renderDecision(result.decision)}
        ${result.reviewError ? `<p class="inline-error" role="alert">${escapeHtml(result.reviewError)}</p>` : ""}
        <div class="card-actions">
          ${result.decision || result.reviewAvailable === false ? "" : `<button class="ai-button" type="button" aria-label="Explain this match with AI" data-action="review-result" data-opportunity-id="${escapeHtml(result.id)}"
            ${reviewState === "loading" || result.reviewDisabled ? "disabled" : ""}
            ${result.reviewDisabled ? 'title="Run matching again before generating an explanation"' : ""}>
            <span class="ai-action-icon" aria-hidden="true">✦</span>
            <span>${reviewState === "loading" ? "Generating…" : result.reviewDisabled ? "Run matching again" : "Explain match"}</span>
          </button>`}
          ${sourceUrl ? `<a class="source-link" href="${escapeHtml(sourceUrl)}" target="_blank" rel="noopener noreferrer" referrerpolicy="strict-origin-when-cross-origin">Open official source ↗</a>` : ""}
        </div>
        ${result.sourceNotice ? `<p class="source-notice">${escapeHtml(result.sourceNotice)}</p>` : ""}
      </div>
    </details>
  `;
}

function renderResults(results) {
  if (!results.length) return renderResultsEmpty();
  return results.map(renderResult).join("");
}

function renderLoading() {
  return Array.from({ length: 3 }, () => '<div class="skeleton-card" aria-hidden="true"></div>').join("");
}

function renderResultsEmpty() {
  return `<div class="empty-state"><p>Results will appear here after matching.</p></div>`;
}
