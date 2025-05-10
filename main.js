const GRAPHQL = 'https://node.xian.org/graphql';
const STAMP_COST = 'https://node.xian.org/abci_query?path="/get/stamp_cost.S:value"';
const REFRESH_MS = 60_000;

const board = document.getElementById('board');
const fmt = n => Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const qs = (s, p = document) => p.querySelector(s);

const isMobile = window.innerWidth < 640;  // you can adjust this breakpoint

let selectedRange = 'day';
let loading = false;
let lastData = null;

// ──────────────────────── GRAPHQL HELPERS ───────────────────
const prettyLabel = r => r === 'day' ? '24h' : r === 'week' ? '7d' : '30d';

const getCutoffISO = r => {
    const now = Date.now();
    const ms = r === 'week' ? 7 * 864e5 : r === 'month' ? 30 * 864e5 : 864e5;
    return new Date(now - ms).toISOString();
};

// kept for internal calculations even though chart is removed
const getChartLabels = r => r === 'week' ? Array(7).fill(0) : r === 'month' ? Array(30).fill(0) : Array(24).fill(0);

const gql = q => fetch(GRAPHQL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
    .then(r => r.json()).then(j => j.data);

const getStampRate = async () => {
    const j = await fetch(STAMP_COST).then(r => r.json());
    const b64 = j?.result?.response?.value;
    return parseInt(atob(b64), 10) || 0;
};

function txQuery(cutISO, beforeISO) {
    const c = beforeISO ? `{ greaterThan:"${cutISO}", lessThan:"${beforeISO}" }` : `{ greaterThan:"${cutISO}" }`;
    return `query{ allTransactions(filter:{created:${c}} orderBy:CREATED_DESC condition:{success:true} first:5000){ edges{ node{ created stamps jsonContent } } } }`;
}

const txEdges = d => d.allTransactions.edges.map(e => e.node);

async function fetchAllTxs(range) {
    const cutoff = getCutoffISO(range);
    const chunk = 500;
    const all = [];
    let before = null;
    while (true) {
        const data = await gql(txQuery(cutoff, before));
        const nodes = txEdges(data);
        if (!nodes.length) break;
        all.push(...nodes);
        before = nodes[nodes.length - 1].created;
        if (nodes.length < chunk) break;
    }
    return all;
}

// ────────────────────────── CRUNCH ──────────────────────────
function crunch(txs, stamp, range) {
    const ONE   = stamp;
    const unit  = range === 'day' ? 3_600_000          // 1 h
                                  : 86_400_000;        // 1 d

    // ── 1 · align “now” to the start of the current bucket ──────────
    const anchorDate = new Date();
    if (range === 'day')  anchorDate.setUTCMinutes(0, 0, 0); // 00:00:00.000 UTC
    else                  anchorDate.setUTCHours(0, 0, 0); // 00:00:00.000 UTC
    const nowMs = anchorDate.getTime();

    // ── 2 · initialise accumulators ─────────────────────────────────
    const bins    = getChartLabels(range);   // array of 24, 7, 30 zeros (not rendered anymore)
    const devMap  = {};
    const valMap  = {};
    let burn = 0, feeSum = 0, dev = 0, val = 0, fnd = 0;

    // ── 3 · walk every transaction ─────────────────────────────────
    for (const tx of txs) {
        const used = tx.stamps / ONE;

        const rewards = tx.jsonContent?.tx_result?.rewards;
        if (!rewards) continue;                           // skip failures

        let rDev = 0, rVal = 0, rFnd = 0;
        for (const [bucket, map] of Object.entries(rewards)) {
            const subtotal = Object.values(map)
                                   .reduce((s, v) => s + parseFloat(v), 0);

            if (bucket === 'developer_reward') {
                for (const [addr, amt] of Object.entries(map)) {
                    const num = parseFloat(amt);
                    devMap[addr] = (devMap[addr] || 0) + num;
                    rDev += num;
                }
            } else if (bucket === 'validator_reward' ||
                       bucket === 'masternode_reward') {
                for (const [addr, amt] of Object.entries(map)) {
                    const num = parseFloat(amt);
                    valMap[addr] = (valMap[addr] || 0) + num;
                }
                rVal += subtotal;
            } else if (bucket === 'foundation_reward') {
                rFnd += subtotal;
            }
        }

        const burned = used - (rDev + rVal + rFnd);
        burn   += burned;
        dev    += rDev;
        val    += rVal;
        fnd    += rFnd;
        feeSum += used;

        // ── 3a · put this tx into the correct time-bin ──────────────
        const age  = nowMs - Date.parse(tx.created);      // ms since bucket-anchor
        const bin  = Math.floor(age / unit);              // how many full units back
        const idx  = bins.length - 1 - bin;               // 0 = oldest, last = newest
        if (idx >= 0 && idx < bins.length) bins[idx] += burned;
    }

    // ── 4 · find top developer (optional) ───────────────────────────
    let topDeveloper = null, max = 0;
    for (const [addr, amt] of Object.entries(devMap)) {
        if (amt > max) { max = amt; topDeveloper = { address: addr, amount: amt }; }
    }

    // ── 5 · return results plus the aligned “anchor” ────────────────
    return {
        burn24h : burn,
        fees    : { dev, val, fnd },
        avgFee  : feeSum / (txs.length || 1),
        hourly  : bins,        // retained for potential future use
        devMap,
        valMap,
        topDeveloper,
        anchor  : nowMs
    };
}


// ───────────────────── UI BUILDERS ──────────────────────────
const tableRows = map => Object.entries(map).sort((a, b) => b[1] - a[1]).map(([addr, amt]) => `
  <tr>
    <td class="rew-addr">
      <a href="https://explorer.xian.org/addresses/${addr}" target="_blank" class="link-addr text-xian-cyan hover:underline">
        ${addr.slice(0, 6)}…${addr.slice(-4)}
      </a>
    </td>
    <td class="rew-amt">${fmt(amt)}</td>
  </tr>`).join('');

const cardList = (htmlTitle, amount, map) => `
  <div class="glass rounded-3xl p-6 flex flex-col gap-4 rewards-card">
    <div>
      <p class="text-sm text-gray-400">${htmlTitle}</p>
      <span class="text-2xl font-semibold block">${fmt(amount)} XIAN</span>
    </div>
    <table class="w-full text-xs">${tableRows(map) || '<tr><td class="text-center text-gray-500">–</td></tr>'}</table>
  </div>`;

const cardSimple = (title, amount) => `
  <div class="glass rounded-3xl p-6 flex flex-col gap-2 text-center rewards-card">
    <p class="text-sm text-gray-400">${title}</p>
    <span class="text-2xl font-semibold">${fmt(amount)} XIAN</span>
  </div>`;

const mini = (l, v) => `
  <div class="text-center">
    <p class="text-sm text-gray-400">${l}</p>
    <span class="text-xl font-semibold">${v}</span>
  </div>`;

// ────────────────────────── RENDER ──────────────────────────
function animateNumber(el, start, end, dur = 600) {
    const s = +start;
    const diff = end - s;
    const t0 = performance.now();
    function tick(t) {
        const p = Math.min((t - t0) / dur, 1);
        el.textContent = fmt(s + diff * p) + ' XIAN';
        if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
}

function render(d, rangeLabel) {
    board.innerHTML = `
    <div class="flex justify-center gap-4 mb-2">
      ${['day', 'week', 'month'].map(r => `
        <button data-range="${r}" class="range-btn px-4 py-2 rounded-full border ${r === rangeLabel ? 'bg-white text-black font-bold active' : 'border-white text-white'} hover:bg-white hover:text-black transition">
          ${r.charAt(0).toUpperCase() + r.slice(1)}
        </button>`).join('')}
    </div>
    <div id="loadingMessage" class="range-loading-bar"></div>
    <div class="flex flex-col items-center mt-6">
      <p class="uppercase text-sm tracking-widest text-gray-400">Burned in last ${prettyLabel(rangeLabel)}</p>
      <h2 id="burnTicker" class="text-4xl sm:text-5xl font-bold text-orange-400">0 XIAN</h2>
      <!-- ✦ Split-bar visualisation ✦ -->
    <p class="text-xs sm:text-sm text-gray-400 mt-4 mb-1 text-center">
  How every 1&nbsp;XIAN of gas is split
</p>

<div class="splitbar w-full max-w-xs sm:max-w-md mx-auto">
  <div class="w-full h-6 rounded-full overflow-hidden flex">
    <span class="seg bg-cyan-400" style="width:30%" data-name="Validators" data-pct="30"></span>
    <span class="seg bg-purple-500" style="width:68%" data-name="Developers" data-pct="68"></span>
    <span class="seg bg-gray-600"  style="width:1%"  data-name="Foundation" data-pct="1"></span>
    <span class="seg bg-orange-400" style="width:1%"  data-name="Burn"       data-pct="1"></span>
  </div>

  <!-- legend: give it the new helper class -->
  <ul class="splitbar-legend flex justify-between text-xs text-gray-400 mt-2">
    <li class="flex items-center gap-1"><i class="w-2 h-2 bg-cyan-400   rounded-full inline-block"></i>Validators&nbsp;30 %</li>
    <li class="flex items-center gap-1"><i class="w-2 h-2 bg-purple-500 rounded-full inline-block"></i>Developers&nbsp;68 %</li>
    <li class="flex items-center gap-1"><i class="w-2 h-2 bg-gray-600   rounded-full inline-block"></i>Foundation&nbsp;1 %</li>
    <li class="flex items-center gap-1"><i class="w-2 h-2 bg-orange-400 rounded-full inline-block"></i>Burn&nbsp;1 %</li>
  </ul>
</div>
    </div>
    
    <div class="flex flex-col sm:flex-row gap-6 justify-center my-8">
      ${mini(`Avg Tx Fee (${prettyLabel(rangeLabel)})`, fmt(d.avgFee) + ' XIAN')}
    </div>
    <div id="rewardsCards">
      ${cardList('<i data-lucide="code" class="inline w-4 h-4 mr-2 align-text-bottom"></i>Developer Rewards', d.fees.dev, d.devMap)}
      ${cardList('<i data-lucide="shield" class="inline w-4 h-4 mr-2 align-text-bottom"></i>Validator Rewards', d.fees.val, d.valMap)}
      ${cardSimple('<i data-lucide="crown" class="inline w-4 h-4 mr-2 align-text-bottom"></i>Foundation Rewards', d.fees.fnd)}
    </div>`;

    // animate hero number
    animateNumber(qs('#burnTicker'), 0, d.burn24h);

    lucide.createIcons();
    addRangeListeners();
}

function addRangeListeners() {
    document.querySelectorAll('.range-btn').forEach(btn => {
        btn.disabled = false;
        btn.onclick = () => { if (loading) return; selectedRange = btn.dataset.range; refresh(); };
    });
}

// ────────────────────────── FLOW ────────────────────────────
async function refresh() {
    if (loading) return; loading = true;
    qs('#loadingMessage')?.classList.add('active');
    try {
        const [rate, txs] = await Promise.all([getStampRate(), fetchAllTxs(selectedRange)]);
        const data = txs.length ? crunch(txs, rate, selectedRange) : { burn24h: 0, fees: { dev: 0, val: 0, fnd: 0 }, avgFee: 0, hourly: getChartLabels(selectedRange), devMap: {}, valMap: {} };
        render(data, selectedRange);
    } catch (e) { console.error(e); qs('#loadingMessage').textContent = 'Error loading data.'; }
    finally {
        loading = false;
        qs('#loadingMessage')?.classList.remove('active');
    }
}

await refresh();