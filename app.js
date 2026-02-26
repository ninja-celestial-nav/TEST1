/* ============================================================
   一等船副 快速自學與測驗系統 - Main App Logic (v4)
   AI 解題 · 間隔重複 · 搜尋 · 速背模式 · Google 登入 · 雲端同步
   ============================================================ */

// ===== FIREBASE CONFIG =====
// 📌 請將下方替換為你的 Firebase 專案設定
const firebaseConfig = {
    apiKey: "YOUR_API_KEY",
    authDomain: "YOUR_PROJECT.firebaseapp.com",
    projectId: "YOUR_PROJECT_ID",
    storageBucket: "YOUR_PROJECT.appspot.com",
    messagingSenderId: "YOUR_SENDER_ID",
    appId: "YOUR_APP_ID"
};

// Firebase init (only if config is set)
let db = null, auth = null, currentUser = null;
const FIREBASE_READY = firebaseConfig.apiKey !== "YOUR_API_KEY";
if (FIREBASE_READY && typeof firebase !== 'undefined') {
    firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
}

const SUBJECT_META = [
    { key: '航海學', icon: '🧭', color: 'var(--subject-1)', colorLight: 'rgba(74,158,255,0.2)' },
    { key: '航行安全與氣象', icon: '⛈️', color: 'var(--subject-2)', colorLight: 'rgba(240,192,64,0.2)' },
    { key: '船舶通訊與航海英文', icon: '📡', color: 'var(--subject-3)', colorLight: 'rgba(78,205,196,0.2)' },
    { key: '貨物作業', icon: '📦', color: 'var(--subject-4)', colorLight: 'rgba(255,107,107,0.2)' },
    { key: '船舶操作與船上人員管理', icon: '🚢', color: 'var(--subject-5)', colorLight: 'rgba(167,139,250,0.2)' }
];

// Spaced repetition intervals (in days)
const SR_INTERVALS = [0, 1, 2, 4, 7, 14, 30];

let state = {
    currentSubject: null, page: 'home', history: [],
    studyQuestions: [], studyIndex: 0, studyRevealed: false, studyFilter: 'all',
    quizQuestions: [], quizIndex: 0, quizAnswers: {}, quizTimer: null, quizTimeLeft: 0, quizSubmitted: false,
    speedMode: false, speedCorrect: 0, speedWrong: 0, speedTotal: 0,
    searchResults: []
};

// ===== GOOGLE SIGN-IN =====
function googleSignIn() {
    if (!FIREBASE_READY) { alert('⚠️ Firebase 尚未設定。請聯絡管理員。'); return; }
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider).catch(e => alert('登入失敗: ' + e.message));
}

function googleSignOut() {
    if (!auth) return;
    auth.signOut().then(() => { currentUser = null; renderUserArea(); renderHome(); });
}

function renderUserArea() {
    const area = document.getElementById('userArea');
    if (!area) return;
    if (currentUser) {
        const photo = currentUser.photoURL || '';
        const name = currentUser.displayName || '使用者';
        area.innerHTML = `
            <div class="user-info" onclick="googleSignOut()" title="點擊登出">
                <img class="user-avatar" src="${photo}" alt="" onerror="this.style.display='none'">
                <span class="user-name">${name.split(' ')[0]}</span>
                <span class="sync-badge" id="syncBadge">☁️</span>
            </div>`;
    } else if (FIREBASE_READY) {
        area.innerHTML = `<button class="login-btn" onclick="googleSignIn()">🔑 Google 登入</button>`;
    } else {
        area.innerHTML = '';
    }
}

// ===== PERSISTENCE (localStorage + Firestore) =====
function getProgress() { try { return JSON.parse(localStorage.getItem('quiz_progress') || '{}'); } catch { return {}; } }

let _syncTimer = null;
function saveProgress(data) {
    localStorage.setItem('quiz_progress', JSON.stringify(data));
    // Debounced cloud sync
    if (currentUser && db) {
        clearTimeout(_syncTimer);
        _syncTimer = setTimeout(() => syncToCloud(data), 1500);
    }
}
function getSubjectProgress(subject) {
    const p = getProgress();
    if (!p[subject]) p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    if (!p[subject].seen) p[subject].seen = [];
    if (!p[subject].sr) p[subject].sr = {};
    return p[subject];
}
function markFamiliar(subject, qId) {
    const p = getProgress();
    if (!p[subject]) p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    if (!p[subject].familiar.includes(qId)) p[subject].familiar.push(qId);
    p[subject].wrong = p[subject].wrong.filter(id => id !== qId);
    if (!p[subject].seen) p[subject].seen = [];
    if (!p[subject].seen.includes(qId)) p[subject].seen.push(qId);
    // Update spaced repetition
    if (!p[subject].sr) p[subject].sr = {};
    const sr = p[subject].sr[qId] || { level: 0, next: 0 };
    sr.level = Math.min(sr.level + 1, SR_INTERVALS.length - 1);
    sr.next = Date.now() + SR_INTERVALS[sr.level] * 86400000;
    p[subject].sr[qId] = sr;
    saveProgress(p);
}
function markUnfamiliar(subject, qId) {
    const p = getProgress();
    if (!p[subject]) p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    if (!p[subject].wrong.includes(qId)) p[subject].wrong.push(qId);
    p[subject].familiar = p[subject].familiar.filter(id => id !== qId);
    if (!p[subject].seen) p[subject].seen = [];
    if (!p[subject].seen.includes(qId)) p[subject].seen.push(qId);
    // Reset spaced repetition
    if (!p[subject].sr) p[subject].sr = {};
    p[subject].sr[qId] = { level: 0, next: Date.now() };
    saveProgress(p);
}
function markSeen(subject, qId) {
    const p = getProgress();
    if (!p[subject]) p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    if (!p[subject].seen) p[subject].seen = [];
    if (!p[subject].seen.includes(qId)) { p[subject].seen.push(qId); saveProgress(p); }
}
function saveQuizScore(subject, score, total, wrong) {
    const p = getProgress();
    if (!p[subject]) p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    p[subject].quizScores.push({ score, total, date: Date.now(), wrongIds: wrong });
    wrong.forEach(id => { if (!p[subject].wrong.includes(id)) p[subject].wrong.push(id); });
    saveProgress(p);
}
function clearSubjectProgress(subject) {
    const p = getProgress();
    p[subject] = { familiar: [], wrong: [], quizScores: [], seen: [], sr: {} };
    saveProgress(p);
}

// ===== AI / GEMINI =====
function getApiKey() { return localStorage.getItem('gemini_api_key') || ''; }
function setApiKey(key) { localStorage.setItem('gemini_api_key', key.trim()); }

// AI explain for study mode — reads question from state directly
function aiExplainStudy() {
    const q = state.studyQuestions[state.studyIndex];
    if (!q) return;
    const container = document.querySelector('#studyContent .question-card') || document.getElementById('studyControls');
    _callAI(q, container);
}

// Shared AI call logic
function _callAI(q, container) {
    const apiKey = getApiKey();
    if (!apiKey) { showSettings(); return; }

    let aiPanel = container.querySelector('.ai-panel');
    if (aiPanel && aiPanel.style.display !== 'none') { aiPanel.style.display = 'none'; return; }
    if (!aiPanel) { aiPanel = document.createElement('div'); aiPanel.className = 'ai-panel'; container.appendChild(aiPanel); }
    aiPanel.style.display = 'block';
    aiPanel.innerHTML = '<div class="ai-loading"><div class="spinner"></div>AI 分析中...</div>';
    aiExplainInPanel(q, aiPanel, apiKey);
}

function renderMarkdown(text) {
    return text
        .replace(/## (.*)/g, '<h3>$1</h3>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        .replace(/`(.*?)`/g, '<code>$1</code>')
        .replace(/\n- /g, '\n• ')
        .replace(/\n(\d+)\. /g, '\n$1. ')
        .replace(/\n/g, '<br>');
}

function aiExplainFromReview(idx) {
    const q = state.quizQuestions[idx];
    if (!q) return;
    const item = document.querySelector('#reviewList .review-item[data-idx="' + idx + '"]');
    if (!item) return;
    _callAI(q, item);
}

// Model fallback chain — each model has independent free quota
const AI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.0-flash-lite', 'gemini-2.0-flash'];

async function aiExplainInPanel(q, aiPanel, apiKey, modelIdx = 0) {
    const prompt = `你是一位經驗豐富的航海考試輔導老師。請用繁體中文詳細解釋以下航海考試題目。

題目：${q.question.replace(/\[圖片:[^\]]*\]/g, '(略圖)')}

選項：
A. ${(q.options.A || '').replace(/\[圖片:[^\]]*\]/g, '(略圖)')}
B. ${(q.options.B || '').replace(/\[圖片:[^\]]*\]/g, '(略圖)')}
C. ${(q.options.C || '').replace(/\[圖片:[^\]]*\]/g, '(略圖)')}
D. ${(q.options.D || '').replace(/\[圖片:[^\]]*\]/g, '(略圖)')}

正確答案：(${q.answer})

請按照以下格式回答：
## 📌 解題思路
簡述本題的核心概念和知識點。

## 📐 詳細解析
如果是計算題，請列出完整的計算步驟，每一步都要有說明。
如果是概念題，請解釋正確答案的推導邏輯。

## ❌ 其他選項分析
簡要說明為什麼其他選項是錯誤的。

## 💡 記憶口訣
提供一個方便記憶的口訣或聯想方式。`;

    const model = AI_MODELS[modelIdx];
    try {
        aiPanel.innerHTML = `<div class="ai-loading"><div class="spinner"></div>AI 分析中... (${model})</div>`;

        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 2048 }
            })
        });

        if (res.status === 429 && modelIdx < AI_MODELS.length - 1) {
            // Rate limited — try next model
            aiPanel.innerHTML = `<div class="ai-loading"><div class="spinner"></div>⏳ ${model} 額度已滿，切換至 ${AI_MODELS[modelIdx + 1]}...</div>`;
            await new Promise(r => setTimeout(r, 500));
            return aiExplainInPanel(q, aiPanel, apiKey, modelIdx + 1);
        }

        if (res.status === 429) {
            // All models exhausted — wait and retry first model
            const errData = await res.json().catch(() => ({}));
            const errMsg = errData.error?.message || '';
            const match = errMsg.match(/retry in ([\d.]+)s/i);
            let waitSec = match ? Math.ceil(parseFloat(match[1])) : 30;
            waitSec = Math.min(waitSec, 60);
            for (let i = waitSec; i > 0; i--) {
                aiPanel.innerHTML = `<div class="ai-loading"><div class="spinner"></div>⏳ 所有模型額度已滿，${i} 秒後重試...</div>`;
                await new Promise(r => setTimeout(r, 1000));
            }
            return aiExplainInPanel(q, aiPanel, apiKey, 0);
        }

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error?.message || `API 錯誤 (${res.status})`);
        }
        const data = await res.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '無法生成解析';
        aiPanel.innerHTML = `<div class="ai-content">${renderMarkdown(text)}</div>
      <button class="ai-close" onclick="this.parentElement.style.display='none'">收起解析</button>`;
    } catch (e) {
        if (modelIdx < AI_MODELS.length - 1) {
            return aiExplainInPanel(q, aiPanel, apiKey, modelIdx + 1);
        }
        aiPanel.innerHTML = `<div class="ai-error">⚠️ ${e.message}<br><small>請確認 API Key 是否正確</small></div>
      <button class="ai-close" onclick="this.parentElement.style.display='none'">關閉</button>`;
    }
}

// ===== SETTINGS =====
function showSettings() {
    const modal = document.getElementById('settingsModal');
    modal.classList.remove('hidden');
    document.getElementById('apiKeyInput').value = getApiKey();
}
function closeSettings() {
    document.getElementById('settingsModal').classList.add('hidden');
}
function saveSettings() {
    setApiKey(document.getElementById('apiKeyInput').value);
    closeSettings();
}

// ===== NAVIGATION =====
function showPage(page) {
    const pages = ['pageHome', 'pageMode', 'pageQuizSetup', 'pageStudy', 'pageQuiz', 'pageResults', 'pageDashboard', 'pageSearch', 'pageSpeed'];
    pages.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add('hidden'); });
    const target = document.getElementById('page' + page.charAt(0).toUpperCase() + page.slice(1));
    if (target) target.classList.remove('hidden');
    document.getElementById('navBack').style.display = page === 'home' ? 'none' : 'inline-block';
    state.page = page;
}

function goBack() {
    if (state.quizTimer) { clearInterval(state.quizTimer); state.quizTimer = null; }
    if (state.page === 'mode' || state.page === 'results' || state.page === 'dashboard') {
        state.currentSubject = null;
        showPage('home');
        document.getElementById('headerSubtitle').textContent = '五大科目 · 超過 10,000 題考古題';
        renderHome();
    } else if (state.page === 'quizSetup' || state.page === 'study' || state.page === 'speed' || state.page === 'search') {
        showPage('mode');
    } else if (state.page === 'quiz') {
        if (state.quizSubmitted || confirm('確定要離開測驗嗎？進度將不會儲存。')) { showPage('mode'); }
    } else { showPage('home'); }
}

// ===== HOME PAGE =====
function renderHome() {
    const grid = document.getElementById('subjectsGrid');
    let totalQ = 0, totalFamiliar = 0, totalWrong = 0, totalQuizzes = 0, totalDue = 0;

    SUBJECT_META.forEach(meta => {
        const questions = QUESTION_DB[meta.key] || [];
        const progress = getSubjectProgress(meta.key);
        totalQ += questions.length;
        totalFamiliar += progress.familiar.length;
        totalWrong += progress.wrong.length;
        totalQuizzes += progress.quizScores.length;
        totalDue += getDueCount(meta.key);
    });

    const banner = document.getElementById('statsBanner');
    if (banner) {
        const overallPct = totalQ > 0 ? Math.round(totalFamiliar / totalQ * 100) : 0;
        banner.innerHTML = `
      <div class="stat-mini"><span class="stat-val">${totalQ.toLocaleString()}</span><span class="stat-lbl">總題數</span></div>
      <div class="stat-mini"><span class="stat-val">${totalFamiliar.toLocaleString()}</span><span class="stat-lbl">已熟悉</span></div>
      <div class="stat-mini"><span class="stat-val">${totalWrong}</span><span class="stat-lbl">待複習</span></div>
      <div class="stat-mini"><span class="stat-val">${totalDue}</span><span class="stat-lbl">📅 今日到期</span></div>
      <div class="stat-mini"><span class="stat-val">${overallPct}%</span><span class="stat-lbl">整體進度</span></div>
    `;
    }

    grid.innerHTML = '';
    SUBJECT_META.forEach((meta) => {
        const questions = QUESTION_DB[meta.key] || [];
        const progress = getSubjectProgress(meta.key);
        const familiarCount = progress.familiar.length;
        const totalCount = questions.length;
        const pct = totalCount > 0 ? Math.round(familiarCount / totalCount * 100) : 0;
        const wrongCount = progress.wrong.length;
        const dueCount = getDueCount(meta.key);
        const avgScore = progress.quizScores.length > 0
            ? Math.round(progress.quizScores.reduce((s, q) => s + (q.score / q.total) * 100, 0) / progress.quizScores.length) : null;

        const card = document.createElement('div');
        card.className = 'subject-card';
        card.style.setProperty('--accent', meta.color);
        card.style.setProperty('--accent-light', meta.colorLight);
        card.onclick = () => selectSubject(meta.key);
        card.innerHTML = `
      <div class="icon">${meta.icon}</div>
      <h3>${meta.key}</h3>
      <div class="count">${totalCount} 題</div>
      <div class="progress-bar"><div class="fill" style="width:${pct}%; background:${meta.color};"></div></div>
      <div class="stats">
        <span>✅ ${familiarCount} 已熟悉 (${pct}%)</span>
        <span>${dueCount > 0 ? '📅 ' + dueCount + ' 到期 ' : ''}${wrongCount > 0 ? '❌ ' + wrongCount : ''}${avgScore !== null ? ' 📊 ' + avgScore + '%' : ''}</span>
      </div>
    `;
        grid.appendChild(card);
    });

    // Bottom buttons
    let btns = document.getElementById('homeBottomBtns');
    if (!btns) {
        btns = document.createElement('div');
        btns.id = 'homeBottomBtns';
        btns.className = 'home-bottom-btns';
        btns.innerHTML = `
      <div class="mode-btn" onclick="showDashboard()"><div class="emoji">📊</div><h3>學習總覽</h3><p>查看各科進度與成績趨勢</p></div>
    `;
        grid.parentElement.appendChild(btns);
    }
}

function getDueCount(subject) {
    const progress = getSubjectProgress(subject);
    if (!progress.sr) return 0;
    const now = Date.now();
    return Object.values(progress.sr).filter(sr => sr.next <= now).length;
}

function selectSubject(subject) {
    state.currentSubject = subject;
    const meta = SUBJECT_META.find(m => m.key === subject);
    document.getElementById('headerSubtitle').textContent = meta.icon + ' ' + subject;
    renderModeSelector();
    showPage('mode');
}

function renderModeSelector() {
    const progress = getSubjectProgress(state.currentSubject);
    const dueCount = getDueCount(state.currentSubject);
    const wrongCount = progress.wrong ? progress.wrong.length : 0;
    const container = document.getElementById('modeSelector');
    container.innerHTML = `
    <div class="mode-btn" onclick="startStudy()"><div class="emoji">📖</div><h3>學習模式</h3><p>逐題翻牌背誦，標記熟悉度</p></div>
    <div class="mode-btn" onclick="showQuizSetup()"><div class="emoji">📝</div><h3>測驗模式</h3><p>模擬考試，計時作答</p></div>
    <div class="mode-btn" onclick="startWrongReview()"><div class="emoji">🔖</div><h3>錯題複習</h3><p>${wrongCount > 0 ? wrongCount + ' 題待複習' : '沒有錯題 🎉'}</p></div>
    <div class="mode-btn${dueCount > 0 ? ' due-glow' : ''}" onclick="startDueReview()"><div class="emoji">📅</div><h3>今日複習</h3><p>${dueCount > 0 ? dueCount + ' 題到期' : '今日無到期'}</p></div>
    <div class="mode-btn speed-glow" onclick="startSpeedMode()"><div class="emoji">⚡</div><h3>速背模式</h3><p>快問快答，考前衝刺</p></div>
    <div class="mode-btn" onclick="showSearchPage()"><div class="emoji">🔍</div><h3>搜尋題目</h3><p>關鍵字搜尋</p></div>
  `;
}

// ===== STUDY MODE =====
function getFilteredStudyQuestions() {
    const all = QUESTION_DB[state.currentSubject] || [];
    const progress = getSubjectProgress(state.currentSubject);
    if (state.studyFilter === 'unseen') {
        return all.filter(q => !progress.seen || !progress.seen.includes(q.id));
    } else if (state.studyFilter === 'unfamiliar') {
        return all.filter(q => progress.wrong.includes(q.id));
    } else if (state.studyFilter === 'due') {
        const now = Date.now();
        return all.filter(q => progress.sr && progress.sr[q.id] && progress.sr[q.id].next <= now);
    }
    return [...all];
}

function startStudy() {
    state.studyFilter = 'all';
    state.studyQuestions = shuffle(getFilteredStudyQuestions());
    state.studyIndex = 0;
    state.studyRevealed = false;
    state.speedMode = false;
    document.querySelectorAll('#studyFilter .pill').forEach((p, i) => { p.classList.toggle('active', i === 0); });
    showPage('study');
    renderStudyCard();
}

function setStudyFilter(filter, el) {
    state.studyFilter = filter;
    state.studyQuestions = shuffle(getFilteredStudyQuestions());
    state.studyIndex = 0;
    state.studyRevealed = false;
    document.querySelectorAll('#studyFilter .pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    renderStudyCard();
}

function renderStudyCard() {
    const container = document.getElementById('studyContent');
    const controls = document.getElementById('studyControls');
    const info = document.getElementById('studyInfo');

    if (state.studyQuestions.length === 0) {
        container.innerHTML = '<div class="question-card" style="text-align:center;padding:40px;"><p style="font-size:1.3rem;">🎉 太棒了！</p><p style="color:var(--text-secondary);margin-top:8px;">此分類下沒有題目</p></div>';
        controls.innerHTML = '';
        info.textContent = '0 / 0';
        return;
    }

    const q = state.studyQuestions[state.studyIndex];
    info.textContent = `${state.studyIndex + 1} / ${state.studyQuestions.length}`;
    markSeen(state.currentSubject, q.id);

    let qText = formatQuestionText(q.question);
    let html = `<div class="question-card" style="position:relative;">
    <span class="q-number">第 ${state.studyIndex + 1} 題</span>
    <span class="q-source">${q.source}</span>
    <div class="q-text">${qText}</div>
    <div class="options-list">`;

    ['A', 'B', 'C', 'D'].forEach(letter => {
        const isCorrect = letter === q.answer;
        let cls = 'option-btn';
        if (state.studyRevealed && isCorrect) cls += ' correct';
        if (!state.studyRevealed) cls += '" onclick="studySelectOption(\'' + letter + '\')';
        html += `<div class="${cls}">
      <span class="letter">${letter}</span>
      <span>${formatOptionText(q.options[letter])}</span>
    </div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;

    if (!state.studyRevealed) {
        controls.innerHTML = `
      <button class="study-btn reveal" onclick="revealStudy()">👁️ 顯示答案</button>
      <span class="kbd-hint">空白鍵 翻牌 · 1234 選答</span>`;
    } else {
        controls.innerHTML = `
      <button class="ai-btn" onclick="aiExplainStudy()">🤖 AI 解題</button>
      <button class="study-btn know" onclick="studyMark('familiar')">✅ 已熟悉</button>
      <button class="study-btn dunno" onclick="studyMark('unfamiliar')">❌ 不熟</button>
      <button class="study-btn next" onclick="studyNext()">➡️ 下一題</button>
      <span class="kbd-hint">← → 切題 · 1=熟悉 2=不熟 3=下一題</span>`;
    }
}

function escStr(s) { return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n'); }

function studySelectOption(letter) {
    state.studyRevealed = true;
    const q = state.studyQuestions[state.studyIndex];
    const container = document.getElementById('studyContent');
    const controls = document.getElementById('studyControls');

    let qText = formatQuestionText(q.question);
    let html = `<div class="question-card" style="position:relative;">
    <span class="q-number">第 ${state.studyIndex + 1} 題</span>
    <span class="q-source">${q.source}</span>
    <div class="q-text">${qText}</div>
    <div class="options-list">`;

    ['A', 'B', 'C', 'D'].forEach(l => {
        let cls = 'option-btn';
        if (l === q.answer) cls += ' correct';
        if (l === letter && l !== q.answer) cls += ' wrong';
        html += `<div class="${cls}">
      <span class="letter">${l}</span>
      <span>${formatOptionText(q.options[l])}</span>
    </div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;

    const isCorrect = letter === q.answer;
    controls.innerHTML = `
    <div class="answer-feedback ${isCorrect ? 'correct' : 'wrong'}">
      ${isCorrect ? '✅ 正確！' : '❌ 錯誤！正確答案是 (' + q.answer + ')'}
    </div>
    <button class="ai-btn" onclick="aiExplainStudy()">🤖 AI 解題</button>
    <button class="study-btn know" onclick="studyMark('familiar')">✅ 已熟悉</button>
    <button class="study-btn dunno" onclick="studyMark('unfamiliar')">❌ 不熟</button>
    <button class="study-btn next" onclick="studyNext()">➡️ 下一題</button>`;
}

function revealStudy() { state.studyRevealed = true; renderStudyCard(); }

function studyMark(type) {
    const q = state.studyQuestions[state.studyIndex];
    if (type === 'familiar') markFamiliar(state.currentSubject, q.id);
    else markUnfamiliar(state.currentSubject, q.id);
    studyNext();
}

function studyNext() {
    if (state.studyFilter !== 'all') {
        state.studyQuestions = getFilteredStudyQuestions();
        if (state.studyIndex >= state.studyQuestions.length) state.studyIndex = 0;
        else state.studyIndex++;
        if (state.studyIndex >= state.studyQuestions.length) state.studyIndex = 0;
    } else {
        state.studyIndex++;
        if (state.studyIndex >= state.studyQuestions.length) state.studyIndex = 0;
    }
    state.studyRevealed = false;
    renderStudyCard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function studyPrev() {
    state.studyIndex--;
    if (state.studyIndex < 0) state.studyIndex = state.studyQuestions.length - 1;
    state.studyRevealed = false;
    renderStudyCard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== DUE REVIEW (Spaced Repetition) =====
function startDueReview() {
    const dueCount = getDueCount(state.currentSubject);
    if (dueCount === 0) { alert('📅 今日沒有到期的複習題目！'); return; }
    state.studyFilter = 'due';
    state.studyQuestions = shuffle(getFilteredStudyQuestions());
    state.studyIndex = 0;
    state.studyRevealed = false;
    document.querySelectorAll('#studyFilter .pill').forEach(p => p.classList.remove('active'));
    showPage('study');
    renderStudyCard();
}

// ===== SPEED MODE =====
function startSpeedMode() {
    const all = QUESTION_DB[state.currentSubject] || [];
    if (all.length === 0) return;
    state.speedMode = true;
    state.speedCorrect = 0;
    state.speedWrong = 0;
    state.speedTotal = 0;
    state.studyQuestions = shuffle(all);
    state.studyIndex = 0;
    showPage('speed');
    renderSpeedCard();
}

function renderSpeedCard() {
    const container = document.getElementById('speedContent');
    const info = document.getElementById('speedInfo');

    if (state.studyIndex >= state.studyQuestions.length) {
        // End of speed mode
        const pct = state.speedTotal > 0 ? Math.round(state.speedCorrect / state.speedTotal * 100) : 0;
        container.innerHTML = `<div class="question-card" style="text-align:center;padding:40px;">
      <p style="font-size:2rem;margin-bottom:16px;">⚡ 速背完成！</p>
      <div class="results-stats" style="max-width:400px;margin:0 auto;">
        <div class="stat-box"><div class="val" style="color:var(--green)">${state.speedCorrect}</div><div class="label">答對</div></div>
        <div class="stat-box"><div class="val" style="color:var(--coral)">${state.speedWrong}</div><div class="label">答錯</div></div>
        <div class="stat-box"><div class="val" style="color:var(--gold)">${pct}%</div><div class="label">正確率</div></div>
      </div>
      <button class="start-quiz-btn" onclick="goBack()" style="margin-top:20px;background:var(--bg-glass);border:1px solid var(--border-glass);">返回</button>
    </div>`;
        info.textContent = `完成 ${state.speedTotal} 題`;
        return;
    }

    const q = state.studyQuestions[state.studyIndex];
    info.innerHTML = `<span style="color:var(--green)">✅ ${state.speedCorrect}</span> · <span style="color:var(--coral)">❌ ${state.speedWrong}</span> · 第 ${state.studyIndex + 1}/${state.studyQuestions.length} 題`;

    let qText = formatQuestionText(q.question);
    let html = `<div class="question-card speed-card">
    <div class="q-text">${qText}</div>
    <div class="options-list">`;
    ['A', 'B', 'C', 'D'].forEach(letter => {
        html += `<div class="option-btn" onclick="speedAnswer('${letter}')">
      <span class="letter">${letter}</span>
      <span>${formatOptionText(q.options[letter])}</span>
    </div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;
}

function speedAnswer(letter) {
    const q = state.studyQuestions[state.studyIndex];
    const isCorrect = letter === q.answer;
    state.speedTotal++;

    if (isCorrect) {
        state.speedCorrect++;
        markFamiliar(state.currentSubject, q.id);
    } else {
        state.speedWrong++;
        markUnfamiliar(state.currentSubject, q.id);
    }

    // Flash feedback
    const container = document.getElementById('speedContent');
    const options = container.querySelectorAll('.option-btn');
    options.forEach(opt => {
        const l = opt.querySelector('.letter').textContent;
        if (l === q.answer) opt.classList.add('correct');
        if (l === letter && !isCorrect) opt.classList.add('wrong');
    });

    setTimeout(() => {
        state.studyIndex++;
        renderSpeedCard();
    }, 500);
}

// ===== SEARCH =====
function showSearchPage() {
    showPage('search');
    document.getElementById('searchInput').value = '';
    document.getElementById('searchResults').innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">輸入關鍵字搜尋題目...</div>';
    document.getElementById('searchInput').focus();
}

function performSearch() {
    const query = document.getElementById('searchInput').value.trim().toLowerCase();
    const resultsEl = document.getElementById('searchResults');
    if (!query || query.length < 2) {
        resultsEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">請輸入至少 2 個字</div>';
        return;
    }

    const all = QUESTION_DB[state.currentSubject] || [];
    const results = all.filter(q => {
        const text = (q.question + ' ' + Object.values(q.options).join(' ')).toLowerCase();
        return text.includes(query);
    }).slice(0, 50); // Max 50 results

    if (results.length === 0) {
        resultsEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:40px;">🔍 找不到相關題目</div>';
        return;
    }

    let html = `<div style="color:var(--text-secondary);margin-bottom:12px;font-size:0.85rem;">找到 ${results.length} 題${results.length >= 50 ? '（僅顯示前 50 題）' : ''}</div>`;
    results.forEach((q, i) => {
        const progress = getSubjectProgress(state.currentSubject);
        const isFamiliar = progress.familiar.includes(q.id);
        const isWrong = progress.wrong.includes(q.id);
        const badge = isFamiliar ? '<span class="search-badge familiar">✅</span>' : isWrong ? '<span class="search-badge wrong">❌</span>' : '';
        html += `<div class="search-item" onclick="jumpToQuestion(${all.indexOf(q)})">
      <div class="search-q">${badge}<strong>${i + 1}.</strong> ${truncateText(q.question, 120)}</div>
      <div class="search-meta"><span class="q-source">${q.source}</span> <span class="search-ans">答案: (${q.answer})</span></div>
    </div>`;
    });
    resultsEl.innerHTML = html;
}

function jumpToQuestion(idx) {
    const all = QUESTION_DB[state.currentSubject] || [];
    state.studyFilter = 'all';
    state.studyQuestions = all;
    state.studyIndex = idx;
    state.studyRevealed = false;
    document.querySelectorAll('#studyFilter .pill').forEach((p, i) => { p.classList.toggle('active', i === 0); });
    showPage('study');
    renderStudyCard();
}

// ===== QUIZ MODE =====
function showQuizSetup() { showPage('quizSetup'); }

function startQuiz() {
    const count = parseInt(document.getElementById('quizCount').value) || 40;
    const time = parseInt(document.getElementById('quizTime').value) || 60;
    const all = QUESTION_DB[state.currentSubject] || [];

    state.quizQuestions = shuffle(all).slice(0, Math.min(count, all.length));
    state.quizIndex = 0;
    state.quizAnswers = {};
    state.quizSubmitted = false;
    state.quizTimeLeft = time * 60;

    showPage('quiz');
    renderQuizDots();
    renderQuizQuestion();
    startTimer();
}

function startTimer() {
    if (state.quizTimer) clearInterval(state.quizTimer);
    updateTimerDisplay();
    state.quizTimer = setInterval(() => {
        state.quizTimeLeft--;
        updateTimerDisplay();
        if (state.quizTimeLeft <= 0) { clearInterval(state.quizTimer); submitQuiz(); }
    }, 1000);
}

function updateTimerDisplay() {
    const m = Math.floor(state.quizTimeLeft / 60);
    const s = state.quizTimeLeft % 60;
    const el = document.getElementById('quizTimer');
    el.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('warning', state.quizTimeLeft <= 300);
}

function renderQuizDots() {
    const container = document.getElementById('quizDots');
    container.innerHTML = '';
    state.quizQuestions.forEach((q, i) => {
        const dot = document.createElement('span');
        dot.className = 'q-dot';
        if (i === state.quizIndex) dot.classList.add('current');
        if (state.quizAnswers[i] !== undefined) dot.classList.add('answered');
        dot.title = `第 ${i + 1} 題`;
        dot.onclick = () => { state.quizIndex = i; renderQuizQuestion(); renderQuizDots(); };
        container.appendChild(dot);
    });
}

function renderQuizQuestion() {
    const q = state.quizQuestions[state.quizIndex];
    const container = document.getElementById('quizContent');
    const info = document.getElementById('quizInfo');
    info.textContent = `第 ${state.quizIndex + 1} / ${state.quizQuestions.length} 題`;

    let qText = formatQuestionText(q.question);
    let html = `<div class="question-card">
    <span class="q-number">第 ${state.quizIndex + 1} 題</span>
    <span class="q-source">${q.source}</span>
    <div class="q-text">${qText}</div>
    <div class="options-list">`;
    ['A', 'B', 'C', 'D'].forEach(letter => {
        const selected = state.quizAnswers[state.quizIndex] === letter;
        html += `<div class="option-btn${selected ? ' selected' : ''}" onclick="selectQuizAnswer('${letter}')">
      <span class="letter">${letter}</span>
      <span>${formatOptionText(q.options[letter])}</span>
    </div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;

    const nav = document.getElementById('quizNav');
    const answeredCount = Object.keys(state.quizAnswers).length;
    nav.innerHTML = `
    <button class="prev-btn" onclick="quizPrev()" ${state.quizIndex === 0 ? 'disabled' : ''}>← 上一題</button>
    <span style="color:var(--text-secondary);font-size:0.85rem;">已作答 ${answeredCount}/${state.quizQuestions.length}
      <button class="submit-inline" onclick="submitQuiz()">📋 交卷</button>
    </span>
    <button class="next-btn" onclick="quizNext()" ${state.quizIndex >= state.quizQuestions.length - 1 ? 'disabled' : ''}>下一題 →</button>
  `;
}

function selectQuizAnswer(letter) {
    if (state.quizSubmitted) return;
    state.quizAnswers[state.quizIndex] = letter;
    renderQuizQuestion();
    renderQuizDots();
    if (state.quizIndex < state.quizQuestions.length - 1) {
        setTimeout(() => { quizNext(); }, 300);
    }
}

function quizPrev() {
    if (state.quizIndex > 0) { state.quizIndex--; renderQuizQuestion(); renderQuizDots(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}
function quizNext() {
    if (state.quizIndex < state.quizQuestions.length - 1) { state.quizIndex++; renderQuizQuestion(); renderQuizDots(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
}

function submitQuiz() {
    if (!state.quizSubmitted) {
        const unanswered = state.quizQuestions.length - Object.keys(state.quizAnswers).length;
        if (unanswered > 0 && state.quizTimeLeft > 0) {
            if (!confirm(`還有 ${unanswered} 題未作答，確定要交卷嗎？`)) return;
        }
    }
    if (state.quizTimer) { clearInterval(state.quizTimer); state.quizTimer = null; }
    state.quizSubmitted = true;

    let correct = 0, wrongIds = [];
    state.quizQuestions.forEach((q, i) => {
        if (state.quizAnswers[i] === q.answer) correct++;
        else wrongIds.push(q.id);
    });

    saveQuizScore(state.currentSubject, correct, state.quizQuestions.length, wrongIds);
    renderResults(correct, wrongIds);
    renderHome();
}

// ===== RESULTS =====
function renderResults(correct, wrongIds) {
    showPage('results');
    const total = state.quizQuestions.length;
    const pct = Math.round(correct / total * 100);
    const circumference = 2 * Math.PI * 75;
    const offset = circumference - (pct / 100) * circumference;
    const passed = pct >= 60;
    const color = passed ? 'var(--green)' : 'var(--coral)';
    const timeUsed = state.quizTimeLeft !== undefined ? (parseInt(document.getElementById('quizTime')?.value || 60) * 60 - state.quizTimeLeft) : 0;
    const timeStr = `${Math.floor(timeUsed / 60)}分${timeUsed % 60}秒`;

    let html = `<div class="results-card">
    <div class="score-ring">
      <svg viewBox="0 0 170 170">
        <circle class="bg" cx="85" cy="85" r="75"/>
        <circle class="fg" cx="85" cy="85" r="75" stroke="${color}"
          stroke-dasharray="${circumference}" stroke-dashoffset="${offset}"/>
      </svg>
      <div class="score-text" style="color:${color}">${pct}%</div>
    </div>
    <div class="grade ${passed ? 'pass' : 'fail'}">${passed ? '🎉 及格！' : '💪 繼續加油！'}</div>
    <div class="score-label">${correct} / ${total} 題正確</div>
    <div class="results-stats">
      <div class="stat-box"><div class="val" style="color:var(--green)">${correct}</div><div class="label">答對</div></div>
      <div class="stat-box"><div class="val" style="color:var(--coral)">${total - correct}</div><div class="label">答錯</div></div>
      <div class="stat-box"><div class="val" style="color:var(--blue)">${timeStr}</div><div class="label">用時</div></div>
    </div>
  </div>`;

    html += `<div class="filter-pills" style="margin:20px 0 12px; justify-content:flex-start;">
    <span class="pill active" onclick="filterResults('all',this)">📋 全部 (${total})</span>
    <span class="pill" onclick="filterResults('wrong',this)">❌ 答錯 (${total - correct})</span>
    <span class="pill" onclick="filterResults('correct',this)">✅ 答對 (${correct})</span>
  </div>`;
    html += '<div class="review-list" id="reviewList">';
    state.quizQuestions.forEach((q, i) => {
        const userAns = state.quizAnswers[i] || '未作答';
        const isCorrect = userAns === q.answer;
        html += `<div class="review-item ${isCorrect ? 'is-correct' : 'is-wrong'}" data-result="${isCorrect ? 'correct' : 'wrong'}" data-idx="${i}">
      <div class="ri-q"><strong>${i + 1}.</strong> ${truncateText(q.question, 150)}</div>
      <div class="ri-answer">
        <span class="ri-your ${isCorrect ? 'match' : ''}">你的答案: (${userAns}) ${userAns !== '未作答' ? truncateText(q.options[userAns] || '', 50) : ''}</span>
        ${!isCorrect ? `<span class="ri-correct">正確答案: (${q.answer}) ${truncateText(q.options[q.answer] || '', 50)}</span>` : ''}
      </div>
      ${!isCorrect ? `<button class="ai-btn-sm" onclick="aiExplainFromReview(${i})">🤖 AI 解題</button>` : ''}
    </div>`;
    });
    html += '</div>';
    html += `<div style="text-align:center;margin-top:24px;display:flex;gap:12px;justify-content:center;">
    <button class="start-quiz-btn" onclick="goBack()" style="background:var(--bg-glass);border:1px solid var(--border-glass);">返回選單</button>
    <button class="start-quiz-btn" onclick="retakeQuiz()">🔄 重考一次</button>
  </div>`;

    document.getElementById('resultsContent').innerHTML = html;
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterResults(type, el) {
    document.querySelectorAll('.filter-pills .pill').forEach(p => p.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('#reviewList .review-item').forEach(item => {
        if (type === 'all') item.style.display = '';
        else item.style.display = item.dataset.result === type ? '' : 'none';
    });
}

function retakeQuiz() { showPage('mode'); showQuizSetup(); }

// ===== WRONG REVIEW =====
function startWrongReview() {
    const progress = getSubjectProgress(state.currentSubject);
    if (!progress.wrong || progress.wrong.length === 0) { alert('🎉 沒有需要複習的錯題！'); return; }
    const all = QUESTION_DB[state.currentSubject] || [];
    state.studyFilter = 'unfamiliar';
    state.studyQuestions = shuffle(all.filter(q => progress.wrong.includes(q.id)));
    state.studyIndex = 0;
    state.studyRevealed = false;
    document.querySelectorAll('#studyFilter .pill').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('#studyFilter .pill')[2]?.classList.add('active');
    showPage('study');
    renderStudyCard();
}

// ===== DASHBOARD =====
function showDashboard() { showPage('dashboard'); renderDashboard(); }

function renderDashboard() {
    const container = document.getElementById('pageDashboard');
    let html = '<div class="dashboard">';
    html += '<div class="dash-card full"><h3>📈 各科考試成績一覽</h3><div class="chart-area">';
    SUBJECT_META.forEach(meta => {
        const progress = getSubjectProgress(meta.key);
        const scores = progress.quizScores.slice(-8);
        if (scores.length === 0) {
            html += `<div class="chart-row"><span class="chart-label">${meta.icon} ${meta.key}</span><span class="chart-empty">尚未考試</span></div>`;
        } else {
            html += `<div class="chart-row"><span class="chart-label">${meta.icon} ${meta.key}</span><div class="chart-bars">`;
            scores.forEach(s => {
                const pct = Math.round(s.score / s.total * 100);
                html += `<div class="chart-bar" style="height:${pct}%;background:${pct >= 60 ? 'var(--green)' : 'var(--coral)'};" title="${pct}%"><span>${pct}</span></div>`;
            });
            html += '</div></div>';
        }
    });
    html += '</div></div>';

    SUBJECT_META.forEach(meta => {
        const questions = QUESTION_DB[meta.key] || [];
        const progress = getSubjectProgress(meta.key);
        const total = questions.length;
        const familiar = progress.familiar.length;
        const wrong = progress.wrong.length;
        const unseen = total - (progress.seen ? progress.seen.length : 0);
        const quizCount = progress.quizScores.length;
        const avgScore = quizCount > 0 ? Math.round(progress.quizScores.reduce((s, q) => s + (q.score / q.total) * 100, 0) / quizCount) : 0;

        html += `<div class="dash-card">
      <h3>${meta.icon} ${meta.key}</h3>
      <div class="dash-stats-grid">
        <div><span class="ds-val">${total}</span><span class="ds-lbl">總題數</span></div>
        <div><span class="ds-val" style="color:var(--green)">${familiar}</span><span class="ds-lbl">已熟悉</span></div>
        <div><span class="ds-val" style="color:var(--coral)">${wrong}</span><span class="ds-lbl">錯題</span></div>
        <div><span class="ds-val" style="color:var(--text-secondary)">${unseen}</span><span class="ds-lbl">未看過</span></div>
        <div><span class="ds-val">${quizCount}</span><span class="ds-lbl">考試次數</span></div>
        <div><span class="ds-val" style="color:var(--gold)">${avgScore}%</span><span class="ds-lbl">平均分</span></div>
      </div>
      <div class="progress-bar" style="margin-top:12px;"><div class="fill" style="width:${total > 0 ? Math.round(familiar / total * 100) : 0}%;background:${meta.color};"></div></div>
      <div style="margin-top:8px;text-align:right;">
        <button class="pill" onclick="if(confirm('確定清除此科目的所有進度嗎？')){clearSubjectProgress('${meta.key}');renderDashboard();renderHome();}">🗑️ 重置進度</button>
      </div>
    </div>`;
    });
    html += '</div>';
    container.innerHTML = html;
}

// ===== KEYBOARD SHORTCUTS =====
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (state.page === 'study') {
        if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            if (!state.studyRevealed) revealStudy(); else studyNext();
        } else if (e.key === 'ArrowRight') { e.preventDefault(); studyNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); studyPrev(); }
        else if (!state.studyRevealed && ['1', '2', '3', '4'].includes(e.key)) {
            e.preventDefault(); studySelectOption(['A', 'B', 'C', 'D'][parseInt(e.key) - 1]);
        } else if (state.studyRevealed) {
            if (e.key === '1') { e.preventDefault(); studyMark('familiar'); }
            else if (e.key === '2') { e.preventDefault(); studyMark('unfamiliar'); }
            else if (e.key === '3') { e.preventDefault(); studyNext(); }
        }
    } else if (state.page === 'quiz') {
        if (e.key === 'ArrowRight') { e.preventDefault(); quizNext(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); quizPrev(); }
        else if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); selectQuizAnswer(['A', 'B', 'C', 'D'][parseInt(e.key) - 1]); }
    } else if (state.page === 'speed') {
        if (['1', '2', '3', '4'].includes(e.key)) { e.preventDefault(); speedAnswer(['A', 'B', 'C', 'D'][parseInt(e.key) - 1]); }
    } else if (state.page === 'home' || state.page === 'mode') {
        if (e.key === 'Escape') { e.preventDefault(); goBack(); }
    }
});

// ===== HELPERS =====
function formatQuestionText(text) {
    return text.replace(/\[圖片: ([^\]]+)\]/g, '<img class="q-image" src="$1" loading="lazy" onerror="this.style.display=\'none\'">');
}
function formatOptionText(text) {
    if (!text) return '';
    return text.replace(/\[圖片: ([^\]]+)\]/g, '<img class="q-image" src="$1" loading="lazy" style="max-height:80px;" onerror="this.style.display=\'none\'">');
}
function truncateText(text, maxLen) {
    if (!text) return '';
    const clean = text.replace(/\[圖片:[^\]]*\]/g, '[圖]').replace(/\n/g, ' ');
    return clean.length > maxLen ? clean.substring(0, maxLen) + '…' : clean;
}
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// ===== CLOUD SYNC =====
async function syncToCloud(data) {
    if (!currentUser || !db) return;
    try {
        const badge = document.getElementById('syncBadge');
        if (badge) badge.textContent = '🔄';
        await db.collection('users').doc(currentUser.uid).set({
            progress: data,
            lastSync: firebase.firestore.FieldValue.serverTimestamp(),
            displayName: currentUser.displayName || '',
            email: currentUser.email || ''
        }, { merge: true });
        if (badge) { badge.textContent = '✅'; setTimeout(() => { if (badge) badge.textContent = '☁️'; }, 2000); }
    } catch (e) {
        console.error('Cloud sync failed:', e);
        const badge = document.getElementById('syncBadge');
        if (badge) badge.textContent = '⚠️';
    }
}

async function syncFromCloud() {
    if (!currentUser || !db) return;
    try {
        const doc = await db.collection('users').doc(currentUser.uid).get();
        if (doc.exists && doc.data().progress) {
            const cloudData = doc.data().progress;
            const localData = getProgress();
            const merged = mergeProgress(localData, cloudData);
            localStorage.setItem('quiz_progress', JSON.stringify(merged));
            // Push merged back to cloud
            await syncToCloud(merged);
        } else {
            // First time login — push local to cloud
            const localData = getProgress();
            if (Object.keys(localData).length > 0) {
                await syncToCloud(localData);
            }
        }
    } catch (e) { console.error('Cloud read failed:', e); }
}

function mergeProgress(local, cloud) {
    const merged = { ...local };
    for (const subject of Object.keys(cloud)) {
        if (!merged[subject]) { merged[subject] = cloud[subject]; continue; }
        const l = merged[subject], c = cloud[subject];
        // Merge arrays: union (keep all unique IDs)
        ['familiar', 'wrong', 'seen'].forEach(key => {
            const lArr = l[key] || [], cArr = c[key] || [];
            merged[subject][key] = [...new Set([...lArr, ...cArr])];
        });
        // Merge quiz scores: keep all unique by date
        const lScores = l.quizScores || [], cScores = c.quizScores || [];
        const scoreMap = new Map();
        [...lScores, ...cScores].forEach(s => scoreMap.set(s.date, s));
        merged[subject].quizScores = [...scoreMap.values()].sort((a, b) => a.date - b.date);
        // Merge SR: keep higher level / later next
        const lSr = l.sr || {}, cSr = c.sr || {};
        merged[subject].sr = { ...lSr };
        for (const qId of Object.keys(cSr)) {
            if (!merged[subject].sr[qId] || cSr[qId].level > (merged[subject].sr[qId].level || 0)) {
                merged[subject].sr[qId] = cSr[qId];
            }
        }
    }
    return merged;
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', () => {
    renderHome();
    showPage('home');
    renderUserArea();

    // Firebase auth listener
    if (auth) {
        auth.onAuthStateChanged(async (user) => {
            currentUser = user;
            renderUserArea();
            if (user) {
                await syncFromCloud();
                renderHome(); // Re-render with merged data
            }
        });
    }
});
