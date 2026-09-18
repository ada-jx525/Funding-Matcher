const MATCHER_API = (() => {
  const REQUEST_TIMEOUT_MS = 45_000;
  const DEMO_STORAGE_KEY = "opportunity-atlas-profiles-v1";
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
  let serviceMode = "unknown";
  let previewDataPromise = null;

  class ApiError extends Error {
    constructor(message, { status = 0, fieldErrors = null } = {}) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.fieldErrors = fieldErrors;
    }
  }

  async function request(path, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const authHeaders = typeof AUTH_CLIENT !== "undefined"
        ? await AUTH_CLIENT.authorizationHeaders()
        : {};
      const response = await fetch(path, {
        ...options,
        headers: {
          Accept: "application/json",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...authHeaders,
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ApiError(
          body.error || "The service could not complete this request.",
          { status: response.status, fieldErrors: body.field_errors || null }
        );
      }
      return body;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new ApiError("The request took too long. Please try again.");
      }
      if (error instanceof ApiError) throw error;
      throw new ApiError("The matching service is currently unreachable.");
    } finally {
      window.clearTimeout(timer);
    }
  }

  function readLocalProfiles() {
    try {
      const value = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function writeLocalProfiles(profiles) {
    localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(profiles));
  }

  function validateProfileFields(fields) {
    const errors = {};
    const name = String(fields.name || "").trim();
    const sourceType = String(fields.source_type || "").trim();
    const location = String(fields.location || "").trim();
    const sectorFocus = splitValues(fields.sector_focus);
    const supportOffered = splitValues(fields.support_offered);
    const supportStages = splitValues(fields.support_stages);
    const geographies = splitValues(fields.geographies);
    const description = String(fields.description || "").trim();
    // Mirror the canonical query validator so preview and live saves cannot
    // disagree. The current corpus/query builders are English-language only.
    const focusTokens = (sectorFocus.join(" ").toLowerCase().match(/[a-z0-9]+/g) || [])
      .filter((token) => token.length > 1);

    if (name.length < 2) errors.name = "Enter a profile name of at least two characters.";
    if (!["eso_profile", "programme_profile"].includes(sourceType)) {
      errors.source_type = "Choose support organisation or programme.";
    }
    if (!location) errors.location = "Enter the organisation or programme location.";
    if (focusTokens.length < 2) {
      errors.sector_focus = "Enter at least two specific English focus terms, such as ‘climate adaptation’.";
    }
    if (!supportOffered.length) errors.support_offered = "Enter at least one support activity.";
    if (!supportStages.length) errors.support_stages = "Enter at least one development stage.";
    if (!geographies.length) errors.geographies = "Enter at least one target geography.";
    // Mirrors the server-side label bounds so the user sees the problem in the
    // form. The server enforces them; this is presentation, not a control.
    const LABEL_LIMIT = 80;
    const LABEL_COUNT = 24;
    for (const [field, values] of Object.entries({
      sector_focus: sectorFocus,
      support_offered: supportOffered,
      support_stages: supportStages,
      geographies
    })) {
      if (values.length > LABEL_COUNT) {
        errors[field] = `Enter no more than ${LABEL_COUNT} values.`;
      } else if (values.some((value) => value.length > LABEL_LIMIT)) {
        errors[field] = `Each value must be a short label of at most ${LABEL_LIMIT} characters.`;
      }
    }
    if (name.length > 120) errors.name = "Keep the profile name to 120 characters or fewer.";
    if (location.length > 120) errors.location = "Keep the location to 120 characters or fewer.";
    if (description.length < 30) {
      errors.description = "Enter a description of at least 30 characters.";
    } else if (description.length > 800) {
      errors.description = "Keep the description to 800 characters or fewer.";
    }
    if (Object.keys(errors).length) {
      throw new ApiError("Please correct the highlighted profile fields.", {
        status: 422,
        fieldErrors: errors
      });
    }
  }

  function demoProfiles() {
    const builtIn = Object.values(PROFILE_CONTEXT).map((profile) => ({
      profile_id: profile.profile_id,
      name: profile.profile_name,
      actor_type: profile.actor_type,
      location: profile.location,
      source_type: profile.source_type || "eso_profile",
      sector_focus: profile.focus || [],
      support_offered: profile.support || [],
      support_stages: profile.stages || [],
      target_geographies: profile.geography || [],
      description: profile.description || ""
    }));
    return [...builtIn, ...readLocalProfiles()];
  }

  function ensurePreviewData() {
    if (typeof PROFILE_CONTEXT !== "undefined" && typeof PUBLIC_RESULTS !== "undefined") {
      return Promise.resolve();
    }
    if (!previewDataPromise) {
      previewDataPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "public-results-sample.js?v=20260820";
        script.addEventListener("load", resolve, { once: true });
        script.addEventListener("error", () => reject(
          new ApiError("Preview data could not be loaded.")
        ), { once: true });
        document.head.append(script);
      });
    }
    return previewDataPromise;
  }

  function isLocalPreview() {
    return window.location.protocol === "file:" || LOCAL_HOSTS.has(window.location.hostname);
  }

  function canUsePreview(error) {
    if (!isLocalPreview() || serviceMode === "live") return false;
    return window.location.protocol === "file:" || error.status === 0 || [404, 405, 501].includes(error.status);
  }

  async function listProfiles() {
    try {
      const body = await request("/api/profiles");
      serviceMode = "live";
      return { profiles: body.profiles || [], meta: body.meta || {}, mode: "live" };
    } catch (error) {
      if (!canUsePreview(error)) throw error;
      await ensurePreviewData();
      serviceMode = "preview";
      return { profiles: demoProfiles(), meta: {}, mode: "preview" };
    }
  }

  async function capabilities() {
    if (serviceMode === "preview") {
      return { reviews_enabled: true, retrieval: "preview" };
    }
    return request("/api/capabilities");
  }

  async function deleteProfile(profileId) {
    if (serviceMode === "preview") {
      const profiles = readLocalProfiles();
      writeLocalProfiles(profiles.filter((profile) => profile.profile_id !== profileId));
      return;
    }
    await request(`/api/profiles/${encodeURIComponent(profileId)}`, {
      method: "DELETE"
    });
  }

  async function deleteAccountData() {
    if (serviceMode === "preview") {
      writeLocalProfiles([]);
      return { deleted: true, profiles_deleted: 0 };
    }
    return request("/api/account", { method: "DELETE" });
  }

  async function createProfile(fields) {
    validateProfileFields(fields);
    try {
      const body = await request("/api/profiles", {
        method: "POST",
        body: JSON.stringify(fields)
      });
      return { profile: body.profile, mode: "live" };
    } catch (error) {
      if (!canUsePreview(error) || error.fieldErrors) throw error;
      const profile = {
        profile_id: `user:${crypto.randomUUID()}`,
        name: fields.name.trim(),
        actor_type: fields.source_type === "programme_profile" ? "Programme" : "Support organisation",
        source_type: fields.source_type,
        location: fields.location.trim(),
        sector_focus: splitValues(fields.sector_focus),
        support_offered: splitValues(fields.support_offered),
        support_stages: splitValues(fields.support_stages),
        target_geographies: splitValues(fields.geographies),
        description: fields.description.trim(),
        local_preview: true
      };
      const profiles = readLocalProfiles();
      profiles.push(profile);
      writeLocalProfiles(profiles);
      return { profile, mode: "preview" };
    }
  }

  async function updateProfile(profileId, fields) {
    validateProfileFields(fields);
    try {
      const body = await request("/api/profiles", {
        method: "PUT",
        body: JSON.stringify({ ...fields, profile_id: profileId })
      });
      return { profile: body.profile, mode: "live" };
    } catch (error) {
      if (!canUsePreview(error) || error.fieldErrors) throw error;
      const profiles = readLocalProfiles();
      const index = profiles.findIndex((profile) => profile.profile_id === profileId);
      if (index < 0) throw error;
      const geographies = splitValues(fields.geographies);
      const updated = {
        ...profiles[index],
        name: fields.name.trim(),
        actor_type: fields.source_type === "programme_profile" ? "Programme" : "Support organisation",
        source_type: fields.source_type,
        location: fields.location.trim(),
        sector_focus: splitValues(fields.sector_focus),
        support_offered: splitValues(fields.support_offered),
        support_stages: splitValues(fields.support_stages),
        target_geographies: geographies,
        eligible_geographies: geographies,
        description: fields.description.trim(),
        local_preview: true
      };
      profiles[index] = updated;
      writeLocalProfiles(profiles);
      return { profile: updated, mode: "preview" };
    }
  }

  async function match({ profileId, searchText, topK }) {
    try {
      const body = await request("/api/matches", {
        method: "POST",
        body: JSON.stringify({
          profile_id: profileId,
          search_text: searchText || null,
          top_k: topK
        })
      });
      return { ...body, mode: "live" };
    } catch (error) {
      if (!canUsePreview(error)) throw error;
      await ensurePreviewData();
      const selected = PUBLIC_RESULTS.baseline.find((item) => item.profile_id === profileId);
      if (!selected) {
        throw new ApiError(
          "Live matching is required for this profile. Start the Hybrid service and try again."
        );
      }
      return {
        ...selected,
        search_context: { search_text: searchText || null },
        results: selected.results.slice(0, topK),
        meta: { retrieval_method: "preview" },
        mode: "preview"
      };
    }
  }

  async function review({ profileId, opportunityId, searchText }) {
    if (serviceMode === "preview") {
      await ensurePreviewData();
      const selected = (PUBLIC_RESULTS.llm || []).find((item) => item.profile_id === profileId);
      const result = selected?.results?.find((item) => item.opportunity?.id === opportunityId);
      if (!result?.decision) {
        throw new ApiError("A sample AI explanation is not available for this opportunity.");
      }
      const raw = result.decision;
      return {
        decision: {
          ...raw,
          summary: raw.summary || raw.reason,
          match_points: raw.match_points || [],
          required_checks: raw.required_checks || raw.missing_information || [],
          action: raw.action || {
            code: "review_requirements",
            label: "Check requirements before proceeding"
          }
        },
        mode: "preview",
        search_context: { search_text: searchText || null }
      };
    }
    const body = await request("/api/reviews", {
      method: "POST",
      body: JSON.stringify({
        profile_id: profileId,
        opportunity_id: opportunityId,
        search_text: searchText || null
      })
    }, 120_000);
    return { ...body, mode: "live" };
  }

  function splitValues(value) {
    return String(value || "")
      .split(/[;,\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return {
    ApiError,
    listProfiles,
    capabilities,
    createProfile,
    updateProfile,
    deleteProfile,
    deleteAccountData,
    match,
    review
  };
})();
