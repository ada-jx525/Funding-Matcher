const params = new URLSearchParams(window.location.search);
const RESULT_LIMIT_CAP = 30;

const state = {
  profiles: [],
  profileId: params.get("profile") || "",
  topK: validTopK(params.get("topK")),
  results: [],
  mode: "connecting",
  loading: false,
  hasMatched: false,
  lastMatchSignature: null,
  lastMatchedSearchText: "",
  resultsStale: false,
  searchMode: "profile",
  corpusSize: null,
  resultLimit: RESULT_LIMIT_CAP,
  reviewsEnabled: false,
  editingProfileId: null
};

let activeProfileOptionIndex = -1;

const els = Object.fromEntries([
  "profile-filter", "profile-filter-status", "profile-data-note", "profile-options", "profile-summary", "profile-picker",
  "profile-step-kicker", "profile-step-title",
  "search-mode-profile", "search-mode-focus", "search-focus-field", "search-focus", "search-focus-help", "search-focus-error", "top-k-select", "result-count-toggle", "result-count-options", "match-button", "results-section", "results-title",
  "results-kicker", "results-meta", "results-list", "selection-status", "app-notice",
  "data-status", "data-status-label", "new-profile-button", "edit-profile-button",
  "auth-controls", "sign-in-button", "account-controls", "account-name",
  "admin-export-button", "delete-account-data-button", "sign-out-button",
  "profile-dialog", "profile-dialog-kicker", "profile-dialog-title", "profile-dialog-copy",
  "close-profile-dialog", "cancel-profile-dialog", "profile-form", "profile-form-error",
  "save-profile-button", "delete-profile-button", "support-field-label",
  "location-field-label", "stage-field-label", "geography-field-label", "description-field-label"
].map((id) => [id.replaceAll("-", "_"), document.getElementById(id)]));

function selectedProfile() {
  return state.profiles.find((profile) => profile.id === state.profileId) || null;
}

function setConnectionMode(mode) {
  state.mode = mode;
  els.data_status.classList.remove("live", "preview", "offline");
  const labels = { live: "Live data", preview: "Preview data", offline: "Service unavailable", connecting: "Connecting" };
  if (["live", "preview", "offline"].includes(mode)) els.data_status.classList.add(mode);
  els.data_status_label.textContent = labels[mode] || labels.connecting;
}

function setNotice(message = "", tone = "info") {
  els.app_notice.hidden = !message;
  els.app_notice.textContent = message;
  els.app_notice.classList.toggle("error", tone === "error");
  els.app_notice.setAttribute("role", tone === "error" ? "alert" : "status");
  els.app_notice.setAttribute("aria-live", tone === "error" ? "assertive" : "polite");
}

function renderAuth(authState) {
  const enabled = authState?.config?.enabled === true;
  const user = authState?.user || null;
  els.auth_controls.hidden = !enabled;
  els.sign_in_button.hidden = !enabled || Boolean(user);
  els.account_controls.hidden = !enabled || !user;
  els.account_name.textContent = user?.name || "";
  els.admin_export_button.hidden = !user || !AUTH_CLIENT.isAdmin();
}

async function initialiseAuth() {
  const authState = await AUTH_CLIENT.initialise();
  renderAuth(authState);
  return authState;
}

function profileCountLabel(count) {
  return `${count} ${count === 1 ? "profile" : "profiles"}`;
}

function setResultLimit(corpusSize) {
  const available = Math.floor(Number(corpusSize));
  state.corpusSize = Number.isFinite(available) && available > 0 ? available : null;
  state.resultLimit = state.corpusSize
    ? Math.min(state.corpusSize, RESULT_LIMIT_CAP)
    : RESULT_LIMIT_CAP;
  state.topK = validTopK(state.topK, state.resultLimit);
  els.top_k_select.max = String(state.resultLimit);
  const choices = [5, 10, 15, 20, 25, 30].filter((value) => value <= state.resultLimit);
  if (!choices.length) choices.push(state.resultLimit);
  els.result_count_options.innerHTML = choices
    .map((value) => `<button type="button" role="option" data-result-count="${value}" aria-selected="${value === state.topK}">${value}</button>`)
    .join("");
  els.top_k_select.value = String(state.topK);
}

function closeResultCountOptions() {
  els.result_count_options.hidden = true;
  els.result_count_toggle.setAttribute("aria-expanded", "false");
  els.top_k_select.setAttribute("aria-expanded", "false");
}

function toggleResultCountOptions() {
  const opening = els.result_count_options.hidden;
  els.result_count_options.hidden = !opening;
  els.result_count_toggle.setAttribute("aria-expanded", String(opening));
  els.top_k_select.setAttribute("aria-expanded", String(opening));
  if (opening) els.result_count_options.querySelector('[role="option"]')?.focus();
}

function syncResultCountSelection() {
  const value = Number(els.top_k_select.value);
  els.result_count_options.querySelectorAll('[role="option"]').forEach((option) => {
    option.setAttribute("aria-selected", String(Number(option.dataset.resultCount) === value));
  });
}

function commitResultCount() {
  const rawValue = Number(els.top_k_select.value);
  const nextValue = validTopK(els.top_k_select.value, state.resultLimit);
  const adjusted = !Number.isInteger(rawValue) || rawValue !== nextValue;
  state.topK = nextValue;
  els.top_k_select.value = String(state.topK);
  els.top_k_select.removeAttribute("aria-invalid");
  syncResultCountSelection();
  closeResultCountOptions();
  syncResultsFreshness();
  if (adjusted) announce(`Adjusted to ${state.topK} results. Choose a number from 1 to ${state.resultLimit}.`);
}

function currentSearchText() {
  return state.searchMode === "focus" ? els.search_focus.value.trim() : "";
}

function setSearchMode(mode) {
  state.searchMode = mode === "focus" ? "focus" : "profile";
  const usesFocus = state.searchMode === "focus";
  els.search_mode_profile.checked = !usesFocus;
  els.search_mode_focus.checked = usesFocus;
  els.search_focus_field.hidden = !usesFocus;
  els.search_focus.disabled = state.loading || !usesFocus;
  els.search_focus.required = usesFocus;
  if (!usesFocus) {
    els.search_focus.removeAttribute("aria-invalid");
    els.search_focus_error.hidden = true;
  }
  syncResultsFreshness();
}

function validateSearchFocus() {
  const valid = state.searchMode !== "focus" || Boolean(els.search_focus.value.trim());
  if (valid) els.search_focus.removeAttribute("aria-invalid");
  else els.search_focus.setAttribute("aria-invalid", "true");
  els.search_focus_error.hidden = valid;
  if (!valid) els.search_focus.focus();
  return valid;
}

function matchingProfiles() {
  const query = els.profile_filter.value.trim().toLocaleLowerCase();
  if (!query) return state.profiles;
  return state.profiles.filter((profile) => [profile.name, profile.location, profile.actorType, ...profile.focus]
    .join(" ").toLocaleLowerCase().includes(query));
}

function closeProfileOptions() {
  activeProfileOptionIndex = -1;
  els.profile_options.hidden = true;
  els.profile_filter.setAttribute("aria-expanded", "false");
  els.profile_filter.setAttribute("aria-activedescendant", "");
}

function setActiveProfileOption(index) {
  const options = [...els.profile_options.querySelectorAll('[role="option"]')];
  if (!options.length) return;
  activeProfileOptionIndex = Math.max(0, Math.min(index, options.length - 1));
  options.forEach((option, optionIndex) => option.classList.toggle("active", optionIndex === activeProfileOptionIndex));
  const activeOption = options[activeProfileOptionIndex];
  els.profile_filter.setAttribute("aria-activedescendant", activeOption.id);
  activeOption.scrollIntoView({ block: "nearest" });
}

function showProfileOptions({ force = false } = {}) {
  const matches = matchingProfiles();
  els.profile_options.innerHTML = matches.length
    ? renderProfileOptions(matches, state.profileId)
    : '<p class="no-profile-match">No saved profiles match that search.</p>';
  els.profile_options.hidden = !force && document.activeElement !== els.profile_filter;
  els.profile_filter.setAttribute("aria-expanded", String(!els.profile_options.hidden));
  activeProfileOptionIndex = -1;
  els.profile_filter.setAttribute("aria-activedescendant", "");
  els.profile_filter_status.textContent = matches.length === state.profiles.length
    ? profileCountLabel(state.profiles.length)
    : `${matches.length} ${matches.length === 1 ? "match" : "matches"}`;
}

function renderSelectedProfile() {
  const profile = selectedProfile();
  els.profile_summary.innerHTML = renderProfile(profile);
  els.profile_picker.hidden = Boolean(profile);
  els.profile_summary.hidden = !profile;
  els.edit_profile_button.hidden = !profile;
  els.profile_step_kicker.textContent = profile ? "Complete" : "Required";
  els.profile_step_title.textContent = profile ? "Profile selected" : "Choose a profile";
  els.edit_profile_button.disabled = !profile || state.loading;
  els.edit_profile_button.textContent = profile?.editable ? "Edit this profile" : "Customise this profile";
  els.match_button.disabled = !profile || state.loading;
}

function chooseProfile(profileId) {
  if (!state.profiles.some((profile) => profile.id === profileId)) return;
  state.profileId = profileId;
  state.results = [];
  state.hasMatched = false;
  state.lastMatchSignature = null;
  state.lastMatchedSearchText = "";
  state.resultsStale = false;
  els.profile_filter.value = "";
  closeProfileOptions();
  renderSelectedProfile();
  announce(`${selectedProfile()?.name || "Profile"} selected.`);
  renderIdle();
  updateUrl();
}

function changeProfile() {
  els.profile_picker.hidden = false;
  els.profile_summary.hidden = true;
  els.edit_profile_button.hidden = true;
  els.profile_step_kicker.textContent = "Required";
  els.profile_step_title.textContent = "Choose a profile";
  els.profile_filter.value = "";
  requestAnimationFrame(() => {
    els.profile_filter.focus();
    showProfileOptions({ force: true });
  });
}

function renderIdle() {
  els.results_kicker.textContent = "Your shortlist";
  els.results_title.textContent = "Ready when you are";
  els.results_meta.textContent = "";
  els.results_meta.classList.remove("stale");
  els.results_list.innerHTML = renderResultsEmpty();
  els.results_list.setAttribute("aria-busy", "false");
}

function currentMatchSignature() {
  return JSON.stringify({ profileId: state.profileId, searchText: currentSearchText(), topK: state.topK });
}

function syncResultsFreshness() {
  state.resultsStale = Boolean(state.hasMatched && state.lastMatchSignature !== currentMatchSignature());
  if (!state.hasMatched) return;
  els.results_meta.classList.toggle("stale", state.resultsStale);
  els.results_meta.textContent = state.resultsStale
    ? "Search settings changed · run matching again"
    : "Ranked by relevance";
}

function announce(message) {
  els.selection_status.textContent = "";
  requestAnimationFrame(() => { els.selection_status.textContent = message; });
}

function renderMatches({ announceResults = false } = {}) {
  els.results_kicker.textContent = state.results.length ? "Ranked opportunities" : "Search complete";
  els.results_title.textContent = state.results.length ? `${state.results.length} opportunities for ${selectedProfile()?.name || "this profile"}` : "No opportunities returned";
  els.results_meta.textContent = state.resultsStale ? "Search settings changed · run matching again" : state.results.length ? "Ranked by relevance" : "Try a broader search";
  els.results_meta.classList.toggle("stale", state.resultsStale);
  els.results_list.setAttribute("aria-busy", "false");
  els.results_list.innerHTML = renderResults(state.results.map((result) => ({
    ...result,
    reviewDisabled: state.resultsStale,
    reviewAvailable: state.reviewsEnabled
  })));
  if (announceResults) announce(`${state.results.length} ranked opportunities found.`);
}

function setControlsBusy(busy) {
  state.loading = busy;
  els.profile_filter.disabled = busy || !state.profiles.length;
  els.search_mode_profile.disabled = busy;
  els.search_mode_focus.disabled = busy;
  els.search_focus.disabled = busy || state.searchMode !== "focus";
  els.top_k_select.disabled = busy;
  els.result_count_toggle.disabled = busy;
  els.new_profile_button.disabled = busy;
  els.edit_profile_button.disabled = busy || !selectedProfile();
  els.match_button.disabled = busy || !selectedProfile();
  els.match_button.setAttribute("aria-busy", String(busy));
}

function updateUrl() {
  const url = new URL(window.location.href);
  if (state.profileId) url.searchParams.set("profile", state.profileId);
  else url.searchParams.delete("profile");
  url.searchParams.set("topK", String(state.topK));
  history.replaceState(null, "", url);
}

async function loadProfiles() {
  setConnectionMode("connecting");
  try {
    const response = await MATCHER_API.listProfiles();
    const capabilities = await MATCHER_API.capabilities();
    state.reviewsEnabled = capabilities.reviews_enabled === true;
    const catalogue = normaliseProfiles(response.profiles);
    state.profiles = catalogue.profiles.sort((a, b) => a.name.localeCompare(b.name));
    // A profile is selected only when it was explicitly supplied in the URL.
    // Silently selecting the alphabetically first record makes a full catalogue
    // look like a single-profile product and can trigger a search for the wrong
    // organisation.
    if (!state.profiles.some((profile) => profile.id === state.profileId)) state.profileId = "";
    setConnectionMode(response.mode);
    if (response.meta?.corpus_size) {
      setResultLimit(response.meta.corpus_size);
    }
    renderSelectedProfile();
    showProfileOptions();
    els.profile_data_note.hidden = response.mode !== "preview";
    els.profile_data_note.textContent = response.mode === "preview"
      ? "Offline preview only. Open the live local service to load all 249 saved profiles."
      : "";
    if (catalogue.rejectedCount) {
      setNotice(`${catalogue.rejectedCount} invalid profile ${catalogue.rejectedCount === 1 ? "record was" : "records were"} excluded from this catalogue.`, "error");
    } else if (!state.profiles.length) {
      setNotice("Create a profile before running your first search.");
    }
  } catch (error) {
    setConnectionMode("offline");
    state.reviewsEnabled = false;
    state.profiles = [];
    els.profile_data_note.hidden = true;
    renderSelectedProfile();
    setNotice(error.message, "error");
  }
}

async function runMatch() {
  if (state.loading || !state.profileId) return;
  if (!validateSearchFocus()) return;
  commitResultCount();
  const searchText = currentSearchText();
  setControlsBusy(true);
  els.match_button.querySelector("span:first-child").textContent = "Finding matches…";
  setNotice();
  els.results_kicker.textContent = "Searching opportunities";
  els.results_title.textContent = "Finding relevant opportunities…";
  els.results_meta.textContent = "Reviewing available opportunities";
  els.results_list.setAttribute("aria-busy", "true");
  els.results_list.innerHTML = renderLoading();
  try {
    const response = await MATCHER_API.match({ profileId: state.profileId, searchText, topK: state.topK });
    const match = normaliseMatchResponse(response);
    if (match.meta.corpusSize) {
      setResultLimit(match.meta.corpusSize);
    }
    state.results = match.results.slice(0, state.topK).map((result, index) => ({
      ...result,
      reviewStatus: "idle",
      reviewError: "",
      expanded: index === 0
    }));
    state.hasMatched = true;
    state.lastMatchedSearchText = searchText;
    state.lastMatchSignature = currentMatchSignature();
    state.resultsStale = false;
    setConnectionMode(response.mode);
    if (response.mode === "preview") setNotice("Showing sample results and sample AI explanations. Open the live service for current matches.");
    renderMatches({ announceResults: true });
    updateUrl();
    els.results_section.scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setNotice(`${error.message} Your previous shortlist has been kept.`, "error");
    state.hasMatched ? renderMatches() : renderIdle();
  } finally {
    setControlsBusy(false);
    els.match_button.querySelector("span:first-child").textContent = "Find opportunities";
  }
}

async function reviewResult(opportunityId) {
  const result = state.results.find((item) => item.id === opportunityId);
  if (!result || result.reviewStatus === "loading" || result.decision) return;
  if (state.resultsStale) {
    setNotice("Run matching again before generating an explanation for changed search settings.", "error");
    return;
  }
  result.reviewStatus = "loading";
  result.reviewError = "";
  renderMatches();
  try {
    const response = await MATCHER_API.review({
      profileId: state.profileId,
      opportunityId,
      searchText: state.lastMatchedSearchText
    });
    result.decision = normaliseDecision(response.decision);
    if (!result.decision) throw new Error("The AI assessment returned an invalid result.");
    result.reviewStatus = "done";
    announce(`AI assessment generated for ${result.title}.`);
  } catch (error) {
    result.reviewStatus = "error";
    result.reviewError = error.message;
  }
  renderMatches();
  requestAnimationFrame(() => {
    const card = [...els.results_list.querySelectorAll("details.result-card")]
      .find((item) => item.dataset.resultId === opportunityId);
    const focusTarget = result.decision
      ? card?.querySelector("summary")
      : card?.querySelector('[data-action="review-result"]');
    focusTarget?.focus();
  });
}

function updateProfileFormLabels() {
  const programme = els.profile_form.elements.source_type.value === "programme_profile";
  els.support_field_label.textContent = programme ? "Programme support offered" : "Support offered";
  els.location_field_label.textContent = programme ? "Programme operator location" : "Organisation location";
  els.stage_field_label.textContent = programme ? "Participant stages" : "Development stages";
  els.geography_field_label.textContent = programme ? "Participant geographies" : "Target geographies";
  els.description_field_label.textContent = programme ? "Programme and participant description" : "Organisation description";
}

function fillProfileForm(profile) {
  const fields = els.profile_form.elements;
  fields.name.value = profile.editable ? profile.name : `${profile.name} (custom)`;
  fields.source_type.value = profile.sourceType;
  fields.location.value = profile.location === "Location not specified" ? "" : profile.location;
  fields.sector_focus.value = profile.focus.join(", ");
  fields.support_offered.value = profile.support.join(", ");
  fields.support_stages.value = profile.stages.join(", ");
  fields.geographies.value = profile.geography.join(", ");
  fields.description.value = profile.description;
}

function clearFormErrors() {
  els.profile_form_error.hidden = true;
  els.profile_form_error.textContent = "";
  els.profile_form.querySelectorAll("[aria-invalid='true']").forEach((field) => field.removeAttribute("aria-invalid"));
  els.profile_form.querySelectorAll(".field-error").forEach((error) => {
    const field = els.profile_form.elements.namedItem(error.dataset.field);
    if (field instanceof HTMLElement) {
      const describedBy = (field.getAttribute("aria-describedby") || "").split(/\s+/).filter((id) => id && id !== error.id);
      if (describedBy.length) field.setAttribute("aria-describedby", describedBy.join(" "));
      else field.removeAttribute("aria-describedby");
    }
    error.remove();
  });
}

function openProfileDialog(mode = "new") {
  els.profile_form.reset(); clearFormErrors();
  const profile = selectedProfile();
  const editing = mode === "edit" && profile?.editable;
  const customising = mode === "edit" && profile && !profile.editable;
  state.editingProfileId = editing ? profile.id : null;
  if (editing || customising) fillProfileForm(profile);
  els.profile_dialog_kicker.textContent = editing ? "Update saved profile" : customising ? "Create an editable copy" : "Create a saved profile";
  els.profile_dialog_title.textContent = editing ? "Update your matching profile" : customising ? "Customise this profile" : "Tell us about your work";
  els.profile_dialog_copy.textContent = customising ? "The source profile stays unchanged. Your editable copy is saved separately." : "Complete the essentials below so the matcher has enough reliable signal.";
  els.save_profile_button.textContent = editing ? "Save changes" : "Save profile";
  els.delete_profile_button.hidden = !editing;
  updateProfileFormLabels();
  els.profile_dialog.showModal();
  requestAnimationFrame(() => els.profile_form.elements.name.focus());
}

function closeProfileDialog() { els.profile_dialog.close(); state.editingProfileId = null; }

function showFormErrors(error) {
  clearFormErrors();
  els.profile_form_error.hidden = false;
  els.profile_form_error.textContent = error.message;
  Object.entries(error.fieldErrors || {}).forEach(([name, message]) => {
    const field = els.profile_form.elements.namedItem(name);
    if (!(field instanceof HTMLElement)) return;
    field.setAttribute("aria-invalid", "true");
    const note = document.createElement("small");
    note.id = `field-error-${name}`; note.className = "field-error"; note.dataset.field = name; note.textContent = message;
    const describedBy = new Set((field.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean));
    describedBy.add(note.id);
    field.setAttribute("aria-describedby", [...describedBy].join(" "));
    field.closest(".form-field")?.append(note);
  });
  (els.profile_form.querySelector("[aria-invalid='true']") || els.profile_form_error).focus();
}

async function saveProfile(event) {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(els.profile_form).entries());
  els.save_profile_button.disabled = true;
  try {
    const response = state.editingProfileId ? await MATCHER_API.updateProfile(state.editingProfileId, fields) : await MATCHER_API.createProfile(fields);
    const profile = normaliseProfile(response.profile);
    const index = state.profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) state.profiles[index] = profile; else state.profiles.push(profile);
    state.profiles.sort((a, b) => a.name.localeCompare(b.name));
    state.profileId = profile.id;
    state.results = []; state.hasMatched = false; state.lastMatchedSearchText = "";
    setConnectionMode(response.mode); renderSelectedProfile(); renderIdle(); closeProfileDialog(); updateUrl();
    setNotice(index >= 0 ? "Profile updated." : "Profile saved. You can now run a match.");
  } catch (error) { showFormErrors(error); }
  finally { els.save_profile_button.disabled = false; }
}

async function deleteProfile() {
  const profileId = state.editingProfileId;
  const profile = selectedProfile();
  if (!profileId || !profile?.editable) return;
  if (!window.confirm(`Delete “${profile.name}”? This cannot be undone.`)) return;
  els.delete_profile_button.disabled = true;
  try {
    await MATCHER_API.deleteProfile(profileId);
    state.profiles = state.profiles.filter((item) => item.id !== profileId);
    state.profileId = "";
    state.results = [];
    state.hasMatched = false;
    closeProfileDialog();
    renderSelectedProfile();
    renderIdle();
    updateUrl();
    setNotice("Profile deleted.");
  } catch (error) {
    showFormErrors(error);
  } finally {
    els.delete_profile_button.disabled = false;
  }
}

els.profile_filter.addEventListener("focus", () => showProfileOptions({ force: true }));
els.profile_filter.addEventListener("input", () => showProfileOptions({ force: true }));
els.profile_filter.addEventListener("keydown", (event) => {
  if (event.key === "Tab") {
    closeProfileOptions();
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", "Escape"].includes(event.key)) return;
  if (event.key === "Escape") {
    closeProfileOptions();
    return;
  }
  const options = [...els.profile_options.querySelectorAll('[role="option"]')];
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && els.profile_options.hidden) {
    showProfileOptions({ force: true });
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    setActiveProfileOption(activeProfileOptionIndex + 1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setActiveProfileOption(activeProfileOptionIndex < 0 ? options.length - 1 : activeProfileOptionIndex - 1);
  } else if (event.key === "Home") {
    event.preventDefault();
    setActiveProfileOption(0);
  } else if (event.key === "End") {
    event.preventDefault();
    setActiveProfileOption(options.length - 1);
  } else if (event.key === "Enter" && activeProfileOptionIndex >= 0) {
    event.preventDefault();
    const activeOption = els.profile_options.querySelectorAll('[role="option"]')[activeProfileOptionIndex];
    if (activeOption) chooseProfile(activeOption.dataset.profileId);
  }
});
els.profile_options.addEventListener("click", (event) => {
  const option = event.target.closest('[data-action="choose-profile"]');
  if (option) chooseProfile(option.dataset.profileId);
});
els.profile_summary.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="change-profile"]')) changeProfile();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".profile-picker")) closeProfileOptions();
  if (!event.target.closest(".result-count-control")) closeResultCountOptions();
});
els.search_focus.addEventListener("input", () => {
  if (els.search_focus.value.trim()) {
    els.search_focus.removeAttribute("aria-invalid");
    els.search_focus_error.hidden = true;
  }
  syncResultsFreshness();
});
els.search_focus.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runMatch();
  }
});
els.search_mode_profile.addEventListener("change", () => {
  if (els.search_mode_profile.checked) setSearchMode("profile");
});
els.search_mode_focus.addEventListener("change", () => {
  if (els.search_mode_focus.checked) setSearchMode("focus");
});
els.top_k_select.addEventListener("input", (event) => {
  const value = Number(event.target.value);
  const valid = Number.isInteger(value) && value >= 1 && value <= state.resultLimit;
  if (!valid) {
    event.target.setAttribute("aria-invalid", "true");
    return;
  }
  event.target.removeAttribute("aria-invalid");
  state.topK = value;
  syncResultCountSelection();
  syncResultsFreshness();
});
els.top_k_select.addEventListener("change", commitResultCount);
els.top_k_select.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeResultCountOptions();
});
els.result_count_toggle.addEventListener("click", toggleResultCountOptions);
els.result_count_options.addEventListener("click", (event) => {
  const option = event.target.closest("[data-result-count]");
  if (!option) return;
  els.top_k_select.value = option.dataset.resultCount;
  commitResultCount();
  els.top_k_select.focus();
});
els.result_count_options.addEventListener("keydown", (event) => {
  const options = [...els.result_count_options.querySelectorAll('[role="option"]')];
  const index = options.indexOf(event.target);
  if (event.key === "Escape") {
    event.preventDefault();
    closeResultCountOptions();
    els.result_count_toggle.focus();
  } else if (event.key === "ArrowDown" && index >= 0) {
    event.preventDefault();
    options[(index + 1) % options.length].focus();
  } else if (event.key === "ArrowUp" && index >= 0) {
    event.preventDefault();
    options[(index - 1 + options.length) % options.length].focus();
  }
});
els.match_button.addEventListener("click", runMatch);
els.results_list.addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="review-result"]');
  if (button) reviewResult(button.dataset.opportunityId);
});
els.results_list.addEventListener("toggle", (event) => {
  const card = event.target.closest("details.result-card");
  if (!card || event.target !== card) return;
  const result = state.results.find((item) => item.id === card.dataset.resultId);
  if (result) result.expanded = card.open;
}, true);
els.new_profile_button.addEventListener("click", () => openProfileDialog("new"));
els.edit_profile_button.addEventListener("click", () => openProfileDialog("edit"));
els.close_profile_dialog.addEventListener("click", closeProfileDialog);
els.cancel_profile_dialog.addEventListener("click", closeProfileDialog);
els.profile_form.addEventListener("submit", saveProfile);
els.delete_profile_button.addEventListener("click", deleteProfile);
els.profile_form.elements.source_type.addEventListener("change", updateProfileFormLabels);
els.profile_dialog.addEventListener("click", (event) => { if (event.target === els.profile_dialog) closeProfileDialog(); });
els.profile_dialog.addEventListener("close", () => { state.editingProfileId = null; });
els.admin_export_button.addEventListener("click", async () => {
  els.admin_export_button.disabled = true;
  try {
    await AUTH_CLIENT.downloadProfiles();
  } catch (error) {
    setNotice(error.message || "The profile export could not be downloaded.", "error");
  } finally {
    els.admin_export_button.disabled = false;
  }
});
els.sign_in_button.addEventListener("click", async () => {
  els.sign_in_button.disabled = true;
  try {
    await AUTH_CLIENT.signIn();
  } catch (error) {
    setNotice(error.message || "Sign-in could not be started.", "error");
    els.sign_in_button.disabled = false;
  }
});
els.sign_out_button.addEventListener("click", async () => {
  els.sign_out_button.disabled = true;
  try {
    await AUTH_CLIENT.signOut();
  } catch (error) {
    setNotice(error.message || "Sign-out could not be completed.", "error");
    els.sign_out_button.disabled = false;
  }
});
els.delete_account_data_button.addEventListener("click", async () => {
  if (!window.confirm(
    "Delete all profiles you created in Opportunity Atlas? This cannot be undone."
  )) return;
  els.delete_account_data_button.disabled = true;
  try {
    await MATCHER_API.deleteAccountData();
    await AUTH_CLIENT.signOut();
  } catch (error) {
    setNotice(error.message || "Your saved data could not be deleted.", "error");
    els.delete_account_data_button.disabled = false;
  }
});

async function bootstrap() {
  setResultLimit();
  setSearchMode("profile");
  renderIdle();
  try {
    const authState = await initialiseAuth();
    if (authState.config.enabled && !authState.user) {
      setConnectionMode("offline");
      setNotice("Sign in or create an account to access saved profiles and matching.");
      return;
    }
    await loadProfiles();
  } catch (error) {
    setConnectionMode("offline");
    setNotice(error.message || "The application could not be started.", "error");
  }
}

bootstrap();
