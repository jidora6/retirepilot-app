// IRP 운용 규칙 점검 - 화면과 분리한 순수 함수(주문 없음, 알림용).
// 규칙과 근거(한국투자증권 IRP 상품 목록으로 한 과거 시험, 위험자산 70% 한도 반영):
//  1. 위험자산(목록의 한도 70% 분류)은 목표 비중 아래로 둔다. 기본 목표 60%, 한도 70%.
//  2. 안전자산은 단기채·예금이 중심. 장기 국채는 안전 분류여도 가격이 크게 움직여서 안전자산의 절반을 넘기지 않는다.
//  3. 지수(코스피, S&P500)가 200일선 아래로 10거래일 연속이면 그 지수 쪽 주식 비중의 절반을 안전자산으로 옮기는 것을 검토한다.
//  4. 지수가 하루 -5% 이하이거나 5일 -8% 이하이면 20거래일 동안 같은 검토를 한다(급락 경보).
// 지수 상태는 매일 갱신되는 market.json(scripts/build_performance_json.py)에서 읽는다. 과거 성과는 미래를 보장하지 않으며 개인 맞춤 조언이 아니다.
(function (root) {
  const DEFAULTS = { target: 0.6, limit: 0.7, nearLimitGap: 0.05, targetTolerance: 0.05, belowTargetGap: 0.1, longBondMaxShare: 0.5, staleDays: 7, crashWindow: 20 };

  const US_NAME = /미국|S&P|나스닥|NASDAQ/i;
  const KR_NAME = /코스피|KOSPI|코스닥|KOSDAQ|KODEX ?200|TIGER ?200|국내/i;
  const NOT_STOCK = /채권|국고채|국채|단기|머니마켓|CD금리|KOFR|TDF|커버드콜|혼합|금현물|골드|리츠/i;
  const LONG_BOND = /국고채|국채|장기|10년|20년|30년|종합채권|회사채|크레딧/;
  const SHORT_BOND = /단기|3년|머니마켓|CD금리|KOFR|통안채|자금/;

  // 주식 쪽 구분: 'US'(S&P500 기준), 'KR'(코스피 기준), null(규칙 대상 아님)
  function sleeveOf(item) {
    const type = String(item.type || '');
    const name = String(item.name || '');
    if (type === '미국주식') return 'US';
    if (type.includes('국내주식')) return 'KR';
    if (/커버드콜|금현물|정기예금|현금|채권|TDF/.test(type) || NOT_STOCK.test(name)) return null;
    if (US_NAME.test(name)) return 'US';
    if (KR_NAME.test(name)) return 'KR';
    return null;
  }

  function isLongBond(item) {
    const name = String(item.name || '');
    return LONG_BOND.test(name) && !SHORT_BOND.test(name);
  }

  function dateText(value) {
    const text = String(value || '');
    return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : text;
  }

  // 지수 하나의 규칙 상태. index는 market.json의 indices.* 항목.
  function marketRule(index, settings = {}) {
    const o = { ...DEFAULTS, ...settings };
    if (!index) return { level: 'unknown', halve: false, title: '지수 상태를 불러오지 못했습니다', detail: '' };
    const crash = index.crash || {};
    if (crash.active) {
      const day = Number(crash.daysSince) + 1;
      return {
        level: 'crash', halve: true,
        title: `${index.name} 급락 경보 (${day}/${o.crashWindow}거래일째)`,
        detail: `${crash.firstTriggerDate && crash.firstTriggerDate !== crash.triggerDate ? `${dateText(crash.firstTriggerDate)}에 급락 기준(하루 -5% 또는 5일 -8%)에 처음 닿았고 마지막으로 닿은 날은 ${dateText(crash.triggerDate)}입니다.` : `${dateText(crash.triggerDate)}에 급락 기준(하루 -5% 또는 5일 -8%)에 닿았습니다.`} 경보가 켜진 동안 이 지수 쪽 주식 비중의 절반을 안전자산으로 옮기는 것을 검토합니다.`,
      };
    }
    if (index.confirmed === 'below') {
      return {
        level: 'confirmed', halve: true,
        title: `${index.name} 200일선 아래 확정`,
        detail: `${dateText(index.confirmedSince)}부터 200일선 아래가 10거래일 넘게 이어졌습니다. 이 지수 쪽 주식 비중의 절반을 안전자산으로 옮기는 것을 검토합니다. 10거래일 연속 위로 올라오면 되돌립니다.`,
      };
    }
    if (index.below) {
      return {
        level: 'watch', halve: false,
        title: `${index.name} 200일선 아래 ${index.rawStreak}거래일째`,
        detail: `확정까지 ${index.confirmDaysLeft}거래일 남았습니다. 아직 규칙상 조치 구간은 아닙니다.`,
      };
    }
    return { level: 'normal', halve: false, title: `${index.name} 200일선 위`, detail: '규칙상 조치 구간이 아닙니다.' };
  }

  function assessRisk(summary, target, settings = {}) {
    const o = { ...DEFAULTS, ...settings };
    const goal = Number.isFinite(target) ? target : o.target;
    if (!summary || !summary.total) return { share: 0, goal, status: 'empty', title: '보유상품이 없습니다', detail: '' };
    const share = summary.assumedRisk / summary.total;
    const pct = value => (value * 100).toFixed(1) + '%';
    let status = 'ok';
    let detail = `목표 ${pct(goal)}, 한도 ${pct(o.limit)}입니다.`;
    if (share > o.limit) {
      status = 'over-limit';
      detail = `한도 ${pct(o.limit)}를 넘었습니다. 새 위험자산 매수는 금융기관 화면에서 한도 분류를 먼저 확인하세요.`;
    } else if (share >= o.limit - o.nearLimitGap) {
      status = 'near-limit';
      detail = `한도 ${pct(o.limit)}에 가깝습니다(여유 ${pct(o.limit - share)}). 가격이 오르면 한도를 넘길 수 있습니다.`;
    } else if (share > goal + o.targetTolerance) {
      status = 'above-target';
      detail = `목표 ${pct(goal)}보다 ${pct(share - goal)} 높습니다. 위험자산을 줄이거나 안전자산을 늘려 목표에 맞추는 것을 검토합니다.`;
    } else if (share < goal - o.belowTargetGap) {
      status = 'below-target';
      detail = `목표 ${pct(goal)}보다 ${pct(goal - share)} 낮습니다. 방어적인 구성입니다(수익 기회는 줄어듭니다).`;
    }
    if (summary.unverified > 0) detail += ` 분류 확인이 필요한 상품 ${Math.round(summary.unverified).toLocaleString('ko-KR')}원은 위험자산으로 계산했습니다.`;
    return { share, goal, status, title: `위험자산 비중 ${pct(share)}`, detail };
  }

  function safeAssetMix(holdings, classify) {
    const safe = holdings.filter(item => ['safe-100', 'qualified-tdf'].includes(classify(item)));
    const total = safe.reduce((sum, item) => sum + Number(item.value || 0), 0);
    const longValue = safe.filter(isLongBond).reduce((sum, item) => sum + Number(item.value || 0), 0);
    return { total, longValue, longShare: total ? longValue / total : 0 };
  }

  // holdings: 화면의 보유상품 목록, summary: limitSummary 결과, market: market.json, classify: 한도 분류 함수
  function buildReport({ holdings = [], summary, market, target, classify, now = Date.now(), settings = {} }) {
    const o = { ...DEFAULTS, ...settings };
    const risk = assessRisk(summary, target, o);
    const sleeves = { KR: { value: 0, items: [] }, US: { value: 0, items: [] } };
    for (const item of holdings) {
      const sleeve = sleeveOf(item);
      if (sleeve) { sleeves[sleeve].value += Number(item.value || 0); sleeves[sleeve].items.push(item); }
    }
    const indices = market && market.indices ? market.indices : {};
    const markets = { KR: marketRule(indices.kospi, o), US: marketRule(indices.sp500, o) };
    const asOf = market && market.asOf ? Date.parse(dateText(market.asOf)) : NaN;
    const stale = !market || !Number.isFinite(asOf) || (now - asOf) / 86400000 > o.staleDays;
    const mix = classify ? safeAssetMix(holdings, classify) : { total: 0, longValue: 0, longShare: 0 };
    const alerts = [];
    if (risk.status === 'over-limit' || risk.status === 'near-limit' || risk.status === 'above-target') {
      alerts.push({ id: 'rule-risk', level: risk.status === 'over-limit' ? 'danger' : 'warn', title: `운용 규칙 · ${risk.title}`, text: risk.detail, meta: [['목표', (risk.goal * 100).toFixed(0) + '%'], ['한도', (o.limit * 100).toFixed(0) + '%'], ['상태', risk.status]] });
    }
    for (const [key, label] of [['KR', '국내 주식'], ['US', '미국 주식']]) {
      const rule = markets[key];
      const sleeve = sleeves[key];
      if (!rule.halve || !sleeve.value || stale) continue;
      alerts.push({
        id: `rule-market-${key}`, level: rule.level === 'crash' ? 'danger' : 'warn',
        title: `운용 규칙 · ${rule.title}`,
        text: `${rule.detail} 현재 ${label} ${Math.round(sleeve.value).toLocaleString('ko-KR')}원의 절반(약 ${Math.round(sleeve.value / 2).toLocaleString('ko-KR')}원)이 검토 대상입니다. 주문은 직접 하셔야 하며, 이 알림은 과거 시험 규칙일 뿐 투자 권유가 아닙니다.`,
        meta: [['검토 대상', `${label} 비중의 절반`], ['지수 기준일', dateText(market.asOf)], ['규칙', rule.level === 'crash' ? '급락 경보' : '200일선']],
      });
    }
    if (mix.total && mix.longShare > o.longBondMaxShare) {
      alerts.push({
        id: 'rule-longbond', level: 'warn', title: '운용 규칙 · 안전자산 중 장기채 비중이 큽니다',
        text: `안전자산의 ${(mix.longShare * 100).toFixed(0)}%가 장기 국채나 종합채권으로 보입니다. 안전 분류여도 금리가 오르면 크게 떨어질 수 있습니다(2022년 국고채10년 -8.7%). 단기채나 예금을 중심으로 두는 것을 검토합니다. 상품명으로 추정한 값입니다.`,
        meta: [['장기채 추정 비중', (mix.longShare * 100).toFixed(0) + '%'], ['기준', `안전자산의 ${(o.longBondMaxShare * 100).toFixed(0)}% 이하`]],
      });
    }
    return { risk, markets, sleeves, stale, mix, alerts, asOf: market && market.asOf ? dateText(market.asOf) : null };
  }

  root.RetirePilotRules = { DEFAULTS, sleeveOf, isLongBond, marketRule, assessRisk, safeAssetMix, buildReport, dateText };
})(typeof window !== 'undefined' ? window : globalThis);
