//hashHandlers.js
const fs = require("fs/promises");
const path = require("path");

// 우리가 분리해 둔 설정과 도구들을 불러옵니다.
const config = require("./config.js");
const utils = require("./utils.js");

const HASH_MAP_PATH = path.join(config.RUNTIME, "hash_map.json");

async function getHashMap() {
    try {
        const data = await fs.readFile(HASH_MAP_PATH, "utf8");
        return JSON.parse(data);
    } catch {
        return {}; // 파일이 없으면 빈 장부로 시작
    }
}

async function saveHashMap(map) {
    await fs.writeFile(HASH_MAP_PATH, JSON.stringify(map, null, 2), "utf8");
}

// 🟢 [정밀 매칭 파이프라인 버전 선언] 
// 💡 프롬프트나 백엔드 로직을 수정하여 '새로 추출'하고 싶을 때 이 버전 번호만 올리세요. (예: "1.1" -> "1.2")
// 💡 번호가 올라가면 이전 장부를 자동으로 무시하고 전면 재추출 프로세스를 가동합니다.
const CURRENT_PIPELINE_VERSION = "1.1";

async function handleCheckDuplicateFile(req, res) {
    try {
        const body = await utils.readRequestBody(req);
        const data = JSON.parse(body || "{}");
        const fileHash = data.file_hash;
        
        const map = await getHashMap();
        const cachedEntry = map[fileHash];

        // 🟢 캐시 장부에 존재하고, 저장된 버전이 현재 시스템 버전과 완전히 일치할 때만 똑같은 파일로 인정 (캐시 복원)
        if (cachedEntry && cachedEntry.pipeline_version === CURRENT_PIPELINE_VERSION) { 
            console.log(`[Smart Cache Hit] 버전(${CURRENT_PIPELINE_VERSION})이 일치하는 동일 파일 발견. 자원을 절약합니다.`);
            return utils.json(res, 200, {
                ok: true,
                is_duplicate: true,
                case_id: cachedEntry.case_id,
                draft_fields: cachedEntry.draft_fields || {},
                v2_safe_candidate_fields: cachedEntry.v2_safe_candidate_fields || {}
            });
        }

        // 만약 파일은 같은데 버전이 다르다면 재분석을 유도하기 위해 중복이 아니라고 판정함
        if (cachedEntry && cachedEntry.pipeline_version !== CURRENT_PIPELINE_VERSION) {
            // 🔴 파이썬용 print를 Node.js 환경에 맞는 console.log로 정정하여 500 크래시를 방지합니다.
            console.log(`[Cache Invalidation] 파일은 동일하나 시스템 버전이 다릅니다. (기존: ${cachedEntry.pipeline_version} -> 현재: ${CURRENT_PIPELINE_VERSION}). 재추출을 개시합니다.`);
        }

        return utils.json(res, 200, { ok: true, is_duplicate: false });
    } catch (error) {
        console.error("중복 확인 에러:", error);
        return utils.json(res, 500, { ok: false, error: error.message });
    }
}

async function handleSaveDuplicateHash(req, res) {
    try {
        const body = await utils.readRequestBody(req);
        const data = JSON.parse(body || "{}");
        
        if (data.file_hash && data.case_id) {
            const map = await getHashMap();
            // 장부에 저장할 때 현재 구동 중인 시스템의 버전을 함께 낙인찍어 저장합니다.
            map[data.file_hash] = {
                case_id: data.case_id,
                pipeline_version: CURRENT_PIPELINE_VERSION,
                draft_fields: data.draft_fields || {},
                v2_safe_candidate_fields: data.v2_safe_candidate_fields || {}, 
                saved_at: new Date().toISOString()
            };
            await saveHashMap(map);
        }
        return utils.json(res, 200, { ok: true });
    } catch (error) {
        console.error("해시 기록 에러:", error);
        return utils.json(res, 500, { ok: false, error: error.message });
    }
}

// 작성한 API 핸들러들을 메인 서버에서 쓸 수 있게 내보냅니다.
module.exports = {
    handleCheckDuplicateFile,
    handleSaveDuplicateHash
};