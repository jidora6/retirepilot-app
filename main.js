const STORAGE_KEY = 'retirepilot-data';
const KIS_SNAPSHOT_STORAGE_KEY = 'retirepilot-kis-snapshot';
const KIS_TREND_STORAGE_KEY = 'retirepilot-kis-trend';
const WOORI_CATALOG_STORAGE_KEY = 'retirepilot-woori-catalog';
const WOORI_PUBLIC_TDF_STORAGE_KEY = 'retirepilot-woori-public-tdf';
const runtimeConfig = window.RETIREPILOT_CONFIG || {};
const hostedMode = Boolean(runtimeConfig.supabaseUrl && runtimeConfig.supabasePublishableKey && runtimeConfig.functionUrl);
const AUTH_STORAGE_KEY = 'retirepilot-auth-session';
const VIEW_STORAGE_KEY = 'retirepilot-active-view';
const HOLDINGS_EXPORT_VERSION = 1;
const VIEW_TITLES = { overview: '홈', accounts: '보유상품', limits: '퇴직연금 한도 검사', products: '상품 검색', recommendations: '운용 제안' };
const EMPTY_PORTFOLIO = {
  accounts: [
    { id: 'k-invest', name: '한국투자증권 IRP' },
    { id: 'woori-dc', name: '우리은행 DC' },
  ],
  holdings: [],
};

function loadData() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.holdings)) {
      const savedAccounts = Array.isArray(saved.accounts) ? saved.accounts : [];
      const accounts = EMPTY_PORTFOLIO.accounts.map(account => {
        const savedAccount = savedAccounts.find(item => item?.id === account.id);
        return savedAccount?.name ? { ...account, name: String(savedAccount.name) } : account;
      });
      return { accounts, holdings: saved.holdings };
    }
  } catch (_) { /* Start empty when local storage is unavailable. */ }
  return structuredClone(EMPTY_PORTFOLIO);
}

const legacyLocalData = loadData();
let data = hostedMode ? structuredClone(EMPTY_PORTFOLIO) : legacyLocalData;
let filter = 'all';
let editingId = null;
let authSession = null;
let authGeneration = 0;
let guestMode = false;
let kisSnapshot = hostedMode ? null : loadKisSnapshot();
let trendSnapshot = hostedMode ? null : loadTrendSnapshot();
let overviewDetail = null;
let productDetailContext = null;
let productInsightCache = new Map();
let catalogComparison = [];
let catalogPerformance = { account: '', codes: new Set(), loading: false, error: '', fetchedAt: '' };
let wooriImportMode = null;
let pendingHoldingImport = null;
let migrationPromptDismissed = false;
const $ = selector => document.querySelector(selector);
const isPublicGuest = () => hostedMode && guestMode && !authSession?.access_token;
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const won = value => '₩ ' + Math.round(value).toLocaleString('ko-KR');
const signed = value => (value > 0 ? '+' : '') + Number(value).toFixed(2) + '%';
const liveKisTypes = {
  '360750': '미국주식',
  '411060': '금현물',
  '480020': '커버드콜'
};
const normalizedName = value => String(value).replaceAll(/\s+/g, '').toLocaleLowerCase('ko-KR');
const isWoori200 = item => normalizedName(item.name) === 'won200';
const displayType = item => isWoori200(item) ? '국내주식 ETF · KOSPI200' : item.type;
const liveKisHolding = item => ({
  id: `kis:${item.code}`,
  code: item.code,
  name: item.name,
  type: liveKisTypes[item.code] || 'ETF',
  account: 'k-invest',
  value: Number(item.value || 0),
  return: Number(item.return || 0),
  source: 'kis-live'
});
const liveKisNames = () => new Set((kisSnapshot?.holdings || []).map(item => normalizedName(item.name)));
const visibleHoldings = () => {
  const manual = data.holdings.filter(item => !(kisSnapshot && item.account === 'k-invest' && liveKisNames().has(normalizedName(item.name))));
  return kisSnapshot ? [...manual, ...kisSnapshot.holdings.map(liveKisHolding)] : manual;
};
const accountTotal = id => visibleHoldings().filter(item => item.account === id).reduce((sum, item) => sum + Number(item.value), 0);
const totalValue = () => data.accounts.reduce((sum, account) => sum + accountTotal(account.id), 0);
const accountName = id => data.accounts.find(account => account.id === id)?.name || id;
const weight = holding => { const total = accountTotal(holding.account); return total ? holding.value / total * 100 : 0; };
const limitLabels = {
  'safe-100': '100% 가능 · 원리금보장/현금',
  'risk-70': '70% 한도군 · 위험자산',
  'qualified-tdf': '100% 가능 · 적격 TDF',
  unverified: '확인 필요 · 금융기관 분류 대기'
};
const productProfiles = {
  '442560': {
    name: 'RISE TDF2040액티브 적격',
    code: '442560',
    fee: '연 0.01%',
    category: '적격 TDF · 자산배분 ETF',
    strategy: '2040년을 목표시점으로 두고 글로벌 주식·채권·대체자산의 비중을 생애주기 방식으로 자동 조정합니다.',
    risk: '적격 TDF라 퇴직연금 편입한도상 100%군으로 안내되지만, 원금보장상품은 아닙니다.',
    source: 'https://www.riseetf.co.kr/prod/finderDetail/44D4'
  }
};

function inferredLimitClass(item) {
  if (item.limitClass && item.limitClass !== 'auto') return item.limitClass;
  const name = normalizedName(item.name);
  if (name.includes('적격tdf')) return 'qualified-tdf';
  if (['정기예금', '현금', '현금성'].includes(item.type)) return 'safe-100';
  if (name === 'won200') return 'risk-70';
  if (item.type === '상품명 확인 필요') return 'unverified';
  return 'risk-70';
}

function limitSummary(accountId) {
  const holdings = visibleHoldings().filter(item => !accountId || item.account === accountId);
  const buckets = Object.fromEntries(Object.keys(limitLabels).map(key => [key, 0]));
  for (const item of holdings) buckets[inferredLimitClass(item)] += Number(item.value || 0);
  const total = holdings.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const cap = total * 0.7;
  return {
    total,
    cap,
    remaining: cap - buckets['risk-70'],
    buckets,
    riskShare: total ? buckets['risk-70'] / total * 100 : 0
  };
}

function loadAuthSession() {
  if (!hostedMode) return;
  try { authSession = JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) || 'null'); }
  catch (_) { authSession = null; }
}

function saveAuthSession(session) {
  authSession = session;
  if (session) guestMode = false;
  try {
    if (session) sessionStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(AUTH_STORAGE_KEY);
  } catch (_) { /* Session persistence is optional. */ }
  updateAuthPanel();
}

function removeRetirePilotStorage(storage) {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    keys.filter(key => key?.startsWith('retirepilot-')).forEach(key => storage.removeItem(key));
  } catch (_) { /* Storage may be unavailable in private browsing. */ }
}

function localPortfolioForMigration() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return saved && Array.isArray(saved.holdings) ? saved : null;
  } catch (_) {
    return null;
  }
}

function hasUnmigratedLocalHoldings() {
  return Boolean(hostedMode && localPortfolioForMigration()?.holdings?.length);
}

async function logoutPrivateSession(options = {}) {
  if (hasUnmigratedLocalHoldings() && !options.discardUnmigrated) {
    const confirmed = globalThis.confirm?.('아직 Supabase로 이전되지 않은 로컬 보유상품이 있습니다. 로그아웃하면 이 브라우저의 보유 데이터가 삭제됩니다. 정말 로그아웃하고 삭제할까요?') ?? false;
    if (!confirmed) return false;
  }
  authGeneration += 1;
  authSession = null;
  guestMode = false;
  removeRetirePilotStorage(localStorage);
  removeRetirePilotStorage(sessionStorage);
  data = structuredClone(EMPTY_PORTFOLIO);
  kisSnapshot = null;
  trendSnapshot = null;
  wooriCatalogue = { items: [], importedAt: null };
  wooriPublicTdf = { items: [], fetchedAt: null };
  productInsightCache.clear();
  catalogComparison = [];
  catalogPerformance = { account: '', codes: new Set(), loading: false, error: '', fetchedAt: '' };
  productDetailContext?.trigger?.setAttribute?.('aria-expanded', 'false');
  productDetailContext?.trigger?.classList?.remove?.('detail-open');
  productDetailContext = null;
  overviewDetail = null;
  wooriImportMode = null;
  editingId = null;
  filter = 'all';
  document.querySelectorAll('.modal.open').forEach(modal => modal.classList.remove('open'));
  $('#product-detail-panel')?.remove();
  $('#product-form')?.reset();
  if ($('#woori-paste-input')) $('#woori-paste-input').value = '';
  if ($('#catalog-query')) $('#catalog-query').value = '';
  document.querySelectorAll('.account-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.account === 'all'));
  switchView('overview', { persist: false });
  render();
  updateAuthPanel();
  if (hostedMode) {
    $('#kis-status').textContent = '로그인 후 잔고를 조회할 수 있습니다.';
    $('#kis-preview-btn').disabled = true;
  }
  try {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith('retirepilot-')).map(name => caches.delete(name)));
  } catch (_) { /* Cache Storage may be unavailable. */ }
  return true;
}

function updateAuthPanel() {
  document.body.classList.remove('auth-pending');
  let panel = $('#auth-panel');
  if (!panel && hostedMode) {
    panel = document.createElement('div');
    panel.id = 'auth-panel';
    panel.className = 'auth-gate';
    panel.innerHTML = '<div class="auth-gate-card"><div class="auth-brand"><span class="brand-mark">R</span><div><strong>RetirePilot</strong><small>PRIVATE WORKSPACE</small></div></div><h1>퇴직연금 계정 로그인</h1><p id="auth-status">Supabase 계정으로 로그인하세요.</p><form id="auth-form" autocomplete="off"><label>이메일<input name="email" type="email" required autocomplete="username"></label><label>비밀번호<input name="password" type="password" required autocomplete="current-password"></label><button class="primary-btn" id="auth-submit" type="submit">로그인</button></form><button class="outline-btn guest-browse-btn" id="guest-browse-btn" type="button">로그인 없이 상품 검색</button><small class="auth-note">공개 상품 검색은 로그인 없이 이용할 수 있습니다. 계좌·보유상품·수익률 분석·운용 제안은 로그인 후에만 표시됩니다.</small></div>';
    document.body.append(panel);
    panel.querySelector('#guest-browse-btn').addEventListener('click', () => {
      guestMode = true;
      data = structuredClone(EMPTY_PORTFOLIO);
      switchView('products', { persist: false });
      updateAuthPanel();
      renderCatalog();
    });
    panel.querySelector('#auth-form').addEventListener('submit', async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const message = panel.querySelector('#auth-status');
      const button = panel.querySelector('#auth-submit');
      button.disabled = true;
      message.textContent = '로그인 중입니다.';
      try {
        const result = await authRequest('token?grant_type=password', { email: form.elements.namedItem('email').value.trim(), password: form.elements.namedItem('password').value });
        saveAuthSession({ ...result, expires_at: Math.floor(Date.now() / 1000) + Number(result.expires_in || 3600) });
        form.reset();
        await loadSupabaseHoldings();
        switchView(loadSavedView());
        maybeOfferLocalMigration();
        if (await checkKisConnection()) await refreshKisHoldings({ quiet: true });
      } catch (error) {
        message.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }
  if (!panel) return;
  panel.hidden = !hostedMode;
  if (!hostedMode) return;
  const form = $('#auth-form');
  const status = $('#auth-status');
  const logout = $('#auth-session-btn');
  const signedIn = Boolean(authSession?.access_token);
  const browsingPublicly = guestMode && !signedIn;
  panel.hidden = signedIn || browsingPublicly;
  document.body.classList.toggle('auth-locked', !signedIn && !browsingPublicly);
  document.body.classList.toggle('guest-mode', browsingPublicly);
  if (form) form.hidden = signedIn;
  if (logout) {
    logout.hidden = !signedIn && !browsingPublicly;
    logout.textContent = browsingPublicly ? '로그인' : '로그아웃';
  }
  if ($('.eyebrow')) $('.eyebrow').textContent = browsingPublicly ? 'PUBLIC CATALOG' : 'MY RETIREMENT';
  status.textContent = signedIn ? '운영 계정으로 로그인됨 · KIS 키는 서버에만 있습니다.' : '본인 Supabase 계정으로 로그인하세요.';
}

function loadSavedView() {
  try {
    const view = sessionStorage.getItem(VIEW_STORAGE_KEY);
    return VIEW_TITLES[view] ? view : 'overview';
  } catch (_) {
    return 'overview';
  }
}

async function authRequest(path, body) {
  const response = await fetch(`${runtimeConfig.supabaseUrl}/auth/v1/${path}`, {
    method: 'POST',
    headers: { apikey: runtimeConfig.supabasePublishableKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_description || result.msg || result.message || 'Supabase 로그인에 실패했습니다.');
  return result;
}

async function ensureHostedSession() {
  if (!hostedMode) return true;
  if (authSession?.access_token && (!authSession.expires_at || authSession.expires_at > Math.floor(Date.now() / 1000) + 30)) return true;
  if (!authSession?.refresh_token) return false;
  const generation = authGeneration;
  try {
    const refreshed = await authRequest('token?grant_type=refresh_token', { refresh_token: authSession.refresh_token });
    if (generation !== authGeneration) return false;
    saveAuthSession({ ...refreshed, expires_at: Math.floor(Date.now() / 1000) + Number(refreshed.expires_in || 3600) });
    return true;
  } catch {
    if (generation === authGeneration) void logoutPrivateSession();
    return false;
  }
}

function holdingsEndpoint(query = '') {
  return `${runtimeConfig.supabaseUrl}/rest/v1/holdings${query}`;
}

async function holdingsRequest(query = '', options = {}) {
  if (!hostedMode || !await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const response = await fetch(holdingsEndpoint(query), {
    ...options,
    headers: {
      apikey: runtimeConfig.supabasePublishableKey,
      authorization: `Bearer ${authSession.access_token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    cache: 'no-store',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || result?.error || '보유상품 저장소 요청에 실패했습니다.');
  return result;
}

function dateForDatabase(value) {
  const text = String(value || '').trim();
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function clientRecordKey(item, index = 0, prefix = 'manual') {
  if (item.recordKey && String(item.recordKey).length <= 200) return String(item.recordKey);
  const identity = item.id ?? item.code ?? `${normalizedName(item.name)}:${index}`;
  return `${prefix}:${item.account}:${identity}`.slice(0, 200);
}

function holdingForDatabase(item, index = 0, sourceOverride = null) {
  const allowedSources = new Set(['manual', 'kis-manual', 'woori-import', 'local-migration']);
  const source = sourceOverride || (allowedSources.has(item.source) ? item.source : 'manual');
  return {
    record_key: clientRecordKey(item, index, source === 'local-migration' ? 'legacy' : 'manual'),
    account_key: item.account,
    product_name: item.name,
    product_type: item.type || '기타',
    product_code: item.code || null,
    evaluation_amount: Number(item.value || 0),
    quantity: item.quantity === undefined || item.quantity === null ? null : Number(item.quantity),
    average_purchase_price: item.averagePrice === undefined || item.averagePrice === null ? null : Number(item.averagePrice),
    official_evaluation_amount: item.officialValue === undefined || item.officialValue === null ? null : Number(item.officialValue),
    return_rate: item.return === undefined || item.return === null ? null : Number(item.return),
    limit_class: item.limitClass || null,
    source,
    memo: item.memo || null,
    is_market_estimated: Boolean(item.marketEstimated),
    market_price: item.marketPrice === undefined || item.marketPrice === null ? null : Number(item.marketPrice),
    market_price_date: dateForDatabase(item.marketPriceDate),
    market_updated_at: item.marketUpdatedAt || null,
    sort_order: Number.isInteger(item.sortOrder) ? item.sortOrder : index,
  };
}

function holdingFromDatabase(row) {
  return {
    id: row.id,
    recordKey: row.record_key,
    account: row.account_key,
    name: row.product_name,
    type: row.product_type,
    code: row.product_code || undefined,
    value: Number(row.evaluation_amount || 0),
    quantity: row.quantity === null ? undefined : Number(row.quantity),
    averagePrice: row.average_purchase_price === null ? undefined : Number(row.average_purchase_price),
    officialValue: row.official_evaluation_amount === null ? null : Number(row.official_evaluation_amount),
    return: row.return_rate === null ? 0 : Number(row.return_rate),
    limitClass: row.limit_class || 'auto',
    source: row.source,
    memo: row.memo || '',
    marketEstimated: Boolean(row.is_market_estimated),
    marketPrice: row.market_price === null ? undefined : Number(row.market_price),
    marketPriceDate: row.market_price_date || null,
    marketUpdatedAt: row.market_updated_at || null,
    sortOrder: Number(row.sort_order || 0),
  };
}

async function loadSupabaseHoldings() {
  if (!hostedMode) return data.holdings;
  const select = 'id,record_key,account_key,product_name,product_type,product_code,evaluation_amount,quantity,average_purchase_price,official_evaluation_amount,return_rate,limit_class,source,memo,is_market_estimated,market_price,market_price_date,market_updated_at,sort_order';
  const rows = await holdingsRequest(`?select=${select}&order=sort_order.asc,created_at.asc`);
  data = { accounts: structuredClone(EMPTY_PORTFOLIO.accounts), holdings: (rows || []).map(holdingFromDatabase) };
  render();
  return data.holdings;
}

async function upsertSupabaseHoldings(items, sourceOverride = null) {
  const manualItems = items.filter(item => item.source !== 'kis-live');
  if (!manualItems.length) return [];
  return holdingsRequest('?on_conflict=user_id,record_key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(manualItems.map((item, index) => holdingForDatabase(item, index, sourceOverride))),
  });
}

async function deleteSupabaseHoldings(ids) {
  const safeIds = ids.filter(id => /^[0-9a-f-]{36}$/i.test(String(id)));
  if (!safeIds.length) return;
  await holdingsRequest(`?id=in.(${safeIds.map(encodeURIComponent).join(',')})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
}

async function fetchKisHoldings() {
  if (!hostedMode) return fetch('/api/kis/holdings', { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const response = await fetch(runtimeConfig.functionUrl, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function fetchKisTrends() {
  if (!hostedMode) return fetch('/api/kis/trends', { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const url = new URL(runtimeConfig.functionUrl);
  url.searchParams.set('mode', 'trend');
  const response = await fetch(url, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function fetchKisProductInsight(code) {
  if (!/^[0-9A-Z]{6}$/.test(code)) throw new Error('상품 코드가 올바르지 않습니다.');
  if (!hostedMode) return fetch(`/api/kis/product-insight?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const url = new URL(runtimeConfig.functionUrl);
  url.searchParams.set('mode', 'product');
  url.searchParams.set('code', code);
  const response = await fetch(url, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function fetchKisPerformance(codes) {
  const uniqueCodes = [...new Set(codes.filter(code => /^[0-9A-Z]{6}$/.test(code)))].slice(0, 12);
  if (!uniqueCodes.length) throw new Error('분석할 상장상품 코드가 없습니다.');
  if (!hostedMode) return fetch(`/api/kis/performance?codes=${encodeURIComponent(uniqueCodes.join(','))}`, { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const url = new URL(runtimeConfig.functionUrl);
  url.searchParams.set('mode', 'performance');
  url.searchParams.set('codes', uniqueCodes.join(','));
  const response = await fetch(url, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function fetchWooriEtfQuotes(codes) {
  const uniqueCodes = [...new Set(codes.filter(code => /^[0-9A-Z]{6}$/.test(code)))].slice(0, 10);
  if (!uniqueCodes.length) throw new Error('시세를 조회할 ETF 종목코드가 없습니다.');
  if (!hostedMode) return fetch(`/api/kis/woori-quotes?codes=${encodeURIComponent(uniqueCodes.join(','))}`, { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const url = new URL(runtimeConfig.functionUrl);
  url.searchParams.set('mode', 'woori-quotes');
  url.searchParams.set('codes', uniqueCodes.join(','));
  const response = await fetch(url, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function fetchWooriPublicTdf() {
  if (!hostedMode) return fetch('/api/woori/public-tdf', { cache: 'no-store' });
  if (!await ensureHostedSession()) throw new Error('먼저 운영 계정에 로그인하세요.');
  const url = new URL(runtimeConfig.functionUrl);
  url.searchParams.set('mode', 'woori-public-tdf');
  const response = await fetch(url, {
    headers: { apikey: runtimeConfig.supabasePublishableKey, authorization: `Bearer ${authSession.access_token}` },
    cache: 'no-store',
  });
  if (response.status === 401) {
    void logoutPrivateSession();
    throw new Error('로그인이 만료되었습니다. 다시 로그인하세요.');
  }
  return response;
}

async function saveData() {
  if (hostedMode) {
    await upsertSupabaseHoldings(data.holdings);
    await loadSupabaseHoldings();
    return;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ accounts: data.accounts, holdings: data.holdings })); }
  catch (_) { throw new Error('브라우저 저장에 실패했습니다.'); }
}

function validateImportedHoldings(payload) {
  if (!payload || !Array.isArray(payload.holdings)) throw new Error('RetirePilot 보유상품 JSON 형식이 아닙니다.');
  if (payload.holdings.length > 500) throw new Error('한 번에 가져올 수 있는 상품은 최대 500개입니다.');
  const accounts = new Set(EMPTY_PORTFOLIO.accounts.map(account => account.id));
  return payload.holdings.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${index + 1}번째 상품 형식이 올바르지 않습니다.`);
    if (raw.source === 'kis-live') throw new Error(`${index + 1}번째 상품은 KIS 실시간 조회 항목이라 가져올 수 없습니다.`);
    const name = String(raw.name || '').trim();
    const account = String(raw.account || '').trim();
    const value = Number(raw.value);
    const rate = Number(raw.return ?? 0);
    const quantity = raw.quantity === undefined || raw.quantity === null || raw.quantity === '' ? undefined : Number(raw.quantity);
    const averagePrice = raw.averagePrice === undefined || raw.averagePrice === null || raw.averagePrice === '' ? undefined : Number(raw.averagePrice);
    if (!name || name.length > 300) throw new Error(`${index + 1}번째 상품명을 확인하세요.`);
    if (!accounts.has(account)) throw new Error(`${index + 1}번째 상품의 계좌 구분이 올바르지 않습니다.`);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${index + 1}번째 상품의 평가금액을 확인하세요.`);
    if (!Number.isFinite(rate) || rate < -100) throw new Error(`${index + 1}번째 상품의 수익률을 확인하세요.`);
    if (quantity !== undefined && (!Number.isFinite(quantity) || quantity < 0)) throw new Error(`${index + 1}번째 상품의 수량을 확인하세요.`);
    if (averagePrice !== undefined && (!Number.isFinite(averagePrice) || averagePrice < 0)) throw new Error(`${index + 1}번째 상품의 평균매입단가를 확인하세요.`);
    const id = String(raw.id || globalThis.crypto?.randomUUID?.() || `import-${Date.now()}-${index}`);
    return {
      id,
      recordKey: clientRecordKey({ ...raw, id, account, name }, index, 'legacy'),
      account,
      name,
      type: String(raw.type || '기타').slice(0, 50),
      code: raw.code ? String(raw.code).slice(0, 30) : undefined,
      value,
      return: rate,
      quantity,
      averagePrice,
      officialValue: raw.officialValue === undefined || raw.officialValue === null ? null : Number(raw.officialValue),
      limitClass: raw.limitClass ? String(raw.limitClass).slice(0, 50) : 'auto',
      memo: raw.memo ? String(raw.memo).slice(0, 2000) : '',
      source: ['manual', 'kis-manual', 'woori-import'].includes(raw.source) ? raw.source : 'local-migration',
      marketEstimated: Boolean(raw.marketEstimated),
      marketPrice: raw.marketPrice === undefined || raw.marketPrice === null ? undefined : Number(raw.marketPrice),
      marketPriceDate: raw.marketPriceDate || null,
      marketUpdatedAt: raw.marketUpdatedAt || null,
    };
  });
}

function holdingsTransferSummary(items) {
  return {
    count: items.length,
    total: items.reduce((sum, item) => sum + Number(item.value || 0), 0),
  };
}

function exportHoldingsJson() {
  const localPortfolio = localPortfolioForMigration();
  const sourcePortfolio = localPortfolio?.holdings?.length ? localPortfolio : data;
  const holdings = sourcePortfolio.holdings.filter(item => item.source !== 'kis-live').map((item, index) => ({
    ...item,
    recordKey: clientRecordKey(item, index, 'legacy'),
  }));
  if (!holdings.length) throw new Error('내보낼 직접 입력 보유상품이 없습니다.');
  const payload = {
    format: 'retirepilot-holdings',
    version: HOLDINGS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    accounts: Array.isArray(sourcePortfolio.accounts) ? sourcePortfolio.accounts : EMPTY_PORTFOLIO.accounts,
    holdings,
    warning: '보유 금액이 들어 있는 파일입니다. 이전 후 삭제하세요',
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `retirepilot-holdings-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function renderHoldingImportModal(items, origin) {
  pendingHoldingImport = { items, origin };
  const summary = holdingsTransferSummary(items);
  let modal = $('#holding-import-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'holding-import-modal';
    modal.className = 'modal';
    document.body.append(modal);
  }
  const accountRows = EMPTY_PORTFOLIO.accounts.map(account => {
    const accountItems = items.filter(item => item.account === account.id);
    return `<div><span>${escapeHtml(account.name)}</span><b>${accountItems.length}건 · ${won(holdingsTransferSummary(accountItems).total)}</b></div>`;
  }).join('');
  modal.innerHTML = `<div class="modal-card transfer-modal-card"><button class="modal-close" type="button" data-close-holding-import aria-label="닫기">×</button><h2>보유상품 가져오기 확인</h2><p>${origin === 'localStorage' ? '현재 주소에서 기존 브라우저 보유 데이터를 발견했습니다.' : '선택한 JSON 파일을 검증했습니다.'} 아래 건수와 합계를 확인한 뒤 Supabase로 이전하세요.</p><div class="transfer-summary"><strong>${summary.count}건</strong><span>${won(summary.total)}</span></div><div class="transfer-account-list">${accountRows}</div><p class="transfer-warning">보유 금액이 들어 있는 파일입니다. 이전 후 삭제하세요.</p><div class="modal-actions"><button class="outline-btn" type="button" data-close-holding-import>나중에</button><button class="primary-btn" type="button" data-apply-holding-import>Supabase로 이전</button></div></div>`;
  modal.classList.add('open');
}

function closeHoldingImportModal() {
  $('#holding-import-modal')?.classList.remove('open');
  migrationPromptDismissed = true;
  pendingHoldingImport = null;
}

async function applyPendingHoldingImport() {
  if (!pendingHoldingImport) return;
  const { items, origin } = pendingHoldingImport;
  const expected = holdingsTransferSummary(items);
  const button = $('[data-apply-holding-import]');
  if (button) { button.disabled = true; button.textContent = '이전 중…'; }
  try {
    await upsertSupabaseHoldings(items);
    const serverItems = await loadSupabaseHoldings();
    const expectedKeys = new Set(items.map((item, index) => clientRecordKey(item, index, 'legacy')));
    const matched = serverItems.filter(item => expectedKeys.has(item.recordKey));
    const actual = holdingsTransferSummary(matched);
    if (actual.count !== expected.count || Math.round(actual.total * 100) !== Math.round(expected.total * 100)) {
      throw new Error(`서버 대조가 일치하지 않습니다. 예상 ${expected.count}건, 서버 ${actual.count}건입니다. 원본을 삭제하지 마세요.`);
    }
    let removedLocal = false;
    if (origin === 'localStorage') {
      localStorage.removeItem(STORAGE_KEY);
      removedLocal = true;
    } else {
      const local = localPortfolioForMigration();
      if (local?.holdings?.length) {
        try {
          const localItems = validateImportedHoldings(local);
          const localKeys = new Set(localItems.map((item, index) => clientRecordKey(item, index, 'legacy')));
          const sameKeys = localKeys.size === expectedKeys.size && [...localKeys].every(key => expectedKeys.has(key));
          const localSummary = holdingsTransferSummary(localItems);
          const sameTotal = Math.round(localSummary.total * 100) === Math.round(expected.total * 100);
          if (sameKeys && sameTotal) {
            localStorage.removeItem(STORAGE_KEY);
            removedLocal = true;
          }
        } catch (_) { /* An unrelated local portfolio must be preserved. */ }
      }
    }
    pendingHoldingImport = null;
    const modal = $('#holding-import-modal');
    const cleanupMessage = origin === 'file'
      ? `가져온 JSON 파일은 기기에서 직접 삭제하세요.${removedLocal ? ' 대조된 이 주소의 로컬 보유 데이터도 삭제했습니다.' : ''}`
      : '이전이 확인되어 이 주소의 로컬 보유 데이터를 삭제했습니다.';
    modal.innerHTML = `<div class="modal-card transfer-modal-card"><h2>이전 완료</h2><p>서버에서 다시 조회해 건수와 평가금액 합계를 대조했습니다.</p><div class="transfer-summary verified"><strong>${actual.count}건 확인</strong><span>${won(actual.total)}</span></div><p class="transfer-warning">${cleanupMessage}</p><div class="modal-actions"><button class="primary-btn" type="button" data-close-holding-import>확인</button></div></div>`;
    render();
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = '다시 시도'; }
    throw error;
  }
}

function maybeOfferLocalMigration() {
  if (!hostedMode || !authSession?.access_token || migrationPromptDismissed) return;
  const local = localPortfolioForMigration();
  if (!local?.holdings?.length) return;
  try { renderHoldingImportModal(validateImportedHoldings(local), 'localStorage'); }
  catch (error) { toast(`기존 브라우저 데이터 확인 필요: ${error.message}`); }
}

function loadWooriCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem(WOORI_CATALOG_STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.items)) return saved;
  } catch (_) { /* An invalid locally pasted catalogue is ignored. */ }
  return { items: [], importedAt: null };
}

function saveWooriCatalog(catalogue) {
  try { localStorage.setItem(WOORI_CATALOG_STORAGE_KEY, JSON.stringify(catalogue)); }
  catch (_) { toast('우리은행 상품 목록 저장에 실패했습니다.'); }
}

let wooriCatalogue = loadWooriCatalog();

function loadWooriPublicTdf() {
  try {
    const saved = JSON.parse(localStorage.getItem(WOORI_PUBLIC_TDF_STORAGE_KEY) || 'null');
    if (saved && Array.isArray(saved.items)) return saved;
  } catch (_) { /* A stale public catalogue can be fetched again. */ }
  return { items: [], fetchedAt: null };
}

function saveWooriPublicTdf(catalogue) {
  try { localStorage.setItem(WOORI_PUBLIC_TDF_STORAGE_KEY, JSON.stringify(catalogue)); }
  catch (_) { toast('우리은행 공개 TDF 목록 저장에 실패했습니다.'); }
}

let wooriPublicTdf = loadWooriPublicTdf();

function loadKisSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem(KIS_SNAPSHOT_STORAGE_KEY) || 'null');
    if (saved && typeof saved.fetchedAt === 'string' && Array.isArray(saved.holdings)) return saved;
  } catch (_) { /* A fresh read-only snapshot will replace invalid local data. */ }
  return null;
}

function saveKisSnapshot(snapshot) {
  try { localStorage.setItem(KIS_SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshot)); }
  catch (_) { /* The current page can still use the live snapshot. */ }
}

function loadTrendSnapshot() {
  try {
    const saved = JSON.parse(localStorage.getItem(KIS_TREND_STORAGE_KEY) || 'null');
    if (saved && typeof saved.fetchedAt === 'string' && Array.isArray(saved.items)) return saved;
  } catch (_) { /* A failed trend refresh must not affect the portfolio view. */ }
  return null;
}

function saveTrendSnapshot(snapshot) {
  try { localStorage.setItem(KIS_TREND_STORAGE_KEY, JSON.stringify(snapshot)); }
  catch (_) { /* The current page can still use the trend result. */ }
}

function kisSnapshotLabel() {
  return kisSnapshot ? new Date(kisSnapshot.fetchedAt).toLocaleString('ko-KR') : '';
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  setTimeout(() => element.classList.remove('show'), 2600);
}

function trendGuidance(holding, trend) {
  if (!trend?.available) return { label: '가격 데이터 확인 필요', detail: '가격 데이터가 충분하지 않아 추세를 판정하지 못했습니다.' };
  const protectingProfit = Number(holding?.return) > 0;
  const byStatus = {
    normal: protectingProfit
      ? { label: '수익 보호 신호 없음', detail: '수익 중이지만 최근 가격 흐름은 정상입니다. 수익률만으로 매도하지 않습니다.' }
      : { label: '추세 정상', detail: '최근 가격 흐름만으로는 교체를 검토할 신호가 없습니다.' },
    watch: protectingProfit
      ? { label: '수익 보호 관찰', detail: '단기 흐름이 약합니다. 지금 매도하지 말고 다음 새로고침에서 10·20일 흐름을 확인합니다.' }
      : { label: '하락 관찰', detail: '단기 하락을 관찰합니다. 이 신호만으로 교체하지 않습니다.' },
    review: protectingProfit
      ? { label: '수익 보호 검토', detail: '수익 중이지만 하락 흐름이 확인됐습니다. 전량 매도 대신 일부 축소·대체 후보를 비교합니다.' }
      : { label: '교체 검토', detail: '하락 흐름이 확인됐습니다. 대체 후보·비중·한도를 함께 확인합니다.' },
    priority: protectingProfit
      ? { label: '수익 보호 우선 검토', detail: '수익 중이지만 중기 하락 흐름이 강합니다. 부분 매도·대체를 우선 검토합니다.' }
      : { label: '교체 우선 검토', detail: '중기 하락 흐름이 강합니다. 교체 후보·비중·한도를 우선 확인합니다.' },
  };
  return byStatus[trend.status] || { label: '추세 확인 필요', detail: '추세 상태를 확인할 수 없습니다.' };
}

function recommendations() {
  const result = [];
  const holdings = visibleHoldings();
  const covered = holdings.find(item => item.type === '커버드콜');
  if (covered && covered.return <= -10 && weight(covered) >= 20) {
    result.push({
      id: 'covered', kind: 'orange', group: 'loss', icon: '↗',
      title: `${accountName(covered.account)} · 커버드콜 비중 축소 검토`,
      text: `${covered.name}은 매입 이후 ${signed(covered.return)}, 계좌의 ${weight(covered).toFixed(1)}%입니다. 수익률뿐 아니라 커버드콜 전략의 집중 위험도 확인하세요. 전량 교체보다 일부 축소 방안을 먼저 검토하세요.`,
      meta: [['교체 1순위', '일부 축소'], ['제안 상품', 'RISE 적격 TDF 2040'], ['KIS 목록', '442560']],
      proposal: { from: covered.name, to: 'RISE TDF2040액티브 적격 (442560)', amount: `보유액의 절반 예시 ${won(Number(covered.value || 0) * 0.5)}`, amountValue: Math.round(Number(covered.value || 0) * 0.5), code: '442560', note: '부분 교체 가정이며 목표시점과 실제 매수 가능 여부를 먼저 확인하세요.' },
      account: covered.account, actionLabel: '보유상품 한도'
    });
  }
  const gold = holdings.find(item => item.type === '금현물');
  if (gold && weight(gold) >= 20) {
    result.push({
      id: 'gold-weight', kind: 'orange', group: 'positive', icon: '◒',
      title: `${accountName(gold.account)} · 금현물 편입비중 조정 검토`,
      text: `${gold.name}은 수익률 ${signed(gold.return)}이지만 계좌의 ${weight(gold).toFixed(1)}%입니다. 수익률이 플러스라는 이유만으로 유지하기보다, 금을 방어·분산 역할로 볼지부터 정하고 신규 매수는 멈춘 뒤 목표 비중을 정하는 편이 낫습니다.`,
      meta: [['현재 비중', weight(gold).toFixed(1) + '%'], ['권장 행동', '신규 매수 중단'], ['대안', '적격 TDF 또는 핵심지수']],
      proposal: { from: gold.name, to: 'RISE TDF2040액티브 적격 (442560)', amount: `보유액의 25% 예시 ${won(Number(gold.value || 0) * 0.25)}`, amountValue: Math.round(Number(gold.value || 0) * 0.25), code: '442560', note: '금은 일부를 남기고 비중만 낮추는 가정입니다.' },
      account: gold.account, actionLabel: '보유상품 한도'
    });
  }
  const woori200 = holdings.find(isWoori200);
  const concentrated = holdings.find(item => item.type === '국내주식 집중형');
  if (woori200 && concentrated) {
    result.push({
      id: 'domestic-overlap', kind: 'orange', group: 'loss', icon: '!',
      title: `${accountName(woori200.account)} · 국내 대형주 중복 축소 검토`,
      text: `${woori200.name}은 KOSPI200 ETF로 식별됐고, ${concentrated.name}은 국내 대형주 중심 ETF입니다. 두 상품 합계가 계좌의 ${(weight(woori200) + weight(concentrated)).toFixed(1)}%라 한국 대형주 흐름에 중복 노출됩니다. 새 국내주식 매수는 보류하고, 교체한다면 ${concentrated.name}부터 우선 검토하세요.`,
      meta: [['중복 노출', (weight(woori200) + weight(concentrated)).toFixed(1) + '%'], ['교체 우선', concentrated.name], ['우리은행 확인', '실제 라인업']], action: 'products', actionLabel: '상품 목록'
    });
  }
  const deposit = holdings.find(item => item.type === '정기예금');
  if (deposit) {
    result.push({
      id: 'deposit', kind: 'teal', group: 'positive', icon: '₩',
      title: `${accountName(deposit.account)} · 정기예금은 당분간 유지`,
      text: `계좌 비중 ${weight(deposit).toFixed(1)}%의 안전자산입니다. 만기·중도해지 조건을 확인하기 전에는 교체하지 마세요. 국내주식 중복을 줄이더라도 안전자산 역할을 먼저 없애는 순서는 권하지 않습니다.`,
      meta: [['현재 비중', weight(deposit).toFixed(1) + '%'], ['행동', '만기 확인 후 판단'], ['역할', '안정자산']]
    });
  }
  for (const trend of trendSnapshot?.items || []) {
    if (!trend.available || !['review', 'priority'].includes(trend.status)) continue;
    const holding = holdings.find(item => item.code === trend.code || normalizedName(item.name) === normalizedName(trend.name));
    if (!holding) continue;
    const guidance = trendGuidance(holding, trend);
    const protectingProfit = holding.return > 0;
    const label = trend.status === 'priority' ? '20거래일 하락 추세' : '10거래일 하락 추세';
    result.push({
      id: `trend-${trend.code}`, kind: 'orange', group: protectingProfit ? 'positive' : 'loss', icon: '⌁',
      title: `${accountName(holding.account)} · ${guidance.label}`,
      text: `${holding.name}은 매입 이후 ${signed(holding.return)}이며 ${label}가 감지됐습니다. 최근 5일 ${trendRate(trend.five?.return)}, 10일 ${trendRate(trend.ten?.return)}, 20일 ${trendRate(trend.twenty?.return)}입니다. ${guidance.detail}`,
      meta: [['판정', guidance.label], ['최근 고점 대비', trendRate(trend.twenty?.drawdown ?? trend.ten?.drawdown ?? trend.five?.drawdown)], ['기준일', trend.lastDate || '—']],
      account: holding.account, actionLabel: '보유상품 한도'
    });
  }
  return result;
}

function trendRate(value) {
  return Number.isFinite(value) ? signed(value) : '—';
}

function renderTotals() {
  const ki = accountTotal('k-invest');
  const woori = accountTotal('woori-dc');
  const total = ki + woori;
  const share = total ? ki / total * 100 : 0;
  $('#total-value').textContent = won(total);
  $('#legend-total-value').textContent = won(total);
  $('#ki-total').textContent = won(ki);
  $('#woori-total').textContent = won(woori);
  $('#ki-share').textContent = share.toFixed(1) + '%';
  $('#woori-share').textContent = (total ? 100 - share : 0).toFixed(1) + '%';
  $('#profit-count').textContent = visibleHoldings().filter(item => item.return > 0).length + '개';
  $('#loss-count').textContent = visibleHoldings().filter(item => item.return < 0).length + '개';
}

function renderOverviewDetail() {
  const host = $('#overview-detail');
  if (!host) return;
  if (!overviewDetail) {
    host.hidden = true;
    host.innerHTML = '';
    $('.metric-grid')?.insertAdjacentElement('afterend', host);
    return;
  }
  const trigger = [...document.querySelectorAll('[data-overview-detail]')].find(element => element.dataset.overviewDetail === overviewDetail);
  const grid = $('.metric-grid');
  const cards = grid ? [...grid.children].filter(element => element.matches('[data-overview-detail]')) : [];
  const triggerIndex = cards.indexOf(trigger);
  const columnCount = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(/\s+/).filter(Boolean).length) : 1;
  const rowEndIndex = Math.min(cards.length - 1, Math.floor(triggerIndex / columnCount) * columnCount + columnCount - 1);
  (cards[rowEndIndex] || trigger)?.insertAdjacentElement('afterend', host);
  host.hidden = false;
  const holdings = visibleHoldings();
  if (overviewDetail === 'recommendations') {
    const items = recommendations();
    host.innerHTML = `<div class="overview-detail-head"><h3>확인할 제안</h3><div><button class="text-btn" data-view-link="recommendations">운용 제안으로 보기 →</button><button class="inline-close" type="button" data-close-overview-detail aria-label="상세 닫기">×</button></div></div>${items.map(item => `<div class="overview-detail-row"><div><strong>${escapeHtml(item.title)}</strong><small>운용 제안 · ${escapeHtml(item.meta?.[0]?.[1] || '검토 필요')}</small></div><span class="status-tag info">검토</span></div>`).join('') || '<div class="empty-state">현재 제안이 없습니다.</div>'}`;
    return;
  }
  const labels = { all: '전체 보유 상품', profit: '수익 중인 상품', loss: '손실 중인 상품' };
  const filtered = holdings.filter(item => overviewDetail === 'all' || (overviewDetail === 'profit' ? item.return > 0 : item.return < 0));
  host.innerHTML = `<div class="overview-detail-head"><h3>${labels[overviewDetail]}</h3><div><button class="text-btn" data-view-link="accounts">보유상품에서 보기 →</button><button class="inline-close" type="button" data-close-overview-detail aria-label="상세 닫기">×</button></div></div>${filtered.map(item => `<div class="overview-detail-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(accountName(item.account))} · ${escapeHtml(displayType(item))}</small></div><div><b class="${item.return >= 0 ? 'return-positive' : 'return-negative'}">${signed(item.return)}</b><small>${won(item.value)}</small></div></div>`).join('') || '<div class="empty-state">표시할 상품이 없습니다.</div>'}`;
}

function renderHoldings() {
  $('#holdings-table').innerHTML = visibleHoldings()
    .filter(item => filter === 'all' || item.account === filter)
    .map(item => {
      const status = item.type === '상품명 확인 필요' && !isWoori200(item) ? ['watch', '확인 필요'] :
        item.return <= -10 ? ['watch', '검토'] :
        ['info', '기록'];
      const source = item.source === 'kis-live';
      const importedWoori = item.source === 'woori-import';
      return `<div class="holding-row">
        <div class="holding-name"><span class="product-mark">${escapeHtml(displayType(item).slice(0, 1))}</span><div>${escapeHtml(item.name)}<span class="holding-sub">${source ? `KIS 자동 조회 · ${escapeHtml(item.code)}` : importedWoori ? `우리은행 표 가져오기${item.code ? ` · ${escapeHtml(item.code)}` : ''}${item.quantity && item.averagePrice ? ' · 시세 자동반영 후보' : ''}` : `${escapeHtml(displayType(item))} · 직접 입력`}</span></div></div>
        <div class="account-tag">${escapeHtml(accountName(item.account).replace('한국투자증권 ', '').replace('우리은행 ', ''))}</div>
        <div>${won(item.value)}</div>
        <div class="${item.return >= 0 ? 'return-positive' : 'return-negative'}">${signed(item.return)}</div>
        <div><div class="weight-bar"><i style="width:${Math.min(weight(item) * 3, 100)}%"></i></div><small class="holding-sub">${weight(item).toFixed(1)}%</small></div>
        <div class="holding-actions"><span class="status-tag ${source ? 'good' : status[0]}">${source ? '자동 갱신' : status[1]}</span>${source ? '' : `<button type="button" class="edit-btn" data-edit="${escapeHtml(item.id)}">수정</button>`}</div>
      </div>`;
    }).join('') || '<div class="empty-state">아직 보유상품이 없습니다. 로그인 후 잔고를 조회하거나 상품을 직접 추가하세요.</div>';
  $('#holdings-table').querySelectorAll('.holding-row').forEach((row, index) => {
    const item = visibleHoldings().filter(candidate => filter === 'all' || candidate.account === filter)[index];
    if (item?.source !== 'woori-import' || !item.marketEstimated) return;
    const subtitle = row.querySelector('.holding-name .holding-sub');
    const statusTag = row.querySelector('.holding-actions .status-tag');
    if (subtitle) subtitle.textContent = wooriSourceLabel(item);
    if (statusTag) {
      statusTag.textContent = '시세 추정';
      statusTag.className = 'status-tag good';
    }
  });
}

function renderRecommendations() {
  const items = recommendations();
  const card = item => `<article class="recommendation-card">
    <span class="rec-badge ${item.kind}">${item.icon}</span>
    <div class="rec-content"><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.text)}</p>${item.proposal ? `<button class="rec-proposal detail-trigger" type="button" data-product-detail="${escapeHtml(item.proposal.code || '442560')}" data-proposal-from="${escapeHtml(item.proposal.from)}" data-proposal-amount="${Number(item.proposal.amountValue || 0)}" data-proposal-account="${escapeHtml(item.account || '')}" aria-label="${escapeHtml(item.proposal.to)} 상세 정보 보기"><span>교체 제안 · 상세 정보 보기</span><strong>${escapeHtml(item.proposal.from)} <i>→</i> ${escapeHtml(item.proposal.to)}</strong><small>${escapeHtml(item.proposal.amount)} · ${escapeHtml(item.proposal.note)}</small></button>` : ''}<div class="rec-meta">${item.meta.map(([label, value]) => `<span>${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`).join('')}</div></div>
    <div class="rec-action"><span class="status-tag info">검토용</span>${item.account ? `<button class="review-btn" data-account-open="${escapeHtml(item.account)}">${escapeHtml(item.actionLabel || '보유상품')}</button>` : item.action ? `<button class="review-btn" data-view-link="${escapeHtml(item.action)}">${escapeHtml(item.actionLabel || '확인하기')}</button>` : ''}</div>
  </article>`;
  const lossItems = items.filter(item => item.group === 'loss');
  const positiveItems = items.filter(item => item.group !== 'loss');
  $('#recommendation-list').innerHTML = `<section class="recommendation-group"><div class="recommendation-group-head"><h3>손실·하락 상품 교체 우선</h3><p>손실률만이 아니라 계좌 비중·종목 집중도·전략 복잡성을 함께 보고 교체 후보를 고릅니다.</p></div>${lossItems.map(card).join('') || '<div class="empty-state">현재 우선 교체 후보가 없습니다.</div>'}</section><section class="recommendation-group"><div class="recommendation-group-head"><h3>수익 보호·재배치 검토</h3><p>수익 중인 상품은 수익률만으로 팔지 않습니다. 추세 악화가 10·20거래일 확인되거나 비중이 과도할 때, 전량 매도 대신 일부 축소·대체를 검토합니다.</p></div>${positiveItems.map(card).join('') || '<div class="empty-state">현재 수익 보호 또는 재배치 검토 상품이 없습니다.</div>'}</section>`;
  $('#signal-grid').innerHTML = items.map(item => `<article class="signal"><span class="signal-icon ${item.kind}">${item.icon}</span><div><h4>${escapeHtml(item.title)}</h4><p>${escapeHtml(item.text)}</p></div></article>`).join('');
  $('#alert-count').textContent = items.length + '건';
  $('#nav-count').textContent = items.length;
  $('#rec-count').textContent = items.length;
}

function limitCard(account, summary) {
  const utilization = summary.cap ? summary.buckets['risk-70'] / summary.cap * 100 : 0;
  const state = utilization > 100 ? 'danger' : utilization > 90 ? 'warning' : '';
  const remaining = summary.remaining >= 0 ? `추가 여유 ${won(summary.remaining)}` : `가정상 초과 ${won(Math.abs(summary.remaining))}`;
  return `<article class="limit-card">
    <h3>${escapeHtml(account.name)}</h3>
    <p>${escapeHtml(account.note)}</p>
    <strong class="limit-number">${summary.riskShare.toFixed(1)}%</strong>
    <span class="limit-caption">일반 위험자산 비중 · 법정 한도 70%</span>
    <div class="limit-track ${state}"><i style="width:${Math.min(utilization, 100)}%"></i></div>
    <div class="limit-caption">위험자산 ${won(summary.buckets['risk-70'])} / 한도 ${won(summary.cap)}</div>
    <div class="limit-meta"><span>일반 한도 여유<b>${remaining}</b></span><span>적격 TDF 100%군<b>${won(summary.buckets['qualified-tdf'])}</b></span></div>
  </article>`;
}

function renderLimits() {
  const accounts = [
    { id: null, name: '전체 계좌 · 추정', note: '확인 필요 상품은 한도 계산에서 제외' },
    { id: 'k-invest', name: '한국투자증권 IRP', note: '실제 주문 화면의 위험평가액을 최종 확인' },
    { id: 'woori-dc', name: '우리은행 DC', note: '회사별 상품 라인업과 분류를 확인' }
  ];
  $('#limit-summary').innerHTML = accounts.map(account => limitCard(account, limitSummary(account.id))).join('');
  const notes = {
    'safe-100': '원리금보장·현금성으로 임시 분류',
    'risk-70': '보수적으로 일반 위험자산으로 임시 분류',
    'qualified-tdf': '적격 여부를 금융기관 상품설명서에서 확인',
    unverified: '분류 확정 전에는 한도 계산에서 제외'
  };
  $('#limit-holdings').innerHTML = visibleHoldings().map(item => {
    const limitClass = inferredLimitClass(item);
    return `<div class="limit-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(accountName(item.account))}${item.source === 'kis-live' ? ' · KIS 자동 조회' : ''}</small></div><div><span class="limit-status ${limitClass}">${escapeHtml(limitLabels[limitClass])}</span></div><div><strong>${won(item.value)}</strong><small>${escapeHtml(notes[limitClass])}</small></div><div><button class="edit-btn" data-edit="${escapeHtml(item.id)}" ${item.source === 'kis-live' ? 'disabled title="자동 조회 상품은 금융기관 분류 확인 후 자동 반영 예정"' : ''}>${item.source === 'kis-live' ? '자동 조회' : '분류 수정'}</button></div></div>`;
  }).join('');
  renderLimitSimulation();
}

function installAccountLimitPanel() {
  const tabs = $('.account-tabs');
  if (!tabs || $('#account-limit-inline')) return;
  tabs.insertAdjacentHTML('afterend', '<section class="account-limit-inline" id="account-limit-inline" hidden></section>');
}

function renderAccountLimitPanel() {
  const host = $('#account-limit-inline');
  if (!host) return;
  if (filter === 'all') { host.hidden = true; host.innerHTML = ''; return; }
  const summary = limitSummary(filter);
  const account = accountName(filter);
  const status = summary.remaining >= 0 ? `일반 한도 여유 ${won(summary.remaining)}` : `보수적 가정상 초과 ${won(Math.abs(summary.remaining))}`;
  host.hidden = false;
  host.innerHTML = `<div><strong>${escapeHtml(account)} · 한도 검사</strong><p>교체하거나 새 상품을 매수하기 전 일반 위험자산 70% 한도를 확인하는 도구입니다. 적격 TDF는 별도 100%군으로 표시합니다.</p></div><div class="account-limit-numbers"><span>일반 위험자산<b>${summary.riskShare.toFixed(1)}%</b></span><span>70% 기준<b>${won(summary.cap)}</b></span><span>현재 상태<b>${status}</b></span></div>`;
}

function installWooriImportPanel() {
  const toolsBody = $('#account-tools-body');
  if (!toolsBody || $('#woori-import-panel')) return;
  const trend = $('#trend-panel');
  const panel = document.createElement('section');
  panel.id = 'woori-import-panel';
  panel.className = 'woori-import-panel';
  panel.innerHTML = '<div><strong>우리은행 DC · 반자동 가져오기</strong><p>우리은행의 자산잔고현황 표를 갱신하고, 종목코드·수량·평균매입가가 있는 ETF는 KIS 시세로 평가금액을 추정할 수 있습니다. 전체 상품 목록은 등록하지 않아도 됩니다.</p><small id="woori-import-status"></small></div><div class="sync-actions"><button class="outline-btn" type="button" data-woori-import="holdings">보유상품 표 가져오기</button><button class="outline-btn" type="button" data-woori-import="catalog">후보 상품만 확인</button><button class="outline-btn" type="button" data-refresh-woori-values>ETF 시세 추정 갱신</button></div>';
  toolsBody.insertBefore(panel, trend);
}

function installHoldingTransferPanel() {
  const accountsView = $('#view-accounts');
  const wooriPanel = $('#woori-import-panel');
  if (!accountsView || !wooriPanel || $('#holding-transfer-panel')) return;
  const panel = document.createElement('section');
  panel.id = 'holding-transfer-panel';
  panel.className = 'woori-import-panel holding-transfer-panel';
  panel.innerHTML = '<div><strong>보유상품 백업·이전</strong><p>기존 주소의 상품은 JSON으로 내보낸 뒤 새 주소에서 가져올 수 있습니다.</p><small>보유 금액이 들어 있는 파일입니다. 이전 후 삭제하세요.</small></div><div class="sync-actions"><button class="outline-btn" type="button" data-export-holdings>보유상품 JSON 내보내기</button><button class="outline-btn" type="button" data-import-holdings>JSON 가져오기</button><input id="holding-import-file" type="file" accept="application/json,.json" hidden></div>';
  wooriPanel.insertAdjacentElement('afterend', panel);
  $('#holding-import-file').addEventListener('change', async event => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!hostedMode || !authSession?.access_token) { toast('새 앱에서 로그인한 뒤 JSON을 가져오세요.'); return; }
    if (file.size > 2 * 1024 * 1024) { toast('JSON 파일은 2MB 이하여야 합니다.'); return; }
    try {
      const payload = JSON.parse(await file.text());
      renderHoldingImportModal(validateImportedHoldings(payload), 'file');
    } catch (error) {
      toast(`JSON 가져오기 실패: ${error.message}`);
    }
  });
}

function updateWooriImportPanel() {
  const status = $('#woori-import-status');
  if (!status) return;
  const holdings = data.holdings.filter(item => item.account === 'woori-dc');
  const autoCandidates = holdings.filter(item => item.code && Number(item.quantity) > 0 && Number(item.averagePrice) > 0).length;
  const catalogueText = wooriCatalogue.items.length ? `확인한 후보 ${wooriCatalogue.items.length}개` : '후보 상품 확인 전';
  const latestUpdate = holdings.map(item => item.marketUpdatedAt).filter(Boolean).sort().at(-1);
  const estimateText = latestUpdate ? `시세 추정 ${new Date(latestUpdate).toLocaleString('ko-KR')}` : '시세 추정 미실행';
  status.textContent = `보유상품 ${holdings.length}개 · 시세 추정 가능 ETF ${autoCandidates}개 · ${estimateText} · ${catalogueText}`;
}

function splitPastedRow(line) {
  if (line.includes('\t')) return line.split('\t').map(value => value.trim());
  if (line.includes('|')) return line.split('|').map(value => value.trim());
  if (line.includes(',')) return line.split(',').map(value => value.trim());
  return [line.trim()];
}

function normalHeader(value) {
  return String(value).replaceAll(/[\s()·_-]/g, '').toLocaleLowerCase('ko-KR');
}

function findColumn(headers, aliases) {
  return headers.findIndex(header => aliases.some(alias => normalHeader(header).includes(alias)));
}

function pastedNumber(value) {
  const parsed = Number(String(value ?? '').replaceAll(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWooriPastedTable(text, mode) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('제목 행과 상품 행을 함께 붙여넣어 주세요.');
  const headers = splitPastedRow(lines[0]);
  const nameAt = findColumn(headers, ['상품명', '종목명', '운용상품', '상품']);
  if (nameAt < 0) throw new Error('첫 줄에 상품명 또는 종목명 열이 필요합니다.');
  const codeAt = findColumn(headers, ['종목코드', '상품코드', '단축코드', '코드']);
  const quantityAt = findColumn(headers, ['보유수량', '수량']);
  const averageAt = findColumn(headers, ['평균매입단가', '매입단가', '매입가격']);
  const valueAt = findColumn(headers, ['평가금액', '평가액', '잔액']);
  const returnAt = findColumn(headers, ['수익률', '평가수익률']);
  const parsed = lines.slice(1).map(line => splitPastedRow(line)).map(columns => ({
    name: columns[nameAt] || '', code: codeAt >= 0 ? String(columns[codeAt] || '').match(/[0-9A-Z]{6}/)?.[0] || '' : '',
    quantity: quantityAt >= 0 ? pastedNumber(columns[quantityAt]) : null,
    averagePrice: averageAt >= 0 ? pastedNumber(columns[averageAt]) : null,
    value: valueAt >= 0 ? pastedNumber(columns[valueAt]) : null,
    return: returnAt >= 0 ? pastedNumber(columns[returnAt]) : null,
  })).filter(item => item.name);
  if (!parsed.length) throw new Error('가져올 상품 행을 찾지 못했습니다. 열 제목과 표 내용을 확인해 주세요.');
  if (mode === 'catalog') return parsed.map(item => ({ name: item.name, code: item.code }));
  return parsed;
}

function guessWooriType(name) {
  const normalized = normalizedName(name);
  if (normalized.includes('정기예금')) return '정기예금';
  if (normalized.includes('현금')) return '현금성';
  if (normalized.includes('금')) return '금현물';
  if (normalized.includes('커버드콜')) return '커버드콜';
  if (normalized.includes('s&p') || normalized.includes('미국')) return '미국주식';
  if (normalized.includes('200') || normalized.includes('top')) return '국내주식 집중형';
  return '기타';
}

function wooriSourceLabel(item) {
  if (!item.marketEstimated) return `우리은행 표 가져오기${item.code ? ` · ${escapeHtml(item.code)}` : ''}${item.quantity && item.averagePrice ? ' · 시세 추정 가능' : ''}`;
  const priceDate = item.marketPriceDate ? `${String(item.marketPriceDate).slice(0, 4)}.${String(item.marketPriceDate).slice(4, 6)}.${String(item.marketPriceDate).slice(6, 8)}` : '';
  return `KIS 종가 기반 추정 · ${escapeHtml(item.code || '')}${priceDate ? ` · ${priceDate}` : ''} · 은행 공식값 아님`;
}

function renderWooriImportModal() {
  let modal = $('#woori-import-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'woori-import-modal';
    modal.className = 'modal';
    document.body.append(modal);
  }
  const isCatalogue = wooriImportMode === 'catalog';
  const example = isCatalogue
    ? '상품명\t종목코드\nTIGER 미국 S&P500\t360750\nRISE TDF2040액티브 적격\t442560'
    : '상품명\t종목코드\t보유수량\t평균매입단가\t평가금액\t수익률\nWON 200\t448100\t100\t25000\t2508440\t-9.21';
  modal.innerHTML = `<div class="modal-card woori-import-card"><button class="modal-close" type="button" data-close-woori-import aria-label="닫기">×</button><h2>${isCatalogue ? '우리은행 매수 가능 목록 가져오기' : '우리은행 DC 보유상품 가져오기'}</h2><p>${isCatalogue ? '상품 변경 화면의 표를 제목 행부터 복사해 붙여넣으세요. 이 목록 안에서만 우리은행 DC 후보를 제안합니다.' : '자산잔고현황조회 표를 제목 행부터 복사해 붙여넣으세요. 기존 우리은행 DC 보유상품은 이 표로 교체됩니다.'}</p><label class="paste-label">붙여넣을 표<textarea id="woori-paste-input" spellcheck="false" placeholder="${escapeHtml(example)}"></textarea></label><div class="paste-example"><strong>지원 열</strong><span>${isCatalogue ? '상품명, 종목코드' : '상품명, 종목코드, 보유수량, 평균매입단가, 평가금액, 수익률'}</span></div><div class="modal-actions"><button class="outline-btn" type="button" data-close-woori-import>취소</button><button class="primary-btn" type="button" data-apply-woori-import>미리보기 및 반영</button></div><p class="paste-note">종목코드·수량·평균매입단가가 있는 ETF만 향후 시세 자동 반영 대상으로 분류합니다. 예금·펀드·현금은 우리은행 공식값을 유지합니다.</p></div>`;
  if (isCatalogue) {
    modal.querySelector('h2').textContent = '우리은행 후보 상품 확인';
    modal.querySelector('p').textContent = '전체 목록은 필요 없습니다. 앱이 제시한 후보를 우리은행 앱에서 검색한 뒤, 보이는 상품명과 종목코드 한두 행만 붙여넣으세요.';
  }
  modal.querySelector('[data-apply-woori-import]').textContent = '가져와 반영';
  modal.classList.add('open');
  $('#woori-paste-input').focus();
}

function closeWooriImportModal() {
  $('#woori-import-modal')?.classList.remove('open');
  wooriImportMode = null;
}

async function applyWooriImport() {
  const text = $('#woori-paste-input')?.value || '';
  const imported = parseWooriPastedTable(text, wooriImportMode);
  if (wooriImportMode === 'catalog') {
    wooriCatalogue = { items: imported, importedAt: new Date().toISOString() };
    saveWooriCatalog(wooriCatalogue);
    toast(`우리은행 DC에서 확인한 후보 ${imported.length}개를 등록했습니다.`);
  } else {
    const previous = data.holdings.filter(item => item.account === 'woori-dc');
    const next = imported.map((item, index) => ({
      id: globalThis.crypto?.randomUUID?.() || `woori:${Date.now()}:${index}`,
      recordKey: `woori-dc:${item.code || normalizedName(item.name)}`.slice(0, 200), name: item.name, code: item.code || undefined, quantity: item.quantity ?? undefined,
      averagePrice: item.averagePrice ?? undefined, type: guessWooriType(item.name), account: 'woori-dc',
      value: item.value ?? (item.quantity && item.averagePrice ? item.quantity * item.averagePrice : 0), officialValue: item.value ?? null, return: item.return ?? 0, source: 'woori-import',
    }));
    data.holdings = [...data.holdings.filter(item => item.account !== 'woori-dc'), ...next];
    if (hostedMode) {
      await upsertSupabaseHoldings(next);
      const nextKeys = new Set(next.map(item => item.recordKey));
      await deleteSupabaseHoldings(previous.filter(item => !nextKeys.has(item.recordKey)).map(item => item.id));
      await loadSupabaseHoldings();
    } else {
      await saveData();
    }
    toast(`우리은행 DC 보유상품 ${next.length}개를 반영했습니다.`);
  }
  closeWooriImportModal();
  render();
}

async function refreshWooriEtfEstimates() {
  const generation = authGeneration;
  const candidates = data.holdings.filter(item => item.account === 'woori-dc' && item.source === 'woori-import' && /^[0-9A-Z]{6}$/.test(item.code || '') && Number(item.quantity) > 0 && Number(item.averagePrice) > 0);
  if (!candidates.length) throw new Error('종목코드·보유수량·평균매입단가가 모두 있는 우리은행 ETF가 없습니다. 보유상품 표를 전체 행으로 다시 가져와 주세요.');
  const response = await fetchWooriEtfQuotes(candidates.map(item => item.code));
  const result = await response.json();
  if (generation !== authGeneration) return;
  if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || 'ETF 시세를 불러오지 못했습니다.');
  const quotes = new Map(result.items.filter(item => Number(item.close) > 0).map(item => [item.code, item]));
  const fetchedAt = result.fetchedAt || new Date().toISOString();
  let updated = 0;
  data.holdings = data.holdings.map(item => {
    const quote = quotes.get(item.code);
    if (!quote || !candidates.some(candidate => candidate.id === item.id)) return item;
    const estimate = Math.round(Number(item.quantity) * Number(quote.close));
    const cost = Number(item.quantity) * Number(item.averagePrice);
    updated += 1;
    return {
      ...item,
      officialValue: item.officialValue ?? item.value,
      value: estimate,
      return: cost > 0 ? Math.round((estimate / cost - 1) * 10000) / 100 : item.return,
      marketEstimated: true,
      marketUpdatedAt: fetchedAt,
      marketPrice: Number(quote.close),
      marketPriceDate: quote.date || null,
    };
  });
  if (!updated) throw new Error('조회 가능한 ETF 시세가 없습니다.');
  await saveData();
  render();
  toast(`우리은행 DC ETF ${updated}개의 KIS 시세 추정값을 반영했습니다. 은행 공식 잔고와는 차이가 날 수 있습니다.`);
}

async function refreshWooriPublicTdf() {
  const generation = authGeneration;
  const response = await fetchWooriPublicTdf();
  const result = await response.json();
  if (generation !== authGeneration) return;
  if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || '우리은행 공개 TDF 목록을 불러오지 못했습니다.');
  wooriPublicTdf = { items: result.items, fetchedAt: result.fetchedAt || new Date().toISOString(), source: result.source || '우리은행 공개 TDF 목록' };
  saveWooriPublicTdf(wooriPublicTdf);
  $('#catalog-account').value = 'woori-dc';
  $('#catalog-kind').value = 'all';
  renderCatalog();
  toast(`우리은행 공개 TDF ${result.items.length}개를 후보 탐색용으로 불러왔습니다.`);
}

function renderTrendPanel() {
  const host = $('#trend-panel');
  if (!host) return;
  if (!trendSnapshot) {
    host.innerHTML = '<div><strong>가격 추세·수익 보호 분석</strong><p>한국투자 잔고를 새로고침하면 보유 ETF의 최근 5·10·20거래일 등락과 계단식 하락을 분석합니다. 수익 중인 상품은 하락이 이어질 때 수익 보호 검토 신호로 표시합니다.</p></div><button class="outline-btn" type="button" data-refresh-trends>수익 보호 분석</button>';
    return;
  }
  const holdings = visibleHoldings();
  const rows = trendSnapshot.items.map(item => {
    const holding = holdings.find(candidate => candidate.code === item.code || normalizedName(candidate.name) === normalizedName(item.name));
    const guidance = trendGuidance(holding, item);
    const tag = item.status === 'priority' ? 'trend-priority' : item.status === 'review' ? 'trend-review' : item.status === 'watch' ? 'trend-watch' : 'trend-normal';
    const summary = item.available ? `매입 이후 ${signed(holding?.return || 0)} · 5일 ${trendRate(item.five?.return)} · 10일 ${trendRate(item.ten?.return)} · 20일 ${trendRate(item.twenty?.return)} · ${guidance.detail}` : escapeHtml(item.reason || '분석할 수 없습니다.');
    return `<div class="trend-row"><div><strong>${escapeHtml(item.name)}</strong><small>${summary}</small></div><span class="trend-tag ${tag}">${escapeHtml(guidance.label)}</span></div>`;
  }).join('');
  host.innerHTML = `<div class="trend-panel-head"><div><strong>가격 추세·수익 보호 분석</strong><p>5일은 관찰, 10일은 수익 보호·교체 검토, 20일은 우선 검토입니다. 단기 하락만으로 주문하지 않으며, 수익 중인 상품은 부분 매도·대체 후보·비중·한도를 함께 확인합니다.</p></div><button class="outline-btn" type="button" data-refresh-trends>추세 새로고침</button></div><div class="trend-list">${rows || '<div class="empty-state">분석 가능한 한국투자 ETF·ETN이 없습니다.</div>'}</div><small class="trend-foot">${escapeHtml(new Date(trendSnapshot.fetchedAt).toLocaleString('ko-KR'))} 조회 · 가격 원본은 서버에서만 계산하며 주문은 실행하지 않습니다.</small>`;
}

function renderLimitSimulation() {
  const accountId = $('#sim-account')?.value;
  const limitClass = $('#sim-limit-class')?.value;
  const amount = Number($('#sim-value')?.value || 0);
  const result = $('#sim-result');
  if (!result || !accountId || !limitClass) return;
  const summary = limitSummary(accountId);
  if (!amount) {
    result.innerHTML = '<strong>금액을 입력하면 가상 매수 후 한도 영향을 계산합니다.</strong><span>입력값은 저장되거나 금융기관으로 전송되지 않습니다.</span>';
    return;
  }
  if (limitClass === 'unverified') {
    result.innerHTML = `<strong>분류를 확인해야 계산할 수 있습니다.</strong><span>${won(amount)}은 금융기관 상품 화면에서 위험자산·적격 TDF·원리금보장 여부를 확인한 뒤 다시 계산하세요.</span>`;
    return;
  }
  if (limitClass !== 'risk-70') {
    result.innerHTML = `<strong>일반 위험자산 한도 사용액은 변하지 않습니다.</strong><span>${limitLabels[limitClass]} ${won(amount)}을 가정했습니다. 적격 TDF 여부 또는 원리금보장 여부는 실제 매수 화면에서 확인하세요.</span>`;
    return;
  }
  const projectedRisk = summary.buckets['risk-70'] + amount;
  const projectedTotal = summary.total + amount;
  const projectedCap = projectedTotal * 0.7;
  const gap = projectedCap - projectedRisk;
  result.innerHTML = `<strong>${escapeHtml(accountName(accountId))} · 가상 매수 후 일반 위험자산 ${won(projectedRisk)} (${(projectedRisk / projectedTotal * 100).toFixed(1)}%)</strong><span>가상 한도 ${won(projectedCap)} · ${gap >= 0 ? `추가 여유 ${won(gap)}` : `가정상 초과 ${won(Math.abs(gap))}`} · 주문·저장 없음</span>`;
}

function render() {
  updateWooriImportPanel();
  renderTotals();
  renderHoldings();
  renderRecommendations();
  renderBuyCandidates();
  renderCatalog();
  renderLimits();
  renderAccountLimitPanel();
  renderTrendPanel();
  renderOverviewDetail();
  $('#last-updated').textContent = kisSnapshot ? `KIS 자동 조회 ${kisSnapshotLabel()}` : '직접 입력 데이터';
}

function renderBuyCandidates() {
  const host = $('#buy-candidates');
  if (!host) return;
  const holdings = visibleHoldings();
  if (!holdings.length) {
    host.innerHTML = '<div class="empty-state">보유상품을 조회하거나 직접 입력하면 현재 비중을 반영한 매수 후보를 보여드립니다.</div>';
    return;
  }
  const catalog = window.KIS_CATALOG?.items || [];
  const tdf = catalog.find(item => item.code === '442560');
  const sp500 = holdings.find(item => item.code === '360750' || normalizedName(item.name).includes('미국s&p500'));
  const gold = holdings.find(item => item.code === '411060' || item.type === '금현물');
  const domestic = holdings.filter(item => item.account === 'woori-dc' && inferredLimitClass(item) === 'risk-70');
  const tdfName = tdf?.name || 'RISE TDF2040액티브 적격';
  const tdfFee = tdf?.fee === null || tdf?.fee === undefined ? '공식 목록 보수 확인' : `총보수 ${Number(tdf.fee).toFixed(2)}%`;
  const proposalTotal = recommendations().filter(item => item.account === 'k-invest').reduce((sum, item) => sum + Number(item.proposal?.amountValue || 0), 0);
  const holdRow = item => item ? `<article class="buy-hold-row"><div><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(accountName(item.account))} · 현재 비중 ${weight(item).toFixed(1)}%</small></div><span class="status-tag watch">추가매수 보류</span></article>` : '';
  host.innerHTML = `<div class="buy-candidates-head"><div><h3>우선 검토 후보</h3><p>현재 보유 비중·중복·퇴직연금 한도를 바탕으로 먼저 살펴볼 상품입니다. 자동 매수 추천이 아닙니다.</p></div><span class="status-tag good">검토용</span></div>
    <article class="buy-candidate-card"><div class="buy-candidate-main"><span class="buy-candidate-icon">◎</span><div><span class="buy-kicker">한국투자증권 IRP · 교체 / 신규 납입 후보</span><h4>${escapeHtml(tdfName)}</h4><p><b>${escapeHtml(tdf?.code || '442560')}</b> · 적격 TDF · ${escapeHtml(tdfFee)}</p><p class="buy-reason">현재 보유 비중과 투자 목표시점을 확인한 뒤 분산 후보로 검토하세요. 적격 TDF도 원금보장상품이 아니며 미래 수익을 보장하지 않습니다.</p></div></div><div class="buy-candidate-action"><span>부분 교체 예시</span><strong>${proposalTotal ? won(proposalTotal) : '비중 검토 후 산정'}</strong><small>현재 보유액 기준 가정 · 주문 아님</small><button class="review-btn" type="button" data-catalog-candidate="442560">공식 목록에서 보기</button></div></article>
    <div class="buy-candidate-note"><strong>지금은 추가매수보다 보류할 상품</strong><p>좋은 상품인지와 지금 더 사도 되는지는 다릅니다. 현재 비중이 높은 상품은 신규 매수 후보에서 제외합니다.</p><div class="buy-hold-list">${holdRow(sp500)}${holdRow(gold)}${domestic.length ? `<article class="buy-hold-row"><div><strong>우리은행 DC 국내주식 ETF</strong><small>${domestic.map(item => escapeHtml(item.name)).join(' · ')} · 합산 비중 ${domestic.reduce((sum, item) => sum + weight(item), 0).toFixed(1)}%</small></div><span class="status-tag watch">라인업 확인 전 보류</span></article>` : ''}</div></div>
    <div class="buy-candidate-foot">우리은행 DC는 공개 TDF 목록을 후보 탐색에 사용하고, 회사별 상품POOL 편입 여부는 실제 교체 직전에 확인합니다. 한국투자 IRP는 ${escapeHtml(window.KIS_CATALOG?.asOf || '공식 기준일')} 기준 공식 ETF·리츠 목록에서 후보 존재를 확인했으며, 실제 주문 화면의 매수가능 여부와 한도 분류가 최종입니다.</div>`;
}

function catalogProductType(item) {
  return /TDF/i.test(`${item.name || ''} ${item.category || ''}`) ? 'TDF' : (item.kind || item.category || '기타');
}

function catalogHolding(item, account) {
  return visibleHoldings().find(holding => holding.account === account && (
    (item.code && holding.code === item.code)
    || normalizedName(holding.name) === normalizedName(item.name)
  ));
}

function catalogFeeValue(item) {
  if (item.fee === null || item.fee === undefined || item.fee === '') return null;
  const value = Number.parseFloat(String(item.fee).replace('%', ''));
  return Number.isFinite(value) ? value : null;
}

function sortedCatalogItems(items) {
  const sort = $('#catalog-sort')?.value || 'default';
  if (sort === 'return3') return [...items].sort((a, b) => {
    const left = productInsightCache.get(a.code)?.periods?.threeMonths;
    const right = productInsightCache.get(b.code)?.periods?.threeMonths;
    const leftValue = Number.isFinite(left) ? left : Number.NEGATIVE_INFINITY;
    const rightValue = Number.isFinite(right) ? right : Number.NEGATIVE_INFINITY;
    return rightValue - leftValue || String(a.name).localeCompare(String(b.name), 'ko-KR');
  });
  if (sort === 'name') return [...items].sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko-KR'));
  if (sort === 'fee') return [...items].sort((a, b) => {
    const left = catalogFeeValue(a) ?? Number.POSITIVE_INFINITY;
    const right = catalogFeeValue(b) ?? Number.POSITIVE_INFINITY;
    return left - right || String(a.name).localeCompare(String(b.name), 'ko-KR');
  });
  return items;
}

function catalogCompareKey(item) {
  return `${item.account}:${item.code || `fund:${item.name}`}`;
}

function catalogCard(item, account, { publicList = false } = {}) {
  const detailKey = item.code || `fund:${item.name}`;
  const holding = catalogHolding(item, account);
  const feeValue = catalogFeeValue(item);
  const fee = feeValue === null ? '보수 미표기' : `${feeValue.toFixed(2)}%`;
  const manager = item.manager || '운용사 미표기';
  const selected = catalogComparison.some(candidate => candidate.key === catalogCompareKey({ ...item, account }));
  const cachedPeriods = productInsightCache.get(item.code)?.periods;
  const periods = cachedPeriods || {
    oneMonth: item.oneMonth,
    threeMonths: item.threeMonth ?? item.threeMonths,
    sixMonths: item.sixMonth ?? item.sixMonths,
  };
  const attributes = `data-product-detail="${escapeHtml(detailKey)}" data-product-name="${escapeHtml(item.name)}" data-product-category="${escapeHtml(item.category || item.kind || '상품 분류 확인 필요')}" data-product-fee="${escapeHtml(fee)}" data-product-one-month="${escapeHtml(periods.oneMonth ?? '')}" data-product-three-months="${escapeHtml(periods.threeMonths ?? '')}" data-product-six-months="${escapeHtml(periods.sixMonths ?? '')}" data-proposal-account="${escapeHtml(account)}"`;
  const compareAttributes = `data-compare-product="${escapeHtml(detailKey)}" data-product-name="${escapeHtml(item.name)}" data-product-category="${escapeHtml(item.category || item.kind || '')}" data-product-manager="${escapeHtml(manager)}" data-product-fee="${escapeHtml(fee)}" data-product-one-month="${escapeHtml(periods.oneMonth ?? '')}" data-product-three-months="${escapeHtml(periods.threeMonths ?? '')}" data-product-six-months="${escapeHtml(periods.sixMonths ?? '')}" data-proposal-account="${escapeHtml(account)}"`;
  const status = holding
    ? `<span class="status-tag good">보유 중 · ${weight(holding).toFixed(1)}%</span>`
    : `<span class="status-tag info">${publicList ? '회사 라인업 확인 필요' : '주문 가능 미확인'}</span>`;
  const analyzed = catalogPerformance.account === account && catalogPerformance.codes.has(item.code);
  const performance = analyzed ? `<div class="catalog-performance"><span>1개월 <b>${insightRate(periods.oneMonth)}</b></span><span>3개월 <b>${insightRate(periods.threeMonths)}</b></span><span>6개월 <b>${insightRate(periods.sixMonths)}</b></span></div>` : '';
  return `<article class="catalog-card catalog-card-row">
    <button class="catalog-card-main catalog-card-button" type="button" ${attributes}><div><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(detailKey.startsWith('fund:') ? '상품코드 미확인' : detailKey)} · ${escapeHtml(catalogProductType(item))} · ${escapeHtml(manager)}</span></div><div class="catalog-card-right">${status}<small>${escapeHtml(fee)} · 상세 보기</small></div></button>
    ${performance}
    <button class="compare-toggle${selected ? ' selected' : ''}" type="button" ${compareAttributes} aria-pressed="${selected}">${selected ? '비교 해제' : '비교'}</button>
  </article>`;
}

function filteredKisCatalogItems() {
  const items = window.KIS_CATALOG?.items || [];
  const query = $('#catalog-query').value.trim().toLocaleLowerCase('ko-KR');
  const kind = $('#catalog-kind').value;
  return items.filter(item => (kind === 'all' || catalogProductType(item) === kind) && (!query || `${item.name} ${item.code} ${item.category} ${item.manager}`.toLocaleLowerCase('ko-KR').includes(query)));
}

function renderPerformanceSearch() {
  const host = $('#performance-search');
  const button = $('#catalog-performance-btn');
  if (!host || !button) return;
  const account = $('#catalog-account').value;
  const guest = isPublicGuest();
  const unavailable = account !== 'k-invest' || guest;
  button.disabled = catalogPerformance.loading || unavailable;
  button.textContent = guest ? '로그인 후 분석' : catalogPerformance.loading ? '수익률 조회 중…' : '현재 결과 분석';
  host.classList.toggle('is-loading', catalogPerformance.loading);
  const message = host.querySelector('p');
  if (guest) message.textContent = '1·3·6개월 수익률 분석과 상품 비교는 로그인 후 이용할 수 있습니다.';
  else if (unavailable) message.textContent = '현재 자동 수익률 순위는 한국투자증권 IRP 공식 상장상품 목록에서 제공합니다.';
  else if (catalogPerformance.error) message.textContent = catalogPerformance.error;
  else if (catalogPerformance.codes.size) message.textContent = `${catalogPerformance.codes.size}개 후보를 분석했습니다. 3개월 수익률순이며 1·6개월 흐름도 함께 확인하세요.`;
  else message.textContent = '상품명·테마로 후보를 12개 이하로 좁히면 3개월 수익률순으로 분석합니다. 1·3·6개월 수익률을 함께 확인하세요.';
}

async function analyzeCatalogPerformance() {
  if (isPublicGuest()) { toast('수익률 분석은 로그인 후 이용할 수 있습니다.'); return; }
  const matches = filteredKisCatalogItems();
  if (!matches.length) { toast('분석할 검색 결과가 없습니다.'); return; }
  if (matches.length > 12) {
    catalogPerformance = { account: 'k-invest', codes: new Set(), loading: false, error: '검색 결과가 많습니다. 상품명이나 테마를 입력해 후보를 12개 이하로 좁혀주세요.', fetchedAt: '' };
    renderPerformanceSearch();
    toast('후보를 12개 이하로 좁혀주세요.');
    return;
  }
  const codes = matches.map(item => item.code).filter(code => /^[0-9A-Z]{6}$/.test(code));
  catalogPerformance = { account: 'k-invest', codes: new Set(codes), loading: true, error: '', fetchedAt: '' };
  renderPerformanceSearch();
  const generation = authGeneration;
  try {
    const response = await fetchKisPerformance(codes);
    const result = await response.json();
    if (generation !== authGeneration) return;
    if (!response.ok || !Array.isArray(result.items)) throw new Error(result.error || '수익률을 조회하지 못했습니다.');
    result.items.forEach(item => productInsightCache.set(item.code, item.error ? { error: item.error, periods: {} } : item));
    catalogPerformance = { account: 'k-invest', codes: new Set(codes), loading: false, error: '', fetchedAt: result.fetchedAt || new Date().toISOString() };
    $('#catalog-sort').value = 'return3';
    renderCatalog();
    toast(`${codes.length}개 후보를 3개월 수익률순으로 정렬했습니다.`);
  } catch (error) {
    if (generation !== authGeneration) return;
    catalogPerformance = { account: 'k-invest', codes: new Set(codes), loading: false, error: `수익률 분석 실패: ${error.message}`, fetchedAt: '' };
    renderPerformanceSearch();
  }
}

function renderCatalogComparison() {
  const host = $('#catalog-compare');
  if (!host) return;
  if (!catalogComparison.length) {
    host.hidden = true;
    host.innerHTML = '';
    return;
  }
  host.hidden = false;
  const cards = catalogComparison.map(item => {
    const insight = productInsightCache.get(item.code);
    const periods = insight?.periods || item.periods || {};
    const value = key => insight === undefined && /^[0-9A-Z]{6}$/.test(item.code) ? '조회 중' : insightRate(periods[key]);
    return `<article><button type="button" class="compare-remove" data-remove-comparison="${escapeHtml(item.key)}" aria-label="${escapeHtml(item.name)} 비교에서 제거">×</button><small>${escapeHtml(item.manager)}</small><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.fee)}</span><dl><div><dt>1개월</dt><dd>${value('oneMonth')}</dd></div><div><dt>3개월</dt><dd>${value('threeMonths')}</dd></div><div><dt>6개월</dt><dd>${value('sixMonths')}</dd></div></dl></article>`;
  }).join('');
  host.innerHTML = `<div class="catalog-compare-head"><div><strong>상품 비교</strong><p>최대 3개 상품의 기간 수익률과 총보수를 비교합니다.</p></div><button class="text-btn" type="button" data-clear-comparison>전체 해제</button></div><div class="catalog-compare-grid">${cards}</div>`;
}

async function loadComparisonInsight(item) {
  if (!/^[0-9A-Z]{6}$/.test(item.code) || productInsightCache.has(item.code)) return;
  const generation = authGeneration;
  try {
    const response = await fetchKisProductInsight(item.code);
    const result = await response.json();
    if (generation !== authGeneration) return;
    if (!response.ok || !result.periods) throw new Error(result.error || '가격 정보 조회 실패');
    productInsightCache.set(item.code, result);
  } catch (error) {
    productInsightCache.set(item.code, { error: error.message, periods: {} });
  }
  renderCatalogComparison();
}

function toggleCatalogComparison(element) {
  if (isPublicGuest()) { toast('상품 비교는 로그인 후 이용할 수 있습니다.'); return; }
  const account = element.dataset.proposalAccount || 'k-invest';
  const code = element.dataset.compareProduct;
  const key = `${account}:${code}`;
  const existing = catalogComparison.findIndex(item => item.key === key);
  if (existing >= 0) catalogComparison.splice(existing, 1);
  else {
    if (catalogComparison.length >= 3) {
      toast('상품 비교는 최대 3개까지 선택할 수 있습니다.');
      return;
    }
    const period = name => {
      const raw = element.dataset[name];
      if (raw === undefined || raw === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    const item = {
      key, account, code, name: element.dataset.productName || code,
      manager: element.dataset.productManager || '운용사 미표기', fee: element.dataset.productFee || '보수 미표기',
      periods: { oneMonth: period('productOneMonth'), threeMonths: period('productThreeMonths'), sixMonths: period('productSixMonths') },
    };
    catalogComparison.push(item);
    loadComparisonInsight(item);
  }
  renderCatalog();
  renderCatalogComparison();
}

function renderCatalog() {
  if (isPublicGuest()) $('#catalog-account').value = 'k-invest';
  const account = $('#catalog-account').value;
  $('#catalog-account').disabled = isPublicGuest();
  const returnSort = $('#catalog-sort').querySelector('option[value="return3"]');
  if (returnSort) returnSort.disabled = isPublicGuest();
  if (isPublicGuest() && $('#catalog-sort').value === 'return3') $('#catalog-sort').value = 'default';
  const notice = $('#catalog-notice');
  const list = $('#catalog-list');
  const count = $('#catalog-count');
  renderPerformanceSearch();
  if (account === 'woori-dc') {
    const verifiedItems = wooriCatalogue.items || [];
    const publicItems = wooriPublicTdf.items || [];
    const isPublicList = !verifiedItems.length && publicItems.length > 0;
    const items = verifiedItems.length ? verifiedItems : publicItems;
    notice.innerHTML = verifiedItems.length ? `<strong>우리은행 DC · 확인한 후보</strong><p>${escapeHtml(new Date(wooriCatalogue.importedAt).toLocaleString('ko-KR'))}에 확인한 ${verifiedItems.length}개입니다. 실제 주문 가능 여부와 한도 분류는 우리은행 상품 변경 화면에서 최종 확인하세요.</p>` : isPublicList ? `<strong>우리은행 공개 TDF 후보 · ${publicItems.length}개</strong><p>${escapeHtml(new Date(wooriPublicTdf.fetchedAt).toLocaleString('ko-KR'))} 기준 공개 목록입니다. 사용자님의 회사 DC 상품POOL 편입 여부는 아직 확인되지 않았습니다.</p>` : '<strong>우리은행 공개 TDF 후보</strong><p>공개 TDF 목록을 자동 수집해 후보 탐색에 사용합니다. 회사별 DC 라인업 편입 여부는 실제 교체 직전에 상품명 하나만 검색해 확인하면 됩니다.</p><button class="outline-btn" type="button" data-load-woori-tdf>공개 TDF 목록 불러오기</button>';
    const query = $('#catalog-query').value.trim().toLocaleLowerCase('ko-KR');
    const kind = $('#catalog-kind').value;
    const matches = sortedCatalogItems(items.filter(item => (kind === 'all' || catalogProductType(item) === kind) && (!query || `${item.name} ${item.code} ${item.category || ''} ${item.manager || ''}`.toLocaleLowerCase('ko-KR').includes(query))));
    count.textContent = isPublicList ? `${matches.length}개 검색됨 · 공개 TDF` : `확인한 후보 ${matches.length}개`;
    list.innerHTML = matches.slice(0, 100).map(item => catalogCard(item, 'woori-dc', { publicList: isPublicList })).join('') || '<div class="empty-state">등록된 상품이 없거나 검색 결과가 없습니다.</div>';
    if (matches.length > 100) list.insertAdjacentHTML('beforeend', '<p class="catalog-more">처음 100개만 표시됩니다. 목표연도나 상품명으로 검색 범위를 좁혀주세요.</p>');
    return;
  }
  const catalog = window.KIS_CATALOG;
  if (!catalog?.items) {
    notice.textContent = '한국투자증권 공식 상품 목록을 불러오지 못했습니다.';
    count.textContent = '';
    list.innerHTML = '';
    return;
  }
  notice.innerHTML = `<strong>한국투자증권 IRP · 공식 ETF·리츠 목록${isPublicGuest() ? ' · 공개 검색' : ''}</strong><p>기준일 ${escapeHtml(catalog.asOf)}. 이 목록은 상품 탐색용이며, 현재 계좌에서 실제 주문 가능한지는 미확인입니다. 주문 전 매수가능조회와 계좌별 위험자산 한도 확인이 필요합니다. 펀드·예금은 아직 이 목록에 포함되지 않았습니다.${isPublicGuest() ? ' 보유 여부·수익률 분석·맞춤 제안은 로그인 후 확인할 수 있습니다.' : ''} <a href="${escapeHtml(catalog.source)}" target="_blank" rel="noopener noreferrer">공식 공지 보기 ↗</a></p>`;
  const matches = sortedCatalogItems(filteredKisCatalogItems());
  count.textContent = `${matches.length.toLocaleString('ko-KR')}개 검색됨 · 전체 ${catalog.items.length.toLocaleString('ko-KR')}개`;
  list.innerHTML = matches.slice(0, 100).map(item => catalogCard(item, 'k-invest')).join('') || '<div class="empty-state">검색 결과가 없습니다.</div>';
  if (matches.length > 100) list.insertAdjacentHTML('beforeend', '<p class="catalog-more">처음 100개만 표시됩니다. 상품명이나 코드로 검색 범위를 좁혀주세요.</p>');
}

async function checkKisConnection() {
  const generation = authGeneration;
  const status = $('#kis-status');
  const button = $('#kis-preview-btn');
  if (hostedMode) {
    updateAuthPanel();
    const ready = await ensureHostedSession();
    if (generation !== authGeneration) return false;
    status.textContent = ready
      ? '운영 서버 연결됨 · 조회 가능한 주식·ETF·ETN은 아래 보유상품 표에 자동 반영됩니다.'
      : '운영 서버 연결됨 · 잔고 미리보기를 사용하려면 로그인하세요.';
    button.disabled = !ready;
    return ready;
  }
  if (location.protocol !== 'http:' || location.hostname !== '127.0.0.1') {
    status.textContent = '현재는 직접 입력 데이터입니다. 실제 잔고 미리보기는 읽기 전용 로컬 서버에서만 사용할 수 있습니다.';
    return false;
  }
  try {
    const response = await fetch('/api/kis/status', { cache: 'no-store' });
    if (!response.ok) throw new Error('연결 서버 응답 없음');
    const result = await response.json();
    if (generation !== authGeneration) return false;
    status.textContent = result.configured
      ? '실전투자 API 설정됨 · 조회 가능한 주식·ETF·ETN은 아래 보유상품 표에 자동 반영됩니다.'
      : '실전투자 API 설정 전 · 서버 시작 시 키를 주입하면 조회할 수 있습니다.';
    button.disabled = !result.configured;
    return result.configured;
  } catch {
    if (generation !== authGeneration) return false;
    status.textContent = '읽기 전용 연결 서버가 실행되지 않았습니다. 현재 아래 표는 직접 입력한 데이터입니다.';
    return false;
  }
}

async function refreshKisHoldings({ quiet = false } = {}) {
  const generation = authGeneration;
  const button = $('#kis-preview-btn');
  button.disabled = true;
  button.textContent = '조회 중…';
  try {
    const response = await fetchKisHoldings();
    const result = await response.json();
    if (generation !== authGeneration) return;
    if (!response.ok) throw new Error(result.error || '조회 실패');
    kisSnapshot = { fetchedAt: result.fetchedAt, scope: result.scope, holdings: Array.isArray(result.holdings) ? result.holdings : [] };
    saveKisSnapshot(kisSnapshot);
    render();
    const updatedAt = new Date(result.fetchedAt).toLocaleString('ko-KR');
    $('#kis-status').textContent = `자동 반영됨 · ${updatedAt} · ${result.scope}`;
    await refreshKisTrends({ quiet: true });
    if (!quiet) toast('한국투자증권 ETF·ETN 잔고를 표에 자동 반영했습니다.');
  } catch (error) {
    if (generation !== authGeneration) return;
    const previous = kisSnapshot ? `마지막 자동 조회(${kisSnapshotLabel()}) 값을 표에 유지합니다.` : '기존 직접 입력 데이터는 유지합니다.';
    $('#kis-status').textContent = `자동 반영 실패: ${error.message}. ${previous}`;
    if (!quiet) toast(kisSnapshot ? '새 조회에 실패해 마지막 자동 조회값을 유지합니다.' : '잔고를 갱신하지 못했습니다. 기존 데이터는 유지됩니다.');
  } finally {
    button.disabled = generation !== authGeneration ? hostedMode : false;
    button.textContent = '실제 잔고 새로고침';
  }
}

async function refreshKisTrends({ quiet = false } = {}) {
  const generation = authGeneration;
  try {
    const response = await fetchKisTrends();
    const result = await response.json();
    if (generation !== authGeneration) return;
    if (!response.ok) throw new Error(result.error || '추세 분석 조회 실패');
    if (!Array.isArray(result.items)) throw new Error('추세 분석용 서버 기능이 아직 배포되지 않았습니다.');
    trendSnapshot = { fetchedAt: result.fetchedAt, scope: result.scope, items: Array.isArray(result.items) ? result.items : [] };
    saveTrendSnapshot(trendSnapshot);
    render();
    if (!quiet) toast('최근 5·10·20거래일 하락 추세를 분석했습니다.');
  } catch (error) {
    if (generation !== authGeneration) return;
    if (!quiet) toast(`추세 분석에 실패했습니다: ${error.message}`);
  }
}

function switchView(view, { persist = true } = {}) {
  if (isPublicGuest()) view = 'products';
  if (!VIEW_TITLES[view]) view = 'overview';
  document.querySelectorAll('.view').forEach(element => element.classList.toggle('active', element.id === 'view-' + view));
  document.querySelectorAll('.nav-item[data-view]').forEach(element => element.classList.toggle('active', element.dataset.view === view));
  $('#page-title').textContent = VIEW_TITLES[view];
  if (persist) {
    try { sessionStorage.setItem(VIEW_STORAGE_KEY, view); }
    catch (_) { /* View persistence is optional. */ }
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function insightRate(value) {
  return Number.isFinite(value) ? signed(value) : '데이터 부족';
}

function productProfile(context) {
  const known = productProfiles[context.code];
  if (known) return known;
  const item = (window.KIS_CATALOG?.items || []).find(candidate => candidate.code === context.code)
    || (wooriCatalogue.items || []).find(candidate => candidate.code === context.code)
    || (wooriPublicTdf.items || []).find(candidate => candidate.code === context.code);
  return {
    name: context.name || item?.name || context.code || '상품 상세',
    code: context.code?.startsWith('fund:') ? '상품코드 미확인' : context.code || item?.code || '상품코드 미확인',
    fee: context.fee || (Number.isFinite(Number(item?.fee)) ? `${Number(item.fee).toFixed(2)}%` : '공식 정보 확인'),
    category: context.category || item?.category || item?.kind || '상품 분류 확인 필요',
    strategy: '최근 가격 흐름과 기간별 수익률을 함께 확인하세요. 상품의 실제 운용전략은 금융기관 상품설명서에서 최종 확인해야 합니다.',
    risk: '과거 수익률은 미래 성과를 보장하지 않으며 원금 손실이 발생할 수 있습니다.',
    source: context.source || window.KIS_CATALOG?.source || '',
  };
}

function candleChart(candles = []) {
  if (!candles.length) return '<div class="detail-chart-empty">가격 데이터를 불러오는 중입니다.</div>';
  const values = candles.flatMap(candle => [candle.high, candle.low]).filter(Number.isFinite);
  const ceiling = Math.max(...values);
  const floor = Math.min(...values);
  const range = ceiling - floor || 1;
  const width = 640;
  const height = 170;
  const gap = width / candles.length;
  const y = value => 12 + (ceiling - value) / range * (height - 24);
  const bars = candles.map((candle, index) => {
    const x = index * gap + gap / 2;
    const rising = candle.close >= candle.open;
    const top = Math.min(y(candle.open), y(candle.close));
    const body = Math.max(2, Math.abs(y(candle.open) - y(candle.close)));
    return `<g><line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(candle.high).toFixed(1)}" y2="${y(candle.low).toFixed(1)}" class="candle-wick ${rising ? 'up' : 'down'}"/><rect x="${(x - Math.min(5, gap * .32)).toFixed(1)}" y="${top.toFixed(1)}" width="${Math.min(10, gap * .64).toFixed(1)}" height="${body.toFixed(1)}" class="candle-body ${rising ? 'up' : 'down'}"/></g>`;
  }).join('');
  const first = candles[0]?.date || '';
  const last = candles.at(-1)?.date || '';
  return `<div class="detail-chart"><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="최근 ${candles.length}거래일 일봉 차트">${bars}</svg><div><span>${escapeHtml(first)}</span><span>${escapeHtml(last)}</span></div></div>`;
}

function renderProductDetailPanel() {
  if (!productDetailContext?.trigger?.isConnected) return;
  let panel = $('#product-detail-panel');
  if (!panel) {
    panel = document.createElement('section');
    panel.id = 'product-detail-panel';
    panel.className = 'product-detail-inline';
  }
  const context = productDetailContext;
  const anchor = context.trigger.closest('.catalog-card') || context.trigger;
  anchor.insertAdjacentElement('afterend', panel);
  context.trigger.classList.add('detail-open');
  context.trigger.setAttribute('aria-expanded', 'true');
  const profile = productProfile(context);
  const account = context.account || 'k-invest';
  const accountValue = accountTotal(account);
  const amount = Math.min(Math.max(Number(context.amount || 0), 0), accountValue);
  const beforeWeight = accountValue ? amount / accountValue * 100 : 0;
  const fromHolding = visibleHoldings().find(item => normalizedName(item.name) === normalizedName(context.from));
  const insight = productInsightCache.get(context.code);
  const guest = isPublicGuest();
  const loading = !guest && insight === undefined;
  const failed = guest ? '가격 차트와 기간 수익률은 로그인 후 확인할 수 있습니다.' : insight?.error;
  const metrics = insight?.periods || context.periods || {};
  const currentTarget = visibleHoldings().find(item => item.code === context.code);
  const currentTargetValue = currentTarget?.value || 0;
  const afterTargetValue = currentTargetValue + amount;
  const tdfLimit = context.code === '442560' ? limitLabels['qualified-tdf'] : '금융기관 주문 화면에서 확인';
  const sourceLink = profile.source ? ` · <a href="${escapeHtml(profile.source)}" target="_blank" rel="noopener noreferrer">공식 정보 ↗</a>` : '';
  const proposalSection = context.from || amount ? `<section class="detail-section"><div class="detail-section-head"><span>4</span><div><h3>내 계좌에 반영하면</h3><p>아래는 주문이 아닌, 현재 제안 금액으로 계산한 가상 교체 결과입니다.</p></div></div><div class="detail-allocation"><div><small>교체 금액</small><b>${won(amount)}</b><span>${escapeHtml(accountName(account))}의 ${beforeWeight.toFixed(1)}%</span></div><div><small>줄일 상품</small><b>${escapeHtml(context.from || '—')}</b><span>제안 금액만큼 축소 가정</span></div><div><small>새 상품 비중</small><b>${accountValue ? (afterTargetValue / accountValue * 100).toFixed(1) + '%' : '—'}</b><span>현재 ${currentTargetValue ? won(currentTargetValue) : '0원'} → 교체 후 ${won(afterTargetValue)}</span></div></div>${fromHolding ? `<p class="detail-note">${escapeHtml(fromHolding.name)}의 현재 계좌 비중은 ${weight(fromHolding).toFixed(1)}%입니다. 이 제안은 전량 매도가 아니라 ${won(amount)}만 부분 교체하는 가정입니다.</p>` : ''}</section>` : '';
  panel.innerHTML = `<div class="product-detail-card" role="region" aria-labelledby="product-detail-title">
    <button class="modal-close" type="button" data-close-product-detail aria-label="닫기">×</button>
    <span class="detail-kicker">${context.from || amount ? '교체 제안 · 판단 정보' : '매수상품 · 상세 정보'}</span>
    <h2 id="product-detail-title">${escapeHtml(profile.name)}</h2>
    <p class="detail-subtitle">${escapeHtml(profile.code)} · ${escapeHtml(profile.category)}${sourceLink}</p>
    <section class="detail-section"><div class="detail-section-head"><span>1</span><div><h3>가격 추세</h3><p>최근 30거래일 일봉입니다. 상장상품이 아닌 펀드는 일봉 차트가 제공되지 않을 수 있습니다.</p></div></div>${loading ? '<div class="detail-loading">가격 조회 중…</div>' : failed ? `<div class="detail-chart-empty">${escapeHtml(insight.error)}</div>` : insight?.candles?.length ? candleChart(insight.candles) : '<div class="detail-chart-empty">이 상품은 조회 가능한 시장 가격 차트가 없습니다.</div>'}</section>
    <section class="detail-section"><div class="detail-section-head"><span>2</span><div><h3>기간 수익률·변동 확인</h3><p>단기 수익률만 보고 교체하지 않고, 1·3·6개월 흐름을 비교합니다.</p></div></div><div class="detail-stats"><div><small>1개월</small><b>${guest ? '로그인 후' : loading ? '조회 중' : insightRate(metrics.oneMonth)}</b></div><div><small>3개월</small><b>${guest ? '로그인 후' : loading ? '조회 중' : insightRate(metrics.threeMonths)}</b></div><div><small>6개월</small><b>${guest ? '로그인 후' : loading ? '조회 중' : insightRate(metrics.sixMonths)}</b></div></div></section>
    <section class="detail-section"><div class="detail-section-head"><span>3</span><div><h3>무엇을 사는지</h3><p>${escapeHtml(profile.strategy)}</p></div></div><div class="detail-facts"><div><small>총보수</small><b>${escapeHtml(profile.fee)}</b></div><div><small>한도 분류</small><b>${escapeHtml(tdfLimit)}</b></div><div><small>핵심 위험</small><b>${escapeHtml(profile.risk)}</b></div></div></section>
    ${proposalSection}
    <p class="detail-disclaimer">가격·수익률은 조회 시점 정보이며 미래 수익을 보장하지 않습니다. 실제 매수 가능 여부와 적격 TDF 분류는 한국투자증권 주문 화면에서 최종 확인하세요.</p>
  </div>`;
}

async function openProductDetail(context) {
  if (productDetailContext?.trigger === context.trigger) {
    closeProductDetail();
    return;
  }
  closeProductDetail();
  const generation = authGeneration;
  productDetailContext = context;
  renderProductDetailPanel();
  if (isPublicGuest()) return;
  if (productInsightCache.has(context.code)) return;
  if (context.periods && !/^[0-9A-Z]{6}$/.test(context.code || '')) {
    productInsightCache.set(context.code || context.name, { candles: [], periods: context.periods });
    renderProductDetailPanel();
    return;
  }
  if (!/^[0-9A-Z]{6}$/.test(context.code || '')) {
    productInsightCache.set(context.code || context.name, { candles: [], periods: context.periods || {} });
    renderProductDetailPanel();
    return;
  }
  try {
    const response = await fetchKisProductInsight(context.code);
    const result = await response.json();
    if (generation !== authGeneration) return;
    if (!response.ok) throw new Error(result.error || '가격 정보를 불러오지 못했습니다.');
    if (!Array.isArray(result.candles) || !result.periods) throw new Error('상세 가격 분석 기능이 아직 배포되지 않았습니다.');
    productInsightCache.set(context.code, result);
  } catch (error) {
    if (generation !== authGeneration) return;
    productInsightCache.set(context.code, { error: `가격 정보 조회 실패: ${error.message}` });
  }
  if (productDetailContext?.trigger === context.trigger) renderProductDetailPanel();
}

function closeProductDetail() {
  productDetailContext?.trigger?.setAttribute?.('aria-expanded', 'false');
  productDetailContext?.trigger?.classList?.remove?.('detail-open');
  $('#product-detail-panel')?.remove();
  productDetailContext = null;
}

function openProductModal(id = null) {
  const form = $('#product-form');
  form.reset();
  editingId = id;
  const item = data.holdings.find(holding => String(holding.id) === String(id));
  if (item) {
    form.elements.namedItem('name').value = item.name;
    form.elements.namedItem('type').value = Array.from(form.elements.namedItem('type').options).some(option => option.value === item.type) ? item.type : '기타';
    form.elements.namedItem('account').value = item.account;
    form.elements.namedItem('value').value = item.value;
    form.elements.namedItem('return').value = item.return;
    form.elements.namedItem('limitClass').value = item.limitClass || 'auto';
    form.elements.namedItem('memo').value = item.memo || '';
  }
  $('#product-modal-title').textContent = item ? '보유 상품 수정' : '보유 상품 추가';
  $('#product-submit').textContent = item ? '변경 저장' : '상품 저장';
  $('#product-modal').classList.add('open');
  $('#product-name').focus();
}

function closeProductModal() {
  $('#product-modal').classList.remove('open');
  editingId = null;
}

function installLimitClassField() {
  const typeSelect = $('#product-type');
  if (!typeSelect || $('#product-limit-class')) return;
  typeSelect.insertAdjacentHTML('beforeend', '<option value="적격 TDF">적격 TDF</option>');
  typeSelect.closest('label').insertAdjacentHTML('afterend', '<label>퇴직연금 한도 분류<select name="limitClass" id="product-limit-class"><option value="auto">상품 유형으로 자동 분류</option><option value="risk-70">70% 한도군 · 위험자산</option><option value="qualified-tdf">100% 가능 · 적격 TDF</option><option value="safe-100">100% 가능 · 원리금보장/현금</option><option value="unverified">확인 필요 · 금융기관 분류 대기</option></select></label>');
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-view]');
  if (nav) switchView(nav.dataset.view);
  const link = event.target.closest('[data-view-link]');
  if (link) switchView(link.dataset.viewLink);
  const accountOpen = event.target.closest('[data-account-open]');
  if (accountOpen) {
    filter = accountOpen.dataset.accountOpen;
    document.querySelectorAll('.account-tab').forEach(element => element.classList.toggle('active', element.dataset.account === filter));
    switchView('accounts');
    renderHoldings();
    renderAccountLimitPanel();
  }
  const catalogCandidate = event.target.closest('[data-catalog-candidate]');
  if (catalogCandidate) {
    $('#catalog-account').value = 'k-invest';
    $('#catalog-query').value = catalogCandidate.dataset.catalogCandidate;
    $('#catalog-kind').value = 'all';
    catalogPerformance = { account: '', codes: new Set(), loading: false, error: '', fetchedAt: '' };
    if ($('#catalog-sort').value === 'return3') $('#catalog-sort').value = 'default';
    switchView('products');
    renderCatalog();
    $('#catalog-query').focus();
  }
  const compare = event.target.closest('[data-compare-product]');
  if (compare) {
    toggleCatalogComparison(compare);
    return;
  }
  const removeComparison = event.target.closest('[data-remove-comparison]');
  if (removeComparison) {
    catalogComparison = catalogComparison.filter(item => item.key !== removeComparison.dataset.removeComparison);
    renderCatalog();
    renderCatalogComparison();
    return;
  }
  if (event.target.closest('[data-clear-comparison]')) {
    catalogComparison = [];
    renderCatalog();
    renderCatalogComparison();
    return;
  }
  const detail = event.target.closest('[data-product-detail]');
  if (detail) {
    const periodValue = name => {
      const raw = detail.dataset[name];
      if (raw === undefined || raw === '') return undefined;
      const value = Number(raw);
      return Number.isFinite(value) ? value : undefined;
    };
    openProductDetail({
      trigger: detail,
      code: detail.dataset.productDetail,
      name: detail.dataset.productName,
      category: detail.dataset.productCategory,
      fee: detail.dataset.productFee,
      from: detail.dataset.proposalFrom,
      amount: Number(detail.dataset.proposalAmount || 0),
      account: detail.dataset.proposalAccount,
      periods: {
        oneMonth: periodValue('productOneMonth'),
        threeMonths: periodValue('productThreeMonths'),
        sixMonths: periodValue('productSixMonths'),
      },
    });
  }
  const wooriImport = event.target.closest('[data-woori-import]');
  if (wooriImport) {
    wooriImportMode = wooriImport.dataset.wooriImport;
    renderWooriImportModal();
  }
  if (event.target.closest('[data-apply-woori-import]')) {
    applyWooriImport().catch(error => toast(error.message));
  }
  if (event.target.closest('[data-close-woori-import]') || event.target.id === 'woori-import-modal') closeWooriImportModal();
  if (event.target.closest('[data-refresh-woori-values]')) {
    refreshWooriEtfEstimates().catch(error => toast(error.message));
  }
  if (event.target.closest('[data-load-woori-tdf]')) {
    refreshWooriPublicTdf().catch(error => toast(error.message));
  }
  if (event.target.closest('[data-export-holdings]')) {
    try { exportHoldingsJson(); }
    catch (error) { toast(error.message); }
  }
  if (event.target.closest('[data-import-holdings]')) $('#holding-import-file')?.click();
  if (event.target.closest('[data-apply-holding-import]')) applyPendingHoldingImport().catch(error => toast(error.message));
  if (event.target.closest('[data-close-holding-import]') || event.target.id === 'holding-import-modal') closeHoldingImportModal();
  if (event.target.closest('[data-refresh-trends]')) refreshKisTrends();
  const tab = event.target.closest('.account-tab');
  if (tab) {
    filter = tab.dataset.account;
    document.querySelectorAll('.account-tab').forEach(element => element.classList.toggle('active', element === tab));
    renderHoldings();
    renderAccountLimitPanel();
  }
  const metric = event.target.closest('[data-overview-detail]');
  if (metric) {
    overviewDetail = overviewDetail === metric.dataset.overviewDetail ? null : metric.dataset.overviewDetail;
    document.querySelectorAll('[data-overview-detail]').forEach(element => {
      const expanded = element === metric && Boolean(overviewDetail);
      element.classList.toggle('active', expanded);
      element.setAttribute('aria-expanded', String(expanded));
    });
    renderOverviewDetail();
  }
  if (event.target.closest('[data-close-overview-detail]')) {
    overviewDetail = null;
    document.querySelectorAll('[data-overview-detail]').forEach(element => {
      element.classList.remove('active');
      element.setAttribute('aria-expanded', 'false');
    });
    renderOverviewDetail();
  }
  if (event.target.closest('#add-product-btn')) openProductModal();
  const edit = event.target.closest('[data-edit]');
  if (edit && !edit.disabled) openProductModal(edit.dataset.edit);
  if (event.target.closest('[data-close-modal]') || event.target.id === 'product-modal') closeProductModal();
  if (event.target.closest('[data-close-product-detail]')) closeProductDetail();
});

$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const name = form.elements.namedItem('name').value.trim();
  const type = form.elements.namedItem('type').value;
  const account = form.elements.namedItem('account').value;
  const value = Number(form.elements.namedItem('value').value);
  const rate = Number(form.elements.namedItem('return').value || 0);
  const limitClass = form.elements.namedItem('limitClass').value;
  const memo = form.elements.namedItem('memo').value.trim();
  if (!name || !data.accounts.some(item => item.id === account) || !Number.isFinite(value) || value < 0 || !Number.isFinite(rate) || rate < -100) {
    toast('상품명, 평가금액, 수익률을 확인하세요.');
    return;
  }
  const existing = data.holdings.find(item => String(item.id) === String(editingId));
  if (existing) Object.assign(existing, { name, type, account, value, return: rate, limitClass, memo });
  else {
    const id = globalThis.crypto?.randomUUID?.() || `manual:${Date.now()}`;
    data.holdings.push({ id, recordKey: `manual:${id}`, name, type, account, value, return: rate, limitClass, memo, source: 'manual' });
  }
  const button = $('#product-submit');
  button.disabled = true;
  try {
    await saveData();
    render();
    closeProductModal();
    toast(existing ? '상품 정보를 수정했습니다.' : '상품을 추가했습니다.');
  } catch (error) {
    toast(error.message);
    if (hostedMode) await loadSupabaseHoldings().catch(() => {});
  } finally {
    button.disabled = false;
  }
});

$('#refresh-btn').addEventListener('click', () => { render(); toast('저장된 입력 데이터를 다시 표시했습니다.'); });
function resetCatalogPerformanceSearch() {
  catalogPerformance = { account: '', codes: new Set(), loading: false, error: '', fetchedAt: '' };
  if ($('#catalog-sort').value === 'return3') $('#catalog-sort').value = 'default';
  renderCatalog();
}

$('#catalog-account').addEventListener('change', resetCatalogPerformanceSearch);
$('#catalog-query').addEventListener('input', resetCatalogPerformanceSearch);
$('#catalog-kind').addEventListener('change', resetCatalogPerformanceSearch);
$('#catalog-sort').addEventListener('change', renderCatalog);
$('#catalog-performance-btn').addEventListener('click', analyzeCatalogPerformance);
$('#kis-preview-btn').addEventListener('click', () => refreshKisHoldings());
['#sim-account', '#sim-limit-class', '#sim-value'].forEach(selector => $(selector)?.addEventListener('input', renderLimitSimulation));
installLimitClassField();
installAccountLimitPanel();
installWooriImportPanel();
installHoldingTransferPanel();
loadAuthSession();
updateAuthPanel();
render();
switchView(loadSavedView());
$('#auth-session-btn')?.addEventListener('click', () => {
  if (isPublicGuest()) {
    guestMode = false;
    updateAuthPanel();
    return;
  }
  void logoutPrivateSession();
});
checkKisConnection().then(async ready => {
  if (hostedMode && ready) {
    try {
      await loadSupabaseHoldings();
      maybeOfferLocalMigration();
    } catch (error) {
      toast(error.message);
    }
  }
  if (ready) refreshKisHoldings({ quiet: true });
});
