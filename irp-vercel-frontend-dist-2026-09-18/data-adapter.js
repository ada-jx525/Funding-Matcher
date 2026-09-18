const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 30;

// The server bounds its own previews, but the browser must not be able to hang
// on an oversized field from a compromised or misconfigured upstream.
const MAX_FIELD_CHARS = 2000;
const MAX_LIST_ITEMS = 24;

function cleanText(value, fallback = "") {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const text = value.trim();
  return text.length > MAX_FIELD_CHARS ? `${text.slice(0, MAX_FIELD_CHARS)}…` : text;
}

function cleanList(value) {
  return Array.isArray(value)
    ? value
        .slice(0, MAX_LIST_ITEMS)
        .filter((item) => typeof item === "string" && item.trim())
        .map((item) => cleanText(item))
    : [];
}

function normaliseProfile(profile) {
  const id = cleanText(profile?.profile_id || profile?.id);
  if (!id) throw new Error("A profile is missing its identifier.");
  return {
    id,
    editable: Boolean(profile.editable || profile.local_preview || id.startsWith("user:")),
    name: cleanText(profile.name || profile.profile_name, "Unnamed profile"),
    actorType: cleanText(profile.actor_type, profile.source_type === "programme_profile" ? "Programme" : "Support organisation"),
    sourceType: cleanText(profile.source_type, "eso_profile"),
    location: cleanText(profile.location, "Location not specified"),
    focus: cleanList(profile.sector_focus || profile.focus),
    support: cleanList(profile.support_offered || profile.support),
    stages: cleanList(profile.support_stages || profile.stages),
    geography: cleanList(profile.target_geographies || profile.eligible_geographies || profile.geography),
    description: cleanText(profile.description || profile.overview)
  };
}

function normaliseProfiles(value) {
  if (!Array.isArray(value)) return { profiles: [], rejectedCount: 0 };
  const profiles = [];
  const seen = new Set();
  let rejectedCount = 0;
  for (const row of value) {
    try {
      const profile = normaliseProfile(row);
      if (seen.has(profile.id)) {
        rejectedCount += 1;
        continue;
      }
      seen.add(profile.id);
      profiles.push(profile);
    } catch {
      rejectedCount += 1;
    }
  }
  return { profiles, rejectedCount };
}

function safeHttpUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function sourceProviderLabel(value) {
  const provider = cleanText(value, "Official source");
  const labels = {
    "eu-funding-tenders": "EU Funding & Tenders",
    "grants-gov": "Grants.gov",
    "ukri": "UKRI"
  };
  return labels[provider.toLowerCase()] || provider;
}

function normaliseOpportunity(result, index) {
  const opportunity = result?.opportunity || {};
  const id = cleanText(opportunity.id);
  if (!id) return null;
  return {
    rank: Number.isInteger(result.rank) && result.rank > 0 ? result.rank : index + 1,
    id,
    title: cleanText(opportunity.title, "Untitled opportunity"),
    status: cleanText(opportunity.status, "Status unknown"),
    funders: cleanList(opportunity.funders),
    fundingType: cleanText(opportunity.funding_type, "Not specified"),
    totalFund: cleanText(opportunity.total_fund, "Not specified"),
    awardScope: cleanText(opportunity.award_scope, "Not specified"),
    openingDate: cleanText(opportunity.opening_date) || null,
    closingDate: cleanText(opportunity.closing_date) || null,
    summaryPreview: cleanText(opportunity.summary_preview, "No summary is available."),
    summaryTruncated: Boolean(opportunity.summary_truncated),
    sourceProvider: sourceProviderLabel(opportunity.source_provider),
    sourceNotice: cleanText(opportunity.source_notice),
    sourceUrl: safeHttpUrl(opportunity.source_url),
    externalDetailsUrl: safeHttpUrl(opportunity.external_details_url),
    actionability: normaliseActionability(result.actionability),
    decision: normaliseDecision(result.decision)
  };
}

function cleanCitations(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => ({
      id: Number(item?.id),
      sourceField: sourceFieldLabel(item?.source_field),
      text: cleanText(item?.text)
    }))
    .filter((item) => Number.isInteger(item.id) && item.text);
}

function sourceFieldLabel(value) {
  const labels = {
    eligibility_source_text: "Eligibility text",
    summary_text: "Call summary"
  };
  return labels[cleanText(value)] || "Source text";
}

const ACTIONABILITY_CODES = ["open_to_ventures", "research_only", "land_partners_only", "unstated"];

function normaliseActionability(actionability) {
  const code = cleanText(actionability?.code);
  if (!ACTIONABILITY_CODES.includes(code)) return null;
  return {
    code,
    label: cleanText(actionability.label),
    basis: cleanList(actionability.basis),
    evidence: cleanCitations(actionability.evidence)
  };
}

function normaliseDecision(decision) {
  if (!decision || typeof decision !== "object") return null;
  const recommendation = cleanText(decision.recommendation);
  if (!["recommended", "reference", "not_suitable"].includes(recommendation)) return null;
  return {
    recommendation,
    suitableFor: cleanText(decision.suitable_for?.label, "Applicant group not confirmed"),
    summary: cleanText(decision.summary, "No explanation was returned."),
    matchPoints: cleanList(decision.match_points),
    requiredChecks: cleanList(decision.required_checks),
    evidence: cleanCitations(decision.evidence),
    action: cleanText(decision.action?.label)
  };
}

function normaliseMatchResponse(payload) {
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error("The matching service returned an invalid result.");
  }
  const seen = new Set();
  const results = payload.results
    .map(normaliseOpportunity)
    .filter((result) => {
      if (!result || seen.has(result.id)) return false;
      seen.add(result.id);
      return true;
    });
  return {
    profileId: cleanText(payload.profile_id),
    profileName: cleanText(payload.profile_name),
    searchText: cleanText(payload.search_context?.search_text),
    results,
    meta: {
      retrievalMethod: cleanText(payload.meta?.retrieval_method, "hybrid_rrf"),
      corpusSize: Number(payload.meta?.corpus_size) || null
    }
  };
}

function validTopK(value, maximum = MAX_TOP_K) {
  const requestedLimit = Math.floor(Number(maximum));
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(requestedLimit, MAX_TOP_K)
    : MAX_TOP_K;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Math.min(DEFAULT_TOP_K, limit);
  return Math.min(limit, Math.max(1, Math.round(parsed)));
}
