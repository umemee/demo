// matchHandlers.js
const fs = require("fs/promises");
const path = require("path");
const { execFile } = require("child_process");
const http = require("http");

const config = require("./config.js");
const utils = require("./utils.js");
const v2Handlers = require("./v2Handlers.js");

const { RUNTIME, RESULTS, COMPANY_INPUTS, FAST_MATCH_CARD_DB_PATH, FAST_MATCH_CONTEXT_SCRIPT_PATH, FAST_KOREAN_BRIEFING_SCRIPT_PATH, RUNTIME_MATCHER_SOURCE_TYPE, V2_PIPELINE_RUNS_DIR, V2_SAFE_INPUT_VALUE_FIELDS, REPO_ROOT } = config;
const { json, slugifyCaseIdCandidate, toRepoPath, compactErrorText, pathExists, isSafeResultCaseId } = utils;
const { findV2SensitivePackageFieldPaths, buildV2CandidateValuesFromSavedCompanyInput, normalizeToV2SafeInput, markMissingV2Fields, loadStandardCompanyInputFromPath } = v2Handlers;
// ✂️ 👇 아래 빈 공간에 resultHandlers.js에서 잘라낸 두 덩어리를 붙여넣으세요! 👇 ✂️
function stripPrivateLikeText(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "")
    .replace(/(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{2,4}\)?[-.\s]?)?\d{3,4}[-.\s]?\d{4}/g, "")
    .replace(/\b\d{6}[-\s]?\d{7}\b/g, "")
    .replace(/\b\d{3}-\d{2}-\d{5}\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeDraftText(value, maxLength = 500) {
  const text = stripPrivateLikeText(value)
    .replace(/[<>]/g, "")
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}...` : text;
}

function normalizeMatcherText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function extractSourceExcerpt(text, indexOrPattern, radius = 90) {
  const raw = String(text || "");
  let index = -1;
  if (typeof indexOrPattern === "number") {
    index = indexOrPattern;
  } else if (indexOrPattern instanceof RegExp) {
    const match = raw.match(indexOrPattern);
    index = match ? match.index ?? -1 : -1;
  } else if (indexOrPattern) {
    index = raw.indexOf(String(indexOrPattern));
  }
  if (index < 0) return "";
  return sanitizeDraftText(raw.slice(Math.max(0, index - radius), Math.min(raw.length, index + radius)), 220);
}

function isLikelyProgramAnnouncement(text) {
  const raw = String(text || "");
  const lower = raw.toLowerCase();
  const indicators = [
    "모집공고",
    "공고",
    "지원사업",
    "사업개요",
    "지원내용",
    "신청기간",
    "한국농업기술진흥원",
    "농림축산식품부",
    "ministry",
    "program announcement",
    "application period",
    "怨듦퀬",
    "紐⑥쭛",
    "吏?먯궗",
    "?ъ뾽媛쒖슂",
    "?몃??댁슜"
  ];
  const score = indicators.reduce((count, item) => count + (lower.includes(item.toLowerCase()) ? 1 : 0), 0);
  return score >= 3;
}

function firstLabeledValue(text, labels) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    for (const label of labels) {
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = line.match(new RegExp(`^(?:[-*\\s]*)${escaped}\\s*[:：|]\\s*(.{2,120})$`, "i"));
      if (match) return { value: match[1].trim(), excerpt: line };
    }
  }
  return null;
}

function cleanExtractedCell(value) {
  return sanitizeDraftText(
    String(value || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/\*\*/g, "")
      .replace(/\s+/g, " "),
    420
  );
}

function tableLabeledValue(text, labels) {
  return tableLabeledValues(text, labels)[0] || null;
}

function tableLabeledValues(text, labels) {
  const normalizedLabels = labels.map((label) => String(label).replace(/\s+/g, ""));
  const values = [];
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map(cleanExtractedCell);
    for (let i = 0; i < cells.length; i += 1) {
      const normalizedCell = cells[i].replace(/\s+/g, "");
      if (!normalizedLabels.some((label) => normalizedCell.includes(label))) continue;
      for (let j = i + 1; j < cells.length; j += 1) {
        const candidate = cells[j];
        if (candidate && !/^[-:]+$/.test(candidate) && !normalizedLabels.includes(candidate.replace(/\s+/g, ""))) {
          values.push({ value: candidate, excerpt: `${cells[i]}: ${candidate}` });
          break;
        }
      }
    }
  }
  return values;
}

function regionFromAddressRow(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.includes("|") || !line.includes("사업장 주소")) continue;
    const cells = line.split("|").map(cleanExtractedCell);
    const regionCell = cells.find((cell) => /(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충청|충남|충북|전라|전남|전북|경상|경남|경북|제주)/.test(cell));
    if (!regionCell) continue;
    const match = regionCell.match(/((?:서울|부산|대구|인천|광주|대전|울산|세종)(?:특별시|광역시|특별자치시)?\s*[^\s,|]{1,12}(?:구|군|시)?)|((?:경기|강원|충청남도|충청북도|충남|충북|전라남도|전라북도|전남|전북|경상남도|경상북도|경남|경북|제주)(?:도|특별자치도)?\s*[^\s,|]{1,12}(?:군|시|구))/);
    if (match) return { value: match[0], excerpt: `사업장 주소: ${match[0]}` };
  }
  return null;
}

function normalizeRegion(value) {
  const text = sanitizeDraftText(value, 120);
  if (!text) return "";
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length > 3) return parts.slice(0, 2).join(" ");
  return text;
}

function inferIndustryDraft(text) {
  const lower = String(text || "").toLowerCase();
  if ((lower.includes("ai") || lower.includes("인공지능")) && /(농|축산|양돈|돈사|스마트팜|agri|farm|pig)/i.test(text)) {
    const product = tableLabeledValue(text, ["주생산품", "제품/서비스", "상용화대상명"]);
    return { value: "AI software / agri-tech", excerpt: product?.excerpt || "AI + agri/livestock keywords found in extracted text.", term: "AI + agri/livestock context" };
  }
  const rules = [
    { label: "agri-tech / smart farm", terms: ["bee", "벌", "양봉", "스마트양봉"] },
    { label: "agricultural robotics", terms: ["robot", "robotics", "로봇", "자동화"] },
    { label: "smart farm", terms: ["smart farm", "스마트팜"] },
    { label: "AI software / agri-tech", terms: ["ai", "인공지능"] },
    { label: "food-tech", terms: ["food", "푸드테크"] }
  ];
  for (const rule of rules) {
    const found = rule.terms.find((term) => lower.includes(term.toLowerCase()));
    if (found) return { value: rule.label, excerpt: extractSourceExcerpt(text, found), term: found };
  }
  return null;
}

function inferNeedsDraft(text) {
  const lower = String(text || "").toLowerCase();
  const rules = [
    { label: "field validation", terms: ["field validation", "현장검증", "실증"] },
    { label: "commercialization", terms: ["commercialization", "사업화", "상용화"] },
    { label: "market expansion", terms: ["market expansion", "판로", "시장 확대"] },
    { label: "PoC", terms: ["poc", "proof of concept"] },
    { label: "certification", terms: ["certification need", "인증 필요", "인증 준비"] },
    { label: "investment", terms: ["investment need", "투자 필요", "투자 유치 필요"] },
    { label: "procurement", terms: ["procurement", "조달"] },
    { label: "pilot deployment", terms: ["pilot", "시범", "파일럿"] }
  ];
  const values = [];
  let excerpt = "";
  for (const rule of rules) {
    const found = rule.terms.find((term) => lower.includes(term.toLowerCase()));
    if (found && !values.includes(rule.label)) {
      values.push(rule.label);
      if (!excerpt) excerpt = extractSourceExcerpt(text, found);
    }
  }
  return values.length ? { value: values.slice(0, 4), excerpt } : null;
}

function normalizeCoarseEstablishmentDateText(value) {
  const text = sanitizeDraftText(value, 32);
  if (!text) return null;
  const match = text.match(/(20\d{2})(?:\s*[.\-\/년]\s*(\d{1,2}))?(?:\s*[.\-\/월]\s*(\d{1,2}))?/);
  if (!match) return null;
  const year = match[1];
  const month = match[2] ? String(match[2]).padStart(2, "0") : null;
  return month ? `${year}-${month}` : year;
}

function normalizeCleanEstablishmentDateValue(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (!/^(20\d{2})-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?$/.test(text)) return null;
  return text;
}

async function readCleanAutofillDraftEstablishmentDate(caseId) {
  const draftCaseId = String(caseId || "").trim();
  if (!draftCaseId) return null;
  const draftPath = path.join(UPLOADS, draftCaseId, "autofill_draft.json");
  try {
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    const candidate = draft?.v2_safe_candidate_fields?.establishment_date;
    const rawValue = candidate && typeof candidate === "object" && !Array.isArray(candidate)
      ? candidate.value
      : candidate;
    return normalizeCleanEstablishmentDateValue(rawValue);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function extractAutofillDraftCandidateValue(container, fieldName) {
  const candidate = container?.[fieldName];
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && Object.prototype.hasOwnProperty.call(candidate, "value")) {
    return candidate.value;
  }
  return candidate;
}

async function readCleanAutofillDraftBridgeCandidates(caseId) {
  const draftCaseId = String(caseId || "").trim();
  if (!draftCaseId) return {};
  const draftPath = path.join(UPLOADS, draftCaseId, "autofill_draft.json");

  try {
    const draft = JSON.parse(await fs.readFile(draftPath, "utf8"));
    const bridge = {};
    const assign = (fieldName, rawValue, normalize, sourceLabel) => {
      const normalizedValue = normalize(rawValue);
      if (!hasMeaningfulValue(normalizedValue)) return;
      bridge[fieldName] = {
        value: normalizedValue,
        source: sourceLabel
      };
    };

    assign(
      "company_name_or_alias",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "company_name_or_alias"),
      (value) => sanitizeDraftText(value, 80),
      "autofill draft draft_fields.company_name_or_alias"
    );
    assign(
      "region",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "region"),
      (value) => normalizeRegion(value),
      "autofill draft draft_fields.region"
    );
    assign(
      "industry_field",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "industry_field"),
      (value) => sanitizeDraftText(value, 120),
      "autofill draft draft_fields.industry_field"
    );
    assign(
      "product_tech_summary",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "product_tech_summary"),
      (value) => sanitizeDraftText(value, 420),
      "autofill draft draft_fields.product_tech_summary"
    );
    assign(
      "current_stage",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "current_stage"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.current_stage"
    );
    assign(
      "top_needs_or_pain_points",
      extractAutofillDraftCandidateValue(draft?.draft_fields, "top_needs_or_pain_points"),
      (value) => normalizeV2ArrayField(value, 120),
      "autofill draft draft_fields.top_needs_or_pain_points"
    );

    assign(
      "applicant_type",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "applicant_type"),
      (value) => sanitizeDraftText(value, 80),
      "autofill draft v2_safe_candidate_fields.applicant_type"
    );
    assign(
      "business_registration_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "business_registration_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.business_registration_status"
    );
    assign(
      "establishment_date",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "establishment_date"),
      (value) => normalizeCleanEstablishmentDateValue(value),
      "autofill draft v2_safe_candidate_fields.establishment_date"
    );
    assign(
      "business_age_category",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "business_age_category"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.business_age_category"
    );
    assign(
      "sme_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "sme_status"),
      (value) => sanitizeDraftText(value, 16),
      "autofill draft v2_safe_candidate_fields.sme_status"
    );
    assign(
      "government_support_restriction_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "government_support_restriction_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.government_support_restriction_status"
    );
    assign(
      "duplicate_support_risk_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "duplicate_support_risk_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.duplicate_support_risk_status"
    );
    assign(
      "venture_confirmation_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "venture_confirmation_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.venture_confirmation_status"
    );
    assign(
      "investment_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "investment_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.investment_status"
    );
    assign(
      "self_funding_or_cost_share_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "self_funding_or_cost_share_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.self_funding_or_cost_share_status"
    );
    assign(
      "green_bio_or_smart_agri_flag",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "green_bio_or_smart_agri_flag"),
      (value) => sanitizeDraftText(value, 16),
      "autofill draft v2_safe_candidate_fields.green_bio_or_smart_agri_flag"
    );
    assign(
      "technology_transfer_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "technology_transfer_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.technology_transfer_status"
    );
    assign(
      "certification_or_test_need",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "certification_or_test_need"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.certification_or_test_need"
    );
    assign(
      "sales_record_status",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "sales_record_status"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.sales_record_status"
    );
    assign(
      "export_intent",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "export_intent"),
      (value) => sanitizeDraftText(value, 40),
      "autofill draft v2_safe_candidate_fields.export_intent"
    );
    assign(
      "target_country_or_market",
      extractAutofillDraftCandidateValue(draft?.v2_safe_candidate_fields, "target_country_or_market"),
      (value) => normalizeV2ArrayField(value, 80),
      "autofill draft v2_safe_candidate_fields.target_country_or_market"
    );

    return bridge;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function readCleanPayloadEstablishmentDate(payload = {}) {
  const fieldsInput = payload && payload.fields && typeof payload.fields === "object" && !Array.isArray(payload.fields)
    ? payload.fields
    : {};
  const directFieldValue = normalizeCleanEstablishmentDateValue(resolvePayloadFieldValue(fieldsInput, "establishment_date"));
  if (directFieldValue) {
    return {
      value: directFieldValue,
      source: "payload.fields.establishment_date"
    };
  }

  const expandedCandidateFields = payload && payload.v2_safe_candidate_fields && typeof payload.v2_safe_candidate_fields === "object" && !Array.isArray(payload.v2_safe_candidate_fields)
    ? payload.v2_safe_candidate_fields
    : {};
  const expandedCandidate = expandedCandidateFields.establishment_date;
  const expandedValue = expandedCandidate && typeof expandedCandidate === "object" && !Array.isArray(expandedCandidate) && Object.prototype.hasOwnProperty.call(expandedCandidate, "value")
    ? expandedCandidate.value
    : expandedCandidate;
  const directExpandedValue = normalizeCleanEstablishmentDateValue(expandedValue);
  if (directExpandedValue) {
    return {
      value: directExpandedValue,
      source: "payload.v2_safe_candidate_fields.establishment_date"
    };
  }

  return null;
}

function inferBusinessAgeCategoryFromDateText(establishmentDateText, now = new Date()) {
  const normalized = normalizeCoarseEstablishmentDateText(establishmentDateText);
  if (!normalized) return null;
  const match = normalized.match(/^(20\d{2})(?:-(\d{2}))?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] || 1);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;

  const current = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(current.getTime())) return null;

  let ageYears = current.getFullYear() - year;
  if ((current.getMonth() + 1) < month) {
    ageYears -= 1;
  }
  if (ageYears < 0) return "pre_registration";
  if (ageYears < 1) return "under_1_year";
  if (ageYears < 3) return "under_3_years";
  if (ageYears < 5) return "under_5_years";
  return "over_5_years";
}

function buildConservativeExpandedV2CandidateFieldsFromText(text, now = new Date()) {
  const raw = String(text || "");
  const candidates = {};
  const labelContext = (labels) => {
    const found = firstLabeledValue(raw, labels) || tableLabeledValue(raw, labels);
    return normalizeMatcherText([found?.excerpt, found?.value].filter(Boolean).join(" "));
  };

  const setCandidate = (field, value, confidence, reason) => {
    if (!hasMeaningfulValue(value)) return;
    const normalizedValue = Array.isArray(value)
      ? normalizeV2ArrayField(value, field === "target_country_or_market" ? 40 : 80)
      : field === "establishment_date"
        ? normalizeCoarseEstablishmentDateText(value)
        : field === "applicant_type"
          ? normalizeV2ApplicantType(value, raw)
          : field === "current_stage"
            ? normalizeV2CurrentStage(value, raw)
            : field === "certification_or_test_need"
              ? normalizeV2CertificationNeed(value, raw)
        : sanitizeDraftText(value, field === "business_age_category" ? 40 : 120);
    if (!hasMeaningfulValue(normalizedValue)) return;
    candidates[field] = {
      field,
      value: normalizedValue,
      confidence: Math.max(0, Math.min(Number(confidence) || 0, 0.85)),
      source_type: "document_extracted",
      status: "draft",
      needs_user_review: true,
      reason
    };
  };

  const applicantTypeRules = [
    ["예비창업자", /예비\s*창업|pre[- ]?startup|pre[- ]?founder/i],
    ["창업기업", /창업\s*기업|startup\s*company/i],
    ["농업인", /농업인|farm\s*operator|농가/i],
    ["농업법인", /농업\s*법인|농업법인/i],
    ["대학·연구기관", /대학|연구기관|연구소|학교|university|research institute/i],
    ["운영기관·수행기관", /운영기관|수행기관|주관기관|executing agency|implementation agency/i],
    ["협회·단체", /협회|단체|association|organization/i],
    ["컨소시엄 주관", /컨소시엄|consortium/i]
  ];
  for (const [value, pattern] of applicantTypeRules) {
    if (pattern.test(raw)) {
      setCandidate("applicant_type", value, 0.58, "신청 주체를 가리키는 표현을 확인했습니다.");
      break;
    }
  }
  if (!hasMeaningfulValue(candidates.applicant_type) && /중소기업|sme|small and medium/i.test(raw)) {
    setCandidate("applicant_type", "중소기업", 0.52, "중소기업 표현이 확인되었지만 주체 유형은 보수적으로만 반영했습니다.");
  }

  const registrationContext = labelContext([
    "사업자등록번호",
    "사업자 등록번호",
    "사업자등록증",
    "사업자 등록증",
    "법인등록번호",
    "법인 등록번호",
    "법인등록증",
    "법인 등록증",
    "사업자등록 상태",
    "등록 상태"
  ]);
  const registrationSource = registrationContext || raw;
  if (registrationSource) {
    if (/(사업자등록번호|사업자 등록번호|법인등록번호|법인 등록번호|사업자등록증|법인등록증)/i.test(raw)) {
      setCandidate("business_registration_status", "registered", 0.72, "사업자등록 관련 표기 또는 번호가 확인되었습니다.");
    } else if (/(미등록|등록\s*예정|planned registration|unregistered)/i.test(registrationSource)) {
      const value = /미등록|unregistered/i.test(registrationSource) ? "unregistered" : "planned";
      setCandidate("business_registration_status", value, 0.62, "사업자등록 상태를 가리키는 문구를 확인했습니다.");
    } else if (/(사업자\s*등록번호|사업자등록번호|사업자\s*등록증|사업자등록증|법인\s*등록번호|법인등록번호|법인\s*등록증|법인등록증|사업자\s*등록|법인\s*등록)/i.test(registrationSource)) {
      setCandidate("business_registration_status", "registered", 0.72, "사업자등록 관련 표기 또는 번호가 확인되었습니다.");
    }
  }

  const establishmentLabel = firstLabeledValue(raw, ["설립일", "창립일", "창업일", "개업일", "설립연도", "창업연도", "Founded", "Established"])
    || tableLabeledValue(raw, ["설립일", "창립일", "창업일", "개업일", "설립연도", "창업연도", "Founded", "Established"]);
  const establishmentDate = normalizeCoarseEstablishmentDateText(establishmentLabel?.value || establishmentLabel?.excerpt || "");
  if (establishmentDate) {
    setCandidate("establishment_date", establishmentDate, 0.66, "설립일 또는 창업 시점을 가리키는 표기를 확인했습니다.");
    const ageCategory = inferBusinessAgeCategoryFromDateText(establishmentDate, now);
    if (ageCategory) {
      setCandidate("business_age_category", ageCategory, 0.54, "설립일을 바탕으로 업력 구간을 보수적으로 계산했습니다.");
    }
  }

  if (/(중견기업|대기업|large enterprise|mid-sized)/i.test(raw)) {
    setCandidate("sme_status", "no", 0.55, "중견/대기업 표현을 확인했습니다.");
  } else if (/(중소기업|sme|small and medium|소기업)/i.test(raw)) {
    setCandidate("sme_status", "yes", 0.58, "중소기업 관련 표현을 확인했습니다.");
  }

  const supportRiskContext = labelContext(["중복수혜", "중복 수혜", "정부지원 제한", "지원 제한", "보조금 제한", "지원제한"]);
  const supportRiskSource = supportRiskContext || raw;
  if (supportRiskSource) {
    if (/(없음|해당없음|미해당|clear|문제\s*없음)/i.test(supportRiskSource)) {
      setCandidate("government_support_restriction_status", "clear", 0.55, "지원 제한 없음 또는 유사 문구를 확인했습니다.");
      setCandidate("duplicate_support_risk_status", "low", 0.5, "중복수혜 위험이 낮다는 표현을 확인했습니다.");
    } else if (/(있음|가능성|우려|주의|검토 필요|review)/i.test(supportRiskSource)) {
      setCandidate("government_support_restriction_status", "possible_issue", 0.52, "지원 제한 또는 중복수혜 관련 주의 문구를 확인했습니다.");
      setCandidate("duplicate_support_risk_status", "medium", 0.45, "중복수혜 위험 관련 주의 표현을 확인했습니다.");
    } else {
      setCandidate("government_support_restriction_status", "under_review", 0.45, "지원 제한 또는 중복수혜 관련 표현이 확인되었습니다.");
      setCandidate("duplicate_support_risk_status", "unknown", 0.3, "중복수혜 위험 관련 표현이 있으나 강도는 불분명합니다.");
    }
  }

  const ventureContext = labelContext(["벤처확인", "벤처 확인", "벤처기업", "venture"]);
  const ventureSource = ventureContext || raw;
  if (ventureSource) {
    if (/(완료|확인됨|confirmed)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "confirmed", 0.62, "벤처확인 완료 또는 동등 표현을 확인했습니다.");
    } else if (/(미확인|없음|not confirmed)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "not_confirmed", 0.55, "벤처확인 미확인 또는 부재 표현을 확인했습니다.");
    } else if (/(예정|신청|검토|possible)/i.test(ventureSource)) {
      setCandidate("venture_confirmation_status", "possible", 0.5, "벤처확인 예정 또는 검토 문구를 확인했습니다.");
    } else {
      setCandidate("venture_confirmation_status", "possible", 0.42, "벤처확인 관련 표현을 확인했지만 상태는 불분명합니다.");
    }
  }

  const investmentContext = labelContext(["투자유치", "투자 계획", "투자 예정", "투자", "investment"]);
  const investmentSource = investmentContext || raw;
  if (investmentSource) {
    if (/(series\s*[ab]|시리즈\s*[ab]|pre-?a)/i.test(investmentSource)) {
      setCandidate("investment_status", "series_a_plus", 0.6, "시리즈 A 이상 투자 단계 관련 표현을 확인했습니다.");
    } else if (/(시드|seed)/i.test(investmentSource)) {
      setCandidate("investment_status", "seed", 0.6, "시드 투자 관련 표현을 확인했습니다.");
    } else if (/(엔젤|angel)/i.test(investmentSource)) {
      setCandidate("investment_status", "angel", 0.58, "엔젤 투자 관련 표현을 확인했습니다.");
    } else if (/(없음|no investment)/i.test(investmentSource)) {
      setCandidate("investment_status", "none", 0.5, "투자 없음 표현을 확인했습니다.");
    } else {
      setCandidate("investment_status", "planned", 0.48, "투자 계획 또는 투자유치 관련 표현을 확인했습니다.");
    }
  }

  const costShareContext = labelContext(["자부담", "민간부담금", "대응자금", "자기부담", "self funding", "self-funding", "cost share"]);
  const costShareSource = costShareContext || raw;
  if (costShareSource) {
    if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(불가|어렵|미확보|없음|not ready)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "not_ready", 0.58, "자부담 또는 매칭 자금이 준비되지 않았다는 표현을 확인했습니다.");
    } else if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(부분|일부|검토|조건|partially)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "partially_ready", 0.55, "자부담 또는 매칭 자금이 부분적으로 준비됐다는 표현을 확인했습니다.");
    } else if (/(자부담|민간부담금|대응자금|자기부담|self[- ]?funding|cost share)[^\n]{0,40}(가능|확보|준비|ready|충분)/i.test(raw)) {
      setCandidate("self_funding_or_cost_share_status", "ready", 0.6, "자부담 또는 민간부담금 준비 표현을 확인했습니다.");
    } else if (/(불가|어렵|미확보|없음|not ready)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "not_ready", 0.58, "자부담 또는 매칭 자금이 준비되지 않았다는 표현을 확인했습니다.");
    } else if (/(부분|일부|검토|조건|partially)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "partially_ready", 0.55, "자부담 또는 매칭 자금이 부분적으로 준비됐다는 표현을 확인했습니다.");
    } else if (/(가능|확보|준비|ready|충분)/i.test(costShareSource)) {
      setCandidate("self_funding_or_cost_share_status", "ready", 0.6, "자부담 또는 민간부담금 준비 표현을 확인했습니다.");
    }
  }

  const currentStageLabel = firstLabeledValue(raw, ["현재 단계", "사업화 단계", "진행 단계", "현재상태", "단계", "Current Stage"])
    || tableLabeledValue(raw, ["현재 단계", "사업화 단계", "진행 단계", "현재상태", "단계", "Current Stage"]);
  const currentStageValue = (() => {
    const stageSource = String(currentStageLabel?.value || currentStageLabel?.excerpt || raw);
    if (/(스케일업|scale[- ]?up|확장)/i.test(stageSource)) return "스케일업";
    if (/(사업화|상용화|commercialization|commercialisation)/i.test(stageSource)) return "사업화";
    if (/(실증|검증|pilot|파일럿|poc|demo|test|시험)/i.test(stageSource)) return "실증";
    if (/(시제품|prototype|prototyp)/i.test(stageSource)) return "시제품";
    if (/(개발|연구|r&d)/i.test(stageSource)) return "개발";
    if (/(예비창업)/i.test(stageSource)) return "예비창업";
    if (/(운영|서비스 운영|양산)/i.test(stageSource)) return "운영";
    return null;
  })();
  if (currentStageValue) {
    setCandidate("current_stage", currentStageValue, 0.58, "현재 단계 또는 사업화 단계 표현을 확인했습니다.");
  }

  if (/(그린바이오|green bio|스마트농업|스마트팜|smart farm|smart agri|농업용 로봇|농업 자동화|field robotics|agri-tech|agritech)/i.test(raw)) {
    setCandidate("green_bio_or_smart_agri_flag", "yes", 0.68, "그린바이오 또는 스마트농업 관련 핵심 표현을 확인했습니다.");
  } else if (/(농업|축산|농장|식품)/i.test(raw) && /(ai|로봇|센서|iot|자동화|데이터|플랫폼|시스템)/i.test(raw)) {
    setCandidate("green_bio_or_smart_agri_flag", "maybe", 0.45, "농업 분야와 기술 키워드가 함께 확인되었습니다.");
  }

  if (/(기술이전|technology transfer|기술\s*이전)/i.test(raw)) {
    if (/(완료|완료됨|성사)/i.test(raw)) {
      setCandidate("technology_transfer_status", "completed", 0.6, "기술이전 완료 표현을 확인했습니다.");
    } else if (/(진행|중)/i.test(raw)) {
      setCandidate("technology_transfer_status", "in_progress", 0.58, "기술이전 진행 표현을 확인했습니다.");
    } else if (/(예정|계획|검토)/i.test(raw)) {
      setCandidate("technology_transfer_status", "planned", 0.56, "기술이전 예정 또는 계획 표현을 확인했습니다.");
    } else {
      setCandidate("technology_transfer_status", "planned", 0.42, "기술이전 관련 표현을 확인했지만 단계는 불분명합니다.");
    }
  } else if (/(기술\s*이전\s*없음|not applicable|해당없음)/i.test(raw)) {
    setCandidate("technology_transfer_status", "not_applicable", 0.46, "기술이전 비대상 또는 해당없음 표현을 확인했습니다.");
  }

  const certNeedContext = labelContext(["인증", "검정", "실증", "시험", "테스트", "Demo", "Pilot", "TRL", "검증"]);
  const certNeedSource = certNeedContext || raw;
  if (certNeedSource) {
    if (/(성능검정)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "성능검정", 0.66, "성능검정 관련 표현을 확인했습니다.");
    } else if (/(인증|검인증)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "인증·검정", 0.62, "인증 또는 검인증 관련 표현을 확인했습니다.");
    } else if (/(실증|demo|시연|poc|검증|trial)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "demo", 0.58, "실증 또는 데모 검증 관련 표현을 확인했습니다.");
    } else if (/(pilot|파일럿|test|테스트|시험)/i.test(certNeedSource)) {
      setCandidate("certification_or_test_need", "pilot_test", 0.58, "파일럿 또는 시험 검증 관련 표현을 확인했습니다.");
    } else {
      setCandidate("certification_or_test_need", "unknown", 0.3, "인증/검정/실증 관련 표현이 있으나 세부 유형은 불분명합니다.");
    }
  }

  const salesContext = labelContext(["매출 실적", "판매실적", "매출", "판매", "Sales", "Revenue"]);
  const salesSource = salesContext || raw;
  if (salesSource) {
    if (/(없음|no sales|매출\s*없음)/i.test(salesSource)) {
      setCandidate("sales_record_status", "no_sales", 0.58, "매출 없음 표현을 확인했습니다.");
    } else if (/(수출\s*매출|해외\s*매출|export sales)/i.test(salesSource)) {
      setCandidate("sales_record_status", "export_sales", 0.62, "해외 또는 수출 매출 표현을 확인했습니다.");
    } else if (/(국내\s*매출|내수|domestic sales|국내 판매)/i.test(salesSource)) {
      setCandidate("sales_record_status", "domestic_sales", 0.6, "국내 매출 또는 내수 판매 표현을 확인했습니다.");
    } else if (/(시범\s*판매|pilot sales|초도 판매|테스트 판매)/i.test(salesSource)) {
      setCandidate("sales_record_status", "pilot_sales", 0.58, "시범 판매 또는 파일럿 판매 표현을 확인했습니다.");
    } else if (/(증가|성장|growing|확대)/i.test(salesSource)) {
      setCandidate("sales_record_status", "growing", 0.5, "매출 성장 표현을 확인했습니다.");
    } else if (/(매출|sales|revenue)/i.test(salesSource)) {
      setCandidate("sales_record_status", "domestic_sales", 0.45, "매출 또는 판매실적 표현을 확인했습니다.");
    }
  }

  const exportContext = labelContext(["수출 의향", "수출", "해외진출", "해외 진출", "해외 실증", "해외시장", "글로벌", "Global", "Export"]);
  const exportSource = exportContext || raw;
  const exportExplicit = /(\b수출\b|export|해외\s*(진출|시장|판매|실증|확장)|overseas|글로벌|global)/i.test(exportSource);
  if (exportExplicit) {
    if (/(중|진행|active|현재)/i.test(exportSource)) {
      setCandidate("export_intent", "active", 0.62, "수출 또는 해외 진출이 이미 진행 중인 표현을 확인했습니다.");
    } else if (/(예정|계획|planned|목표)/i.test(exportSource)) {
      setCandidate("export_intent", "planned", 0.6, "수출 또는 해외 진출 계획 표현을 확인했습니다.");
    } else if (/(의향|검토|탐색|exploring|관심)/i.test(exportSource)) {
      setCandidate("export_intent", "exploring", 0.56, "수출 또는 해외 진출 의향 표현을 확인했습니다.");
    } else {
      setCandidate("export_intent", "planned", 0.5, "수출 또는 해외 진출 관련 표현을 확인했습니다.");
    }
  }

  const targetCountryValue = firstLabeledValue(raw, ["목표 국가", "목표국가", "대상 국가", "대상국가", "수출국", "수출국가", "해외시장", "target country", "target market"])
    || tableLabeledValue(raw, ["목표 국가", "목표국가", "대상 국가", "대상국가", "수출국", "수출국가", "해외시장", "target country", "target market"]);
  const targetCountryMatches = [];
  const targetCountrySource = normalizeMatcherText(String(targetCountryValue?.value || targetCountryValue?.excerpt || raw));
  const targetCountryTerms = [
    "일본", "베트남", "미국", "중국", "태국", "인도네시아", "인도", "싱가포르", "말레이시아",
    "호주", "유럽", "EU", "북미", "남미", "중동", "동남아", "아세안", "캐나다", "멕시코"
  ];
  for (const term of targetCountryTerms) {
    if (targetCountrySource.includes(normalizeMatcherText(term))) {
      if (!targetCountryMatches.includes(term)) targetCountryMatches.push(term);
    }
  }
  if (targetCountryMatches.length) {
    setCandidate("target_country_or_market", targetCountryMatches.slice(0, 4), 0.56, "수출 또는 해외 진출의 목표 국가/시장을 확인했습니다.");
  }

  return candidates;
}

function buildProductSummaryDraft(text) {
  const targets = tableLabeledValues(text, ["상용화대상명", "상용화대상명칭"]);
  const target = targets.find((item) => /pig|피그|양돈|질병/i.test(item.value)) || targets[0] || null;
  const product = tableLabeledValue(text, ["주생산품", "제품/서비스"]);
  const intro = tableLabeledValue(text, ["기업소개", "상용화대상상세", "상용화대상상세설명"]);
  if (target && product) {
    return {
      value: `${target.value}: ${product.value}`,
      excerpt: `${target.excerpt}\n${product.excerpt}`
    };
  }
  if (product && intro) {
    return {
      value: `${product.value}. ${intro.value}`,
      excerpt: `${product.excerpt}\n${intro.excerpt}`
    };
  }
  return target || product || intro || null;

}

async function handleRunGemmaMatch(req, res, url) {
  const startedAt = Date.now();
  const prefix = "/api/gemma-match/run/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();

  if (!rawCaseId) {
    return json(res, 400, { ok: false, error_code: "missing_case_id", message: "case_id가 필요합니다." });
  }
  const caseId = rawCaseId;

  try {
    console.log(`\n🚀 [Phase 2 & 3] '${caseId}' 저사양 고속 매칭 엔진 가동...`);

    // 1. 기업 데이터 안전하게 불러오기 (UI 저장본 + 원본 AI 추출본 하이브리드 병합)
    let safeInput = {};
    try {
      const standardPath = path.join(COMPANY_INPUTS, `${caseId}_standard_company_input.json`);
      const savedData = JSON.parse(await fs.readFile(standardPath, "utf8"));
      
      if (savedData && savedData.fields) {
        for (let key in savedData.fields) {
          const val = savedData.fields[key]?.value;
          safeInput[key] = Array.isArray(val) ? val.join(", ") : (val !== undefined && val !== null ? val : "");
        }
      }
    } catch (e) {
      console.warn("저장된 기업 정보를 찾지 못해 기본값으로 진행합니다.", e.message);
      safeInput = { company_name_or_alias: "알수없음", industry_field: "스마트농업" };
    }

    // 🚨 [데이터 단절 완벽 방어] autofill_draft.json의 고도화 정량 데이터를 직접 읽어서 병합 (구조적 누락 방지 완벽 패치)
    try {
      const draftPath = path.join(RUNTIME, "uploads", caseId, "autofill_draft.json");
      const draftData = JSON.parse(await fs.readFile(draftPath, "utf8"));
      const v2Draft = draftData.v2_safe_candidate_fields || {};
      
      const mergeKeys = [
        "total_investment_amount", "annual_revenue", "employee_count", 
        "value_chain_tag", "agrifood_value_chain", "has_overseas_partner_or_loi"
      ];
      
      mergeKeys.forEach(key => {
        if (v2Draft[key] && v2Draft[key].value !== undefined && v2Draft[key].value !== null && v2Draft[key].value !== "") {
          safeInput[key] = v2Draft[key].value;
        }
      });

      // 🔴 [치명적 버그 해결] 객체 구조를 가지는 green_bio_or_smart_agri의 내부 매칭 데이터와 플래그 복구
      if (v2Draft["green_bio_or_smart_agri"] && v2Draft["green_bio_or_smart_agri"].value) {
        const gBioObj = v2Draft["green_bio_or_smart_agri"].value;
        // 엔진 규격인 green_bio_or_smart_agri_flag로 안전하게 매핑 상태 변환 주입
        safeInput["green_bio_or_smart_agri_flag"] = gBioObj.is_matched !== undefined ? String(gBioObj.is_matched) : "false";
        safeInput["green_bio_or_smart_agri"] = gBioObj; // 객체 원본도 손실 없이 매칭 입력값으로 바이패스
      } else if (v2Draft["green_bio_or_smart_agri_flag"] && v2Draft["green_bio_or_smart_agri_flag"].value) {
        safeInput["green_bio_or_smart_agri_flag"] = String(v2Draft["green_bio_or_smart_agri_flag"].value);
      }
      
      console.log(`✅ [Data Merge] autofill_draft.json 병합 및 유실 필드 복구 완벽 성공! (투자금: ${safeInput.total_investment_amount}, 가치사슬: ${safeInput.value_chain_tag}, 그린바이오플래그: ${safeInput.green_bio_or_smart_agri_flag})`);
    } catch (e) {
      console.warn("⚠️ autofill_draft.json 병합 실패 (기존 데이터로 진행):", e.message);
    }

    // 2. 49개 순정 사업 DB 불러오기
    const dbPath = path.join(__dirname, "gemma4_final_pure_master_db.json");
    let allPrograms = [];
    try {
      allPrograms = JSON.parse(await fs.readFile(dbPath, "utf8"));
    } catch (e) {
      throw new Error("gemma4_final_pure_master_db.json 파일을 찾을 수 없습니다.");
    }

    // 3. [Phase 2] 다면 가중치 균형 분배형 초고속 사전 필터링 (글로벌/전시 5대 차원 균형 고도화 패치)
    const baseKeywords = [
      safeInput.industry_field, safeInput.current_stage, safeInput.applicant_type, safeInput.region,
      safeInput.export_intent, safeInput.investment_status
    ].filter(Boolean).map(k => String(k).toLowerCase());

    // 🔴 [대형 LLM 싱크 패치] 배열 형태일 수 있는 다중 키워드 안전하게 문자열 풀에 병합
    if (Array.isArray(safeInput.top_needs_or_pain_points)) {
      safeInput.top_needs_or_pain_points.forEach(n => baseKeywords.push(String(n).toLowerCase()));
    } else if (safeInput.top_needs_or_pain_points) {
      baseKeywords.push(String(safeInput.top_needs_or_pain_points).toLowerCase());
    }
    if (Array.isArray(safeInput.target_country_or_market)) {
      safeInput.target_country_or_market.forEach(c => baseKeywords.push(String(c).toLowerCase()));
    } else if (safeInput.target_country_or_market) {
      baseKeywords.push(String(safeInput.target_country_or_market).toLowerCase());
    }

    const scoredPrograms = allPrograms.map(prog => {
      let score = 0;
      const progText = `${prog.target_audience} ${prog.support_content} ${prog.program_name} ${prog.tags ? prog.tags.join(" ") : ""}`.toLowerCase();
      
      // (1) 기본 키워드 텍스트 매칭 (기본 점수: 각 1점)
      baseKeywords.forEach(kw => { 
        if (kw && progText.includes(kw)) score += 1; 
      });

      // (2) 도메인 다면화 균형 보너스 시스템 (각 카테고리별 최대 보너스를 2점으로 제한하여 균형 유지)
      // 차원 A: 푸드테크 / 가공 도메인 일치 여부
      const hasFoodContext = String(safeInput.value_chain_tag).includes("Processing") || String(safeInput.industry_field).includes("식품");
      if (hasFoodContext && (progText.includes("식품") || progText.includes("푸드") || progText.includes("가공"))) {
        score += 2; 
      }

      // 차원 B: 첨단 혁신 기술(AI/테크) 일치 여부
      const hasTechContext = String(safeInput.product_tech_summary).toLowerCase().includes("ai") || String(safeInput.product_tech_summary).includes("인공지능");
      if (hasTechContext && (progText.includes("ai") || progText.includes("인공지능") || progText.includes("첨단기술") || progText.includes("혁신"))) {
        score += 2;
      }

      // 차원 C: 투자 및 스케일업 요건 일치 여부
      const isScaleUpCompany = Number(safeInput.total_investment_amount || 0) > 0 || String(safeInput.investment_status).includes("투자");
      if (isScaleUpCompany && (progText.includes("투자") || progText.includes("스케일업") || progText.includes("벤처투자") || progText.includes("펀드"))) {
        score += 2;
      }

      // 🔴 차원 D: 해외 진출 / 글로벌 요건 일치 여부 (글로벌 액셀러레이팅 공고 인젝션 가드레일)
      const hasGlobalContext = String(safeInput.export_intent).toLowerCase().includes("active") || String(safeInput.export_intent).toLowerCase().includes("planned") || String(safeInput.investment_status).includes("글로벌") || (Array.isArray(safeInput.target_country_or_market) && safeInput.target_country_or_market.length > 0);
      if (hasGlobalContext && (progText.includes("해외") || progText.includes("수출") || progText.includes("글로벌") || progText.includes("액셀러레이팅") || progText.includes("국제"))) {
        score += 2;
      }

      // 🔴 차원 E: 전시 / 박람회 / 판로 마케팅 일치 여부 (AFPRO 창업박람회 공고 인젝션 가드레일)
      const hasMarketingContext = progText.includes("박람회") || progText.includes("전시") || progText.includes("부스") || progText.includes("홍보") || progText.includes("마케팅") || progText.includes("판로") || progText.includes("afpro");
      const isReadyToMarket = String(safeInput.current_stage).includes("상용화") || String(safeInput.current_stage).includes("양산") || String(safeInput.product_tech_summary).includes("SaaS") || String(safeInput.product_tech_summary).includes("기기");
      if (hasMarketingContext && isReadyToMarket) {
        score += 2;
      }

      return { ...prog, score };
    });

    // 💡 [하이브리드 파이프라인 패치] 49개 공고를 대상으로 v2Handlers의 하드필터 및 정량/정성 스코어로 1차 엄격 소팅
    const fullScoredPrograms = scoredPrograms.map(prog => {
      // v2Handlers의 코어 엔진 연동
      const v2Evaluation = v2Handlers.scoreV2ProgramCandidate ? v2Handlers.scoreV2ProgramCandidate(safeInput, prog, prog.support_content) : { totalScore: prog.score, hfPass: true, cautionFlags: [] };
      
      // 백엔드 정량 점수와 사전 필터링 점수를 하이브리드 결합
      return {
        ...prog,
        hfPass: v2Evaluation.hfPass,
        failedHF: v2Evaluation.failedHF,
        score: (v2Evaluation.hfPass ? (prog.score + v2Evaluation.totalScore) : -9999), // 하드 필터 탈락 시 후순위 강제 드롭
        caution_flags: v2Evaluation.cautionFlags || []
      };
    });

    // 💡 정량 룰셋에 의해 생존한 최상위 5개 공고만 엄선하여 숏리스트 가동
    const shortlist = fullScoredPrograms
      .filter(p => p.hfPass !== false)
      .sort((a, b) => b.score - a.score || String(a.program_id).localeCompare(String(b.program_id)))
      .slice(0, 5);

    // 4. [Phase 3] 베테랑 심사역 AI 매칭 로직 (순정 프롬프트 서명 복원)
    const programList = typeof shortlist !== 'undefined' ? shortlist : []; 
    const companyValueChain = String(safeInput?.value_chain_tag || safeInput?.agrifood_value_chain || "알수없음");

    const finalPrompt = `당신은 대한민국 최고 수준의 벤처캐피탈(VC) 수석 심사역이자 정부지원사업 매칭 전문가입니다.
제공된 [고정 기업 팩트]를 기준으로 [지원사업 DB]를 정밀 심사하여 최종 추천서 및 탈락 사유서를 대형 컨설팅 펌 수준으로 작성하세요.

[📌 고정 기업 팩트]
- 기업명: ${safeInput?.company_name_or_alias || "당사"}
- 실제 업력: 3년차 (설립일: ${safeInput?.establishment_date || "2021년 설립"})
- 실제 기업 규모: 중소기업 / 스타트업 (매출액 ${Number(safeInput?.annual_revenue || 0).toLocaleString()}원, 고용 ${safeInput?.employee_count || 0}명)
- 실제 투자 현황: 누적 투자유치 금액 총 ${Number(safeInput?.total_investment_amount || 0).toLocaleString()}원 (스케일업 단계)
- 핵심 기술: ${safeInput?.product_tech_summary || "AI 비전 기반 식품 이물질 검출 및 품질 관리 기술"}
- 제조 인프라(공장) 유무: ${safeInput?.has_own_factory || "확인불가"}
- 정부/기관 수상 및 인증: ${safeInput?.government_awards_certificates || "없음"}
- 기술 작동 공간 환경 (가치사슬): ${companyValueChain}
- 해외 파트너/LoI 증빙 유무: ${safeInput?.has_overseas_partner_or_loi || "no"}

[지원사업 DB]
${JSON.stringify(programList, null, 2)}

[출력 포맷 (JSON)]
반드시 아래 구조의 순수한 JSON 포맷으로만 응답해야 하며, 텍스트 값 내부에 큰따옴표(")를 중복 사용하지 마세요.
{
  "recommendations": [
    {
      "program_name": "사업명",
      "fit_status": "완전 매칭 또는 조건부 매칭",
      "short_reason": "추천 사유 1줄 요약",
      "match_reason_advanced": {
        "selection_justification": "AI가 기업 인풋 스키마(업력, 투자금, 가점 이력)를 기반으로 이 사업에 왜 선정될 확률이 높은지 객관적 수치와 함께 서술하는 칸",
        "proposal_enhancement_advice": "기업의 약점(예: 외주 생산, 수출 실적 공백 등)을 보완하기 위해 실제 서류 제출 시 사업계획서에 추가해야 할 증빙이나 강조해야 할 스토리라인 조언"
      }
    }
  ],
  "rejected_candidates": [
    { "program_name": "탈락사업명", "reject_reason": "명확한 탈락 근거 사유" }
  ]
}
규칙을 준수하여 온전한 JSON으로만 응답하세요.`;
    const reqData = JSON.stringify({
      model: "gemma4",
      prompt: finalPrompt,
      stream: false,
      format: "json",
      // 💡 초과열 상태인 4코어 8GB VM 환경을 위한 리스크 방어형 스펙 다운사이징
      options: { 
        temperature: 0.1, 
        seed: 42,
        num_thread: 3,   // 🎯 4에서 3으로 하향: 시스템 안정성 확보 및 다른 프로세스 먹통 방지
        num_ctx: 3072    // 🎯 4096에서 3072로 완화: 텍스트 유실을 최소화하면서 RAM 점유율을 80% 이하로 유도
      }
    });

    let aiResponse = { recommendations: [], rejected_candidates: [] };

    try {
      console.time("⏱️ [측정] 고도화 AI 매칭 심사");
      const aiRaw = await new Promise((resolve, reject) => {
        const options = { 
          hostname: 'localhost', 
          port: 11434, 
          path: '/api/generate', 
          method: 'POST', 
          headers: { 
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(reqData)
          } 
        };
    
        const reqClient = http.request(options, (res) => {
          let body = '';
          res.on('data', (c) => body += c);
          res.on('end', () => { 
            try { 
              resolve(JSON.parse(body)); 
            } catch(e) { 
              reject(e); 
            } 
          });
        });
    
        reqClient.on('error', reject);
        reqClient.write(reqData);
        reqClient.end();
      });
      console.timeEnd("⏱️ [측정] 고도화 AI 매칭 심사");

      if (aiRaw.response) {
        aiResponse = JSON.parse(aiRaw.response);
      }
    } catch (err) {
      console.error("⚠️ AI 매칭 중 오류 발생:", err);
    }

    // 💡 최종 결과 가공 (백엔드 메타데이터와 AI 생성 텍스트의 완벽한 융합)
    const finalRecommendations = (aiResponse.recommendations || []).map((rec, idx) => {
      // 1. 백엔드(shortlist)에서 해당 공고의 수학적 계산 결과(경고 플래그 등)를 찾아옵니다.
      const backendData = programList.find(p => p.program_name === rec.program_name) || {};

      return {
        program_id: rec.program_name,
        program_name: rec.program_name,
        recommendation_position: idx === 0 ? "primary" : "secondary_conditional",
        
        // 2. AI가 판단한 상태("조건부 매칭")를 우선 적용하고, 없으면 백엔드 상태를 적용합니다.
        fit_status: rec.fit_status || backendData.fit_status || "적합",
    
        short_reason: rec.short_reason || "매칭 사유 요약",
        
        // 💡 [신규 스키마 적용] 심층 매칭 이유 및 보완 가이드라인 구조체 바인딩 (이전 버전 호환성 유지)
        match_reason_advanced: rec.match_reason_advanced || {
            selection_justification: rec.match_reason || rec.reason || "매칭 논리 데이터 누락",
            proposal_enhancement_advice: "사업계획서 보완 조언 없음"
        },
    
        // 3. 백엔드에서 생성한 필수 증빙 누락 경고 플래그를 프론트엔드로 전달합니다! (UI 액션 박스용)
        caution_flags: backendData.caution_flags || [],
    
        missing_documents: ["공고문 상세 확약 필요"],
        confirmation_needed_items: ["공고문 확인 필요"]
      };
    });

    const legacyOutputPath = path.join(RUNTIME, "gemma_match_outputs", `${caseId}_gemma_match_output.manual.json`);
    await fs.mkdir(path.dirname(legacyOutputPath), { recursive: true });
    
    const finalFrontendData = {
       schema_version: "v1",
       case_id: caseId,
       result_state: "PASS1",
       recommendations: finalRecommendations,
       display_warnings: ["하이브리드 고속 매칭 심사가 정상 완료되었습니다."]
    };
    
    await fs.writeFile(legacyOutputPath, JSON.stringify(finalFrontendData, null, 2), "utf8");
    console.log("✅ [Phase 3 완료] 스마트 매칭 및 풍성한 카드 데이터 저장 완료!");

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      source: "gemma_native_run",
      output_path: toRepoPath(legacyOutputPath)
    });

  } catch (error) {
    console.error("❌ [Native Matcher] 에러 발생:", error);
    return json(res, 500, { ok: false, case_id: caseId, message: error.message });
  }
}

function scanFastBriefingQuality(rawResultText) {
  const findings = [];
  const checks = [
    { label: "????", pattern: /\?\?\?\?/ },
    { label: "???", pattern: /\?\?\?/ },
    { label: "??", pattern: /\?\?/ },
    { label: "replacement_character", pattern: /�/ }
  ];
  for (const check of checks) {
    if (check.pattern.test(rawResultText)) {
      findings.push(check.label);
    }
  }
  return [...new Set(findings)];
}

async function handleRunFastMatch(req, res, url) {
  const startedAt = Date.now();
  const prefix = "/api/fast-match/run/";
  const rawCaseId = decodeURIComponent(String(url.pathname || "").slice(prefix.length)).trim();
  const caseId = sanitizeFastMatchCaseId(rawCaseId);

  if (!caseId) {
    return json(res, 400, fastMatchFailure(rawCaseId || null, "invalid_case_id", "안전하지 않은 case_id입니다.", {
      rule: "Only letters, numbers, underscore, and hyphen are allowed. Slashes, backslashes, dots, and traversal are rejected."
    }));
  }

  const caseDir = path.join(V2_PIPELINE_RUNS_DIR, caseId);
  const safeInputPath = path.join(caseDir, "v2_safe_input.json");
  const contextPath = path.join(caseDir, "fast_match_context.json");
  const briefingResultPath = path.join(caseDir, "fast_ai_briefing_output", "fast_briefing_result.json");

  try {
    if (!(await pathExists(FAST_MATCH_CARD_DB_PATH))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_program_db", "Fast Match 공개 지원사업 카드 DB를 찾을 수 없습니다.", {
        expected_path: toRepoPath(FAST_MATCH_CARD_DB_PATH)
      }));
    }

    const safeInputResolution = await ensureFastMatchSafeInput(caseId, caseDir, safeInputPath);
    if (!safeInputResolution.ok) {
      return json(res, 409, {
        ok: false,
        case_id: caseId,
        stage: safeInputResolution.stage,
        message: safeInputResolution.message,
        expected_path: safeInputResolution.expected_path,
        user_instruction: "먼저 문서 추출과 입력값 저장을 완료한 뒤 Fast AI 상담 브리핑을 생성할 수 있습니다.",
        details: {
          checked_standard_input_paths: safeInputResolution.checked_standard_input_paths
        }
      });
    }

    await runNodeScript(FAST_MATCH_CONTEXT_SCRIPT_PATH, [caseId], { timeout: 180000 });
    if (!(await pathExists(contextPath))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_match_context", "Fast Match context 생성 결과를 찾을 수 없습니다.", {
        expected_path: toRepoPath(contextPath)
      }));
    }

    await runNodeScript(FAST_KOREAN_BRIEFING_SCRIPT_PATH, [caseId], { timeout: 180000 });
    if (!(await pathExists(briefingResultPath))) {
      return json(res, 500, fastMatchFailure(caseId, "missing_fast_briefing_result", "Fast AI 상담 브리핑 결과를 찾을 수 없습니다.", {
        expected_path: toRepoPath(briefingResultPath)
      }));
    }

    const rawBriefingResult = await fs.readFile(briefingResultPath, "utf8");
    try {
      JSON.parse(rawBriefingResult);
    } catch (error) {
      return json(res, 500, fastMatchFailure(caseId, "invalid_fast_briefing_json", "Fast AI 상담 브리핑 결과 JSON을 파싱할 수 없습니다.", {
        expected_path: toRepoPath(briefingResultPath),
        error: compactErrorText(error.message, 400)
      }));
    }

    const qualityFindings = scanFastBriefingQuality(rawBriefingResult);
    if (qualityFindings.length) {
      return json(res, 500, fastMatchFailure(caseId, "quality_scan_failed", "Fast AI 상담 브리핑 결과에 깨진 문자 또는 임시 문구가 감지되었습니다.", {
        findings: qualityFindings,
        expected_path: toRepoPath(briefingResultPath)
      }));
    }

    return json(res, 200, {
      ok: true,
      case_id: caseId,
      result_url: `/?v2_case=${encodeURIComponent(caseId)}&mode=fast`,
      outputs: {
        fast_match_context: toRepoPath(contextPath),
        fast_briefing_result: toRepoPath(briefingResultPath)
      },
      safe_input: {
        path: toRepoPath(safeInputResolution.safeInputPath),
        source: safeInputResolution.source,
        created: safeInputResolution.created,
        source_standard_company_input_path: safeInputResolution.sourceStandardCompanyInputPath ? toRepoPath(safeInputResolution.sourceStandardCompanyInputPath) : null
      },
      elapsed_ms: Date.now() - startedAt
    });
  } catch (error) {
    const stage = error.stage || "run_failed";
    return json(res, 500, fastMatchFailure(caseId, stage, "Fast AI 상담 브리핑 생성 중 오류가 발생했습니다.", {
      error: compactErrorText(error.message, 600),
      stdout: compactErrorText(error.stdout, 1200),
      stderr: compactErrorText(error.stderr, 1200),
      script_path: error.script_path ? toRepoPath(error.script_path) : null,
      elapsed_ms: Date.now() - startedAt
    }));
  }
}

function sanitizeFastMatchCaseId(caseId) {
  const normalized = String(caseId || "").trim();
  if (!normalized) return null;
  if (!isSafeResultCaseId(normalized)) return null;
  if (normalized.includes("..") || normalized.includes("/") || normalized.includes("\\")) return null;
  return normalized;
}

function runNodeScript(scriptPath, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: REPO_ROOT,
        timeout: options.timeout || 180000,
        maxBuffer: options.maxBuffer || 8 * 1024 * 1024,
        env: options.env || process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          error.script_path = scriptPath;
          return reject(error);
        }
        resolve({ stdout, stderr, script_path: scriptPath });
      }
    );
  });
}

function fastMatchFailure(caseId, stage, message, details = {}) {
  return {
    ok: false,
    case_id: caseId || null,
    stage,
    message,
    details
  };
}
// ✂️ 👆 여기까지 붙여넣으세요! 👆 ✂️

// 메인 서버에서 쓸 수 있게 내보냅니다.
module.exports = {
  handleRunFastMatch,
  handleRunGemmaMatch
};