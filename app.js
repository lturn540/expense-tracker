// ============================================================
// Expense Tracker PWA v2 — Complete Rewrite
// ============================================================

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/expense-tracker/sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.warn('SW registration failed:', err));
    });
}

const CONFIG = {
    CLIENT_ID: '1053757888615-536rq74c096k5a3birh2e1lc9rs9mk9k.apps.googleusercontent.com',
    SPREADSHEET_ID: '1dKEt0tgWYkCjYXkMov_zwY9vXyjInY4zIeyXyhxfSgw',
    TAB_NAME: 'Expenses',
    SCOPES: 'https://www.googleapis.com/auth/spreadsheets',
    DISCOVERY_DOCS: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
    CATEGORIES: ['Utilities', 'Grocery/Toiletry', 'House Items', 'Other'],
    VENMO_USERNAMES: { Gigi: 'Gigi-Lopez-8', Luke: 'Luke-Turner-40' },
};

// Column mapping for Expenses tab: A=Date, B=Amount, C=WhoPaid, D=Category, E=Notes
const COL = { DATE: 0, AMOUNT: 1, WHO_PAID: 2, CATEGORY: 3, NOTES: 4 };

// ============================================================
// State
// ============================================================
let state = {
    isAuthenticated: false,
    accessToken: null,
    expenses: [],
    offlineQueue: JSON.parse(localStorage.getItem('offlineQueue') || '[]'),
    deleteQueue: JSON.parse(localStorage.getItem('deleteQueue') || '[]'),
    currentTab: 'add',
    gapiLoaded: false,
    gisLoaded: false,
    tokenClient: null,
    pendingDeleteRow: null,
    monthlyChart: null,
};

// ============================================================
// Date Helpers — M/D/YYYY format
// ============================================================

function toSheetDate(dateStr) {
    // Convert YYYY-MM-DD (from input[type=date]) to M/D/YYYY
    const [y, m, d] = dateStr.split('-');
    return `${parseInt(m)}/${parseInt(d)}/${y}`;
}

function parseSheetDate(sheetDate) {
    // Parse M/D/YYYY into a Date object. Handle edge cases.
    if (!sheetDate) return null;
    const parts = sheetDate.split('/');
    if (parts.length !== 3) return null;
    const [m, d, y] = parts;
    return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
}

function toISODate(sheetDate) {
    // M/D/YYYY -> YYYY-MM-DD for sorting
    const d = parseSheetDate(sheetDate);
    if (!d || isNaN(d.getTime())) return '0000-00-00';
    return d.toISOString().slice(0, 10);
}

function getMonthKey(sheetDate) {
    // M/D/YYYY -> "YYYY-MM" for grouping
    const d = parseSheetDate(sheetDate);
    if (!d || isNaN(d.getTime())) return null;
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    return `${d.getFullYear()}-${mm}`;
}

function monthKeyToLabel(key) {
    // "YYYY-MM" -> "February 2026"
    const [y, m] = key.split('-');
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${months[parseInt(m) - 1]} ${y}`;
}

function todaySheetDate() {
    const d = new Date();
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}

function currentMonthKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function prevMonthKey(key) {
    let [y, m] = key.split('-').map(Number);
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
}

// ============================================================
// Initialization
// ============================================================

function checkLibrariesLoaded() {
    if (typeof gapi !== 'undefined' && typeof google !== 'undefined' && google.accounts) {
        initializeApp();
    } else {
        setTimeout(checkLibrariesLoaded, 100);
    }
}

window.addEventListener('load', checkLibrariesLoaded);

function initializeApp() {
    gapi.load('client', async () => {
        await gapi.client.init({ discoveryDocs: CONFIG.DISCOVERY_DOCS });
        state.gapiLoaded = true;

        const storedToken = localStorage.getItem('gapi_token');
        if (storedToken) {
            try {
                const tokenData = JSON.parse(storedToken);
                if (tokenData.expires_at && tokenData.expires_at > Date.now() + 300000) {
                    gapi.client.setToken({ access_token: tokenData.access_token });
                    state.accessToken = tokenData.access_token;
                    state.isAuthenticated = true;
                    showMainApp();
                    await loadExpenses();
                    processRecurringExpenses();
                }
            } catch (e) {
                localStorage.removeItem('gapi_token');
            }
        }
    });

    state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: handleTokenResponse,
    });
    state.gisLoaded = true;

    document.getElementById('inp-date').valueAsDate = new Date();

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    updateOnlineStatus();
}

// ============================================================
// Authentication
// ============================================================

function handleSignIn() {
    if (!state.gisLoaded) { showToast('Loading...', 'info'); return; }
    state.tokenClient.requestAccessToken();
}

function handleTokenResponse(response) {
    if (response.error) {
        showAuthError('Authentication failed. Please try again.');
        return;
    }
    state.accessToken = response.access_token;
    state.isAuthenticated = true;
    localStorage.setItem('gapi_token', JSON.stringify({
        access_token: response.access_token,
        expires_at: Date.now() + (response.expires_in * 1000),
    }));
    gapi.client.setToken({ access_token: response.access_token });
    showMainApp();
    loadExpenses().then(() => processRecurringExpenses());
    syncOfflineQueue();
}

function handleSignOut() {
    const token = gapi.client.getToken();
    if (token) google.accounts.oauth2.revoke(token.access_token);
    gapi.client.setToken(null);
    state.isAuthenticated = false;
    state.accessToken = null;
    state.expenses = [];
    localStorage.removeItem('gapi_token');
    showAuthScreen();
}

function showAuthScreen() {
    document.getElementById('auth-screen').classList.remove('hidden');
    document.getElementById('main-app').classList.add('hidden');
}

function showMainApp() {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('main-app').classList.remove('hidden');
}

function showAuthError(msg) {
    const el = document.getElementById('auth-error');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 5000);
}

// ============================================================
// Google Sheets API — Expenses tab (A=Date, B=Amount, C=WhoPaid, D=Category, E=Notes)
// ============================================================

async function loadExpenses() {
    setSyncStatus('syncing');
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `'${CONFIG.TAB_NAME}'!A2:E`,
        });

        const rows = resp.result.values || [];
        state.expenses = rows.map((row, index) => ({
            rowIndex: index + 2,
            date: row[COL.DATE] || '',
            amount: parseAmount(row[COL.AMOUNT]),
            whoPaid: row[COL.WHO_PAID] || '',
            category: row[COL.CATEGORY] || '',
            notes: row[COL.NOTES] || '',
        }));

        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));
        renderAll();
        setSyncStatus('synced');
    } catch (err) {
        console.error('Error loading expenses:', err);
        if (err.status === 401) {
            handleSignOut();
            showToast('Session expired. Please sign in again.', 'error');
            return;
        }
        const cached = localStorage.getItem('cachedExpenses');
        if (cached) {
            state.expenses = JSON.parse(cached);
            renderAll();
            setSyncStatus('offline');
            showToast('Loaded cached data', 'info');
        } else {
            showToast('Failed to load expenses', 'error');
            setSyncStatus('error');
        }
    }
}

async function appendExpenseToSheet(expense) {
    const row = [
        expense.date,
        expense.amount.toFixed(2),
        expense.whoPaid,
        expense.category,
        expense.notes,
    ];
    await gapi.client.sheets.spreadsheets.values.append({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        range: `'${CONFIG.TAB_NAME}'!A:E`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [row] },
    });
}

async function deleteExpenseFromSheet(rowIndex) {
    const resp = await gapi.client.sheets.spreadsheets.get({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
    });
    const sheet = resp.result.sheets.find(s => s.properties.title === CONFIG.TAB_NAME);
    if (!sheet) throw new Error('Tab not found');

    await gapi.client.sheets.spreadsheets.batchUpdate({
        spreadsheetId: CONFIG.SPREADSHEET_ID,
        resource: {
            requests: [{
                deleteDimension: {
                    range: {
                        sheetId: sheet.properties.sheetId,
                        dimension: 'ROWS',
                        startIndex: rowIndex - 1,
                        endIndex: rowIndex,
                    }
                }
            }]
        }
    });
}

// ============================================================
// Render All
// ============================================================

function renderAll() {
    renderDashboard();
    renderMonthSelector();
    renderMonthDetail();
    renderSettleUp();
}

// ============================================================
// Tab 1: Add Expense
// ============================================================

function toggleRecurring() {
    const on = document.getElementById('recurring-toggle').checked;
    document.getElementById('recurring-fields').classList.toggle('hidden', !on);
    if (on) {
        document.getElementById('inp-recur-start').value = document.getElementById('inp-date').value;
    }
}

function toggleEndDate() {
    const noEnd = document.getElementById('no-end-date').checked;
    const inp = document.getElementById('inp-recur-end');
    inp.disabled = noEnd;
    inp.classList.toggle('bg-gray-50', noEnd);
    if (noEnd) inp.value = '';
}

async function handleSubmitExpense(event) {
    event.preventDefault();

    const desc = document.getElementById('inp-desc').value.trim();
    const amount = parseFloat(document.getElementById('inp-amount').value);
    const category = document.getElementById('inp-category').value;
    const whoPaid = document.querySelector('input[name="who-paid"]:checked')?.value;
    const dateVal = document.getElementById('inp-date').value; // YYYY-MM-DD
    const notes = document.getElementById('inp-notes').value.trim();

    if (!desc || !amount || !category || !whoPaid || !dateVal) {
        showToast('Please fill in all required fields', 'error');
        return;
    }

    const sheetDate = toSheetDate(dateVal);
    // Build notes: prepend description since there's no Description column
    const fullNotes = notes ? `${desc} - ${notes}` : desc;
    const expense = { date: sheetDate, amount, whoPaid, category, notes: fullNotes };

    // Handle recurring
    const isRecurring = document.getElementById('recurring-toggle').checked;
    if (isRecurring) {
        const frequency = document.getElementById('inp-frequency').value;
        const startDate = document.getElementById('inp-recur-start').value || dateVal;
        const noEndDate = document.getElementById('no-end-date').checked;
        const endDate = noEndDate ? null : (document.getElementById('inp-recur-end').value || null);

        const recurring = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            description: desc,
            amount,
            category,
            whoPaid,
            frequency,
            startDate,
            endDate,
            lastGenerated: dateVal,
        };
        saveRecurringExpense(recurring);
        showToast('Recurring expense saved!', 'success');
    }

    setSubmitting(true);

    if (!navigator.onLine) {
        state.offlineQueue.push(expense);
        localStorage.setItem('offlineQueue', JSON.stringify(state.offlineQueue));
        state.expenses.push({ ...expense, rowIndex: -1 });
        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));
        renderAll();
        setSubmitting(false);
        resetForm();
        showToast('Saved offline. Will sync when online.', 'info');
        return;
    }

    try {
        await appendExpenseToSheet(expense);
        setSubmitting(false);
        resetForm();
        showToast('Expense added!', 'success');
        await loadExpenses();
    } catch (err) {
        console.error('Error adding expense:', err);
        if (err.status === 401) { handleSignOut(); showToast('Session expired.', 'error'); return; }
        state.offlineQueue.push(expense);
        localStorage.setItem('offlineQueue', JSON.stringify(state.offlineQueue));
        state.expenses.push({ ...expense, rowIndex: -1 });
        renderAll();
        setSubmitting(false);
        resetForm();
        showToast('Saved locally. Will sync later.', 'info');
    }
}

function setSubmitting(loading) {
    const btn = document.getElementById('submit-btn');
    const text = document.getElementById('submit-text');
    const spinner = document.getElementById('submit-spinner');
    btn.disabled = loading;
    text.textContent = loading ? 'Adding...' : 'Add Expense';
    spinner.classList.toggle('hidden', !loading);
    btn.classList.toggle('opacity-70', loading);
}

function resetForm() {
    document.getElementById('expense-form').reset();
    document.getElementById('inp-date').valueAsDate = new Date();
    document.getElementById('recurring-fields').classList.add('hidden');
}

// ============================================================
// Recurring Expenses
// ============================================================

function getRecurringExpenses() {
    return JSON.parse(localStorage.getItem('recurringExpenses') || '[]');
}

function saveRecurringExpense(expense) {
    const list = getRecurringExpenses();
    const idx = list.findIndex(e => e.id === expense.id);
    if (idx >= 0) list[idx] = expense;
    else list.push(expense);
    localStorage.setItem('recurringExpenses', JSON.stringify(list));
}

function deleteRecurringExpense(id) {
    const list = getRecurringExpenses().filter(e => e.id !== id);
    localStorage.setItem('recurringExpenses', JSON.stringify(list));
    renderRecurringList();
}

function getNextDate(lastDate, frequency) {
    const d = new Date(lastDate + 'T00:00:00');
    switch (frequency) {
        case 'weekly': d.setDate(d.getDate() + 7); break;
        case 'biweekly': d.setDate(d.getDate() + 14); break;
        case 'monthly': d.setMonth(d.getMonth() + 1); break;
    }
    return d;
}

async function processRecurringExpenses() {
    const list = getRecurringExpenses();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let added = 0;

    for (const rec of list) {
        // Check end date
        if (rec.endDate) {
            const end = new Date(rec.endDate + 'T00:00:00');
            if (today > end) continue;
        }

        let nextDate = getNextDate(rec.lastGenerated, rec.frequency);
        while (nextDate <= today) {
            const sheetDate = `${nextDate.getMonth() + 1}/${nextDate.getDate()}/${nextDate.getFullYear()}`;
            const expense = {
                date: sheetDate,
                amount: rec.amount,
                whoPaid: rec.whoPaid,
                category: rec.category,
                notes: rec.description,
            };

            if (navigator.onLine && state.isAuthenticated) {
                try {
                    await appendExpenseToSheet(expense);
                    added++;
                } catch (err) {
                    console.error('Failed to add recurring expense:', err);
                    break;
                }
            } else {
                state.offlineQueue.push(expense);
                localStorage.setItem('offlineQueue', JSON.stringify(state.offlineQueue));
                added++;
            }

            // Update lastGenerated
            const isoDate = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
            rec.lastGenerated = isoDate;
            nextDate = getNextDate(rec.lastGenerated, rec.frequency);
        }
    }

    localStorage.setItem('recurringExpenses', JSON.stringify(list));

    if (added > 0) {
        showToast(`Added ${added} recurring expense(s)`, 'success');
        if (navigator.onLine) await loadExpenses();
    }
}

function openRecurringModal() {
    document.getElementById('recurring-modal').classList.remove('hidden');
    renderRecurringList();
}

function closeRecurringModal() {
    document.getElementById('recurring-modal').classList.add('hidden');
}

function renderRecurringList() {
    const list = getRecurringExpenses();
    const container = document.getElementById('recurring-list');

    if (list.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm text-center py-4">No recurring expenses set up</p>';
        return;
    }

    container.innerHTML = list.map(rec => {
        const nextDate = getNextDate(rec.lastGenerated, rec.frequency);
        const freqLabels = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
        const isExpired = rec.endDate && new Date(rec.endDate + 'T00:00:00') < new Date();
        return `
            <div class="border border-gray-100 rounded-xl p-4 ${isExpired ? 'opacity-50' : ''}">
                <div class="flex items-center justify-between mb-2">
                    <p class="font-medium text-gray-900">${escapeHtml(rec.description)}</p>
                    <span class="text-sm font-semibold ${rec.whoPaid === 'Gigi' ? 'text-pink-600' : 'text-blue-600'}">${formatCurrency(rec.amount)}</span>
                </div>
                <div class="flex items-center gap-2 text-xs text-gray-500 mb-2">
                    <span class="px-1.5 py-0.5 rounded-full ${getCategoryColorClass(rec.category)}">${rec.category}</span>
                    <span>${freqLabels[rec.frequency]}</span>
                    <span>·</span>
                    <span>${rec.whoPaid}</span>
                </div>
                <div class="flex items-center justify-between">
                    <p class="text-xs text-gray-400">${isExpired ? 'Expired' : 'Next: ' + nextDate.toLocaleDateString()}</p>
                    <button onclick="deleteRecurringExpense('${rec.id}')" class="text-xs text-red-500 hover:text-red-700 font-medium">Delete</button>
                </div>
            </div>
        `;
    }).join('');
}

// ============================================================
// Tab 2: Dashboard
// ============================================================

function getExpensesForMonth(monthKey) {
    return state.expenses.filter(e => {
        const mk = getMonthKey(e.date);
        return mk === monthKey;
    });
}

function getNonSettlementExpenses() {
    return state.expenses.filter(e => e.category !== 'Settlement');
}

function renderDashboard() {
    const allExp = getNonSettlementExpenses();
    const curKey = currentMonthKey();
    const prevKey = prevMonthKey(curKey);
    const thisMonth = allExp.filter(e => getMonthKey(e.date) === curKey);
    const lastMonth = allExp.filter(e => getMonthKey(e.date) === prevKey);

    const thisTotal = thisMonth.reduce((s, e) => s + e.amount, 0);
    const lastTotal = lastMonth.reduce((s, e) => s + e.amount, 0);
    const allTotal = allExp.reduce((s, e) => s + e.amount, 0);

    document.getElementById('stat-this-month').textContent = formatCurrency(thisTotal);
    document.getElementById('stat-all-time').textContent = formatCurrency(allTotal);

    // Month-over-month change
    const changeEl = document.getElementById('stat-month-change');
    if (lastTotal > 0) {
        const pctChange = ((thisTotal - lastTotal) / lastTotal * 100).toFixed(0);
        const up = thisTotal > lastTotal;
        changeEl.innerHTML = `<span class="${up ? 'text-red-500' : 'text-green-500'}">${up ? '↑' : '↓'} ${Math.abs(pctChange)}% vs last month</span>`;
    } else {
        changeEl.textContent = '';
    }

    // Quick balance
    const { balanceText } = computeBalance();
    document.getElementById('stat-balance-quick').textContent = balanceText;

    // Category breakdown (current month)
    renderCategoryBreakdown(thisMonth, 'category-breakdown-current');

    // Person breakdown (current month)
    renderPersonBreakdown(thisMonth);

    // Monthly spending chart
    renderMonthlyChart();
}

function renderCategoryBreakdown(expenses, containerId) {
    const container = document.getElementById(containerId);
    const filtered = expenses.filter(e => e.category !== 'Settlement');
    const total = filtered.reduce((s, e) => s + e.amount, 0);

    if (filtered.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No expenses</p>';
        return;
    }

    const byCategory = {};
    CONFIG.CATEGORIES.forEach(c => { byCategory[c] = 0; });
    filtered.forEach(e => {
        if (byCategory[e.category] !== undefined) byCategory[e.category] += e.amount;
        else byCategory['Other'] = (byCategory['Other'] || 0) + e.amount;
    });

    container.innerHTML = Object.entries(byCategory)
        .filter(([, amt]) => amt > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => {
            const pct = total > 0 ? (amt / total * 100).toFixed(0) : 0;
            return `
                <div class="flex items-center gap-3">
                    <span class="text-xs font-medium px-2 py-0.5 rounded-full ${getCategoryColorClass(cat)} min-w-[80px] text-center">${cat}</span>
                    <div class="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        <div class="h-full rounded-full ${getCategoryBarColor(cat)}" style="width: ${pct}%"></div>
                    </div>
                    <span class="text-xs text-gray-500 w-10 text-right">${pct}%</span>
                    <span class="text-sm font-medium text-gray-700 w-20 text-right">${formatCurrency(amt)}</span>
                </div>
            `;
        }).join('');
}

function renderPersonBreakdown(expenses) {
    const container = document.getElementById('person-breakdown-current');
    const filtered = expenses.filter(e => e.category !== 'Settlement');
    const total = filtered.reduce((s, e) => s + e.amount, 0);
    const gigiTotal = filtered.filter(e => e.whoPaid === 'Gigi').reduce((s, e) => s + e.amount, 0);
    const lukeTotal = filtered.filter(e => e.whoPaid === 'Luke').reduce((s, e) => s + e.amount, 0);

    if (filtered.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No expenses</p>';
        return;
    }

    const gigiPct = total > 0 ? (gigiTotal / total * 100).toFixed(0) : 0;
    const lukePct = total > 0 ? (lukeTotal / total * 100).toFixed(0) : 0;

    container.innerHTML = `
        <div class="space-y-2">
            <div class="flex items-center gap-3">
                <span class="text-sm font-medium text-pink-600 w-12">Gigi</span>
                <div class="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                    <div class="h-full rounded-full bg-pink-500" style="width: ${gigiPct}%"></div>
                </div>
                <span class="text-sm font-medium text-gray-700 w-24 text-right">${formatCurrency(gigiTotal)} (${gigiPct}%)</span>
            </div>
            <div class="flex items-center gap-3">
                <span class="text-sm font-medium text-blue-600 w-12">Luke</span>
                <div class="flex-1 bg-gray-100 rounded-full h-3 overflow-hidden">
                    <div class="h-full rounded-full bg-blue-500" style="width: ${lukePct}%"></div>
                </div>
                <span class="text-sm font-medium text-gray-700 w-24 text-right">${formatCurrency(lukeTotal)} (${lukePct}%)</span>
            </div>
        </div>
    `;
}

function renderMonthlyChart() {
    const canvas = document.getElementById('chart-monthly');
    if (!canvas) return;

    const allExp = getNonSettlementExpenses();

    // Get last 6 months
    const months = [];
    let key = currentMonthKey();
    for (let i = 0; i < 6; i++) {
        months.unshift(key);
        key = prevMonthKey(key);
    }

    const totals = months.map(mk => {
        return allExp.filter(e => getMonthKey(e.date) === mk).reduce((s, e) => s + e.amount, 0);
    });

    const labels = months.map(mk => {
        const [y, m] = mk.split('-');
        const shortMonths = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return shortMonths[parseInt(m) - 1];
    });

    if (state.monthlyChart) {
        state.monthlyChart.destroy();
    }

    state.monthlyChart = new Chart(canvas, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data: totals,
                backgroundColor: 'rgba(79, 70, 229, 0.7)',
                borderColor: 'rgba(79, 70, 229, 1)',
                borderWidth: 1,
                borderRadius: 6,
                hoverBackgroundColor: 'rgba(79, 70, 229, 0.9)',
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: ctx => '$' + ctx.raw.toFixed(2),
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: val => '$' + val,
                        font: { size: 11 },
                    },
                    grid: { color: 'rgba(0,0,0,0.05)' },
                },
                x: {
                    ticks: { font: { size: 11 } },
                    grid: { display: false },
                }
            }
        }
    });
}

// ============================================================
// Monthly Detail View
// ============================================================

function renderMonthSelector() {
    const selector = document.getElementById('month-selector');
    const allExp = state.expenses;

    // Collect all unique months
    const monthSet = new Set();
    allExp.forEach(e => {
        const mk = getMonthKey(e.date);
        if (mk) monthSet.add(mk);
    });
    // Also include current month
    monthSet.add(currentMonthKey());

    const months = [...monthSet].sort().reverse();

    const prevSelected = selector.value;
    selector.innerHTML = months.map(mk =>
        `<option value="${mk}" ${mk === (prevSelected || currentMonthKey()) ? 'selected' : ''}>${monthKeyToLabel(mk)}</option>`
    ).join('');
}

function navigateMonth(dir) {
    const selector = document.getElementById('month-selector');
    const opts = [...selector.options];
    const curIdx = opts.findIndex(o => o.selected);
    const newIdx = curIdx - dir; // options are sorted newest first, so -dir for "next"
    if (newIdx >= 0 && newIdx < opts.length) {
        selector.selectedIndex = newIdx;
        renderMonthDetail();
    }
}

function renderMonthDetail() {
    const monthKey = document.getElementById('month-selector').value;
    const sortBy = document.getElementById('md-sort').value;
    const expenses = getExpensesForMonth(monthKey).filter(e => e.category !== 'Settlement');

    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const gigiTotal = expenses.filter(e => e.whoPaid === 'Gigi').reduce((s, e) => s + e.amount, 0);
    const lukeTotal = expenses.filter(e => e.whoPaid === 'Luke').reduce((s, e) => s + e.amount, 0);

    document.getElementById('md-total').textContent = formatCurrency(total);
    document.getElementById('md-gigi').textContent = formatCurrency(gigiTotal);
    document.getElementById('md-luke').textContent = formatCurrency(lukeTotal);

    // Category breakdown for month
    renderMonthCategoryBreakdown(expenses);

    document.getElementById('md-count').textContent = expenses.length > 0
        ? `${expenses.length} expense${expenses.length !== 1 ? 's' : ''} this month`
        : '';

    // Expense list
    const listContainer = document.getElementById('md-expense-list');

    if (expenses.length === 0) {
        listContainer.innerHTML = `
            <div class="text-center py-6 text-gray-400">
                <p>No expenses in ${monthKeyToLabel(monthKey)}</p>
            </div>`;
        return;
    }

    let sorted = [...expenses];
    if (sortBy === 'date') {
        sorted.sort((a, b) => toISODate(b.date).localeCompare(toISODate(a.date)));
    } else {
        sorted.sort((a, b) => a.category.localeCompare(b.category) || toISODate(b.date).localeCompare(toISODate(a.date)));
    }

    listContainer.innerHTML = sorted.map(expense => {
        const isPending = expense.rowIndex === -1;
        return `
            <div class="border border-gray-100 rounded-xl p-3 flex items-center gap-3 ${isPending ? 'opacity-70' : ''}">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-0.5">
                        <p class="font-medium text-gray-900 text-sm truncate">${escapeHtml(expense.notes || expense.category)}</p>
                        ${isPending ? '<span class="text-xs text-amber-500">Pending</span>' : ''}
                    </div>
                    <div class="flex items-center gap-1.5 text-xs text-gray-500">
                        <span>${expense.date}</span>
                        <span>·</span>
                        <span>${expense.whoPaid}</span>
                        <span class="px-1.5 py-0.5 rounded-full ${getCategoryColorClass(expense.category)}">${expense.category}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-sm font-semibold ${expense.whoPaid === 'Gigi' ? 'text-pink-600' : 'text-blue-600'}">${formatCurrency(expense.amount)}</span>
                    <button onclick="openDeleteModal(${expense.rowIndex})" class="text-gray-300 hover:text-red-500 transition p-1">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function renderMonthCategoryBreakdown(expenses) {
    const container = document.getElementById('md-categories');
    const total = expenses.reduce((s, e) => s + e.amount, 0);

    if (expenses.length === 0) {
        container.innerHTML = '';
        return;
    }

    const byCategory = {};
    CONFIG.CATEGORIES.forEach(c => { byCategory[c] = 0; });
    expenses.forEach(e => {
        if (byCategory[e.category] !== undefined) byCategory[e.category] += e.amount;
        else byCategory['Other'] = (byCategory['Other'] || 0) + e.amount;
    });

    container.innerHTML = Object.entries(byCategory)
        .filter(([, amt]) => amt > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => {
            const pct = total > 0 ? (amt / total * 100).toFixed(0) : 0;
            return `
                <div class="flex items-center gap-2">
                    <span class="text-xs font-medium px-1.5 py-0.5 rounded-full ${getCategoryColorClass(cat)}">${cat}</span>
                    <div class="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                        <div class="h-full rounded-full ${getCategoryBarColor(cat)}" style="width: ${pct}%"></div>
                    </div>
                    <span class="text-xs text-gray-700">${formatCurrency(amt)} (${pct}%)</span>
                </div>
            `;
        }).join('');
}

// ============================================================
// Tab 3: Settle Up
// ============================================================

function computeBalance() {
    const allExp = state.expenses;
    const lukeTotal = allExp.filter(e => e.whoPaid === 'Luke').reduce((s, e) => s + e.amount, 0);
    const gigiTotal = allExp.filter(e => e.whoPaid === 'Gigi').reduce((s, e) => s + e.amount, 0);
    const total = lukeTotal + gigiTotal;
    const fairShare = total / 2;
    const balance = lukeTotal - fairShare; // positive = Gigi owes Luke

    let balanceText;
    if (Math.abs(balance) < 0.01) {
        balanceText = 'All settled up!';
    } else if (balance > 0) {
        balanceText = `Gigi owes Luke ${formatCurrency(balance)}`;
    } else {
        balanceText = `Luke owes Gigi ${formatCurrency(Math.abs(balance))}`;
    }

    return { lukeTotal, gigiTotal, total, fairShare, balance, balanceText };
}

function renderSettleUp() {
    const { lukeTotal, gigiTotal, total, fairShare, balance, balanceText } = computeBalance();

    document.getElementById('settle-balance-text').textContent = balanceText;
    document.getElementById('settle-luke-total').textContent = formatCurrency(lukeTotal);
    document.getElementById('settle-gigi-total').textContent = formatCurrency(gigiTotal);
    document.getElementById('settle-fair-share').textContent = formatCurrency(fairShare);

    // Visual bar
    const lukePct = total > 0 ? (lukeTotal / total * 100) : 50;
    const gigiPct = total > 0 ? (gigiTotal / total * 100) : 50;
    document.getElementById('settle-bar-luke').style.width = lukePct + '%';
    document.getElementById('settle-bar-gigi').style.width = gigiPct + '%';

    // Color the balance text
    const balanceEl = document.getElementById('settle-balance-text');
    if (Math.abs(balance) < 0.01) {
        balanceEl.className = 'text-2xl font-bold text-green-600 mb-4';
    } else {
        balanceEl.className = 'text-2xl font-bold text-orange-600 mb-4';
    }

    // Show/hide settle actions
    document.getElementById('settle-actions').classList.toggle('hidden', Math.abs(balance) < 0.01);

    // Settlement history
    renderSettlementHistory();
}

function renderSettlementHistory() {
    const settlements = state.expenses.filter(e => e.category === 'Settlement');
    const container = document.getElementById('settlement-history');

    if (settlements.length === 0) {
        container.innerHTML = '<p class="text-gray-400 text-sm">No settlements yet</p>';
        return;
    }

    const sorted = [...settlements].sort((a, b) => toISODate(b.date).localeCompare(toISODate(a.date)));
    container.innerHTML = sorted.map(s => {
        const d = parseSheetDate(s.date);
        const dateLabel = d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : s.date;
        return `
            <div class="flex items-center justify-between py-2 border-b border-gray-50 last:border-0">
                <div>
                    <p class="text-sm text-gray-700">${dateLabel}</p>
                    <p class="text-xs text-gray-400">${s.whoPaid} paid</p>
                </div>
                <span class="font-semibold text-gray-900">${formatCurrency(s.amount)}</span>
            </div>
        `;
    }).join('');
}

function openVenmo() {
    const { balance } = computeBalance();
    const absBalance = Math.abs(balance);

    // Determine who owes whom
    let recipient;
    if (balance > 0) {
        // Gigi owes Luke
        recipient = CONFIG.VENMO_USERNAMES.Gigi; // Gigi is paying
    } else {
        // Luke owes Gigi
        recipient = CONFIG.VENMO_USERNAMES.Luke; // Luke is paying
    }

    // Note: Venmo deep link — the person who owes should pay the person who is owed.
    // We construct a pay link for the person who owes to pay the person who is owed.
    let payee;
    if (balance > 0) {
        payee = CONFIG.VENMO_USERNAMES.Luke; // Luke is owed
    } else {
        payee = CONFIG.VENMO_USERNAMES.Gigi; // Gigi is owed
    }

    const url = `venmo://paycharge?txn=pay&recipients=${payee}&amount=${absBalance.toFixed(2)}&note=${encodeURIComponent('Expense settlement')}`;
    window.location.href = url;

    // Fallback for desktop
    setTimeout(() => {
        showToast('Open this on your phone with Venmo installed', 'info');
    }, 2000);
}

function openSettleModal() {
    const { balance, balanceText } = computeBalance();
    document.getElementById('settle-modal-desc').textContent = `Mark ${formatCurrency(Math.abs(balance))} as settled? This will add a settlement entry to the spreadsheet.`;
    document.getElementById('settle-modal').classList.remove('hidden');
}

function closeSettleModal() {
    document.getElementById('settle-modal').classList.add('hidden');
}

async function confirmSettle() {
    const { balance } = computeBalance();
    const absBalance = Math.abs(balance);

    // The person who owes pays
    const whoPaid = balance > 0 ? 'Gigi' : 'Luke';

    const expense = {
        date: todaySheetDate(),
        amount: absBalance,
        whoPaid,
        category: 'Settlement',
        notes: 'Settled via app',
    };

    const btn = document.getElementById('settle-confirm-btn');
    btn.textContent = 'Settling...';
    btn.disabled = true;

    try {
        await appendExpenseToSheet(expense);
        closeSettleModal();
        btn.textContent = 'Settle';
        btn.disabled = false;
        showToast('Balance settled!', 'success');
        await loadExpenses();
    } catch (err) {
        console.error('Error settling:', err);
        closeSettleModal();
        btn.textContent = 'Settle';
        btn.disabled = false;
        if (err.status === 401) { handleSignOut(); showToast('Session expired.', 'error'); return; }
        showToast('Failed to settle. Try again.', 'error');
    }
}

// ============================================================
// Delete Expense
// ============================================================

function openDeleteModal(rowIndex) {
    const expense = state.expenses.find(e => e.rowIndex === rowIndex);
    if (!expense) return;
    state.pendingDeleteRow = rowIndex;
    document.getElementById('delete-desc').textContent =
        `Delete "${expense.notes || expense.category}" (${formatCurrency(expense.amount)}) paid by ${expense.whoPaid}?`;
    document.getElementById('delete-modal').classList.remove('hidden');
}

function closeDeleteModal() {
    document.getElementById('delete-modal').classList.add('hidden');
    state.pendingDeleteRow = null;
}

async function confirmDelete() {
    const rowIndex = state.pendingDeleteRow;
    if (!rowIndex) return;

    const btn = document.getElementById('delete-confirm-btn');
    btn.textContent = 'Deleting...';
    btn.disabled = true;

    if (!navigator.onLine || rowIndex === -1) {
        if (rowIndex !== -1) {
            state.deleteQueue.push(rowIndex);
            localStorage.setItem('deleteQueue', JSON.stringify(state.deleteQueue));
        }
        state.expenses = state.expenses.filter(e => e.rowIndex !== rowIndex);
        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));
        renderAll();
        closeDeleteModal();
        btn.textContent = 'Delete';
        btn.disabled = false;
        showToast('Deleted locally.', 'info');
        return;
    }

    try {
        await deleteExpenseFromSheet(rowIndex);
        closeDeleteModal();
        btn.textContent = 'Delete';
        btn.disabled = false;
        showToast('Expense deleted', 'success');
        await loadExpenses();
    } catch (err) {
        closeDeleteModal();
        btn.textContent = 'Delete';
        btn.disabled = false;
        if (err.status === 401) { handleSignOut(); showToast('Session expired.', 'error'); return; }
        showToast('Failed to delete.', 'error');
    }
}

// ============================================================
// Tab Navigation (3 tabs)
// ============================================================

function switchTab(tab) {
    state.currentTab = tab;

    document.getElementById('tab-add').classList.toggle('hidden', tab !== 'add');
    document.getElementById('tab-dashboard').classList.toggle('hidden', tab !== 'dashboard');
    document.getElementById('tab-settle').classList.toggle('hidden', tab !== 'settle');

    const tabs = ['add', 'dashboard', 'settle'];
    tabs.forEach(t => {
        const btn = document.getElementById(`tab-btn-${t}`);
        if (t === tab) {
            btn.classList.remove('text-gray-400');
            btn.classList.add('text-primary');
        } else {
            btn.classList.remove('text-primary');
            btn.classList.add('text-gray-400');
        }
    });

    if ((tab === 'dashboard' || tab === 'settle') && state.isAuthenticated && navigator.onLine) {
        loadExpenses();
    }
}

// ============================================================
// Offline Support
// ============================================================

function handleOnline() {
    document.getElementById('offline-banner').classList.add('hidden');
    showToast('Back online!', 'success');
    syncOfflineQueue();
}

function handleOffline() {
    document.getElementById('offline-banner').classList.remove('hidden');
}

function updateOnlineStatus() {
    if (!navigator.onLine) document.getElementById('offline-banner').classList.remove('hidden');
}

async function syncOfflineQueue() {
    if (state.offlineQueue.length === 0 && state.deleteQueue.length === 0) return;
    if (!navigator.onLine || !state.isAuthenticated) return;

    setSyncStatus('syncing');

    const queue = [...state.offlineQueue];
    state.offlineQueue = [];
    localStorage.setItem('offlineQueue', '[]');

    let addFailed = [];
    for (const expense of queue) {
        try {
            await appendExpenseToSheet(expense);
        } catch (err) {
            addFailed.push(expense);
        }
    }
    if (addFailed.length > 0) {
        state.offlineQueue = addFailed;
        localStorage.setItem('offlineQueue', JSON.stringify(addFailed));
    }

    const delQueue = [...state.deleteQueue];
    state.deleteQueue = [];
    localStorage.setItem('deleteQueue', '[]');
    delQueue.sort((a, b) => b - a);
    for (const rowIndex of delQueue) {
        try {
            await deleteExpenseFromSheet(rowIndex);
        } catch (err) {
            console.error('Failed to sync delete for row', rowIndex);
        }
    }

    await loadExpenses();
    const synced = queue.length - addFailed.length + delQueue.length;
    if (synced > 0) showToast(`Synced ${synced} change(s)`, 'success');
}

// ============================================================
// Refresh
// ============================================================

async function refreshData() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.innerHTML = `<svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Refreshing...`;

    try {
        await syncOfflineQueue();
        await loadExpenses();
        showToast('Refreshed!', 'success');
    } catch (err) {
        showToast('Refresh failed', 'error');
    }

    btn.disabled = false;
    btn.innerHTML = `<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg> Refresh`;
}

// ============================================================
// Sync Status
// ============================================================

function setSyncStatus(status) {
    const el = document.getElementById('sync-status');
    switch (status) {
        case 'syncing': el.textContent = 'Syncing...'; el.className = 'text-xs opacity-75'; break;
        case 'synced': el.textContent = 'Synced'; el.className = 'text-xs opacity-75 text-green-200'; break;
        case 'offline': el.textContent = 'Offline'; el.className = 'text-xs opacity-75 text-amber-200'; break;
        case 'error': el.textContent = 'Sync error'; el.className = 'text-xs opacity-75 text-red-200'; break;
        default: el.textContent = '';
    }
}

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const colors = { success: 'bg-green-600', error: 'bg-red-600', info: 'bg-gray-800' };
    const icons = { success: '✓', error: '✕', info: 'ℹ' };
    const toast = document.createElement('div');
    toast.className = `toast pointer-events-auto ${colors[type]} text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-medium`;
    toast.innerHTML = `<span>${icons[type]}</span> ${escapeHtml(message)}`;
    container.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
}

// ============================================================
// Utilities
// ============================================================

function parseAmount(val) {
    // Handle currency-formatted strings like "$1,234.56" or "1234.56"
    if (!val) return 0;
    const cleaned = String(val).replace(/[$,\s]/g, '');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

function formatCurrency(amount) {
    return '$' + amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function getCategoryColorClass(category) {
    switch (category) {
        case 'Utilities': return 'cat-utilities';
        case 'Grocery/Toiletry': return 'cat-grocery';
        case 'House Items': return 'cat-house';
        case 'Settlement': return 'cat-settlement';
        default: return 'cat-other';
    }
}

function getCategoryBarColor(category) {
    switch (category) {
        case 'Utilities': return 'bg-blue-500';
        case 'Grocery/Toiletry': return 'bg-green-500';
        case 'House Items': return 'bg-amber-500';
        default: return 'bg-purple-500';
    }
}
