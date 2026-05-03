const express = require("express");
const multer  = require("multer");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");

const app  = express();
const PORT = 3000;

// ──────────────────────────────────────────
// 1. 정적 파일 & 기본 미들웨어
// ──────────────────────────────────────────
app.use(express.static("web"));
app.use("/uploads",   express.static(path.join(__dirname, "web/uploads")));
app.use("/diagnosis", express.static(path.join(__dirname, "web/diagnosis")));
app.use("/estimate-assets", express.static(path.join(__dirname, "web/estimate-assets")));
app.use("/estimates", express.static(path.join(__dirname, "web/estimates")));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

["db/components", "web/uploads", "web/diagnosis", "web/estimate-assets", "web/estimates", "db/customers"].forEach(dir => {
    const p = path.join(__dirname, dir);
    if (!fs.existsSync(p)) { fs.mkdirSync(p, { recursive: true }); console.log("📁 생성:", dir); }
});

const cpuTuningProfilesPath = path.join(__dirname, "db/cpu_tuning_profiles.json");
if (!fs.existsSync(cpuTuningProfilesPath)) fs.writeFileSync(cpuTuningProfilesPath, JSON.stringify([], null, 2), "utf8");

function loadCpuTuningProfilesDb() {
    try { return JSON.parse(fs.readFileSync(cpuTuningProfilesPath, "utf8")); } catch { return []; }
}
function saveCpuTuningProfilesDb(data) {
    fs.writeFileSync(cpuTuningProfilesPath, JSON.stringify(data, null, 2), "utf8");
}


const memoryTuningProfilesPath = path.join(__dirname, "db/memory_tuning_profiles.json");
if (!fs.existsSync(memoryTuningProfilesPath)) fs.writeFileSync(memoryTuningProfilesPath, JSON.stringify([], null, 2), "utf8");

function loadMemoryTuningProfilesDb() {
    try { return JSON.parse(fs.readFileSync(memoryTuningProfilesPath, "utf8")); } catch { return []; }
}
function saveMemoryTuningProfilesDb(data) {
    fs.writeFileSync(memoryTuningProfilesPath, JSON.stringify(data, null, 2), "utf8");
}


// ──────────────────────────────────────────
// 2. 메모리 캐시
// ──────────────────────────────────────────
let componentsCache = null;
let issuesCache     = null;
let customersCache  = null;
let isComponentsLoaded = false;
let isIssuesLoaded     = false;
let isCustomersLoaded  = false;

// ──────────────────────────────────────────
// 비동기 쓰기 큐
// ──────────────────────────────────────────
const writeQueue = {};

function queueWrite(filePath, getData) {
    const prev = writeQueue[filePath] || Promise.resolve();
    const next = prev
        .catch(() => {})
        .then(() => fs.promises.writeFile(filePath, JSON.stringify(getData(), null, 2), 'utf8'));
    writeQueue[filePath] = next;
    return next.catch(e => {
        console.error("❌ 쓰기 실패:", filePath, e.message);
        throw e;
    });
}

// ──────────────────────────────────────────
// 3. 부품 DB 로드
// ──────────────────────────────────────────
function loadComponentsOnce() {
    if (isComponentsLoaded && componentsCache) return componentsCache;
    const dir = path.join(__dirname, "db/components");
    const comps = {};
    if (!fs.existsSync(dir)) return comps;
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json")) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
                comps[data.name] = data.models;
            } catch(e) { console.error("❌ 로드 실패:", f, e.message); }
        }
    } catch(e) { console.error("❌ components 읽기 실패:", e); }
    componentsCache = comps;
    isComponentsLoaded = true;
    return comps;
}

// ──────────────────────────────────────────
// 4. 이슈 DB
// ──────────────────────────────────────────
const issuesPath = path.join(__dirname, "db/issues.json");

function loadIssuesOnce() {
    if (isIssuesLoaded && issuesCache) return issuesCache;
    if (!fs.existsSync(issuesPath)) {
        issuesCache = [{ id:1, component:"CPU", model:"Intel Core i9-13900K", symptom:"과도한 발열",
            bsod:"WHEA_UNCORRECTABLE_ERROR", event_id:41, os:"공통(전체)",
            cause:["CPU 전압 과다","쿨러 불량"], solution:["전압 조정","쿨러 재장착"], images:[] }];
        fs.writeFileSync(issuesPath, JSON.stringify(issuesCache, null, 2));
    } else {
        issuesCache = JSON.parse(fs.readFileSync(issuesPath, "utf8"));
    }
    isIssuesLoaded = true;
    return issuesCache;
}

function saveIssues() {
    queueWrite(issuesPath, () => issuesCache);
}

// ──────────────────────────────────────────
// 5. 고객 DB
// ──────────────────────────────────────────
const customersPath = path.join(__dirname, "db/customers/customers.json");

function loadCustomersOnce() {
    if (isCustomersLoaded && customersCache) return customersCache;
    if (!fs.existsSync(customersPath)) {
        customersCache = [];
        fs.writeFileSync(customersPath, JSON.stringify([], null, 2));
    } else {
        try {
            const raw = JSON.parse(fs.readFileSync(customersPath, "utf8"));
            // 🔧 키/값 공백 자동 제거 및 데이터 정제
            customersCache = Array.isArray(raw) ? raw.map(c => {
                const clean = {};
                for (const [k, v] of Object.entries(c || {})) {
                    clean[k.trim()] = typeof v === 'string' ? v.trim() : v;
                }
                if (!clean.pcs) clean.pcs = [];
                return clean;
            }) : [];
        } catch(e) { 
            console.error("❌ customers 로드 실패:", e); 
            customersCache = []; 
        }
    }
    isCustomersLoaded = true;
    return customersCache;
}

function saveCustomers() {
    return queueWrite(customersPath, () => customersCache);
}

function findCustomerByNamePhone(name, phone) {
    return loadCustomersOnce().find(c => c.name === name && c.phone === phone);
}

function summarizeCustomer(customer) {
    const pcs = Array.isArray(customer?.pcs) ? customer.pcs : [];
    return {
        id: customer.id,
        name: customer.name || '',
        phone: customer.phone || '',
        memo: customer.memo || '',
        address: customer.address || '',
        createdAt: customer.createdAt || null,
        updatedAt: customer.updatedAt || null,
        lastVisit: customer.lastVisit || null,
        pcs: pcs.map(pc => ({
            pcId: pc.pcId,
            name: pc.name || '기본PC',
            createdAt: pc.createdAt || null,
            visitCount: Array.isArray(pc.visits) ? pc.visits.length : 0,
            lastVisit: Array.isArray(pc.visits) && pc.visits.length ? pc.visits[pc.visits.length - 1]?.visitDate || null : null
        }))
    };
}

let _idCounter = 0;
function generateId(prefix = '') {
    // Date.now() + 랜덤 hex 4바이트 조합으로 충돌 가능성 제거
    const ts = Date.now();
    const rand = crypto.randomBytes(4).toString('hex');
    _idCounter = (_idCounter + 1) % 10000;
    return prefix
        ? `${prefix}_${ts}_${String(_idCounter).padStart(4,'0')}_${rand}`
        : `${ts}_${String(_idCounter).padStart(4,'0')}_${rand}`;
}

function generatePCId() {
    return generateId('pc');
}

// ──────────────────────────────────────────
// 6. 폴더명 생성
// ──────────────────────────────────────────
const COMP_ORDER = ["CPU","메인보드","RAM","GPU","공랭쿨러","수랭쿨러","파워","케이스","SSD","HDD","운영체제","모니터","키보드","마우스"];

function sanitizeForFolder(str) {
    if (!str) return "none";
    return String(str).replace(/[<>:"/\\|?*]/g,'_').replace(/[\n\r\t]/g,' ').trim().slice(0,50);
}

function generateFolderName(customerInfo, components_data, timestamp) {
    const now      = timestamp ? new Date(timestamp) : new Date();
    const cName    = customerInfo?.name  ? sanitizeForFolder(customerInfo.name)  : "미등록";
    const cPhone   = customerInfo?.phone ? sanitizeForFolder(customerInfo.phone) : "미등록";
    const pcName   = customerInfo?.pcName ? sanitizeForFolder(customerInfo.pcName) : "기본PC";
    const specParts = COMP_ORDER.map(k => {
        const v = components_data[k];
        return (v && v !== "-" && v !== "") ? sanitizeForFolder(v) : "none";
    });
    const ds = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`;
    return [cName, cPhone, pcName, ...specParts, ds].join('_').slice(0,200);
}

// ──────────────────────────────────────────
// escapeHtml
// ──────────────────────────────────────────
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/`/g, '&#96;');
}

// ──────────────────────────────────────────
// [공통] HTML 렌더링 헬퍼 (buildVisitReportHtml / generateReportHtml 공용)
// ──────────────────────────────────────────

/**
 * 파워 측정값 카드 그리드 HTML 생성
 * @param {Object} s - 파워 증상 객체 (symptom, cause, solution, model)
 * @returns {string} HTML 문자열
 */
function renderPsuCardHtml(s) {
    const rows = (s.cause || []).filter(l => l.match(/^[+\w]/)).map(line => {
        const isWarn = line.includes('범위 이탈');
        const isOk   = line.includes('정상');
        const colonIdx = line.indexOf(':');
        const label = colonIdx !== -1 ? line.slice(0, colonIdx).trim() : line;
        const afterColon = colonIdx !== -1 ? line.slice(colonIdx + 1).trim() : '';
        const valueMatch = afterColon.match(/^([\d.]+(?:V|ms)?)/);
        const displayVal = valueMatch ? valueMatch[1] : afterColon.split(/\s/)[0] || '-';
        return `<div style="background:${isWarn ? '#3d1a1a' : isOk ? '#1a3a1f' : '#1c2128'};border:1px solid ${isWarn ? '#f85149' : isOk ? '#3fb950' : '#30363d'};border-radius:8px;padding:12px;text-align:center;">
            <div style="font-size:11px;color:#8b949e;margin-bottom:4px;">${escapeHtml(label)}</div>
            <div style="font-size:20px;font-weight:900;color:${isWarn ? '#f85149' : isOk ? '#3fb950' : '#e6edf3'};font-family:monospace;">${escapeHtml(displayVal)}</div>
            <div style="font-size:11px;color:${isWarn ? '#f85149' : isOk ? '#3fb950' : '#8b949e'};margin-top:4px;">${isWarn ? '⚠️ 정상 범위 이탈' : isOk ? '✅ 정상' : ''}</div>
        </div>`;
    }).join('');

    const gradeInfo = (s.solution || []).find(l => l.includes('종합 판정:'));
    const gradeText = gradeInfo ? gradeInfo.replace('📊 종합 판정: ', '') : '';

    return `<div class="card" style="border:2px solid #00adb5;background:#0a1a1f;margin-bottom:20px;">
        <h3 style="color:#00adb5;margin:0 0 10px 0;">⚡ 파워 테스터기 진단 결과</h3>
        <p style="font-size:12px;color:#8b949e;margin-bottom:12px;"><strong>파워 모델:</strong> ${escapeHtml(s.model)}</p>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:15px;">${rows}</div>
        ${gradeText ? `<div style="background:#1a2a1a;border:1px solid #3fb950;border-radius:8px;padding:10px;text-align:center;margin-top:10px;"><span style="color:#3fb950;font-weight:700;">📊 종합 판정: ${escapeHtml(gradeText)}</span></div>` : ''}
    </div>`;
}

/**
 * 변경 내역 diff HTML 생성
 * @param {Array} changes - getVisitChanges() 반환값
 * @param {string|null} prevDate - 이전 방문일 문자열
 * @param {string} titleText - 섹션 제목
 * @returns {string} HTML 문자열 (변경 없으면 빈 문자열)
 */
function renderChangesHtml(changes, prevDate, titleText = '이번 방문 변경 내역') {
    if (!changes || changes.length === 0) return '';
    const changeItems = changes.map(change => {
        if (change.type === 'removed') {
            return `<li style="color:#f85149;"><span style="text-decoration:line-through;">🗑️ ${escapeHtml(change.key)}: ${escapeHtml(change.prevVal)}</span> <span style="color:#8b949e">(제거됨)</span></li>`;
        } else if (change.type === 'added') {
            return `<li style="color:#3fb950;">✨ ${escapeHtml(change.key)}: ${escapeHtml(change.currVal)} <span style="color:#8b949e">(신규 추가)</span></li>`;
        } else if (change.type === 'changed') {
            return `<li style="color:#d29922;">🔄 ${escapeHtml(change.key)}: <span style="text-decoration:line-through;color:#f85149">${escapeHtml(change.prevVal)}</span> → <span style="color:#3fb950">${escapeHtml(change.currVal)}</span></li>`;
        } else if (change.type === 'psu_added') {
            return `<li style="color:#00adb5;">✨ ⚡ ${escapeHtml(change.key)}: ${escapeHtml(change.currVal)} <span style="color:#8b949e">(파워 측정값 추가)</span></li>`;
        } else if (change.type === 'psu_changed') {
            return `<li style="color:#00adb5;">🔄 ⚡ ${escapeHtml(change.key)}: <span style="text-decoration:line-through;color:#f85149">${escapeHtml(change.prevVal)}</span> → <span style="color:#3fb950">${escapeHtml(change.currVal)}</span> <span style="color:#8b949e">(파워 측정값 변경)</span></li>`;
        } else if (change.type === 'psu_unchanged') {
            return `<li style="color:#00adb5;">✅ ⚡ ${escapeHtml(change.key)}: ${escapeHtml(change.currVal)} <span style="color:#8b949e">(파워 측정값 유지)</span></li>`;
        }
        return '';
    }).join('');

    return `<div class="card" style="background:#1a2a1a;border:1px solid #3fb950;border-left:4px solid #3fb950;">
        <h3 style="color:#3fb950;margin:0 0 8px 0;">🔄 ${escapeHtml(titleText)} (${changes.length}건)</h3>
        ${prevDate ? `<p style="color:#8b949e;font-size:12px;margin-bottom:10px;">📅 이전 방문일: ${escapeHtml(prevDate)}</p>` : ''}
        <ul style="margin:0;padding-left:20px;">${changeItems}</ul>
    </div>`;
}

// ──────────────────────────────────────────
// 7. Multer 설정
// ──────────────────────────────────────────
let sharp;
try   { sharp = require('sharp'); console.log("✅ sharp 로드됨"); }
catch { console.log("⚠️ sharp 미설치 (선택사항)"); }

const ALLOWED_MIME = new Set(['image/jpeg','image/png','image/gif','image/webp']);

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const d = path.join(__dirname, "web/uploads");
            fs.mkdirSync(d, { recursive: true });
            cb(null, d);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g,'');
            const safeName = crypto.randomBytes(8).toString('hex');
            cb(null, `${Date.now()}-${safeName}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`), false);
        }
    }
});

async function optimizeImage(req, res, next) {
    if (!req.file || !sharp) return next();
    const filePath = req.file.path;
    const tempPath = filePath + '.temp';
    try {
        await sharp(filePath)
            .resize(1200, 1200, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 75, progressive: true })
            .toFile(tempPath);
        fs.renameSync(tempPath, filePath);
    } catch(e) { console.error("이미지 압축 실패:", e.message); }
    next();
}

// ──────────────────────────────────────────
// 컴포넌트 키 허용 목록
// ──────────────────────────────────────────
const ALLOWED_COMPONENTS = new Set(["CPU","메인보드","RAM","GPU","공랭쿨러","수랭쿨러","파워","케이스","SSD","HDD","운영체제","모니터","키보드","마우스"]);

const fileMap = {
    "CPU":"cpu.json","메인보드":"motherboard.json","RAM":"ram.json",
    "GPU":"gpu.json","공랭쿨러":"air_cooler.json","수랭쿨러":"water_cooler.json",
    "파워":"power.json","케이스":"case.json","SSD":"ssd.json",
    "HDD":"hdd.json","운영체제":"os.json",
    "모니터":"monitor.json","키보드":"keyboard.json","마우스":"mouse.json"
};

function getComponentFilePath(component) {
    if (!ALLOWED_COMPONENTS.has(component)) return null;
    return path.join(__dirname, "db/components", fileMap[component]);
}


function normalizeRepairItems(repairItems) {
    if (!Array.isArray(repairItems)) return [];
    return repairItems.map(it => ({
        key: it?.key || '',
        label: it?.label || it?.categoryLabel || '추가수리',
        model: it?.model || it?.memo || '',
        qty: parseInt(it?.qty || 1, 10) || 1,
        partPrice: Number(it?.partPrice || 0) || 0,
        labor: Number(it?.labor || 0) || 0,
        total: Number(it?.total || 0) || 0,
        memo: it?.memo || ''
    }));
}

// ──────────────────────────────────────────
// 파워 측정값 추출 헬퍼
// ──────────────────────────────────────────
function extractPsuValuesFromSymptom(psuSym) {
    const values = {
        '+12V (무부하)': null, '+12V (부하)': null,
        '+5V (무부하)': null, '+5V (부하)': null,
        '+3.3V (무부하)': null, '+3.3V (부하)': null,
        'PG': null
    };
    if (!psuSym || !psuSym.cause) return values;
    for (const line of psuSym.cause) {
        // 숫자 추출: "+12V (무부하): 12.1V" → 12.1
        const numMatch = line.match(/:\s*(\d+\.?\d*)/);
        if (!numMatch) continue;
        const num = parseFloat(numMatch[1]);
        if (isNaN(num)) continue;

        if      (line.includes('+12V (무부하)')) values['+12V (무부하)'] = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('+12V (부하)'))   values['+12V (부하)']   = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('+5V (무부하)'))  values['+5V (무부하)']  = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('+5V (부하)'))    values['+5V (부하)']    = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('+3.3V (무부하)')) values['+3.3V (무부하)'] = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('+3.3V (부하)'))  values['+3.3V (부하)']  = parseFloat(num.toFixed(3)) + 'V';
        else if (line.includes('PG'))             values['PG']             = Math.round(num) + 'ms';
    }
    return values;
}

// ──────────────────────────────────────────
// 변경 내역 비교 함수
// ──────────────────────────────────────────
function getVisitChanges(prevComp, currComp, prevSymptoms, currSymptoms) {
    const changes = [];
    
    // 부품 사양 변경
    const allKeys = new Set([...Object.keys(prevComp || {}), ...Object.keys(currComp || {})]);
    for (const key of COMP_ORDER) {
        if (!allKeys.has(key)) continue;
        const prevVal = prevComp ? prevComp[key] : null;
        const currVal = currComp ? currComp[key] : null;
        if (prevVal && !currVal) {
            changes.push({ type: 'removed', key, prevVal, currVal: null });
        } else if (!prevVal && currVal && currVal !== '-') {
            changes.push({ type: 'added', key, prevVal: null, currVal });
        } else if (prevVal && currVal && prevVal !== currVal && currVal !== '-') {
            changes.push({ type: 'changed', key, prevVal, currVal });
        }
    }
    
    // 파워 측정값 변경
    const prevPsuSym = (prevSymptoms || []).find(s => s.symptom === '🔌 파워 테스터기 측정 결과');
    const currPsuSym = (currSymptoms || []).find(s => s.symptom === '🔌 파워 테스터기 측정 결과');
    const prevVals = extractPsuValuesFromSymptom(prevPsuSym);
    const currVals = extractPsuValuesFromSymptom(currPsuSym);
    
    for (const key of ['+12V (무부하)', '+12V (부하)', '+5V (무부하)', '+5V (부하)', '+3.3V (무부하)', '+3.3V (부하)', 'PG']) {
        const prevVal = prevVals[key];
        const currVal = currVals[key];
        if (prevVal && !currVal) {
            changes.push({ type: 'psu_removed', key, prevVal, currVal: null });
        } else if (!prevVal && currVal) {
            changes.push({ type: 'psu_added', key, prevVal: null, currVal });
        } else if (prevVal && currVal && prevVal !== currVal) {
            changes.push({ type: 'psu_changed', key, prevVal, currVal });
        } else if (prevVal && currVal && prevVal === currVal) {
            changes.push({ type: 'psu_unchanged', key, prevVal, currVal });
        }
    }
    
    return changes;
}

// ──────────────────────────────────────────
// 직접입력 가격/수량 정규화 헬퍼 (0원 보존)
// ──────────────────────────────────────────
function normalizeManualPrices(manualPrices) {
    const out = {};
    if (manualPrices && typeof manualPrices === 'object') {
        for (const [k, v] of Object.entries(manualPrices)) {
            if (v !== undefined && v !== null && v !== '') {
                const n = Number(String(v).replace(/,/g, ''));
                if (!Number.isNaN(n)) out[k] = n; // 0 포함
            }
        }
    }
    return out;
}

function normalizeCompQty(compQty) {
    const out = {};
    if (compQty && typeof compQty === 'object') {
        for (const [k, v] of Object.entries(compQty)) {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) out[k] = n;
        }
    }
    return out;
}

function normalizeRamSlots(ramSlots) {
    const out = { slot1: '', slot2: '', slot3: '', slot4: '' };
    if (ramSlots && typeof ramSlots === 'object') {
        for (const key of Object.keys(out)) {
            out[key] = String(ramSlots[key] || '').replace(/\s+/g, ' ').trim();
        }
    }
    return out;
}

function hasRamSlots(ramSlots) {
    const slots = normalizeRamSlots(ramSlots);
    return Object.values(slots).some(Boolean);
}

function getRamSlotEntries(ramSlots) {
    const slots = normalizeRamSlots(ramSlots);
    return Object.entries(slots)
        .map(([key, value], idx) => ({ key, index: idx + 1, value }))
        .filter(item => item.value);
}

function parseRamCapacityGb(text) {
    const s = String(text || '').toUpperCase();
    if (!s) return 0;
    const multi = s.match(/(\d+(?:\.\d+)?)\s*[X×]\s*(\d+(?:\.\d+)?)(?:\s*(?:GB|G|기가))?/i);
    if (multi) return Math.round(parseFloat(multi[1]) * parseFloat(multi[2]));
    const gb = s.match(/(\d+(?:\.\d+)?)\s*(?:GB|G|기가)/i);
    if (gb) return Math.round(parseFloat(gb[1]));
    return 0;
}

function getRamTotalGb(ramSlots) {
    return getRamSlotEntries(ramSlots).reduce((sum, item) => sum + parseRamCapacityGb(item.value), 0);
}

function buildRamSlotSummary(ramSlots) {
    const entries = getRamSlotEntries(ramSlots);
    if (!entries.length) return '';
    const totalGb = getRamTotalGb(ramSlots);
    const body = entries.map(item => `슬롯${item.index} ${item.value}`).join(' / ');
    return totalGb > 0 ? `${body} / 총 ${totalGb}GB` : body;
}

function renderRamSlotCardHtml(ramSlots) {
    const entries = getRamSlotEntries(ramSlots);
    if (!entries.length) return '';
    const totalGb = getRamTotalGb(ramSlots);
    const rows = entries.map(item => `<li><strong>슬롯 ${item.index}:</strong> ${escapeHtml(item.value)}</li>`).join('');
    return `<div class="card" style="margin-bottom:20px;border:1px solid #bc8cff;background:#171321;">
        <h2 style="color:#bc8cff;margin:0 0 10px 0;">💾 RAM 슬롯 상세</h2>
        <ul style="margin:0 0 10px 20px;">${rows}</ul>
        <div style="font-size:13px;color:#00adb5;font-weight:800;">총 용량: ${totalGb > 0 ? totalGb + 'GB' : '미계산'}</div>
    </div>`;
}

function renderRepairItemsHtml(repairItems) {
    const list = Array.isArray(repairItems) ? repairItems : [];
    if (!list.length) return '';
    const rows = list.map((item, idx) => `<li><strong>${escapeHtml(item.label || '추가수리')}</strong>${item.model ? ` — ${escapeHtml(item.model)}` : ''} / 수량 ${escapeHtml(String(item.qty || 1))} / 합계 ${escapeHtml((Number(item.total || 0)).toLocaleString('ko-KR'))}원</li>`).join('');
    const total = list.reduce((sum, item) => sum + (Number(item.total || 0) || 0), 0);
    return `<div class="card" style="margin-bottom:20px;border:1px solid #e3a350;background:#22170f;">
        <h2 style="color:#e3a350;margin:0 0 10px 0;">🧾 수리 견적 추가 내역</h2>
        <ul style="margin:0 0 10px 20px;">${rows}</ul>
        <div style="font-size:13px;color:#e3a350;font-weight:800;">추가 수리 합계: ${total.toLocaleString('ko-KR')}원</div>
    </div>`;
}

// ──────────────────────────────────────────
// 8. 기본 API
// ──────────────────────────────────────────
app.get("/components", (req, res) => res.json(loadComponentsOnce()));
app.get("/issues",     (req, res) => res.json(loadIssuesOnce()));

app.get("/issues/:component/:model", (req, res) => {
    const { component, model } = req.params;
    const result = loadIssuesOnce().filter(i => i.component === component && i.model === model);
    res.json(result);
});

// ──────────────────────────────────────────
// 9. 고객 API
// ──────────────────────────────────────────
app.get("/customers", (req, res) => {
    const { limit = 100, offset = 0, summary = '0' } = req.query;
    const all = loadCustomersOnce();
    const start = parseInt(offset, 10) || 0;
    const end = start + (parseInt(limit, 10) || 100);
    let slice = all.slice(start, end);
    if (String(summary) === '1') slice = slice.map(summarizeCustomer);
    res.json({ success: true, customers: slice, total: all.length, hasMore: all.length > end });
});

app.get("/customers/search", (req, res) => {
    const { q, limit = 50, summary = '1' } = req.query;
    if (!q) return res.json({ success: true, customers: [] });
    const lq = String(q).toLowerCase();
    let result = loadCustomersOnce()
        .filter(c => c.name?.toLowerCase().includes(lq) || c.phone?.includes(String(q)) ||
                     c.memo?.toLowerCase().includes(lq) || c.address?.toLowerCase().includes(lq))
        .slice(0, parseInt(limit, 10) || 50);
    if (String(summary) === '1') result = result.map(summarizeCustomer);
    res.json({ success: true, customers: result });
});

app.get("/customers/find", (req, res) => {
    const { name, phone } = req.query;
    if (!name || !phone) return res.status(400).json({ error: "이름과 연락처가 필요합니다" });
    const c = findCustomerByNamePhone(name, phone);
    res.json({ success: true, customer: c || null });
});

app.get("/customers/:id", (req, res) => {
    const c = loadCustomersOnce().find(c => c.id == req.params.id);
    if (!c) return res.status(404).json({ error: "고객 없음" });
    if (String(req.query.summary || '0') === '1') return res.json({ success: true, customer: summarizeCustomer(c) });
    res.json({ success: true, customer: c });
});

app.post("/customers", async (req, res) => {
    const { name, phone, memo, address } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "이름과 연락처는 필수입니다." });
    const customers = loadCustomersOnce();
    if (customers.find(c => c.name === name && c.phone === phone))
        return res.status(409).json({ error: "이미 등록된 고객입니다." });
    const newCustomer = {
        id: generateId(), name: name.trim(), phone: phone.trim(),
        memo: memo || "", address: address || "",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        pcs: []
    };
    customers.push(newCustomer);
    customersCache = customers;
    try {
        await saveCustomers();
        console.log(`✅ 고객 등록: ${name} (${phone})`);
        res.json({ success: true, customer: newCustomer });
    } catch (e) {
        return res.status(500).json({ error: "고객 저장 실패" });
    }
});

app.put("/customers/:id", async (req, res) => {
    const customers = loadCustomersOnce();
    const idx = customers.findIndex(c => c.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: "고객 없음" });
    const { name, phone, memo, address } = req.body;
    if (name)             customers[idx].name    = name.trim();
    if (phone)            customers[idx].phone   = phone.trim();
    if (memo !== undefined)    customers[idx].memo    = memo;
    if (address !== undefined) customers[idx].address = address;
    customers[idx].updatedAt = new Date().toISOString();
    customersCache = customers;
    try {
        await saveCustomers();
        res.json({ success: true, customer: customers[idx] });
    } catch (e) {
        return res.status(500).json({ error: "고객 수정 저장 실패" });
    }
});

app.delete("/customers/:id", async (req, res) => {
    const customers = loadCustomersOnce();
    const idx = customers.findIndex(c => c.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: "고객 없음" });
    const del = customers.splice(idx, 1)[0];
    customersCache = customers;
    try {
        await saveCustomers();
        console.log(`✅ 고객 삭제: ${del.name}`);
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "고객 삭제 저장 실패" });
    }
});

app.post("/customers/:customerId/add-pc", async (req, res) => {
    const { pcName } = req.body;
    if (!pcName) return res.status(400).json({ error: "PC 이름이 필요합니다" });
    const customers = loadCustomersOnce();
    const customer  = customers.find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).json({ error: "고객을 찾을 수 없습니다" });
    if (!customer.pcs) customer.pcs = [];
    if (customer.pcs.some(p => p.name === pcName))
        return res.status(400).json({ error: "같은 이름의 PC가 이미 존재합니다" });
    const newPC = { pcId: generatePCId(), name: pcName, createdAt: new Date().toISOString(), visits: [] };
    customer.pcs.push(newPC);
    customer.updatedAt = new Date().toISOString();
    customersCache = customers;
    try {
        await saveCustomers();
        res.json({ success: true, pcId: newPC.pcId, pcName: newPC.name });
    } catch (e) {
        return res.status(500).json({ error: "PC 저장 실패" });
    }
});

app.get("/customers/:customerId/pc/:pcId/latest", (req, res) => {
    const customer = loadCustomersOnce().find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).json({ error: "고객을 찾을 수 없습니다" });
    const pc = (customer.pcs || []).find(p => p.pcId === req.params.pcId);
    if (!pc) return res.status(404).json({ error: "PC를 찾을 수 없습니다" });
    if (pc.visits && pc.visits.length > 0) {
        const latest = [...pc.visits].sort((a,b) => new Date(b.visitDate)-new Date(a.visitDate))[0];
        return res.json({ success: true, components: latest.components, manualPrices: latest.manualPrices || {}, compQty: latest.compQty || {}, pcSetCount: latest.pcSetCount || 1, ramSlots: normalizeRamSlots(latest.ramSlots || {}), pcName: pc.name });
    }
    res.json({ success: true, components: null, pcName: pc.name });
});

app.post("/customers/:customerId/visits", async (req, res) => {
    const { pcId, components, symptoms, actions, cost, memo, diagnosisId, diagnosisFolder, address, customDate, manualPrices, compQty, pcSetCount, ramSlots, laborFee, inspectionFee, assemblyFee, travelFee, travelKm, travelRate, repairItems, repairTotal } = req.body;
    const customers = loadCustomersOnce();
    const customer  = customers.find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).json({ error: "고객 없음" });
    if (!customer.pcs) customer.pcs = [];
    if (address && customer.address !== address) customer.address = address;

    let targetPC = customer.pcs.find(p => p.pcId === pcId);
    if (!targetPC) {
        targetPC = customer.pcs.length > 0 ? customer.pcs[0] :
            (() => { const p = { pcId: generatePCId(), name:"기본PC", createdAt: new Date().toISOString(), visits:[] }; customer.pcs.push(p); return p; })();
    }

    const now = customDate ? new Date(customDate) : new Date();
    const visitRecord = {
        visitId:     Date.now(),
        visitDate:   now.toISOString(),
        visitDateStr: now.toLocaleString("ko-KR", { year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false }),
        components:  components  || {},
        manualPrices: normalizeManualPrices(manualPrices), // 직접입력 가격 저장 (0원 포함)
        compQty: normalizeCompQty(compQty),
        pcSetCount: parseInt(pcSetCount, 10) || 1,
        ramSlots: normalizeRamSlots(ramSlots),
        laborFee: parseInt(laborFee || '0', 10) || 0,
        inspectionFee: parseInt(inspectionFee || '0', 10) || 0,
        assemblyFee: parseInt(assemblyFee || '0', 10) || 0,
        travelFee: parseInt(travelFee || '0', 10) || 0,
        travelKm: parseFloat(travelKm || '0') || 0,
        travelRate: parseInt(travelRate || '1000', 10) || 1000,
        repairItems: normalizeRepairItems(repairItems),
        repairTotal: Number(repairTotal || 0) || 0,
        symptoms:    symptoms    || [],  // 소수점 3자리 값이 그대로 저장됨
        actions:     actions     || "",
        cost:        cost        || "",
        memo:        memo        || "",
        diagnosisId: diagnosisId || null,
        diagnosisFolder: diagnosisFolder || null
    };
    targetPC.visits.push(visitRecord);
    customer.lastVisit  = now.toISOString();
    customer.updatedAt  = now.toISOString();
    customersCache = customers;
    try {
        await saveCustomers();
        console.log(`✅ 방문 추가: ${customer.name} - ${targetPC.name} #${targetPC.visits.length}`);
        res.json({ success: true, visit: visitRecord, customer });
    } catch (e) {
        return res.status(500).json({ error: "방문 기록 저장 실패" });
    }
});

app.delete("/customers/:customerId/visits/:visitId", async (req, res) => {
    const customers = loadCustomersOnce();
    const customer  = customers.find(c => String(c.id) === String(req.params.customerId));
    if (!customer) return res.status(404).json({ error: "고객 없음" });
    if (!customer.pcs) return res.status(404).json({ error: "방문 기록 없음" });
    const targetVid = String(req.params.visitId);
    console.log(`[DELETE visit] customerId=${req.params.customerId} visitId=${targetVid}`);
    let deleted = false;
    for (const pc of customer.pcs) {
        const idx = (pc.visits || []).findIndex(v => String(v.visitId) === targetVid);
        if (idx !== -1) {
            console.log(`[DELETE visit] 찾음: pc="${pc.name}" idx=${idx}`);
            pc.visits.splice(idx, 1);
            deleted = true;
            break;
        }
    }
    if (!deleted) {
        // 디버그: 전체 visitId 목록 출력
        const allVids = customer.pcs.flatMap(pc => (pc.visits||[]).map(v => String(v.visitId)));
        console.error(`[DELETE visit] 실패 - 대상: ${targetVid}, 존재하는 visitId: [${allVids.join(', ')}]`);
        return res.status(404).json({ error: `방문 기록 없음 (id:${targetVid})` });
    }
    customer.updatedAt = new Date().toISOString();
    customersCache = customers;
    try {
        await saveCustomers();
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "방문 삭제 저장 실패" });
    }
});

app.put("/customers/:customerId/pc/:pcId/visit/:visitId/edit", async (req, res) => {
    const { components, symptoms, memo, actions, cost, updatedAt, customVisitDate, manualPrices, compQty, pcSetCount, ramSlots, laborFee, inspectionFee, assemblyFee, travelFee, travelKm, travelRate, repairItems, repairTotal } = req.body;
    const customers = loadCustomersOnce();
    const customer  = customers.find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).json({ error: "고객 없음" });
    const pc = (customer.pcs || []).find(p => p.pcId === req.params.pcId);
    if (!pc) return res.status(404).json({ error: "PC 없음" });
    const visit = (pc.visits || []).find(v => v.visitId == req.params.visitId);
    if (!visit) return res.status(404).json({ error: "방문 기록 없음" });
    if (components)                visit.components = components;
    if (manualPrices !== undefined) visit.manualPrices = normalizeManualPrices(manualPrices); // 0원 포함
    if (compQty !== undefined)      visit.compQty = normalizeCompQty(compQty);
    if (pcSetCount !== undefined)   visit.pcSetCount = parseInt(pcSetCount, 10) || 1;
    if (ramSlots !== undefined)     visit.ramSlots = normalizeRamSlots(ramSlots);
    if (laborFee !== undefined)      visit.laborFee = parseInt(laborFee, 10) || 0;
    if (inspectionFee !== undefined) visit.inspectionFee = parseInt(inspectionFee, 10) || 0;
    if (assemblyFee !== undefined)   visit.assemblyFee = parseInt(assemblyFee, 10) || 0;
    if (travelFee !== undefined)     visit.travelFee = parseInt(travelFee, 10) || 0;
    if (travelKm !== undefined)      visit.travelKm = parseFloat(travelKm) || 0;
    if (travelRate !== undefined)    visit.travelRate = parseInt(travelRate, 10) || 1000;
    if (repairItems !== undefined)   visit.repairItems = normalizeRepairItems(repairItems);
    if (repairTotal !== undefined)   visit.repairTotal = Number(repairTotal || 0) || 0;
    if (symptoms)                    visit.symptoms = symptoms;  // 소수점 3자리 값이 그대로 저장됨
    if (memo !== undefined)          visit.memo = memo;
    if (actions !== undefined)       visit.actions = actions;
    if (cost !== undefined)          visit.cost = cost;

    if (customVisitDate) {
        visit.visitDate = customVisitDate;
        visit.visitDateStr = new Date(customVisitDate).toLocaleString("ko-KR", { year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false });
    }
    visit.updatedAt = updatedAt || new Date().toISOString();
    customer.updatedAt = new Date().toISOString();
    customersCache = customers;
    try {
        await saveCustomers();
        res.json({ success: true, visit });
    } catch (e) {
        return res.status(500).json({ error: "방문 수정 저장 실패" });
    }
});
// ──────────────────────────────────────────
// 10. 리포트 HTML 생성 (PC 전체 변경내역 포함)
// ──────────────────────────────────────────

function renderFullPcChangeHtml(prevComp, currComp, prevDate) {
    const prev = prevComp || {};
    const curr = currComp || {};

    const rows = COMP_ORDER.map(key => {
        const before = prev[key] && prev[key] !== '-' ? String(prev[key]) : '';
        const after  = curr[key] && curr[key] !== '-' ? String(curr[key]) : '';

        let status = '유지';
        let color = '#8b949e';

        let beforeHtml = before ? escapeHtml(before) : '<span style="color:#8b949e">-</span>';
        let afterHtml  = after  ? escapeHtml(after)  : '<span style="color:#8b949e">-</span>';

        if (!before && after) {
            status = '신규';
            color = '#3fb950';
        } else if (before && !after) {
            status = '제거';
            color = '#f85149';
        } else if (before && after && before !== after) {
            status = '변경';
            color = '#d29922';
            beforeHtml = `<span style="color:#f85149;text-decoration:line-through;">${escapeHtml(before)}</span>`;
            afterHtml  = `<span style="color:#3fb950;font-weight:700;">${escapeHtml(after)}</span>`;
        }

        return `
        <tr>
            <td style="padding:8px;border-bottom:1px solid #30363d;color:#00adb5;font-weight:700;width:120px;">${escapeHtml(key)}</td>
            <td style="padding:8px;border-bottom:1px solid #30363d;">${beforeHtml}</td>
            <td style="padding:8px;border-bottom:1px solid #30363d;">${afterHtml}</td>
            <td style="padding:8px;border-bottom:1px solid #30363d;text-align:center;color:${color};font-weight:700;width:70px;">${status}</td>
        </tr>`;
    }).join('');

    return `
    <div class="card" style="background:#0a1a1f;border:2px solid #00adb5;border-left:6px solid #00adb5;margin-bottom:20px;">
        <h2 style="color:#00adb5;margin:0 0 8px 0;">🖥️ PC 전체 사양 및 변경 내역</h2>
        ${prevDate ? `<p style="font-size:12px;color:#8b949e;margin-bottom:12px;">📅 이전 방문일: ${escapeHtml(prevDate)}</p>` : `<p style="font-size:12px;color:#8b949e;margin-bottom:12px;">📅 첫 방문 또는 이전 사양 없음</p>`}
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
                <tr style="background:#161b22;">
                    <th style="padding:8px;color:#8b949e;text-align:left;">항목</th>
                    <th style="padding:8px;color:#8b949e;text-align:left;">이전 사양</th>
                    <th style="padding:8px;color:#8b949e;text-align:left;">현재 사양</th>
                    <th style="padding:8px;color:#8b949e;text-align:center;">상태</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
    </div>`;
}

function buildVisitReportHtml(customer, visit, pcName, symptoms, components_data) {
    let prevComponents = null;
    let prevSymptoms = null;
    let prevVisitDate = null;

    if (customer.pcs) {
        const currentPC = customer.pcs.find(p => p.name === pcName);
        if (currentPC && currentPC.visits) {
            const currentVisitIndex = currentPC.visits.findIndex(v => String(v.visitId) === String(visit.visitId));
            if (currentVisitIndex > 0) {
                const prevVisit = currentPC.visits[currentVisitIndex - 1];
                prevComponents = prevVisit.components || {};
                prevSymptoms = prevVisit.symptoms || [];
                prevVisitDate = prevVisit.visitDateStr || new Date(prevVisit.visitDate).toLocaleString("ko-KR");
            }
        }
    }

    function getChangeHtml(current, previous, prevDate, currentSymptoms, previousSymptoms) {
        const changes = getVisitChanges(previous, current, previousSymptoms, currentSymptoms);
        return renderChangesHtml(changes, prevDate, '이번 방문 변경 내역');
    }

    const symptomsHtml = symptoms.map((s) => {
        if (s.symptom === '🔌 파워 테스터기 측정 결과') {
            return renderPsuCardHtml(s);
        }

        return `<div class="card" style="margin-bottom:20px;">
            <h3 class="symptom-title" style="color:#f85149;margin:0 0 10px 0;">⚠️ 발견된 증상: ${escapeHtml(s.symptom)}</h3>
            <p><strong>🔍 원인 분석:</strong></p>
            <ul style="margin:8px 0 12px 20px;">${(s.cause || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
            <p><strong>🔧 해결 방안:</strong></p>
            <ul style="margin:8px 0 0 20px;">${(s.solution || []).map(c => `<li>${escapeHtml(c)}</li>`).join('')}</ul>
        </div>`;
    }).join('');

    const fullPcChangeHtml = renderFullPcChangeHtml(prevComponents, components_data, prevVisitDate);
    const changeHtml = getChangeHtml(components_data, prevComponents, prevVisitDate, symptoms, prevSymptoms);
    const ramSlotHtml = renderRamSlotCardHtml(visit.ramSlots);
    const repairItemsHtml = renderRepairItemsHtml(visit.repairItems);

    const actionsHtml = visit.actions ? `
        <div class="card" style="background:#0a1a10;border:2px solid #3fb950;border-left:6px solid #3fb950;margin-top:20px;">
            <h2 style="color:#3fb950;margin:0 0 8px 0;">✅ 수리 완료 및 조치 사항</h2>
            <p style="white-space:pre-wrap;line-height:1.8;font-size:14px;margin:0;">${escapeHtml(visit.actions)}</p>
        </div>
    ` : '';

    const costHtml = visit.cost ? `
        <div class="card" style="background:#1a2a1a;border:2px solid #d29922;border-left:6px solid #d29922;margin-top:15px;">
            <h2 style="color:#d29922;margin:0 0 8px 0;">💰 결제 금액</h2>
            <p style="font-size:24px;font-weight:900;color:#d29922;margin:0;">${escapeHtml(visit.cost)}</p>
        </div>
    ` : '';

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>PC 진단 리포트 - ${escapeHtml(customer.name)}</title>
    <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body {
            font-family:'Noto Sans KR', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding:30px;
            max-width:900px;
            margin:0 auto;
            background:#0d1117;
            color:#e6edf3;
            line-height:1.5;
        }
        .header {
            text-align:center;
            padding:20px 0;
            border-bottom:2px solid #30363d;
            margin-bottom:25px;
        }
        .header h1 {
            font-size:28px;
            background:linear-gradient(135deg,#388bfd,#bc8cff);
            -webkit-background-clip:text;
            -webkit-text-fill-color:transparent;
            background-clip:text;
        }
        .header p { color:#8b949e; font-size:12px; margin-top:8px; }
        .customer-info {
            background:#161b22;
            border:1px solid #30363d;
            border-radius:12px;
            padding:16px 20px;
            margin-bottom:20px;
        }
        .customer-info h2 { font-size:16px; color:#3fb950; margin-bottom:12px; }
        .customer-info p { margin:5px 0; font-size:14px; }
        .card {
            background:#161b22;
            border:1px solid #30363d;
            border-radius:12px;
            padding:20px;
            margin-bottom:20px;
        }
        .symptom-title { color:#f85149; font-size:18px; margin-bottom:12px; }
        ul { margin:8px 0 0 20px; }
        li { margin:5px 0; }
        .footer {
            text-align:center;
            padding:20px;
            font-size:11px;
            color:#8b949e;
            border-top:1px solid #30363d;
            margin-top:20px;
        }
        @media print {
            body { background:white; color:black; padding:20px; }
            .card { background:#f5f5f5; border:1px solid #ddd; }
            .customer-info { background:#f0f0f0; }
            .header h1 { background:none; color:#333; -webkit-text-fill-color:#333; }
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>🔧 PC 진단 리포트</h1>
        <p>발급일: ${new Date().toLocaleString("ko-KR")}</p>
    </div>

    <div class="customer-info">
        <h2>👤 고객 정보</h2>
        <p><strong>고객명:</strong> ${escapeHtml(customer.name)}</p>
        <p><strong>연락처:</strong> ${escapeHtml(customer.phone || '')}</p>
        ${customer.address ? `<p><strong>주소:</strong> ${escapeHtml(customer.address)}</p>` : ''}
        <p><strong>PC명:</strong> ${escapeHtml(pcName)}</p>
        <p><strong>방문 일시:</strong> ${escapeHtml(visit.visitDateStr || new Date(visit.visitDate).toLocaleString("ko-KR"))}</p>
    </div>

    ${fullPcChangeHtml}
    ${changeHtml}
    ${ramSlotHtml}
    ${repairItemsHtml}

    <div class="card" style="margin-top:0;">
        <h2 style="color:#388bfd;margin-bottom:15px;">🔍 진단 결과</h2>
        ${symptomsHtml || '<p style="color:#8b949e;">등록된 증상이 없습니다.</p>'}
    </div>

    ${actionsHtml}
    ${costHtml}

    <div class="footer">
        <p>본 리포트는 PC 통합 수리 진단 시스템에서 자동 생성되었습니다.</p>
        <p>문의사항이 있으시면 매장으로 연락 바랍니다.</p>
    </div>
</body>
</html>`;
}

app.get("/customers/:customerId/visits/:visitId/report", (req, res) => {
    const customer = loadCustomersOnce().find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).send("고객을 찾을 수 없습니다");

    let visit = null;
    let pcName = "기본PC";

    for (const pc of (customer.pcs || [])) {
        const found = (pc.visits || []).find(v => String(v.visitId) === String(req.params.visitId));
        if (found) {
            visit = found;
            pcName = pc.name;
            break;
        }
    }

    if (!visit) return res.status(404).send("방문 기록을 찾을 수 없습니다");

    const symptoms = visit.symptoms || [];
    const components_data = visit.components || {};

    res.send(buildVisitReportHtml(customer, visit, pcName, symptoms, components_data));
});

// ──────────────────────────────────────────
// 11. 증상 CRUD
// ──────────────────────────────────────────
app.post("/issues", async (req, res) => {
    const issues = loadIssuesOnce();
    const issue  = {
        ...req.body,
        id: generateId(),
        images: Array.isArray(req.body.images) ? req.body.images : [],
        os: req.body.os || "공통(전체)"
    };
    issues.push(issue);
    issuesCache = issues;
    try {
        await saveIssues();
        res.json({ success: true, id: issue.id });
    } catch (e) {
        return res.status(500).json({ error: "증상 저장 실패" });
    }
});

app.put("/issues/:id/update", async (req, res) => {
    const issues = loadIssuesOnce();
    const issue  = issues.find(i => i.id == req.params.id);
    if (!issue) return res.status(404).json({ error: "없음" });
    const { symptom, bsod, event_id, cause, solution, os } = req.body;
    Object.assign(issue, { symptom, bsod: bsod||null, event_id: event_id||null, cause, solution, os: os||"공통(전체)" });
    issuesCache = issues;
    try {
        await saveIssues();
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "증상 수정 저장 실패" });
    }
});

app.delete("/issues/:id", async (req, res) => {
    const issues = loadIssuesOnce();
    const idx    = issues.findIndex(i => i.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: "없음" });
    issues.splice(idx, 1);
    issuesCache = issues;
    try {
        await saveIssues();
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "증상 삭제 저장 실패" });
    }
});

// ──────────────────────────────────────────
// 12. 이미지 API
// ──────────────────────────────────────────
app.post("/upload-image", upload.single("image"), optimizeImage, (req, res) => {
    if (!req.file) return res.status(400).json({ error: "파일 없음" });
    res.json({ success: true, filename: req.file.filename, url: `/uploads/${req.file.filename}` });
});

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError || err.message?.includes('허용되지 않는')) {
        return res.status(400).json({ error: err.message });
    }
    next(err);
});

app.post("/issues/:id/add-image", async (req, res) => {
    const issues = loadIssuesOnce();
    const issue  = issues.find(i => i.id == req.params.id);
    if (!issue) return res.status(404).json({ error: "없음" });
    if (!issue.images) issue.images = [];
    issue.images.push({ url: req.body.imageUrl, caption: req.body.caption||null, uploadedAt: Date.now() });
    issuesCache = issues;
    try {
        await saveIssues();
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "이미지 추가 저장 실패" });
    }
});

app.post("/issues/:id/remove-image", async (req, res) => {
    const issues = loadIssuesOnce();
    const issue  = issues.find(i => i.id == req.params.id);
    if (!issue) return res.status(404).json({ error: "없음" });
    issue.images = (issue.images||[]).filter(img => img.url !== req.body.imageUrl);
    issuesCache = issues;
    try {
        await saveIssues();
        res.json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: "이미지 삭제 저장 실패" });
    }
});

// ──────────────────────────────────────────
// 13. 검색 API
// ──────────────────────────────────────────
app.get("/search/by-symptom/:kw", (req, res) => {
    const kw = req.params.kw.toLowerCase();
    res.json({ success: true, results: loadIssuesOnce().filter(i => i.symptom?.toLowerCase().includes(kw)) });
});
app.get("/search/by-bsod/:code", (req, res) => {
    const kw = req.params.code.toLowerCase();
    res.json({ success: true, results: loadIssuesOnce().filter(i => i.bsod?.toLowerCase().includes(kw)) });
});
app.get("/search/by-eventid/:id", (req, res) => {
    const kw = req.params.id;
    res.json({ success: true, results: loadIssuesOnce().filter(i => i.event_id && String(i.event_id).includes(kw)) });
});


function parseCostNumber(v) {
    if (v == null) return 0;
    const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}
function normSearchText(v) {
    return String(v == null ? '' : v).toLowerCase().replace(/\s+/g, ' ').trim();
}
function textIncludes(hay, needle) {
    return normSearchText(hay).includes(normSearchText(needle));
}
function countByName(items) {
    const map = new Map();
    for (const raw of (items || [])) {
        const name = String(raw || '').trim();
        if (!name) continue;
        map.set(name, (map.get(name) || 0) + 1);
    }
    return [...map.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0], 'ko')).map(([name,count]) => ({ name, count }));
}
function medianOf(nums) {
    if (!nums.length) return 0;
    const arr = [...nums].sort((a,b)=>a-b);
    const mid = Math.floor(arr.length/2);
    return arr.length % 2 ? arr[mid] : Math.round((arr[mid-1] + arr[mid]) / 2);
}
function buildCommonBand(nums) {
    if (!nums.length) return '';
    const map = new Map();
    for (const n of nums) {
        const start = Math.floor(n / 10000) * 10000;
        const end = start + 9999;
        const key = `${start}-${end}`;
        map.set(key, (map.get(key) || 0) + 1);
    }
    const top = [...map.entries()].sort((a,b)=>b[1]-a[1])[0];
    if (!top) return '';
    const [key, count] = top;
    const [start, end] = key.split('-').map(v => parseInt(v, 10));
    return `${start.toLocaleString('ko-KR')}~${end.toLocaleString('ko-KR')}원 (${count}건)`;
}
function buildSearchHitFields(entry, query) {
    const q = normSearchText(query);
    const hits = [];
    if (textIncludes(entry.symptom, q)) hits.push('증상');
    if (textIncludes(entry.component, q) || textIncludes(entry.model, q)) hits.push('부품');
    if (textIncludes(entry.bsod, q)) hits.push('BSOD');
    if (textIncludes(entry.eventId, q)) hits.push('Event ID');
    if (entry.causeList.some(v => textIncludes(v, q))) hits.push('원인');
    if (entry.solutionList.some(v => textIncludes(v, q))) hits.push('해결');
    if (textIncludes(entry.actions, q)) hits.push('조치');
    if (textIncludes(entry.memo, q)) hits.push('메모');
    if (textIncludes(entry.customerName, q) || textIncludes(entry.customerPhone, q)) hits.push('고객');
    return [...new Set(hits)];
}
function buildVisitSymptomEntries() {
    const customers = loadCustomersOnce();
    const entries = [];
    for (const customer of customers) {
        for (const pc of (customer.pcs || [])) {
            for (const visit of (pc.visits || [])) {
                const symptoms = Array.isArray(visit.symptoms) ? visit.symptoms : [];
                const costValue = parseCostNumber(visit.cost);
                for (const sym of symptoms) {
                    const causeList = Array.isArray(sym.cause) ? sym.cause.filter(Boolean) : [];
                    const solutionList = Array.isArray(sym.solution) ? sym.solution.filter(Boolean) : [];
                    const eventId = sym.eventId ?? sym.event_id ?? null;
                    entries.push({
                        customerId: customer.id,
                        customerName: customer.name || '',
                        customerPhone: customer.phone || '',
                        pcId: pc.pcId || '',
                        pcName: pc.name || '기본PC',
                        visitId: visit.visitId,
                        visitDate: visit.visitDate || '',
                        visitDateStr: visit.visitDateStr || '',
                        component: sym.component || '',
                        model: sym.model || '',
                        symptom: sym.symptom || '',
                        bsod: sym.bsod || '',
                        eventId: eventId == null ? '' : String(eventId),
                        causeList,
                        solutionList,
                        actions: visit.actions || '',
                        memo: visit.memo || '',
                        costValue,
                        rawCost: visit.cost || '',
                        components: visit.components || {}
                    });
                }
            }
        }
    }
    return entries;
}
app.get('/search/judgment', (req, res) => {
    try {
        const q = String(req.query.q || '').trim();
        if (!q) return res.status(400).json({ success:false, error:'검색어가 필요합니다.' });
        const currentCustomerId = req.query.currentCustomerId != null ? String(req.query.currentCustomerId) : '';
        const currentPcId = req.query.currentPcId != null ? String(req.query.currentPcId) : '';
        const entries = buildVisitSymptomEntries();
        const filtered = entries.map(entry => {
            const hitFields = buildSearchHitFields(entry, q);
            let score = 0;
            if (hitFields.includes('증상')) score += 8;
            if (hitFields.includes('원인')) score += 7;
            if (hitFields.includes('해결')) score += 7;
            if (hitFields.includes('BSOD')) score += 7;
            if (hitFields.includes('Event ID')) score += 7;
            if (hitFields.includes('부품')) score += 5;
            if (hitFields.includes('조치')) score += 4;
            if (hitFields.includes('메모')) score += 3;
            if (hitFields.includes('고객')) score += 5;
            const sameCustomer = currentCustomerId && String(entry.customerId) === currentCustomerId;
            const samePc = currentPcId && String(entry.pcId) === currentPcId;
            if (sameCustomer) score += 4;
            if (samePc) score += 6;
            return { ...entry, hitFields, sameCustomer, samePc, score };
        }).filter(entry => entry.hitFields.length > 0)
          .sort((a,b) => b.score - a.score || new Date(b.visitDate || 0) - new Date(a.visitDate || 0));

        const topFiltered = filtered.slice(0, 80);
        const causeCounts = countByName(topFiltered.flatMap(v => v.causeList));
        const solutionCounts = countByName(topFiltered.flatMap(v => v.solutionList));
        const priced = topFiltered.filter(v => v.costValue > 0).map(v => v.costValue);
        const avg = priced.length ? Math.round(priced.reduce((a,b)=>a+b,0) / priced.length) : 0;
        const median = priced.length ? medianOf(priced) : 0;
        const priceSummary = {
            count: priced.length,
            min: priced.length ? Math.min(...priced) : 0,
            max: priced.length ? Math.max(...priced) : 0,
            avg,
            median,
            commonBand: buildCommonBand(priced),
            suggestedRange: priced.length ? `${Math.min(...priced).toLocaleString('ko-KR')}~${Math.max(...priced).toLocaleString('ko-KR')}원` : ''
        };
        const recommendations = [];
        const topCause = causeCounts[0]?.name || '';
        const topSolution = solutionCounts[0]?.name || '';
        if (topCause || topSolution) {
            recommendations.push({
                title: '가장 많이 나온 유사사례 기준',
                cause: topCause,
                solution: topSolution,
                reason: `${topFiltered.length}건의 유사사례에서 가장 많이 반복된 원인과 해결방안을 우선 참고하는 방식입니다.`,
                priceHint: priceSummary.suggestedRange || ''
            });
        }
        const samePcCases = topFiltered.filter(v => v.samePc);
        if (samePcCases.length) {
            const pcCause = countByName(samePcCases.flatMap(v => v.causeList))[0]?.name || '';
            const pcSol = countByName(samePcCases.flatMap(v => v.solutionList))[0]?.name || '';
            recommendations.push({
                title: '같은 PC 재방문 우선 기준',
                cause: pcCause,
                solution: pcSol,
                reason: `현재 선택된 PC와 동일한 장비에서 ${samePcCases.length}건의 이력이 있어 재발/연관 가능성을 먼저 확인하는 방식입니다.`,
                priceHint: samePcCases.filter(v => v.costValue > 0).length ? `${Math.min(...samePcCases.filter(v => v.costValue > 0).map(v => v.costValue)).toLocaleString('ko-KR')}~${Math.max(...samePcCases.filter(v => v.costValue > 0).map(v => v.costValue)).toLocaleString('ko-KR')}원` : ''
            });
        }
        const sameCustomerCases = topFiltered.filter(v => v.sameCustomer);
        if (sameCustomerCases.length) {
            const custCause = countByName(sameCustomerCases.flatMap(v => v.causeList))[0]?.name || '';
            const custSol = countByName(sameCustomerCases.flatMap(v => v.solutionList))[0]?.name || '';
            recommendations.push({
                title: '같은 고객 과거 처리 이력 기준',
                cause: custCause,
                solution: custSol,
                reason: `같은 고객의 과거 수리 패턴 ${sameCustomerCases.length}건을 우선 확인해 설명과 금액 설득을 빠르게 하는 방식입니다.`,
                priceHint: sameCustomerCases.filter(v => v.costValue > 0).length ? `${Math.min(...sameCustomerCases.filter(v => v.costValue > 0).map(v => v.costValue)).toLocaleString('ko-KR')}~${Math.max(...sameCustomerCases.filter(v => v.costValue > 0).map(v => v.costValue)).toLocaleString('ko-KR')}원` : ''
            });
        }
        const latestVisitDate = topFiltered[0]?.visitDateStr || (topFiltered[0]?.visitDate ? new Date(topFiltered[0].visitDate).toLocaleString('ko-KR') : '');
        res.json({
            success: true,
            summary: {
                query: q,
                totalCases: topFiltered.length,
                sameCustomerCases: sameCustomerCases.length,
                samePcCases: samePcCases.length,
                pricedCases: priced.length,
                latestVisitDate
            },
            topCauses: causeCounts.slice(0, 10),
            topSolutions: solutionCounts.slice(0, 10),
            priceSummary,
            recommendations: recommendations.slice(0, 3),
            cases: topFiltered.slice(0, 25).map(v => ({
                customerId: v.customerId,
                customerName: v.customerName,
                customerPhone: v.customerPhone,
                pcId: v.pcId,
                pcName: v.pcName,
                visitId: v.visitId,
                visitDate: v.visitDate,
                visitDateStr: v.visitDateStr,
                component: v.component,
                model: v.model,
                symptom: v.symptom,
                bsod: v.bsod,
                eventId: v.eventId,
                topCause: v.causeList[0] || '',
                topSolution: v.solutionList[0] || '',
                actions: v.actions,
                memo: v.memo,
                costValue: v.costValue,
                sameCustomer: v.sameCustomer,
                samePc: v.samePc,
                hitFields: v.hitFields
            }))
        });
    } catch (e) {
        console.error('❌ /search/judgment 오류:', e);
        res.status(500).json({ success:false, error:e.message });
    }
});

// ──────────────────────────────────────────
// 14. 모델 추가/삭제 API
// ──────────────────────────────────────────
app.post("/components/:component/add-model", (req, res) => {
    const { component } = req.params;
    const { model } = req.body;
    if (!component || !model) return res.status(400).json({ error: "부품명과 모델명이 필요합니다" });
    const filePath = getComponentFilePath(component);
    if (!filePath) return res.status(400).json({ error: "허용되지 않는 부품입니다" });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "부품 파일이 존재하지 않습니다" });
    try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (data.models.includes(model)) return res.json({ success: false, error: "이미 존재하는 모델입니다" });
        data.models.push(model);
        data.models.sort((a,b) => a.localeCompare(b, 'ko'));
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        if (componentsCache && componentsCache[component]) componentsCache[component] = data.models;
        console.log(`✅ 모델 추가: ${component} - ${model}`);
        res.json({ success: true, models: data.models });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete("/components/:component/remove-model", (req, res) => {
    const { component } = req.params;
    const { model } = req.body;
    if (!component || !model) return res.status(400).json({ error: "부품명과 모델명이 필요합니다" });
    const filePath = getComponentFilePath(component);
    if (!filePath) return res.status(400).json({ error: "허용되지 않는 부품입니다" });
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "부품 파일이 존재하지 않습니다" });
    try {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
        const idx = data.models.indexOf(model);
        if (idx === -1) return res.json({ success: false, error: "모델을 찾을 수 없습니다" });
        data.models.splice(idx, 1);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        if (componentsCache && componentsCache[component]) componentsCache[component] = data.models;
        console.log(`✅ 모델 삭제: ${component} - ${model}`);
        res.json({ success: true, models: data.models });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ──────────────────────────────────────────
// 15. 진단 저장 API
// ──────────────────────────────────────────
function generateReportHtml(folderName, timestamp, diagnosisId, customerInfo, components_data, symptoms) {
    const dateStr = new Date(timestamp).toLocaleString("ko-KR");
    const customerHtml = customerInfo
        ? `<div><strong>고객명:</strong> ${escapeHtml(customerInfo.name)}</div>
           <div><strong>연락처:</strong> ${escapeHtml(customerInfo.phone)}</div>
           ${customerInfo.address ? `<div><strong>주소:</strong> ${escapeHtml(customerInfo.address)}</div>` : ''}
           <div><strong>PC명:</strong> ${escapeHtml(customerInfo.pcName||'기본PC')}</div>`
        : '<div>비회원 진단</div>';
    
    let changeHtml = '';
    if (customerInfo && (customerInfo.prevComponents || customerInfo.prevSymptoms)) {
        const changes = getVisitChanges(customerInfo.prevComponents, components_data, customerInfo.prevSymptoms, symptoms);
        changeHtml = renderChangesHtml(changes, customerInfo.prevVisitDate, '이전 방문 대비 변경된 항목');
    }
    
    const symptomsHtml = symptoms.map((s,i) => {
        if (s.symptom === '🔌 파워 테스터기 측정 결과') {
            return renderPsuCardHtml(s);
        }
        return `<div style="border:1px solid #30363d;margin:15px 0;padding:12px;border-radius:8px">
            <h3 style="color:#f85149;margin:0 0 8px">⚠️ 증상 #${i+1}: ${escapeHtml(s.symptom)}</h3>
            <p style="font-size:13px;color:#8b949e;margin-bottom:8px"><strong>부품:</strong> ${escapeHtml(s.componentLabel||s.component)} — ${escapeHtml(s.model)}</p>
            ${s.bsod ? `<p><strong>💀 BSOD:</strong> ${escapeHtml(s.bsod)}</p>` : ''}
            ${s.eventId ? `<p><strong>📊 Event ID:</strong> ${escapeHtml(String(s.eventId))}</p>` : ''}
            <p style="margin:8px 0 4px"><strong>🔍 원인:</strong></p><ul style="margin:0 0 8px 18px">${(s.cause||[]).map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>
            <p style="margin:8px 0 4px"><strong>🔧 해결방안:</strong></p><ul style="margin:0 0 8px 18px">${(s.solution||[]).map(c=>`<li>${escapeHtml(c)}</li>`).join('')}</ul>
            ${s.images?.length ? `<p style="margin:8px 0 4px"><strong>📷 참고 이미지:</strong></p><div style="display:flex;flex-wrap:wrap;gap:8px">${s.images.map(img=>`<img src="${escapeHtml(img.url)}" style="max-width:120px;border-radius:6px" alt="${escapeHtml(img.caption||'')}">`).join('')}</div>` : ''}
        </div>`;
    }).join('');

    // PC 사양 섹션
    const specRows = Object.entries(components_data)
        .filter(([,v]) => v && v !== '-')
        .map(([k,v]) => `<tr><td style="padding:6px 12px;color:#8b949e;font-size:13px;border-bottom:1px solid #21262d;white-space:nowrap">${escapeHtml(k)}</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #21262d">${escapeHtml(v)}</td></tr>`)
        .join('');
    const specHtml = specRows ? `<div class="card"><h2>🖥️ PC 사양</h2><table style="width:100%;border-collapse:collapse;margin-top:8px">${specRows}</table></div>` : '';

    // 결제/조치 정보 (customerInfo에서 가져옴)
    const actionsHtml2 = customerInfo?.actions ? `
        <div class="card" style="background:#0a1a10;border:2px solid #3fb950;border-left:6px solid #3fb950">
            <h2 style="color:#3fb950;margin:0 0 8px">✅ 수리 완료 및 조치 사항</h2>
            <p style="white-space:pre-wrap;line-height:1.8;font-size:14px;margin:0">${escapeHtml(customerInfo.actions)}</p>
        </div>` : '';
    const costHtml2 = customerInfo?.cost ? `
        <div class="card" style="background:#1a1a0a;border:2px solid #d29922;border-left:6px solid #d29922">
            <h2 style="color:#d29922;margin:0 0 8px">💰 결제 금액</h2>
            <p style="font-size:28px;font-weight:900;color:#d29922;margin:0">${escapeHtml(customerInfo.cost)}원</p>
        </div>` : '';

    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>진단 리포트 - ${escapeHtml(diagnosisId)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans KR',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:30px;max-width:900px;margin:0 auto;background:#0d1117;color:#e6edf3;line-height:1.5}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px;margin-bottom:20px}
h1,h2,h3{color:#e6edf3}
.header{text-align:center;padding:20px 0;border-bottom:2px solid #30363d;margin-bottom:25px}
.header h1{font-size:28px;background:linear-gradient(135deg,#388bfd,#bc8cff);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.header p{color:#8b949e;font-size:12px;margin-top:8px}
.footer{text-align:center;padding:20px;font-size:11px;color:#8b949e;border-top:1px solid #30363d;margin-top:20px}
@media print{body{background:white;color:black;padding:20px}.card{background:#f5f5f5;border:1px solid #ddd}.header h1{background:none;color:#333;-webkit-text-fill-color:#333}}
</style></head>
<body>
<div class="header"><h1>🔧 PC 진단 리포트</h1><p>발급일: ${new Date().toLocaleString("ko-KR")}</p></div>
<div class="card"><h2 style="color:#388bfd;margin-bottom:12px">📋 진단 정보</h2>
<p style="font-size:13px;margin:4px 0"><strong>진단 ID:</strong> ${escapeHtml(diagnosisId)}</p>
<p style="font-size:13px;margin:4px 0"><strong>진단 일시:</strong> ${dateStr}</p></div>
<div class="card"><h2 style="color:#3fb950;margin-bottom:12px">👤 고객 정보</h2>${customerHtml}</div>
${specHtml}
${changeHtml}
<div class="card"><h2 style="color:#388bfd;margin-bottom:12px">🔍 진단 결과</h2>${symptomsHtml || '<p style="color:#8b949e">등록된 증상이 없습니다.</p>'}</div>
${actionsHtml2}
${costHtml2}
<div class="footer"><p>본 리포트는 PC 통합 수리 진단 시스템에서 자동 생성되었습니다.</p><p>문의사항이 있으시면 매장으로 연락 바랍니다.</p></div>
</body></html>`;
}

app.post("/save-diagnosis", async (req, res) => {
    const { diagnosisData, timestamp, diagnosisId, customerInfo, cost, actions } = req.body;
    const folderName = generateFolderName(customerInfo, diagnosisData.components, timestamp);
    const baseDir    = path.join(__dirname, "web/diagnosis", folderName);
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });

    let prevComponents = null;
    let prevSymptoms = null;
    let prevVisitDate = null;
    if (customerInfo && customerInfo.customerId && customerInfo.pcId) {
        const customers = loadCustomersOnce();
        const customer = customers.find(c => c.id == customerInfo.customerId);
        if (customer && customer.pcs) {
            const pc = customer.pcs.find(p => p.pcId == customerInfo.pcId);
            if (pc && pc.visits && pc.visits.length > 0) {
                const latest = [...pc.visits].sort((a,b) => new Date(b.visitDate)-new Date(a.visitDate))[0];
                prevComponents = latest.components;
                prevSymptoms = latest.symptoms;
                prevVisitDate = latest.visitDateStr || new Date(latest.visitDate).toLocaleString("ko-KR");
            }
        }
    }
    
    const fullCustomerInfo = customerInfo
        ? { ...customerInfo, prevComponents, prevSymptoms, prevVisitDate, cost: cost || customerInfo.cost || null, actions: actions || customerInfo.actions || null }
        : null;
    const htmlContent = generateReportHtml(folderName, timestamp, diagnosisId, fullCustomerInfo, diagnosisData.components, diagnosisData.symptoms);
    fs.writeFileSync(path.join(baseDir, "report.html"), htmlContent);

    let txt = `진단 ID: ${diagnosisId}\n일시: ${new Date(timestamp).toLocaleString()}\n\n`;
    if (customerInfo) {
        txt += `고객: ${customerInfo.name} (${customerInfo.phone})\n`;
        if (customerInfo.address) txt += `주소: ${customerInfo.address}\n`;
        txt += `PC: ${customerInfo.pcName||'기본PC'}\n\n`;
    }
    txt += "=== PC 사양 ===\n";
    for (const [k,v] of Object.entries(diagnosisData.components)) if (v && v!=='-') txt += `${k}: ${v}\n`;
    txt += "\n=== 진단 결과 ===\n";
    for (const s of diagnosisData.symptoms) {
        txt += `\n[증상] ${s.symptom}\n부품: ${s.componentLabel||s.component} - ${s.model}\n`;
        if (s.bsod)    txt += `BSOD: ${s.bsod}\n`;
        if (s.eventId) txt += `Event ID: ${s.eventId}\n`;
        txt += `원인:\n${(s.cause||[]).map(c=>`- ${c}`).join('\n')}\n`;
        txt += `해결방안:\n${(s.solution||[]).map(c=>`- ${c}`).join('\n')}\n`;
        if (s.images?.length) txt += `사진: ${s.images.map(i=>i.url).join(', ')}\n`;
    }
    fs.writeFileSync(path.join(baseDir, "diagnosis.txt"), txt);

    const dirs = { bsod: "bsod_photos", event: "event_photos", other: "other_photos" };
    for (const d of Object.values(dirs)) {
        const dp = path.join(baseDir, d);
        if (!fs.existsSync(dp)) fs.mkdirSync(dp);
    }
    for (const s of diagnosisData.symptoms) {
        for (const img of (s.images||[])) {
            const src = path.join(__dirname, "web", img.url);
            if (fs.existsSync(src)) {
                const cap = (img.caption||'').toLowerCase();
                const dir = cap.includes('bsod') ? dirs.bsod : cap.includes('event id') ? dirs.event : dirs.other;
                const dst = path.join(baseDir, dir, path.basename(src));
                if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
            }
        }
    }
    res.json({ success:true, folderName, path:`/diagnosis/${folderName}/report.html`, txtPath:`/diagnosis/${folderName}/diagnosis.txt` });
});

// ──────────────────────────────────────────
// 16. 파워 측정값 저장 API
// ──────────────────────────────────────────
const psuMeasurementsPath = path.join(__dirname, "db/psu_measurements.json");
if (!fs.existsSync(path.join(__dirname, "db/psu_measurements.json"))) {
    fs.writeFileSync(path.join(__dirname, "db/psu_measurements.json"), JSON.stringify([], null, 2));
}

app.post("/save-psu-measurement", (req, res) => {
    const { customerId, customerName, pcId, timestamp, measurements, psuModel } = req.body;
    if (!measurements) return res.status(400).json({ error: "측정값이 없습니다" });
    let logs = [];
    if (fs.existsSync(psuMeasurementsPath)) {
        try { logs = JSON.parse(fs.readFileSync(psuMeasurementsPath, "utf8")); } catch(e) { logs = []; }
    }
    logs.push({
        id: Date.now(), customerId: customerId || null, customerName: customerName || "알 수 없음",
        pcId: pcId || null, psuModel: psuModel || "알 수 없음",
        timestamp: timestamp || new Date().toISOString(),
        measurements: { 
            volt12: measurements.volt12 ? parseFloat(measurements.volt12).toFixed(3) : null, 
            volt5: measurements.volt5 ? parseFloat(measurements.volt5).toFixed(3) : null, 
            volt33: measurements.volt33 ? parseFloat(measurements.volt33).toFixed(3) : null, 
            pg: measurements.pg || null 
        }
    });
    fs.writeFileSync(psuMeasurementsPath, JSON.stringify(logs, null, 2));
    console.log(`✅ 파워 측정값 저장: ${customerName} - 12V:${measurements.volt12}V / PG:${measurements.pg}ms`);
    res.json({ success: true, count: logs.length });
});

// ──────────────────────────────────────────
// 17. 설정 파일 (API 키 등)
// ──────────────────────────────────────────
const configPath = path.join(__dirname, "db/config.json");
function loadConfig() {
    if (!fs.existsSync(configPath)) {
        const def = {
            solapi: { apiKey: "", apiSecret: "", fromNumber: "" },
            telegram: { botToken: "", defaultChatId: "" },
            shopName: "PC 수리점",
            shopPhone: "",
            estimateBrand: {
                shopName: "PC 수리점",
                shopAddress: "",
                shopPhone: "",
                shopBizNo: "",
                logoUrl: "",
                stampUrl: "",
                bankInfo: "",
                note: ""
            }
        };
        fs.writeFileSync(configPath, JSON.stringify(def, null, 2));
        return def;
    }
    try {
        const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
        cfg.estimateBrand = Object.assign({
            shopName: cfg.shopName || "PC 수리점",
            shopAddress: "",
            shopPhone: cfg.shopPhone || "",
            shopBizNo: "",
            logoUrl: "",
            stampUrl: "",
            bankInfo: "",
            note: ""
        }, cfg.estimateBrand || {});
        return cfg;
    }
    catch(e) { return {}; }
}
function saveConfig(cfg) {
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}

app.get("/config", (req, res) => res.json({ success: true, config: loadConfig() }));
app.post("/config", (req, res) => {
    const cfg = loadConfig();
    const { solapi, telegram, shopName, shopPhone } = req.body;
    if (solapi)    Object.assign(cfg.solapi    = cfg.solapi    || {}, solapi);
    if (telegram)  Object.assign(cfg.telegram  = cfg.telegram  || {}, telegram);
    if (shopName !== undefined) cfg.shopName = shopName;
    if (shopPhone !== undefined) cfg.shopPhone = shopPhone;
    saveConfig(cfg);
    res.json({ success: true });
});

// ──────────────────────────────────────────
// 견적서 매장정보 / 로고 / 도장 / 견적서 저장 API
// 저장 경로: C:\repair-system\web\estimate-assets, C:\repair-system\web\estimates
// ──────────────────────────────────────────
const estimateAssetUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const d = path.join(__dirname, "web/estimate-assets");
            fs.mkdirSync(d, { recursive: true });
            cb(null, d);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '') || '.png';
            const prefix = file.fieldname === 'stamp' ? 'stamp' : 'logo';
            cb(null, `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED_MIME.has(file.mimetype)) cb(null, true);
        else cb(new Error(`허용되지 않는 파일 형식: ${file.mimetype}`), false);
    }
});

app.get("/estimate-brand", (req, res) => {
    const cfg = loadConfig();
    res.json({ success: true, brand: cfg.estimateBrand || {} });
});

app.post("/estimate-brand", estimateAssetUpload.fields([{ name:'logo', maxCount:1 }, { name:'stamp', maxCount:1 }]), (req, res) => {
    const cfg = loadConfig();
    const oldBrand = cfg.estimateBrand || {};
    const brand = Object.assign({}, oldBrand, {
        shopName: req.body.shopName ?? oldBrand.shopName ?? cfg.shopName ?? "PC 수리점",
        shopAddress: req.body.shopAddress ?? oldBrand.shopAddress ?? "",
        shopPhone: req.body.shopPhone ?? oldBrand.shopPhone ?? cfg.shopPhone ?? "",
        shopBizNo: req.body.shopBizNo ?? oldBrand.shopBizNo ?? "",
        bankInfo: req.body.bankInfo ?? oldBrand.bankInfo ?? "",
        note: req.body.note ?? oldBrand.note ?? ""
    });
    if (req.files?.logo?.[0]) brand.logoUrl = `/estimate-assets/${req.files.logo[0].filename}`;
    if (req.files?.stamp?.[0]) brand.stampUrl = `/estimate-assets/${req.files.stamp[0].filename}`;
    cfg.estimateBrand = brand;
    cfg.shopName = brand.shopName;
    cfg.shopPhone = brand.shopPhone;
    saveConfig(cfg);
    res.json({ success: true, brand });
});

function safeEstimateFileName(str) {
    return String(str || 'estimate').replace(/[<>:"/\\|?*]/g, '_').replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || 'estimate';
}

app.post("/estimates/save", (req, res) => {
    const { estimateNo, customerName, html, text, data } = req.body || {};
    if (!html || !estimateNo) return res.status(400).json({ success:false, error:"견적서 HTML 또는 견적번호가 없습니다" });
    const dir = path.join(__dirname, "web/estimates");
    fs.mkdirSync(dir, { recursive: true });
    const base = `${safeEstimateFileName(estimateNo)}_${safeEstimateFileName(customerName || '고객')}`;
    const htmlName = `${base}.html`;
    fs.writeFileSync(path.join(dir, htmlName), html, 'utf8');
    if (text) fs.writeFileSync(path.join(dir, `${base}.txt`), text, 'utf8');
    if (data) fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify(data, null, 2), 'utf8');
    res.json({ success:true, url:`/estimates/${htmlName}`, path:path.join(dir, htmlName) });
});

function getPrevVisitForText(customer, pc, visit) {
    const visits = pc?.visits || [];
    const idx = visits.findIndex(v => String(v.visitId) === String(visit.visitId));
    if (idx > 0) return visits[idx - 1];
    return null;
}

function normalizePcValue(v) {
    if (v == null) return "";
    const str = String(v).trim();

    if (
        str === "" ||
        str === "-" ||
        str === "none" ||
        str === "null" ||
        str === "undefined" ||
        str === "미장착" ||
        str === "없음"
    ) {
        return "";
    }

    return str;
}

function buildPcChangeText(prevComp, currComp) {
    const prev = prevComp || {};
    const curr = currComp || {};
    const lines = [];

    lines.push(`━━━━ 🖥️ PC 전체 사양 및 변경 내역 ━━━━`);

    COMP_ORDER.forEach(k => {
        const before = normalizePcValue(prev[k]);
        const after  = normalizePcValue(curr[k]);

        if (!before && after) {
            lines.push(`  🆕 ${k}: ${after} (신규 장착)`);
        } else if (before && !after) {
            lines.push(`  ❌ ${k}: ${before} → 제거`);
        } else if (before && after && before !== after) {
            lines.push(`  🔄 ${k}: ${before} → ${after}`);
        } else if (after) {
            lines.push(`  ✅ ${k}: ${after} (유지)`);
        }
    });

    lines.push(``);
    return lines;
}

function buildVisitText(customer, pc, visit, shopName) {
    const lines = [];

    const visitDate = visit.visitDateStr || new Date(visit.visitDate || Date.now()).toLocaleString("ko-KR");
    const comp = visit.components || {};
    const prevVisit = getPrevVisitForText(customer, pc, visit);
    const prevComp = prevVisit?.components || null;

    lines.push(`╔══════════════════════════════╗`);
    lines.push(`║   🔧 PC 수리 진단 결과서   ║`);
    lines.push(`╚══════════════════════════════╝`);
    lines.push(``);
    lines.push(`👤 고객명: ${customer.name || ""}`);
    lines.push(`📞 연락처: ${customer.phone || ""}`);
    lines.push(`🖥️  PC명:   ${pc?.name || "기본PC"}`);
    lines.push(`📅 방문일: ${visitDate}`);
    lines.push(``);

    lines.push(...buildPcChangeText(prevComp, comp));

    const ramSlotEntries = getRamSlotEntries(visit.ramSlots);
    if (ramSlotEntries.length) {
        lines.push(`━━━━ 💾 RAM 슬롯 정보 ━━━━`);
        ramSlotEntries.forEach(item => lines.push(`  슬롯 ${item.index}: ${item.value}`));
        const totalGb = getRamTotalGb(visit.ramSlots);
        if (totalGb > 0) lines.push(`  총 용량: ${totalGb}GB`);
        lines.push(``);
    }

    const symptoms  = (visit.symptoms || []).filter(s => s.symptom !== "🔌 파워 테스터기 측정 결과");
    const psuSym    = (visit.symptoms || []).find(s  => s.symptom === "🔌 파워 테스터기 측정 결과");

    if (symptoms.length > 0) {
        lines.push(`━━━━ 🔍 진단 결과 ━━━━`);
        symptoms.forEach((s, i) => {
            lines.push(`[증상 ${i + 1}] ${s.symptom}`);
            if (s.componentLabel || s.component) lines.push(`  부품: ${s.componentLabel || s.component}${s.model ? " — " + s.model : ""}`);
            if (s.bsod) lines.push(`  💀 BSOD: ${s.bsod}`);
            if ((s.cause || []).length > 0) {
                lines.push(`  🔍 원인:`);
                s.cause.forEach(c => lines.push(`    - ${c}`));
            }
            if ((s.solution || []).length > 0) {
                lines.push(`  🔧 해결방안:`);
                s.solution.forEach(c => lines.push(`    - ${c}`));
            }
        });
        lines.push(``);
    }

    if (psuSym) {
        lines.push(`━━━━ ⚡ 파워 전압 측정 ━━━━`);
        if (psuSym.model) lines.push(`  파워 모델: ${psuSym.model}`);
        (psuSym.cause || []).forEach(line => {
            const isWarn = line.includes("범위 이탈");
            const isOk   = line.includes("정상");
            lines.push(`  ${isWarn ? "⚠️" : isOk ? "✅" : "  "} ${line}`);
        });
        const grade = (psuSym.solution || []).find(l => l.includes("종합 판정:"));
        if (grade) lines.push(`  📊 ${grade}`);
        lines.push(``);
    }

    const repairList = Array.isArray(visit.repairItems) ? visit.repairItems : [];
    if (repairList.length) {
        lines.push(`━━━━ 🧾 수리 견적 추가 내역 ━━━━`);
        repairList.forEach((item, idx) => {
            lines.push(`  [${idx + 1}] ${item.label || '추가수리'}${item.model ? ' — ' + item.model : ''}`);
            lines.push(`      수량 ${item.qty || 1} / 합계 ${(Number(item.total || 0) || 0).toLocaleString('ko-KR')}원`);
        });
        const repairTotalText = repairList.reduce((sum, item) => sum + (Number(item.total || 0) || 0), 0);
        lines.push(`  추가 수리 합계: ${repairTotalText.toLocaleString('ko-KR')}원`);
        lines.push(``);
    }

    if (visit.actions) {
        lines.push(`━━━━ ✅ 수리 조치 사항 ━━━━`);
        visit.actions.split("\n").forEach(l => lines.push(`  ${l}`));
        lines.push(``);
    }

    if (visit.cost) {
        lines.push(`━━━━ 💰 결제 금액 ━━━━`);
        lines.push(`  ${visit.cost}원`);
        lines.push(``);
    }

    if (visit.memo) {
        lines.push(`━━━━ 📝 메모 ━━━━`);
        lines.push(`  ${visit.memo}`);
        lines.push(``);
    }

    lines.push(`──────────────────────────────`);
    if (shopName) lines.push(shopName);
    lines.push(`문의사항이 있으시면 매장으로 연락 바랍니다.`);

    return lines.join("\n");
}

// ──────────────────────────────────────────
// 19.5 자동 견적 계산 API
// ──────────────────────────────────────────

const PRICE_CAT = {
    "CPU": "CPU", "메인보드": "메인보드", "RAM": "RAM", "GPU": "GPU",
    "공랭쿨러": "공랭쿨러", "수랭쿨러": "수랭쿨러", "파워": "파워",
    "케이스": "케이스", "SSD": "SSD", "HDD": "HDD", "운영체제": "운영체제"
};

const LABELS = {
    "CPU": "CPU", "메인보드": "메인보드", "RAM": "RAM", "GPU": "GPU",
    "공랭쿨러": "공랭 쿨러", "수랭쿨러": "수랭 쿨러", "파워": "파워",
    "케이스": "케이스", "SSD": "SSD", "HDD": "HDD", "운영체제": "운영체제"
};

/**
 * 가격 DB에서 부품 모델 조회
 */
function lookupPrice(compKey, model) {
    const db = loadPrices();
    const cat = PRICE_CAT[compKey];
    if (!cat || !db[cat]) return null;
    // 정확히 일치하는 키 우선, 없으면 부분 일치 탐색
    if (db[cat][model]) return { ...db[cat][model], key: model };
    const lower = model.toLowerCase();
    const found = Object.entries(db[cat]).find(([k]) => k.toLowerCase() === lower);
    if (found) return { ...found[1], key: found[0] };
    return null;
}

/**
 * solution/cause 배열에서 교체 필요 여부 판단 (한국어 키워드 기반)
 */
function needsReplacement(cause, solution) {
    const keywords = [
        '교체', '구매', '새로', '신품', '교환', '재구매',
        'replacement', '구입', '장착', '업그레이드', '호환',
        '불량', '파손', '고장', '수명', '마모', '노후화'
    ];
    const text = [...(cause || []), ...(solution || [])].join(' ');
    return keywords.some(kw => text.includes(kw));
}

/**
 * 견적 계산: 교체 필요 부품 → 부품가 + 공임, 그 외 → 점검비(공임 30%)
 */
function calculateEstimate(components_data, symptoms, laborRates = {}) {
    const defaultLabor = {
        CPU: 30000, 메인보드: 50000, RAM: 10000, GPU: 30000,
        공랭쿨러: 15000, 수랭쿨러: 40000, 파워: 20000,
        케이스: 0, SSD: 10000, HDD: 10000, 운영체제: 30000
    };

    let partsTotal = 0, laborTotal = 0;
    const breakdown = [];
    const missingPrices = [];

    // 증상 기반으로 교체 필요 부품 찾기
    const replaceTargets = new Set();
    for (const s of (symptoms || [])) {
        if (needsReplacement(s.cause, s.solution)) {
            replaceTargets.add(s.component);
        }
    }

    // 각 부품별 견적 산출
    for (const [compKey, model] of Object.entries(components_data)) {
        if (!model || model === '-') continue;

        const priceInfo = lookupPrice(compKey, model);
        const needsReplace = replaceTargets.has(compKey);

        let partPrice = 0;
        let priceSource = '미등록';

        if (priceInfo) {
            const normal = priceInfo.price || 0;
            const benefit = priceInfo.benefit || 0;
            partPrice = benefit > 0 && benefit < normal ? benefit : normal;
            priceSource = benefit > 0 && benefit < normal ? '혜택가' : '정상가';
        } else {
            missingPrices.push(`${LABELS[compKey] || compKey}: ${model}`);
        }

        const labor = laborRates[compKey] !== undefined ? laborRates[compKey] : (defaultLabor[compKey] !== undefined ? defaultLabor[compKey] : 20000);

        if (needsReplace && partPrice > 0) {
            partsTotal += partPrice;
            laborTotal += labor;
            breakdown.push({
                component: compKey,
                label: LABELS[compKey] || compKey,
                model, partPrice, labor,
                total: partPrice + labor,
                needsReplace: true, priceSource,
                link: priceInfo?.link || null
            });
        } else if (needsReplace && partPrice === 0) {
            laborTotal += labor;
            breakdown.push({
                component: compKey,
                label: LABELS[compKey] || compKey,
                model, partPrice: 0, labor,
                total: labor,
                needsReplace: true,
                priceSource: '가격미등록(별도문의)',
                link: null,
                warning: '부품 가격 미등록 - 별도 문의 필요'
            });
        } else {
            const checkFee = Math.floor(labor * 0.3);
            laborTotal += checkFee;
            breakdown.push({
                component: compKey,
                label: LABELS[compKey] || compKey,
                model, partPrice: 0, labor: checkFee,
                total: checkFee,
                needsReplace: false,
                priceSource: '점검비',
                link: null
            });
        }
    }

    return {
        partsTotal,
        laborTotal,
        grandTotal: partsTotal + laborTotal,
        breakdown,
        missingPrices,
        replaceCount: breakdown.filter(b => b.needsReplace).length
    };
}

app.post("/estimate", (req, res) => {
    const { components, symptoms, laborRates } = req.body;
    if (!components) return res.status(400).json({ error: "components 필요" });
    const estimate = calculateEstimate(components, symptoms || [], laborRates || {});
    res.json({ success: true, ...estimate });
});

// ──────────────────────────────────────────
// 19. SMS 발송 API (Solapi)
// ──────────────────────────────────────────
app.post("/send-sms", async (req, res) => {
    const { customerId, pcId, visitId, toPhone, message } = req.body;
    if (!toPhone || !message) return res.status(400).json({ error: "수신번호와 메시지가 필요합니다" });

    const cfg = loadConfig();
    const { apiKey, apiSecret, fromNumber } = cfg.solapi || {};

    if (!apiKey || !apiSecret || !fromNumber) {
        return res.json({ success: false, noConfig: true, message: "Solapi API 키가 설정되지 않았습니다. 설정에서 입력해주세요." });
    }

    try {
        // Solapi HMAC 인증
        const date = new Date().toISOString();
        const salt = crypto.randomBytes(16).toString("hex");
        const hmacStr = date + salt;
        const signature = crypto.createHmac("sha256", apiSecret).update(hmacStr).digest("hex");

        const payload = {
            message: {
                to:   toPhone.replace(/-/g, ""),
                from: fromNumber.replace(/-/g, ""),
                text: message.length > 2000 ? message.slice(0, 1997) + "..." : message,
                type: message.length > 90 ? "LMS" : "SMS"
            }
        };

        const response = await fetch("https://api.solapi.com/messages/v4/send", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`
            },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.errorCode) {
            console.error("❌ Solapi 오류:", data);
            return res.json({ success: false, error: `발송 실패: ${data.errorMessage || data.errorCode}` });
        }
        console.log(`✅ SMS 발송: ${toPhone} (${payload.message.type})`);
        res.json({ success: true, type: payload.message.type });
    } catch(e) {
        console.error("❌ SMS 발송 오류:", e.message);
        res.json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────
// 20. 텔레그램 발송 API
// ──────────────────────────────────────────
app.post("/send-telegram", async (req, res) => {
    const { chatId, message } = req.body;
    if (!message) return res.status(400).json({ error: "메시지가 필요합니다" });

    const cfg = loadConfig();
    const { botToken, defaultChatId } = cfg.telegram || {};
    const targetChatId = chatId || defaultChatId;

    if (!botToken) {
        return res.json({ success: false, noConfig: true, message: "텔레그램 Bot Token이 설정되지 않았습니다." });
    }
    if (!targetChatId) {
        return res.json({ success: false, noConfig: true, message: "텔레그램 Chat ID가 설정되지 않았습니다." });
    }

    try {
        const chunks = [];
        const MAX = 4000;
        for (let i = 0; i < message.length; i += MAX) chunks.push(message.slice(i, i + MAX));

        for (const chunk of chunks) {
            const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: targetChatId, text: chunk, parse_mode: "" })
            });
            const data = await response.json();
            if (!data.ok) {
                console.error("❌ 텔레그램 오류:", data);
                return res.json({ success: false, error: `텔레그램 오류: ${data.description}` });
            }
        }
        console.log(`✅ 텔레그램 발송 완료 → chatId: ${targetChatId}`);
        res.json({ success: true });
    } catch(e) {
        console.error("❌ 텔레그램 발송 오류:", e.message);
        res.json({ success: false, error: e.message });
    }
});

// ──────────────────────────────────────────
// 21. 방문기록 텍스트 조회 API
// ──────────────────────────────────────────
app.get("/customers/:customerId/pc/:pcId/visit/:visitId/text", (req, res) => {
    const customer = loadCustomersOnce().find(c => c.id == req.params.customerId);
    if (!customer) return res.status(404).json({ error: "고객 없음" });
    const pc = (customer.pcs||[]).find(p => p.pcId === req.params.pcId);
    if (!pc) return res.status(404).json({ error: "PC 없음" });
    const visit = (pc.visits||[]).find(v => v.visitId == req.params.visitId);
    if (!visit) return res.status(404).json({ error: "방문 기록 없음" });
    const cfg = loadConfig();
    const text = buildVisitText(customer, pc, visit, cfg.shopName);
    res.json({ success: true, text, customerPhone: customer.phone || "" });
});

// ──────────────────────────────────────────
// 22. 서버 시작
// ──────────────────────────────────────────
loadComponentsOnce();
loadIssuesOnce();
loadCustomersOnce();
console.log("📦 모든 데이터 메모리 로드 완료");

// ──────────────────────────────────────────
// 다나와 가격 DB API
// ──────────────────────────────────────────
const pricesDbPath = path.join(__dirname, "db/danawa_prices.json");
let pricesCache = null;

function loadPrices() {
    if (pricesCache) return pricesCache;
    if (!fs.existsSync(pricesDbPath)) return {};
    try {
        pricesCache = JSON.parse(fs.readFileSync(pricesDbPath, "utf8"));
        const total = Object.values(pricesCache).reduce((s, v) => s + Object.keys(v).length, 0);
        console.log(`💰 다나와 가격 DB 로드: ${total}개 상품`);
        return pricesCache;
    } catch(e) { console.error("❌ 가격 DB 로드 실패:", e.message); return {}; }
}

app.get("/prices", (req, res) => {
    res.json({ success: true, prices: loadPrices() });
});

// 특정 카테고리 가격 조회
app.get("/prices/:category", (req, res) => {
    const db = loadPrices();
    const cat = decodeURIComponent(req.params.category);
    res.json({ success: true, prices: db[cat] || {} });
});

// ── 다나와 엑셀 업로드 → prices DB 자동 갱신 ──
const uploadExcel = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ok = file.originalname.match(/\.(xlsx|xlsm|xls)$/i);
        cb(ok ? null : new Error('xlsx 파일만 허용됩니다'), !!ok);
    }
});

app.post("/prices/import-excel", uploadExcel.single("excel"), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "엑셀 파일이 필요합니다" });
    let XLSX;
    try { XLSX = require('xlsx'); } catch(e) {
        return res.status(500).json({ error: "xlsx 패키지가 없습니다. npm install xlsx 후 재시작" });
    }
    try {
        const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
        const wsName = wb.SheetNames.includes('DataMap') ? 'DataMap' : wb.SheetNames[0];
        const ws = wb.Sheets[wsName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

        const prices = {};
        let count = 0;
        for (let i = 1; i < rows.length; i++) {
            const [keyCol, cat, name, normalPrice, benefitPrice] = rows[i];
            if (!cat || !name) continue;
            if (!prices[cat]) prices[cat] = {};

            const priceObj = {
                price:   typeof normalPrice   === 'number' ? normalPrice   : 0,
                benefit: typeof benefitPrice  === 'number' ? benefitPrice  : 0,
                link:    (typeof rows[i][6] === 'string' && rows[i][6].startsWith('http')) ? rows[i][6] : ''
            };

            // 상품명(col2) 기준으로 저장: 더 낮은 혜택가가 있으면 업데이트
            if (!prices[cat][name]) {
                prices[cat][name] = priceObj;
                count++;
            } else {
                // 기존 항목보다 혜택가가 낮으면 업데이트
                const existing = prices[cat][name];
                const existBenefit = existing.benefit || existing.price || 0;
                const newBenefit = priceObj.benefit || priceObj.price || 0;
                if (newBenefit > 0 && newBenefit < existBenefit) {
                    prices[cat][name] = priceObj;
                }
            }

            // KEY 컬럼(col0)도 별칭으로 저장 (드롭다운 선택값 = SourceData 형식)
            if (keyCol && typeof keyCol === 'string' && keyCol !== name) {
                if (!prices[cat][keyCol]) {
                    prices[cat][keyCol] = priceObj;
                    count++;
                }
            }
        }

        fs.writeFileSync(pricesDbPath, JSON.stringify(prices, null, 2), 'utf8');
        pricesCache = prices;
        console.log(`✅ 다나와 가격 DB 갱신: ${count}개 상품`);
        res.json({ success: true, count, categories: Object.keys(prices) });
    } catch(e) {
        console.error("❌ 엑셀 파싱 오류:", e.message);
        res.status(500).json({ error: e.message });
    }
});


// ──────────────────────────────────────────
// 네이버 쇼핑 가격 자동검색 API (새로 시작용 안정 버전)
// config.json: { "naverShopping": { "clientId":"", "clientSecret":"" } }
// ──────────────────────────────────────────
function cleanNaverShopTitle(title) {
    return String(title || '')
        .replace(/<\/?b>/gi, '')
        .replace(/&quot;/gi, '"')
        .replace(/&amp;/gi, '&')
        .replace(/&#39;/gi, "'")
        .trim();
}
function toPriceNumber(v) {
    const n = parseInt(String(v || '0').replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : 0;
}
function savePricesDb(prices) {
    fs.writeFileSync(pricesDbPath, JSON.stringify(prices, null, 2), 'utf8');
    pricesCache = prices;
}

// 브라우저에서 바로 테스트 가능:
// /api/price-search?component=GPU&model=RTX%204060
app.get('/api/price-search', async (req, res) => {
    try {
        const component = String(req.query.component || '').trim();
        const model = String(req.query.model || '').trim();
        if (!component || !model) {
            return res.status(400).json({ success:false, error:'component와 model이 필요합니다.' });
        }
        const cfg = loadConfig();
        const clientId = cfg.naverShopping?.clientId || '';
        const clientSecret = cfg.naverShopping?.clientSecret || '';
        if (!clientId || !clientSecret) {
            return res.status(400).json({ success:false, error:'db/config.json에 naverShopping.clientId / clientSecret을 입력하세요.' });
        }
        const url = 'https://openapi.naver.com/v1/search/shop.json?query=' + encodeURIComponent(model) + '&display=10&start=1&sort=sim';
        const r = await fetch(url, {
            headers: {
                'X-Naver-Client-Id': clientId,
                'X-Naver-Client-Secret': clientSecret
            }
        });
        let data;
        try { data = await r.json(); } catch(e) { data = { errorMessage: await r.text().catch(()=>String(e.message)) }; }
        if (!r.ok) {
            console.error('❌ 네이버 쇼핑 API 오류:', data);
            return res.status(r.status).json({ success:false, error:data.errorMessage || '네이버 쇼핑 API 오류', detail:data });
        }
        const items = (data.items || []).map((it, idx) => {
            const price = toPriceNumber(it.lprice);
            return {
                rank: idx + 1,
                component,
                model,
                title: cleanNaverShopTitle(it.title),
                price,
                benefit: price,
                link: it.link || '',
                image: it.image || '',
                mallName: it.mallName || '',
                brand: it.brand || '',
                maker: it.maker || ''
            };
        });
        res.json({ success:true, component, model, count:items.length, items });
    } catch(e) {
        console.error('❌ /api/price-search 서버 오류:', e);
        res.status(500).json({ success:false, error:e.message });
    }
});

// 선택한 네이버 검색 결과를 기존 danawa_prices.json에 저장
app.post('/api/price-apply', (req, res) => {
    try {
        const component = String(req.body.component || '').trim();
        const model = String(req.body.model || '').trim();
        const title = String(req.body.title || '').trim();
        if (!component || !model || !title) {
            return res.status(400).json({ success:false, error:'component, model, title은 필수입니다.' });
        }
        const db = loadPrices();
        if (!db[component]) db[component] = {};
        const price = toPriceNumber(req.body.price);
        const benefit = toPriceNumber(req.body.benefit || req.body.price);
        const priceObj = {
            price,
            benefit,
            link: req.body.link || '',
            source: 'naver_shopping',
            condition: req.body.mallName ? ('네이버쇼핑 / ' + req.body.mallName) : '네이버쇼핑 자동검색',
            searchedModel: model,
            savedTitle: title,
            updatedAt: new Date().toISOString()
        };
        db[component][model] = priceObj;   // 현재 선택 모델명으로 저장: UI 즉시 반영용
        db[component][title] = priceObj;   // 실제 상품명으로도 저장
        savePricesDb(db);
        res.json({ success:true, message:'가격 DB 저장 완료', component, model, saved:priceObj });
    } catch(e) {
        console.error('❌ /api/price-apply 서버 오류:', e);
        res.status(500).json({ success:false, error:e.message });
    }
});

// ──────────────────────────────────────────
// 진단 리포트 PDF 생성 / 문자 / 텔레그램 전송 API
// app.listen(PORT, ...) 바로 위에 추가
// ──────────────────────────────────────────

const REPORTS_DIR = path.join(__dirname, "web", "reports");
if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

function cleanPhoneNumber(v) {
    return String(v || "").replace(/[^0-9]/g, "");
}

function safeFileName(v) {
    return String(v || "report")
        .replace(/[<>:"/\\|?*\n\r\t]/g, "_")
        .replace(/\s+/g, "_")
        .slice(0, 80);
}

function getShopConfig() {
    const cfg = typeof loadConfig === "function" ? loadConfig() : {};
    return {
        shopName: cfg.shopName || cfg.shop?.name || "PC 수리점",
        shopPhone: cfg.shopPhone || cfg.shop?.phone || "",
        solapi: cfg.solapi || {},
        telegram: cfg.telegram || {}
    };
}

function findVisitForReport(customerId, visitId) {
    const customer = loadCustomersOnce().find(c => String(c.id) === String(customerId));
    if (!customer) return null;

    for (const pc of customer.pcs || []) {
        const visit = (pc.visits || []).find(v => String(v.visitId) === String(visitId));
        if (visit) return { customer, pc, visit };
    }

    return null;
}

function buildReportUrl(req, pdfFileName) {
    const cfg = getShopConfig();

    // 외부 접속용 도메인을 나중에 쓰고 싶으면 config.json에 publicBaseUrl 추가 가능
    const publicBaseUrl = (typeof loadConfig === "function" ? loadConfig().publicBaseUrl : "") || "";
    if (publicBaseUrl) {
        return `${publicBaseUrl.replace(/\/$/, "")}/reports/${encodeURIComponent(pdfFileName)}`;
    }

    return `${req.protocol}://${req.get("host")}/reports/${encodeURIComponent(pdfFileName)}`;
}

async function generateVisitPdf(customerId, visitId, req) {
    const found = findVisitForReport(customerId, visitId);
    if (!found) throw new Error("고객 또는 방문기록을 찾을 수 없습니다.");

    const { customer, pc, visit } = found;
    const html = buildVisitReportHtml(
        customer,
        visit,
        pc.name || "기본PC",
        visit.symptoms || [],
        visit.components || {}
    );

    const puppeteer = require("puppeteer");

    const fileName =
        `${safeFileName(customer.name)}_${safeFileName(pc.name)}_${safeFileName(visit.visitDateStr || visit.visitDate)}_진단레포트.pdf`;

    const pdfPath = path.join(REPORTS_DIR, fileName);

    const browser = await puppeteer.launch({
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    try {
        const page = await browser.newPage();

        await page.setContent(html, {
            waitUntil: "networkidle0"
        });

        await page.pdf({
            path: pdfPath,
            format: "A4",
            printBackground: true,
            margin: {
                top: "12mm",
                bottom: "12mm",
                left: "10mm",
                right: "10mm"
            }
        });
    } finally {
        await browser.close();
    }

    return {
        fileName,
        pdfPath,
        url: buildReportUrl(req, fileName),
        customer,
        pc,
        visit
    };
}

// PDF 생성
app.post("/api/report/pdf", async (req, res) => {
    try {
        const { customerId, visitId } = req.body;

        if (!customerId || !visitId) {
            return res.status(400).json({
                success: false,
                error: "customerId, visitId가 필요합니다."
            });
        }

        const result = await generateVisitPdf(customerId, visitId, req);

        res.json({
            success: true,
            message: "PDF 생성 완료",
            fileName: result.fileName,
            url: result.url
        });

    } catch (e) {
        console.error("❌ PDF 생성 오류:", e);
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// 문자로 PDF 링크 전송
app.post("/api/report/send-sms", async (req, res) => {
    try {
        const { customerId, visitId, to, text } = req.body;
        const cfg = getShopConfig();

        if (!cfg.solapi.apiKey || !cfg.solapi.apiSecret || !cfg.solapi.fromNumber) {
            return res.status(400).json({
                success: false,
                error: "db/config.json에 solapi apiKey/apiSecret/fromNumber를 입력하세요."
            });
        }

        const result = await generateVisitPdf(customerId, visitId, req);
        const toNumber = cleanPhoneNumber(to || result.customer.phone);
        const fromNumber = cleanPhoneNumber(cfg.solapi.fromNumber);

        if (!toNumber) {
            return res.status(400).json({
                success: false,
                error: "수신번호가 없습니다."
            });
        }

        const { SolapiMessageService } = require("solapi");
        const messageService = new SolapiMessageService(
            cfg.solapi.apiKey,
            cfg.solapi.apiSecret
        );

        const messageText = text || `[${cfg.shopName}]
${result.customer.name} 고객님 PC 진단레포트가 생성되었습니다.

확인 링크:
${result.url}

문의: ${cfg.shopPhone || fromNumber}`;

        await messageService.send({
            to: toNumber,
            from: fromNumber,
            text: messageText
        });

        res.json({
            success: true,
            message: "문자 전송 완료",
            url: result.url
        });

    } catch (e) {
        console.error("❌ 문자 전송 오류:", e);
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// 텔레그램으로 PDF 파일 전송
app.post("/api/report/send-telegram", async (req, res) => {
    try {
        const { customerId, visitId, chatId, caption } = req.body;
        const cfg = getShopConfig();

        if (!cfg.telegram.botToken) {
            return res.status(400).json({
                success: false,
                error: "db/config.json에 telegram.botToken을 입력하세요."
            });
        }

        const targetChatId = chatId || cfg.telegram.defaultChatId;
        if (!targetChatId) {
            return res.status(400).json({
                success: false,
                error: "telegram.defaultChatId 또는 chatId가 필요합니다."
            });
        }

        const result = await generateVisitPdf(customerId, visitId, req);

        const form = new FormData();
        form.append("chat_id", targetChatId);
        form.append(
            "caption",
            caption || `[${cfg.shopName}] ${result.customer.name} 고객님 진단레포트`
        );

        const pdfBuffer = fs.readFileSync(result.pdfPath);
        const pdfBlob = new Blob([pdfBuffer], { type: "application/pdf" });
        form.append("document", pdfBlob, result.fileName);

        const tgRes = await fetch(
            `https://api.telegram.org/bot${cfg.telegram.botToken}/sendDocument`,
            {
                method: "POST",
                body: form
            }
        );

        const tgData = await tgRes.json();

        if (!tgRes.ok || !tgData.ok) {
            return res.status(400).json({
                success: false,
                error: tgData.description || "텔레그램 전송 실패",
                detail: tgData
            });
        }

        res.json({
            success: true,
            message: "텔레그램 전송 완료",
            url: result.url
        });

    } catch (e) {
        console.error("❌ 텔레그램 전송 오류:", e);
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});

// 카카오톡용 텍스트 생성
app.post("/api/report/kakao-text", async (req, res) => {
    try {
        const { customerId, visitId } = req.body;
        const cfg = getShopConfig();
        const result = await generateVisitPdf(customerId, visitId, req);

        const text = `[${cfg.shopName}]
${result.customer.name} 고객님 PC 진단레포트입니다.

PC명: ${result.pc.name || "기본PC"}
방문일: ${result.visit.visitDateStr || result.visit.visitDate}

PDF 확인:
${result.url}

문의: ${cfg.shopPhone || ""}`;

        res.json({
            success: true,
            text,
            url: result.url
        });

    } catch (e) {
        console.error("❌ 카카오톡 텍스트 생성 오류:", e);
        res.status(500).json({
            success: false,
            error: e.message
        });
    }
});




// ──────────────────────────────────────────
// CPU 튜닝 프로파일 API
// ──────────────────────────────────────────
app.get("/api/cpu-tuning-profiles", (req, res) => {
    try {
        const { customerId, pcId } = req.query;
        let list = loadCpuTuningProfilesDb();
        if (customerId) list = list.filter(p => String(p.customerId || "") === String(customerId));
        if (pcId) list = list.filter(p => String(p.pcId || "") === String(pcId));
        list.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
        res.json({ success: true, profiles: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/cpu-tuning-profiles/:profileId", (req, res) => {
    try {
        const list = loadCpuTuningProfilesDb();
        const profile = list.find(p => String(p.profileId) === String(req.params.profileId));
        if (!profile) return res.status(404).json({ success: false, error: "프로파일 없음" });
        res.json({ success: true, profile });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/cpu-tuning-profiles", (req, res) => {
    try {
        const body = req.body || {};
        if (!body.cpuDetail || !body.cpuDetail.vendor || !body.cpuDetail.cpuModel) {
            return res.status(400).json({ success: false, error: "cpuDetail.vendor와 cpuDetail.cpuModel이 필요합니다." });
        }
        const list = loadCpuTuningProfilesDb();
        const now = new Date().toISOString();
        let profile;
        if (body.profileId) {
            const idx = list.findIndex(p => String(p.profileId) === String(body.profileId));
            if (idx >= 0) {
                profile = { ...list[idx], ...body, updatedAt: now };
                list[idx] = profile;
            }
        }
        if (!profile) {
            profile = {
                profileId: generateId('cpu_tuning'),
                createdAt: now,
                updatedAt: now,
                customerId: body.customerId || null,
                customerName: body.customerName || '',
                pcId: body.pcId || null,
                pcName: body.pcName || '기본PC',
                profileName: body.profileName || (body.cpuDetail?.cpuModel || 'CPU 프로파일'),
                boardModel: body.boardModel || '',
                memoryModel: body.memoryModel || '',
                validation: body.validation || '추천값',
                cinebenchR23: body.cinebenchR23 || '',
                benchMemo: body.benchMemo || '',
                memo: body.memo || '',
                cpuDetail: body.cpuDetail || { vendor:'', cpuModel:'', intel:{}, amd:{} }
            };
            list.unshift(profile);
        }
        saveCpuTuningProfilesDb(list);
        res.json({ success: true, profile });
    } catch (e) {
        console.error('❌ CPU 튜닝 프로파일 저장 오류:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete("/api/cpu-tuning-profiles/:profileId", (req, res) => {
    try {
        const list = loadCpuTuningProfilesDb();
        const next = list.filter(p => String(p.profileId) !== String(req.params.profileId));
        saveCpuTuningProfilesDb(next);
        res.json({ success: true, deleted: list.length - next.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});



// ──────────────────────────────────────────
// 메모리 튜닝 프로파일 API
// ──────────────────────────────────────────
app.get("/api/memory-tuning-profiles", (req, res) => {
    try {
        const { customerId, pcId } = req.query;
        let list = loadMemoryTuningProfilesDb();
        if (customerId) list = list.filter(p => String(p.customerId || "") === String(customerId));
        if (pcId) list = list.filter(p => String(p.pcId || "") === String(pcId));
        list.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
        res.json({ success: true, profiles: list });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.get("/api/memory-tuning-profiles/:profileId", (req, res) => {
    try {
        const list = loadMemoryTuningProfilesDb();
        const profile = list.find(p => String(p.profileId) === String(req.params.profileId));
        if (!profile) return res.status(404).json({ success: false, error: "프로파일 없음" });
        res.json({ success: true, profile });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post("/api/memory-tuning-profiles", (req, res) => {
    try {
        const body = req.body || {};
        if (!body.memoryDetail || !body.memoryDetail.generation || !body.memoryDetail.model) {
            return res.status(400).json({ success: false, error: "memoryDetail.generation과 memoryDetail.model이 필요합니다." });
        }
        const list = loadMemoryTuningProfilesDb();
        const now = new Date().toISOString();
        let profile;
        if (body.profileId) {
            const idx = list.findIndex(p => String(p.profileId) === String(body.profileId));
            if (idx >= 0) {
                profile = { ...list[idx], ...body, updatedAt: now };
                list[idx] = profile;
            }
        }
        if (!profile) {
            profile = {
                profileId: generateId('memory_tuning'),
                createdAt: now,
                updatedAt: now,
                customerId: body.customerId || null,
                customerName: body.customerName || '',
                pcId: body.pcId || null,
                pcName: body.pcName || '기본PC',
                profileName: body.profileName || (body.memoryDetail?.model || '메모리 프로파일'),
                cpuModel: body.cpuModel || '',
                boardModel: body.boardModel || '',
                bootStatus: body.bootStatus || '미기록',
                validation: body.validation || '추천값',
                testTool: body.testTool || '',
                aidaLatency: body.aidaLatency || '',
                benchMemo: body.benchMemo || '',
                bootMemo: body.bootMemo || '',
                memo: body.memo || '',
                memoryDetail: body.memoryDetail || { generation:'', model:'', profileType:'XMP', presetKey:'', capacity:'', ic:'', trueLatencyNs:'', aidaLatency:'', ddr4:{ timings:{} }, ddr5:{ timings:{} } }
            };
            list.unshift(profile);
        }
        saveMemoryTuningProfilesDb(list);
        res.json({ success: true, profile });
    } catch (e) {
        console.error('❌ 메모리 튜닝 프로파일 저장 오류:', e);
        res.status(500).json({ success: false, error: e.message });
    }
});

app.delete("/api/memory-tuning-profiles/:profileId", (req, res) => {
    try {
        const list = loadMemoryTuningProfilesDb();
        const next = list.filter(p => String(p.profileId) !== String(req.params.profileId));
        saveMemoryTuningProfilesDb(next);
        res.json({ success: true, deleted: list.length - next.length });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 서버 실행: http://localhost:${PORT}`);
    console.log("🔒 보안 패치 적용 완료");
    console.log("📁 진단 저장 폴더: web/diagnosis/");
    console.log("📱 SMS 발송: POST /send-sms (Solapi)");
    console.log("✈️  텔레그램: POST /send-telegram (Bot API)");
    console.log("⚙️  설정:     GET/POST /config\n");
});