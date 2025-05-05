/* -------------------------------------------
   Replace fetchStats() with your real API call
   ------------------------------------------- */
   async function fetchStats () {
    // demo payload for UI / CSS testing
    return {
      burn24h: 14654,
      dev24h: 3200,
      val24h: 1410,
      fdn24h: 50,
      lastTx: '6tXg…9Qe',
      volume24h: 873000,
      volumeChange: +12.4 // % vs prev‑24h (optional)
    };
  }
  
  /* build the four stat boxes */
  function renderStats (d) {
    const grid = document.getElementById('statsGrid');
    grid.innerHTML = `
      ${box('Burned (24 h)', d.burn24h)}
      ${box('Dev Rewards (24 h)', d.dev24h)}
      ${box('Validator Rewards (24 h)', d.val24h)}
      ${box('Foundation Share (24 h)', d.fdn24h)}
    `;
  }
  
  function box (label, value) {
    return `
      <div class="stats-box">
        <p class="stats-value">${fmt(value)}</p>
        <p class="stats-label">${label}</p>
      </div>
    `;
  }
  
  function fmt (n) {
    return n.toLocaleString(undefined, {maximumFractionDigits:0}) + ' XIAN';
  }
  
  /* badge helper for volume change (optional) */
  function volumeBadge (pct) {
    const dir = pct >= 0 ? 'up' : 'down';
    const sign = pct >= 0 ? '+' : '';
    return `<span class="volume-badge ${dir}">${sign}${pct.toFixed(1)}%</span>`;
  }
  
  /* copy tx hash */
  function copyHash () {
    navigator.clipboard.writeText(document.getElementById('txHash').textContent);
    toast('Copied to clipboard', 'success');
  }
  
  document.getElementById('copyBtn').addEventListener('click', copyHash);
  
  /* small toast feedback */
  function toast (msg, type='success') {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.textContent = msg;
    document.getElementById('toastContainer').appendChild(el);
    requestAnimationFrame(()=>el.classList.add('show'));
    setTimeout(()=>{ el.classList.add('hide'); setTimeout(()=>el.remove(),300); },1800);
  }
  
  /* main loop */
  async function update () {
    try {
      const d = await fetchStats();
      renderStats(d);
      document.getElementById('txHash').textContent = d.lastTx;
    } catch (e) {
      console.error(e);
      toast('Stats fetch failed','error');
    }
  }
  update();
  setInterval(update, 10000);
  