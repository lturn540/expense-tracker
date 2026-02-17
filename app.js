// ============================================================
// Expense Tracker PWA — Main Application
// ============================================================

// Register Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js')
            .then(reg => console.log('SW registered:', reg.scope))
            .catch(err => console.warn('SW registration failed:', err));
    });
}

const CONFIG = {
    CLIENT_ID: '1053757888615-536rq74c096k5a3birh2e1lc9rs9mk9k.apps.googleusercontent.com',
    SPREADSHEET_ID: '1dKEt0tgWYkCjYXkMov_zwY9vXyjInY4zIeyXyhxfSgw',
    TAB_NAME: 'App Data',
    SCOPES: 'https://www.googleapis.com/auth/spreadsheets',
    API_KEY: '', // Not needed for OAuth flow
    DISCOVERY_DOCS: ['https://sheets.googleapis.com/$discovery/rest?version=v4'],
    CATEGORIES: ['Utilities', 'Grocery/Toiletry', 'House Items', 'Other'],
    PEOPLE: ['Gigi', 'Luke'],
};

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
    isLoading: false,
    gapiLoaded: false,
    gisLoaded: false,
    tokenClient: null,
    pendingDeleteRow: null,
};

// ============================================================
// Initialization
// ============================================================

// Wait for both gapi and gis to load
function checkLibrariesLoaded() {
    if (typeof gapi !== 'undefined' && typeof google !== 'undefined' && google.accounts) {
        initializeApp();
    } else {
        setTimeout(checkLibrariesLoaded, 100);
    }
}

window.addEventListener('load', checkLibrariesLoaded);

function initializeApp() {
    // Initialize GAPI client
    gapi.load('client', async () => {
        await gapi.client.init({
            discoveryDocs: CONFIG.DISCOVERY_DOCS,
        });
        state.gapiLoaded = true;
        console.log('GAPI client initialized');

        // Check if we have a stored token
        const storedToken = localStorage.getItem('gapi_token');
        if (storedToken) {
            try {
                const tokenData = JSON.parse(storedToken);
                // Check if token is still valid (has more than 5 min left)
                if (tokenData.expires_at && tokenData.expires_at > Date.now() + 300000) {
                    gapi.client.setToken({ access_token: tokenData.access_token });
                    state.accessToken = tokenData.access_token;
                    state.isAuthenticated = true;
                    showMainApp();
                    loadExpenses();
                }
            } catch (e) {
                localStorage.removeItem('gapi_token');
            }
        }
    });

    // Initialize Google Identity Services token client
    state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.CLIENT_ID,
        scope: CONFIG.SCOPES,
        callback: handleTokenResponse,
    });

    state.gisLoaded = true;

    // Set default date to today
    document.getElementById('inp-date').valueAsDate = new Date();

    // Listen for online/offline
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    updateOnlineStatus();
}

// ============================================================
// Authentication
// ============================================================

function handleSignIn() {
    if (!state.gisLoaded) {
        showToast('Loading... please wait', 'info');
        return;
    }
    state.tokenClient.requestAccessToken();
}

function handleTokenResponse(response) {
    if (response.error) {
        console.error('Auth error:', response);
        showAuthError('Authentication failed. Please try again.');
        return;
    }

    state.accessToken = response.access_token;
    state.isAuthenticated = true;

    // Store token with expiry
    const tokenData = {
        access_token: response.access_token,
        expires_at: Date.now() + (response.expires_in * 1000),
    };
    localStorage.setItem('gapi_token', JSON.stringify(tokenData));

    gapi.client.setToken({ access_token: response.access_token });
    showMainApp();
    loadExpenses();
    syncOfflineQueue();
}

function handleSignOut() {
    const token = gapi.client.getToken();
    if (token) {
        google.accounts.oauth2.revoke(token.access_token);
    }
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
// Google Sheets API
// ============================================================

async function ensureTabExists() {
    try {
        const resp = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
        });
        const sheets = resp.result.sheets || [];
        const exists = sheets.some(s => s.properties.title === CONFIG.TAB_NAME);

        if (!exists) {
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: CONFIG.SPREADSHEET_ID,
                resource: {
                    requests: [{
                        addSheet: {
                            properties: { title: CONFIG.TAB_NAME }
                        }
                    }]
                }
            });

            // Add headers
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: CONFIG.SPREADSHEET_ID,
                range: `'${CONFIG.TAB_NAME}'!A1:G1`,
                valueInputOption: 'RAW',
                resource: {
                    values: [['Date', 'Description', 'Amount', 'Who Paid', 'Category', 'Notes', 'Timestamp']]
                }
            });
            console.log('Created "App Data" tab with headers');
        }
    } catch (err) {
        console.error('Error ensuring tab exists:', err);
        throw err;
    }
}

async function loadExpenses() {
    setSyncStatus('syncing');
    try {
        await ensureTabExists();

        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `'${CONFIG.TAB_NAME}'!A2:G`,
        });

        const rows = resp.result.values || [];
        state.expenses = rows.map((row, index) => ({
            rowIndex: index + 2, // 1-based, skip header
            date: row[0] || '',
            description: row[1] || '',
            amount: parseFloat(row[2]) || 0,
            whoPaid: row[3] || '',
            category: row[4] || '',
            notes: row[5] || '',
            timestamp: row[6] || '',
        }));

        // Also store in localStorage for offline access
        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));

        renderDashboard();
        renderExpenseList();
        setSyncStatus('synced');
    } catch (err) {
        console.error('Error loading expenses:', err);
        if (err.status === 401) {
            handleSignOut();
            showToast('Session expired. Please sign in again.', 'error');
            return;
        }
        // Try loading from cache
        const cached = localStorage.getItem('cachedExpenses');
        if (cached) {
            state.expenses = JSON.parse(cached);
            renderDashboard();
            renderExpenseList();
            setSyncStatus('offline');
            showToast('Loaded cached data', 'info');
        } else {
            showToast('Failed to load expenses', 'error');
            setSyncStatus('error');
        }
    }
}

async function appendExpense(expense) {
    const row = [
        expense.date,
        expense.description,
        expense.amount.toFixed(2),
        expense.whoPaid,
        expense.category,
        expense.notes,
        new Date().toISOString(),
    ];

    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: CONFIG.SPREADSHEET_ID,
            range: `'${CONFIG.TAB_NAME}'!A:G`,
            valueInputOption: 'RAW',
            insertDataOption: 'INSERT_ROWS',
            resource: { values: [row] },
        });
        return true;
    } catch (err) {
        console.error('Error appending expense:', err);
        if (err.status === 401) {
            handleSignOut();
            showToast('Session expired. Please sign in again.', 'error');
        }
        throw err;
    }
}

async function deleteExpenseFromSheet(rowIndex) {
    try {
        // Get sheet ID for App Data tab
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
                            startIndex: rowIndex - 1, // 0-based for API
                            endIndex: rowIndex,
                        }
                    }
                }]
            }
        });
        return true;
    } catch (err) {
        console.error('Error deleting expense:', err);
        if (err.status === 401) {
            handleSignOut();
            showToast('Session expired. Please sign in again.', 'error');
        }
        throw err;
    }
}

// ============================================================
// Expense Form Handling
// ============================================================

async function handleSubmitExpense(event) {
    event.preventDefault();

    const desc = document.getElementById('inp-desc').value.trim();
    const amount = parseFloat(document.getElementById('inp-amount').value);
    const category = document.getElementById('inp-category').value;
    const whoPaid = document.querySelector('input[name="who-paid"]:checked')?.value;
    const date = document.getElementById('inp-date').value;
    const notes = document.getElementById('inp-notes').value.trim();

    if (!desc || !amount || !category || !whoPaid || !date) {
        showToast('Please fill in all required fields', 'error');
        return;
    }

    const expense = { date, description: desc, amount, whoPaid, category, notes };

    setSubmitting(true);

    if (!navigator.onLine) {
        // Queue for later
        state.offlineQueue.push(expense);
        localStorage.setItem('offlineQueue', JSON.stringify(state.offlineQueue));
        // Add to local state for immediate display
        state.expenses.push({
            ...expense,
            rowIndex: -1,
            timestamp: new Date().toISOString(),
        });
        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));
        renderDashboard();
        renderExpenseList();
        setSubmitting(false);
        resetForm();
        showToast('Saved offline. Will sync when online.', 'info');
        return;
    }

    try {
        await appendExpense(expense);
        setSubmitting(false);
        resetForm();
        showToast('Expense added!', 'success');
        // Reload to get updated row indices
        await loadExpenses();
    } catch (err) {
        // Queue if failed
        state.offlineQueue.push(expense);
        localStorage.setItem('offlineQueue', JSON.stringify(state.offlineQueue));
        state.expenses.push({
            ...expense,
            rowIndex: -1,
            timestamp: new Date().toISOString(),
        });
        renderDashboard();
        renderExpenseList();
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
}

// ============================================================
// Delete Expense
// ============================================================

function openDeleteModal(rowIndex) {
    const expense = state.expenses.find(e => e.rowIndex === rowIndex);
    if (!expense) return;

    state.pendingDeleteRow = rowIndex;
    const modal = document.getElementById('delete-modal');
    document.getElementById('delete-desc').textContent =
        `Delete "${expense.description}" ($${expense.amount.toFixed(2)}) paid by ${expense.whoPaid}?`;
    modal.classList.remove('hidden');
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
        // Queue delete for later (if it was a real row)
        if (rowIndex !== -1) {
            state.deleteQueue.push(rowIndex);
            localStorage.setItem('deleteQueue', JSON.stringify(state.deleteQueue));
        }
        // Remove from local state
        state.expenses = state.expenses.filter(e => e.rowIndex !== rowIndex);
        localStorage.setItem('cachedExpenses', JSON.stringify(state.expenses));
        renderDashboard();
        renderExpenseList();
        closeDeleteModal();
        btn.textContent = 'Delete';
        btn.disabled = false;
        showToast('Deleted locally. Will sync when online.', 'info');
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
        showToast('Failed to delete. Try again.', 'error');
    }
}

// ============================================================
// Dashboard Rendering
// ============================================================

function renderDashboard() {
    const expenses = state.expenses;
    const total = expenses.reduce((s, e) => s + e.amount, 0);
    const gigiTotal = expenses.filter(e => e.whoPaid === 'Gigi').reduce((s, e) => s + e.amount, 0);
    const lukeTotal = expenses.filter(e => e.whoPaid === 'Luke').reduce((s, e) => s + e.amount, 0);

    document.getElementById('stat-total').textContent = formatCurrency(total);
    document.getElementById('stat-gigi').textContent = formatCurrency(gigiTotal);
    document.getElementById('stat-luke').textContent = formatCurrency(lukeTotal);

    // Balance: Each person should pay half. Whoever paid more is owed money.
    const halfTotal = total / 2;
    const gigiOwes = halfTotal - gigiTotal; // positive means Gigi owes Luke
    const balanceEl = document.getElementById('stat-balance');

    if (Math.abs(gigiOwes) < 0.01) {
        balanceEl.textContent = 'All settled up!';
    } else if (gigiOwes > 0) {
        balanceEl.textContent = `Gigi owes Luke ${formatCurrency(gigiOwes)}`;
    } else {
        balanceEl.textContent = `Luke owes Gigi ${formatCurrency(Math.abs(gigiOwes))}`;
    }

    // Category breakdown
    const byCategory = {};
    CONFIG.CATEGORIES.forEach(cat => { byCategory[cat] = 0; });
    expenses.forEach(e => {
        if (byCategory[e.category] !== undefined) {
            byCategory[e.category] += e.amount;
        } else {
            byCategory['Other'] = (byCategory['Other'] || 0) + e.amount;
        }
    });

    const catContainer = document.getElementById('category-breakdown');
    if (expenses.length === 0) {
        catContainer.innerHTML = '<p class="text-gray-400 text-sm">No expenses yet</p>';
        return;
    }

    catContainer.innerHTML = Object.entries(byCategory)
        .filter(([, amt]) => amt > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([cat, amt]) => {
            const pct = total > 0 ? (amt / total * 100).toFixed(0) : 0;
            const colorClass = getCategoryColorClass(cat);
            return `
                <div class="flex items-center gap-3">
                    <span class="text-xs font-medium px-2 py-0.5 rounded-full ${colorClass}">${cat}</span>
                    <div class="flex-1 bg-gray-100 rounded-full h-2.5 overflow-hidden">
                        <div class="h-full rounded-full ${getCategoryBarColor(cat)}" style="width: ${pct}%"></div>
                    </div>
                    <span class="text-sm font-medium text-gray-700 w-20 text-right">${formatCurrency(amt)}</span>
                </div>
            `;
        }).join('');
}

function renderExpenseList() {
    const container = document.getElementById('expense-list');
    const filterCat = document.getElementById('filter-category').value;
    const filterPerson = document.getElementById('filter-person').value;
    const sortBy = document.getElementById('sort-by').value;

    let filtered = [...state.expenses];

    if (filterCat) filtered = filtered.filter(e => e.category === filterCat);
    if (filterPerson) filtered = filtered.filter(e => e.whoPaid === filterPerson);

    // Sort
    filtered.sort((a, b) => {
        switch (sortBy) {
            case 'date-desc': return b.date.localeCompare(a.date) || b.timestamp.localeCompare(a.timestamp);
            case 'date-asc': return a.date.localeCompare(b.date) || a.timestamp.localeCompare(b.timestamp);
            case 'amount-desc': return b.amount - a.amount;
            case 'amount-asc': return a.amount - b.amount;
            default: return 0;
        }
    });

    if (filtered.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8 text-gray-400">
                <div class="text-4xl mb-2">📝</div>
                <p>No expenses found</p>
            </div>
        `;
        return;
    }

    container.innerHTML = filtered.map(expense => {
        const colorClass = getCategoryColorClass(expense.category);
        const isPending = expense.rowIndex === -1;
        return `
            <div class="bg-white rounded-xl border border-gray-100 shadow-sm p-4 flex items-center gap-3 ${isPending ? 'opacity-70' : ''}" data-row="${expense.rowIndex}">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                        <p class="font-medium text-gray-900 truncate">${escapeHtml(expense.description)}</p>
                        ${isPending ? '<span class="text-xs text-amber-500 font-medium">Pending</span>' : ''}
                    </div>
                    <div class="flex items-center gap-2 text-xs text-gray-500">
                        <span>${expense.date}</span>
                        <span>·</span>
                        <span>${expense.whoPaid}</span>
                        <span class="px-1.5 py-0.5 rounded-full ${colorClass}">${expense.category}</span>
                    </div>
                    ${expense.notes ? `<p class="text-xs text-gray-400 mt-1 truncate">${escapeHtml(expense.notes)}</p>` : ''}
                </div>
                <div class="text-right flex items-center gap-2">
                    <span class="text-lg font-semibold ${expense.whoPaid === 'Gigi' ? 'text-pink-600' : 'text-blue-600'}">${formatCurrency(expense.amount)}</span>
                    <button onclick="openDeleteModal(${expense.rowIndex})" class="text-gray-300 hover:text-red-500 transition p-1" title="Delete">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join('');
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
    if (!navigator.onLine) {
        document.getElementById('offline-banner').classList.remove('hidden');
    }
}

async function syncOfflineQueue() {
    if (state.offlineQueue.length === 0 && state.deleteQueue.length === 0) return;
    if (!navigator.onLine || !state.isAuthenticated) return;

    setSyncStatus('syncing');

    // Process adds
    const queue = [...state.offlineQueue];
    state.offlineQueue = [];
    localStorage.setItem('offlineQueue', '[]');

    let addFailed = [];
    for (const expense of queue) {
        try {
            await appendExpense(expense);
        } catch (err) {
            addFailed.push(expense);
        }
    }

    if (addFailed.length > 0) {
        state.offlineQueue = addFailed;
        localStorage.setItem('offlineQueue', JSON.stringify(addFailed));
    }

    // Process deletes — note: row indices may have shifted, so reload after
    const delQueue = [...state.deleteQueue];
    state.deleteQueue = [];
    localStorage.setItem('deleteQueue', '[]');

    // Sort descending so we delete from bottom first (preserves indices)
    delQueue.sort((a, b) => b - a);
    for (const rowIndex of delQueue) {
        try {
            await deleteExpenseFromSheet(rowIndex);
        } catch (err) {
            console.error('Failed to sync delete for row', rowIndex);
        }
    }

    // Reload everything
    await loadExpenses();

    const synced = queue.length - addFailed.length + delQueue.length;
    if (synced > 0) {
        showToast(`Synced ${synced} change(s)`, 'success');
    }
}

// ============================================================
// Tab Navigation
// ============================================================

function switchTab(tab) {
    state.currentTab = tab;

    // Toggle tab content
    document.getElementById('tab-add').classList.toggle('hidden', tab !== 'add');
    document.getElementById('tab-dashboard').classList.toggle('hidden', tab !== 'dashboard');

    // Toggle tab button styles
    const addBtn = document.getElementById('tab-btn-add');
    const dashBtn = document.getElementById('tab-btn-dashboard');

    if (tab === 'add') {
        addBtn.classList.remove('text-gray-400');
        addBtn.classList.add('text-primary');
        dashBtn.classList.remove('text-primary');
        dashBtn.classList.add('text-gray-400');
    } else {
        dashBtn.classList.remove('text-gray-400');
        dashBtn.classList.add('text-primary');
        addBtn.classList.remove('text-primary');
        addBtn.classList.add('text-gray-400');
    }

    // Refresh dashboard data when switching to it
    if (tab === 'dashboard' && state.isAuthenticated && navigator.onLine) {
        loadExpenses();
    }
}

// ============================================================
// Refresh
// ============================================================

async function refreshData() {
    const btn = document.getElementById('refresh-btn');
    btn.disabled = true;
    btn.innerHTML = `
        <svg class="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        Refreshing...
    `;

    try {
        await syncOfflineQueue();
        await loadExpenses();
        showToast('Refreshed!', 'success');
    } catch (err) {
        showToast('Refresh failed', 'error');
    }

    btn.disabled = false;
    btn.innerHTML = `
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
        Refresh
    `;
}

// ============================================================
// Sync Status
// ============================================================

function setSyncStatus(status) {
    const el = document.getElementById('sync-status');
    switch (status) {
        case 'syncing':
            el.textContent = 'Syncing...';
            el.className = 'text-xs opacity-75';
            break;
        case 'synced':
            el.textContent = 'Synced';
            el.className = 'text-xs opacity-75 text-green-200';
            break;
        case 'offline':
            el.textContent = 'Offline';
            el.className = 'text-xs opacity-75 text-amber-200';
            break;
        case 'error':
            el.textContent = 'Sync error';
            el.className = 'text-xs opacity-75 text-red-200';
            break;
        default:
            el.textContent = '';
    }
}

// ============================================================
// Toast Notifications
// ============================================================

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const colors = {
        success: 'bg-green-600',
        error: 'bg-red-600',
        info: 'bg-gray-800',
    };

    const icons = {
        success: '✓',
        error: '✕',
        info: 'ℹ',
    };

    const toast = document.createElement('div');
    toast.className = `toast pointer-events-auto ${colors[type]} text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm font-medium`;
    toast.innerHTML = `<span>${icons[type]}</span> ${escapeHtml(message)}`;
    container.appendChild(toast);

    setTimeout(() => {
        toast.remove();
    }, 3000);
}

// ============================================================
// Utilities
// ============================================================

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
