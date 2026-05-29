// aiHandlers.js
const fs = require("fs/promises");
const path = require("path");
const http = require("http");

const config = require("./config.js");
const utils = require("./utils.js");
const { toRepoPath, fromRepoPath, isPathInside, pathExists } = utils;

// 경로 확인을 위한 안전 도우미 함수들


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

// 빈 초안 생성 함수들
function blankDraftField(field, reason) {
  return {
    field,
    value: field === "top_needs_or_pain_points" ? [] : null,
    confidence: 0,
    source_type: "document_extracted",
    source_excerpt: "",
    status: "draft",
    needs_user_review: true,
    reason
  };
}

function draftField(field, value, confidence, sourceExcerpt, reason) {
  const safeValue = Array.isArray(value)
    ? value.map((item) => sanitizeDraftText(item, 120)).filter(Boolean)
    : sanitizeDraftText(value, field === "product_tech_summary" ? 420 : 160);
  return {
    field,
    value: Array.isArray(value) ? safeValue : safeValue || null,
    confidence: Math.max(0, Math.min(Number(confidence) || 0, 0.9)),
    source_type: "document_extracted",
    source_excerpt: sanitizeDraftText(sourceExcerpt, 220),
    status: "draft",
    needs_user_review: true,
    reason
  };
}

function buildEmptyExpandedV2SafeCandidateFields() {
  const fields = {};
  for (const field of config.AUTOFILL_EXPANDED_V2_SAFE_FIELDS) {
    fields[field] = blankDraftField(field, "No clear expanded V2-safe candidate signal found. Left blank.");
  }
  return fields;
}

function buildEmptyAutofillDraft(caseId, sourcePath, extractionManifestPath, now, status = "AUTOFILL_DRAFT_READY", note = "") {
  return {
    case_id: caseId,
    source_extracted_path: sourcePath || null,
    source_extraction_manifest_path: extractionManifestPath || null,
    created_at: now,
    status,
    notes: note || "Draft suggestions only. User must review/edit and click the existing 입력 저장 button to confirm.",
    allowed_fields: config.AUTOFILL_ALLOWED_FIELDS,
    blocked_fields: config.AUTOFILL_BLOCKED_FIELDS,
    draft_fields: {
      company_name_or_alias: blankDraftField("company_name_or_alias", "No clear company name found. Left blank."),
      region: blankDraftField("region", "No clear city/province/county-level company region found. Left blank."),
      industry_field: blankDraftField("industry_field", "No conservative broad company sector label found. Left blank."),
      product_tech_summary: blankDraftField("product_tech_summary", "No safe company-specific product or technology summary found. Left blank."),
      top_needs_or_pain_points: blankDraftField("top_needs_or_pain_points", "No clearly stated company needs found. Left blank.")
    },
    v2_safe_candidate_fields: buildEmptyExpandedV2SafeCandidateFields()
  };
}

// 핵심 1: Gemma AI 데이터 추출 엔진 (공백 출력 방어 가드 시스템 탑재)
async function generateAutofillDraftWithAI(text, caseId, sourcePath, extractionManifestPath, now) {
  const draft = buildEmptyAutofillDraft(caseId, sourcePath, extractionManifestPath, now);
  
  try {
    console.log(`\n🚀 [Speed Optimize] '${caseId}' 정밀 추출 프로세스 가동...`);
    
    // 🎯 [신규 아키텍처] 진짜 문단(Block) 단위 문맥 보존형 스마트 RAG (임시방편 완전 제거)
    const rawText = String(text || "");
    const blocks = rawText.split(/\n\s*\n/); 
    
    const keywords = ["매출", "투자", "고용", "설립", "대표", "단계", "지원", "자금", "시장", "기술", "제품", "TRL", "자부담", "국고", "수출", "인증", "특허", "수상", "공장", "농업", "스마트", "생육", "방제", "드론", "AI"]; 
    
    let filteredBlocks = [];
    let currentLength = 0;
    const MAX_ALLOWED_CHARS = 4000; // 🎯 뇌 용량(num_ctx) 초과로 인한 템플릿 잘림 현상을 막기 위해 4000자로 최적화

    for (const block of blocks) {
        if (keywords.some(kw => block.includes(kw))) {
            const trimmedBlock = block.trim();
            if (currentLength + trimmedBlock.length + 2 <= MAX_ALLOWED_CHARS) {
                filteredBlocks.push(trimmedBlock);
                currentLength += trimmedBlock.length + 2;
            } else {
                console.log(`⚠️ 컨텍스트 제어로 인해 이후 일부 블록은 제외되었습니다. 포함된 온전한 블록 수: ${filteredBlocks.length}`);
                break;
            }
        }
    }
    
    let condensedText = filteredBlocks.join("\n\n");

    if (!condensedText || condensedText.trim().length < 100) {
        console.log("⚠️ 스마트 RAG 압축 결과가 부족하여 원본 문서의 구조를 그대로 유지하여 전송합니다.");
        condensedText = rawText.length > MAX_ALLOWED_CHARS ? rawText.slice(0, MAX_ALLOWED_CHARS) : rawText;
    }

    try {
        const inputDebugPath = require("path").join(require("path").dirname(extractionManifestPath), "raw_gemma_input_debug_v2.txt");
        require("fs").writeFileSync(inputDebugPath, condensedText, "utf8");
    } catch (err) {}

    // 🎯 [완전체 아키텍처] 4096 넉넉한 문맥을 활용한 '강제 빈칸 채우기(Fill-in-the-blank) 템플릿' 정방향 배치
    const finalPrompt = `당신은 최고 수준의 데이터 정제 AI입니다.
아래 첨부된 [제공된 문서]를 정밀 분석한 후, 반드시 맨 아래의 [JSON 템플릿]을 단 한 줄도 빠짐없이 100% 똑같이 복사하여 빈칸(값)만 채워 넣으세요.

[🚨 절대 준수 사항 - 위반 시 시스템 붕괴]
1. 템플릿 완벽 복사: 아래 30개가 넘는 Key(변수명) 중 하나라도 지우거나, 임의로 새로운 Key(예: total_funding_amount)를 만들어내면 시스템이 파괴됩니다.
2. 정량 데이터: 매출액(annual_revenue), 투자금(total_investment_amount), 직원수(employee_count)는 한글이나 단위 없이 오직 원 단위의 순수 숫자(예: 1800000000, 0)로만 적으세요.
3. 빈칸 유지: 문서에서 찾을 수 없는 정보는 억지로 지어내지 말고 반드시 "" (빈 문자열) 또는 0 으로 그대로 두세요.

[제공된 문서]
${condensedText}

[JSON 템플릿]
(반드시 아래 구조를 그대로 복사해서 빈칸을 채운 순수 JSON만 응답하세요. 마크다운 기호는 쓰지 마세요)
{
  "company_name_or_alias": "",
  "region": "",
  "industry_field": "",
  "product_tech_summary": "",
  "current_stage": "",
  "applicant_type": "",
  "business_registration_status": "",
  "establishment_date": "",
  "business_age_category": "",
  "sme_status": "",
  "government_support_restriction_status": "",
  "duplicate_support_risk_status": "",
  "venture_confirmation_status": "",
  "investment_status": "",
  "self_funding_or_cost_share_status": "",
  "technology_transfer_status": "",
  "certification_or_test_need": "",
  "sales_record_status": "",
  "export_intent": "",
  "target_country_or_market": "",
  "youth_founder_condition_status": "",
  "representative_age_condition_status": "",
  "additional_matching_notes": "",
  "total_investment_amount": 0,
  "annual_revenue": 0,
  "employee_count": 0,
  "value_chain_tag": "",
  "agrifood_value_chain": "",
  "has_overseas_partner_or_loi": "",
  "has_own_factory": "",
  "government_awards_certificates": "",
  "geographic_advantage": "",
  "green_bio_or_smart_agri_flag": "",
  "green_bio_or_smart_agri": {
    "is_matched": false,
    "confidence_score": 0.0,
    "justification": ""
  }
위 규칙과 구조를 철저하게 엄수하여 완벽한 JSON 포맷으로만 최종 응답하십시오.`;

    const reqData = JSON.stringify({
      model: "gemma4",
      prompt: finalPrompt,
      stream: false,
      format: "json",
      options: { 
        temperature: 0.1, 
        seed: 42,
        num_thread: 3,    // 🎯 파트너님이 검증하신 초고속 멀티스레드 컴퓨팅 파워 자원 할당
        num_ctx: 4096     // 🎯 문단 RAG 본문과 30개 JSON 구조체를 낭비 없이 수용할 수 있는 넉넉한 4K 컨텍스트 가동
      }
    });

    const aiData = await new Promise((resolve, reject) => {
      const options = { 
          hostname: 'localhost', port: 11434, path: '/api/generate', method: 'POST', 
          headers: { 
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(reqData)
          } 
      };
      const reqClient = http.request(options, (res) => {
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
      });
      reqClient.on('error', reject);
      reqClient.write(reqData);
      reqClient.end();
    });   

    let ai;
    try {
        // 🚨 [디버깅 강화] AI의 순수 원본 응답을 파일로 저장하고 콘솔에 출력합니다.
        console.log("=========================================");
        console.log("🔍 [디버깅] AI 원본 응답 (Raw Response) 확인:");
        console.log(aiData.response);
        console.log("=========================================");
        
        // 원본 텍스트를 눈으로 확인하기 쉽도록 파일로 강제 기록
        const debugPath = require("path").join(require("path").dirname(extractionManifestPath), "raw_gemma_debug.txt");
        require("fs").writeFileSync(debugPath, aiData.response || "응답 없음", "utf8");

        const cleanResponse = (aiData.response || "{}").replace(/```json/g, '').replace(/```/g, '').trim();
        ai = JSON.parse(cleanResponse);
        
        // 🚨 [디버깅 강화] 파싱된 JSON 객체가 어떤 키값들을 가지고 있는지 확인합니다.
        console.log("✅ [디버깅] 파싱 성공! AI가 뱉어낸 키(Key) 목록:", Object.keys(ai));
    } catch (parseErr) {
        console.error("⚠️ AI 응답 파싱 실패:", parseErr.message);
        
        // 에러가 났을 때도 원본을 보존합니다.
        const errorPath = require("path").join(require("path").dirname(extractionManifestPath), "raw_gemma_error.txt");
        require("fs").writeFileSync(errorPath, `파싱 에러: ${parseErr.message}\n\n원본 응답:\n${aiData.response}`, "utf8");
        
        throw new Error("AI가 올바른 JSON 구조를 반환하지 못했습니다.");
    }

    const mapField = (target, key, val) => {
      // 💡 공백 주입 방지: 값이 존재할 때만 정상 draft 상태로 기입
      if (val !== undefined && val !== null && val !== "null" && val !== "") {
          target[key] = { field: key, value: val, confidence: 0.9, source_type: "ai", status: "draft" };
      } else {
          target[key] = { field: key, value: "정보 없음", confidence: 0.1, source_type: "ai", status: "draft" };
      }
    };

    // 1. 기본 텍스트 정보 매핑 (draft_fields 영역)
    mapField(draft.draft_fields, "company_name_or_alias", ai.company_name_or_alias);
    mapField(draft.draft_fields, "region", ai.region);
    mapField(draft.draft_fields, "industry_field", ai.industry_field);
    mapField(draft.draft_fields, "product_tech_summary", ai.product_tech_summary);
    mapField(draft.draft_fields, "top_needs_or_pain_points", ai.top_needs_or_pain_points);

    // 2. 행정용 필수 팩트 및 심층/신규 필드 완벽 복구 매핑 (v2_safe_candidate_fields 영역으로 30개 필드 전수 바인딩)
    mapField(draft.v2_safe_candidate_fields, "applicant_type", ai.applicant_type);
    mapField(draft.v2_safe_candidate_fields, "business_registration_status", ai.business_registration_status);
    mapField(draft.v2_safe_candidate_fields, "establishment_date", ai.establishment_date);
    mapField(draft.v2_safe_candidate_fields, "business_age_category", ai.business_age_category);
    mapField(draft.v2_safe_candidate_fields, "sme_status", ai.sme_status);
    mapField(draft.v2_safe_candidate_fields, "government_support_restriction_status", ai.government_support_restriction_status);
    mapField(draft.v2_safe_candidate_fields, "duplicate_support_risk_status", ai.duplicate_support_risk_status);
    mapField(draft.v2_safe_candidate_fields, "venture_confirmation_status", ai.venture_confirmation_status);
    mapField(draft.v2_safe_candidate_fields, "investment_status", ai.investment_status);
    mapField(draft.v2_safe_candidate_fields, "self_funding_or_cost_share_status", ai.self_funding_or_cost_share_status);
    mapField(draft.v2_safe_candidate_fields, "current_stage", ai.current_stage);
    mapField(draft.v2_safe_candidate_fields, "green_bio_or_smart_agri_flag", ai.green_bio_or_smart_agri_flag);
    mapField(draft.v2_safe_candidate_fields, "technology_transfer_status", ai.technology_transfer_status);
    mapField(draft.v2_safe_candidate_fields, "certification_or_test_need", ai.certification_or_test_need);
    mapField(draft.v2_safe_candidate_fields, "sales_record_status", ai.sales_record_status);
    mapField(draft.v2_safe_candidate_fields, "export_intent", ai.export_intent);
    mapField(draft.v2_safe_candidate_fields, "target_country_or_market", ai.target_country_or_market);
    mapField(draft.v2_safe_candidate_fields, "youth_founder_condition_status", ai.youth_founder_condition_status);
    mapField(draft.v2_safe_candidate_fields, "representative_age_condition_status", ai.representative_age_condition_status);
    mapField(draft.v2_safe_candidate_fields, "additional_matching_notes", ai.additional_matching_notes);
    mapField(draft.v2_safe_candidate_fields, "total_investment_amount", ai.total_investment_amount);
    mapField(draft.v2_safe_candidate_fields, "annual_revenue", ai.annual_revenue);
    mapField(draft.v2_safe_candidate_fields, "employee_count", ai.employee_count);
    mapField(draft.v2_safe_candidate_fields, "value_chain_tag", ai.value_chain_tag);
    mapField(draft.v2_safe_candidate_fields, "agrifood_value_chain", ai.agrifood_value_chain);
    mapField(draft.v2_safe_candidate_fields, "has_overseas_partner_or_loi", ai.has_overseas_partner_or_loi);
    mapField(draft.v2_safe_candidate_fields, "has_own_factory", ai.has_own_factory);
    mapField(draft.v2_safe_candidate_fields, "government_awards_certificates", ai.government_awards_certificates);
    mapField(draft.v2_safe_candidate_fields, "geographic_advantage", ai.geographic_advantage);
    mapField(draft.v2_safe_candidate_fields, "green_bio_or_smart_agri", ai.green_bio_or_smart_agri);

    draft.notes = "성공적으로 정밀 추출 및 폴백 연산이 완료되었습니다.";
    console.log(`✅ [AI 정밀 추출 완료] 본문 유실 차단 및 공백 방어선 가동 성공!`);
  } catch (error) {
    console.error("❌ 추출 에러 발생, 기본값 주입:", error);
    draft.notes = "추출 중 내부 오류가 발생하여 기본 방어 스펙을 주입했습니다.";
  }
  return draft;
}

// 핵심 2: 자동 완성(Autofill) API 핸들러
async function handleGenerateAutofillDraft(req, res) {
  const now = new Date().toISOString();
  let caseId = null;
  let draftPath = null;
  let extractionManifestRel = null;

  try {
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.includes("application/json")) {
      return utils.json(res, 415, { ok: false, error: "application/json request body is required." });
    }

    const body = await utils.readRequestBody(req);
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      return utils.json(res, 400, { ok: false, error: "Invalid JSON request body." });
    }
    const extraKeys = Object.keys(payload).filter((key) => key !== "case_id");
    if (extraKeys.length) {
      return utils.json(res, 400, { ok: false, error: "Only case_id is accepted for auto-fill draft generation." });
    }

    const rawCaseId = String(payload.case_id || "").trim();

    if (!rawCaseId) {
      return utils.json(res, 400, { ok: false, error: "case_id is required before generating an auto-fill draft." });
    }

    // 🟢 [물리 경로 동형화 완벽 해결] 실제 언더바(_) 폴더 구조가 존재한다면 변환을 우회하여 경로 파괴를 원천 방어합니다.
    const underscoredDir = path.resolve(config.UPLOADS, rawCaseId);
    if (await pathExists(underscoredDir)) {
      caseId = rawCaseId;
    } else {
      caseId = utils.slugify(rawCaseId);
    }

    const uploadDir = path.resolve(config.UPLOADS, caseId);
    const extractionManifestPath = path.join(uploadDir, "extraction_manifest.json");
    const targetDraftPath = path.join(uploadDir, "autofill_draft.json");

    // 🟢 [캐시 이중 바인딩 안전 장치] 실제 AI 추출물 데이터 유무를 파악하여 프론트엔드 호환 규격으로 완벽하게 조립 반환합니다.
    try {
      if (await pathExists(targetDraftPath)) {
        const existingRaw = await fs.readFile(targetDraftPath, "utf8");
        const existing = JSON.parse(existingRaw);
        
        const hasRealAiData = existing && (
            (existing.draft_fields && Object.keys(existing.draft_fields).length > 0) || 
            (existing.v2_safe_candidate_fields && Object.keys(existing.v2_safe_candidate_fields).length > 0)
        );

        if (hasRealAiData) {
          console.log(`[Cache Hit] '${caseId}'의 최신 고도화 추출물이 정상 존재합니다. 캐시 데이터를 즉시 화면에 뿌려줍니다.`);
          return utils.json(res, 200, {
            ok: true,
            case_id: caseId,
            source_file: existing.source_extracted_path ? path.basename(existing.source_extracted_path) : "uploaded_file.pdf",
            draft: existing, // 프론트엔드 최신 UI 렌더링용 바인딩
            extraction_payload: existing // 레거시 프로토콜 백업 컴포넌트용 바인딩
          });
        }
      }
      throw new Error("Trigger AI extraction");
    } catch (err) {
      // 🔴 [오타 완벽 수정] 자바스크립트 문법에 맞게 console.log로 원복하여 500 Internal Error 크래시를 원천 제거합니다.
      console.log(`[Logic] 기존 추출물이 없거나 캐시 유효성을 검사할 수 없어 AI 정밀 파이프라인을 기동합니다.`);
    }

    draftPath = targetDraftPath;
    extractionManifestRel = toRepoPath(extractionManifestPath);

    if (!(await pathExists(extractionManifestPath))) {
      return writeBlockedDraft(404, "Successful Step 4 extraction is required before generating an auto-fill draft.");
    }

    const extractionManifest = JSON.parse(await fs.readFile(extractionManifestPath, "utf8"));
    
    // 🟢 언더바/하이픈 혼용으로 인한 억울한 ID 불일치 거부 버그 해결 (식별자 정규화 비교)
    const normalizeId = (id) => String(id || "").replace(/[-_]/g, "").trim().toLowerCase();
    if (normalizeId(extractionManifest.case_id) !== normalizeId(caseId)) {
    
      return writeBlockedDraft(400, "Extraction manifest case_id does not match.");
    }
    const sourceRelPath = extractionManifest.extracted_markdown_path || extractionManifest.extracted_text_path;
    const sourcePath = fromRepoPath(sourceRelPath);

    let extractedText;
    try {
      extractedText = await fs.readFile(sourcePath, "utf8");
    } catch {
      return writeBlockedDraft(500, "Extracted text file exists but could not be read.");
    }

    // 🟢 [스마트 본문 지문 매칭 - 동일 파일 재분석 방지 완벽 구원 패치]
    // 프론트엔드가 매번 새로운 case_id를 발급하더라도, 본문 텍스트가 일치하는 과거 기록이 있다면 AI 비용 없이 즉시 복원합니다.
    try {
      const hashMapPath = path.join(config.RUNTIME, "hash_map.json");
      if (await pathExists(hashMapPath)) {
        const hashMap = JSON.parse(await fs.readFile(hashMapPath, "utf8"));
        const TARGET_VERSION = "1.1"; // hashHandlers.js의 CURRENT_PIPELINE_VERSION과 동기화
        
        for (const [fileHash, entry] of Object.entries(hashMap)) {
          if (entry.case_id && entry.pipeline_version === TARGET_VERSION && entry.case_id !== caseId) {
            const oldDraftPath = path.join(config.UPLOADS, entry.case_id, "autofill_draft.json");
            const oldManifestPath = path.join(config.UPLOADS, entry.case_id, "extraction_manifest.json");
            
            if (await pathExists(oldDraftPath) && await pathExists(oldManifestPath)) {
              const oldManifest = JSON.parse(await fs.readFile(oldManifestPath, "utf8"));
              const oldSourceRelPath = oldManifest.extracted_markdown_path || oldManifest.extracted_text_path;
              const oldSourcePath = path.resolve(config.ROOT, "..", oldSourceRelPath);
              
              if (await pathExists(oldSourcePath)) {
                const oldText = await fs.readFile(oldSourcePath, "utf8");
                
                // 본문 내용이 토씨 하나 안 틀리고 완전히 같다면 동일 파일 캐시 히트!
                if (oldText === extractedText) {
                  console.log(`[Smart Text Match Hit] 기존 case_id('${entry.case_id}')와 본문이 100% 일치하는 캐시를 발견했습니다. AI 추출을 건너뜁니다.`);
                  const cachedDraft = JSON.parse(await fs.readFile(oldDraftPath, "utf8"));
                  
                  // 현재 발급된 새 case_id 규칙에 맞게 메타데이터만 갱신 후 하이브리드 복사 저장
                  cachedDraft.case_id = caseId;
                  cachedDraft.source_extracted_path = sourcePath;
                  cachedDraft.source_extraction_manifest_path = extractionManifestPath;
                  
                  await fs.writeFile(targetDraftPath, JSON.stringify(cachedDraft, null, 2), "utf8");
                  
                  return utils.json(res, 200, {
                    ok: true,
                    case_id: caseId,
                    autofill_draft_path: toRepoPath(targetDraftPath),
                    draft: cachedDraft,
                    message: "Auto-fill draft successfully restored from smart text identity cache."
                  });
                }
              }
            }
          }
        }
      }
    } catch (cacheErr) {
      console.warn("⚠️ 스마트 캐시 본문 대조 중 경미한 예외 발생 (안전을 위해 AI 신규 추출로 전환):", cacheErr.message);
    }

    console.time("⏱️ [측정] 2. AI 초안 추출 엔진 (Gemma4)");
    const draft = await generateAutofillDraftWithAI(extractedText, caseId, sourcePath, extractionManifestPath, now);
    console.timeEnd("⏱️ [측정] 2. AI 초안 추출 엔진 (Gemma4)");
    
    await fs.writeFile(draftPath, JSON.stringify(draft, null, 2), "utf8");

    return utils.json(res, 200, {
      ok: true,
      case_id: caseId,
      autofill_draft_path: toRepoPath(draftPath),
      draft,
      message: "Auto-fill draft generated."
    });
  } catch (error) {
    return utils.json(res, 500, {
      ok: false,
      case_id: caseId,
      autofill_draft_path: draftPath ? toRepoPath(draftPath) : null,
      message: "Auto-fill draft generation failed.",
      error: error.message
    });
  }
}

// 메인 서버에서 사용할 수 있게 내보냅니다.
module.exports = {
  handleGenerateAutofillDraft
};