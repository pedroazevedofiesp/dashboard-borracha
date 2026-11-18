// Protótipo de layout (prototipo.html): segmento em botões, seções em abas,
// cartões com minigráfico, mapa de estados e "leitura executiva". Usa o
// mesmo data/data.json e a mesma biblioteca de gráficos do painel.
(function () {
  'use strict';
  const { lineChart, barChart, fmt } = window.Charts;
  const $ = s => document.querySelector(s);
  const st = { data: null, seg: null, uf: null, aba: 'emprego' };
  const ANO_BASE = 2024;

  const UF_GRID = {
    RR: [2, 0], AP: [4, 0],
    AM: [1, 1], PA: [3, 1], MA: [4, 1], CE: [5, 1], RN: [6, 1],
    AC: [0, 2], RO: [1, 2], MT: [2, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
    GO: [3, 3], DF: [4, 3], BA: [5, 3], AL: [6, 3],
    MS: [2, 4], SP: [3, 4], MG: [4, 4], ES: [5, 4], SE: [6, 4],
    PR: [3, 5], RJ: [4, 5],
    SC: [3, 6],
    RS: [3, 7],
  };

  const cfg = () => st.data.meta.config;
  const setores = () => [cfg().agregado, ...cfg().cnaes].filter(Boolean);
  const sd = () => st.data.sectors[st.seg];
  const rotulo = c => { const s = setores().find(x => x.codigo === c); return s ? (s.rotulo_exec || s.rotulo) : c; };
  const pct = (v, casas = 1, sinal = false) => v == null || !isFinite(v) ? '-' :
    (sinal && v > 0 ? '+' : '') + v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%';
  const num = v => v == null ? '-' : Math.round(v).toLocaleString('pt-BR');
  const cagr = (a, b, n) => a > 0 && b > 0 && n > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : null;
  const anoFechado = rows => rows.filter(r => r.ano < new Date().getFullYear());

  // ---------- minigráfico SVG ----------
  function spark(vals, cor = 'var(--accent)') {
    const v = vals.filter(x => x != null);
    if (v.length < 2) return '';
    const w = 120, h = 32, min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
    const pts = vals.map((x, i) => x == null ? null : [i / (vals.length - 1) * w, h - 3 - (x - min) / rng * (h - 6)]).filter(Boolean);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const ult = pts[pts.length - 1];
    return `<svg class="p-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${cor}" stroke-width="1.8" stroke-linejoin="round"/><circle cx="${ult[0]}" cy="${ult[1]}" r="2.6" fill="${cor}"/></svg>`;
  }

  function card({ rotulo, valor, sub, serie, delta, deltaRuim }) {
    const cls = delta == null ? '' : ((delta >= 0) !== !!deltaRuim ? 'bom' : 'ruim');
    return `<div class="p-card">
      <div class="p-card-rot">${rotulo}</div>
      <div class="p-card-linha"><span class="p-card-val">${valor}</span>${spark(serie || [])}</div>
      <div class="p-card-sub">${delta != null ? `<span class="p-delta ${cls}">${pct(delta, 1, true)}</span> ` : ''}${sub || ''}</div>
    </div>`;
  }

  function leitura(alvo, titulo, itens) {
    $(alvo).innerHTML = `<div class="p-leitura-cab"><span class="p-leitura-tag">Leitura executiva</span>${titulo}</div>
      <ul>${itens.filter(Boolean).map(t => `<li>${t}</li>`).join('')}</ul>`;
  }

  // ---------- segmento / abas / tema ----------
  function montarSeg() {
    $('#p-seg').innerHTML = setores().map(s =>
      `<button type="button" data-seg="${s.codigo}" class="${s.codigo === st.seg ? 'ativo' : ''}">${s.rotulo_curto || s.rotulo}<small>${s.rotulo_curto_codigo || s.codigo}</small></button>`).join('');
    const s = setores().find(x => x.codigo === st.seg);
    $('#p-seg-desc').textContent = s ? (s.descricao || '') : '';
  }

  function trocarAba(aba) {
    st.aba = aba;
    document.querySelectorAll('#p-abas button').forEach(b => b.classList.toggle('ativo', b.dataset.aba === aba));
    document.querySelectorAll('.p-aba').forEach(s => { s.hidden = s.dataset.aba !== aba; });
    renderAba();
  }

  function renderAba() {
    if (st.aba === 'emprego') renderEmprego();
    if (st.aba === 'comex') renderComex();
    if (st.aba === 'visao') renderVisao();
  }

  // ---------- EMPREGO ----------
  function renderEmprego() {
    const r = sd().rais;
    const tot = r.uf_yearly_total;
    const ult = tot[tot.length - 1], prim = tot[0], ant = tot[tot.length - 2];
    const massa = r.massa_nacional_yearly;
    const ipcaDez = a => { const m = st.data.shared.macro.find(x => x.ano === a && x.mes === 12); return m ? m.ipca : null; };
    const remReal = massa.map(m => m.remuneracao_media_nominal && ipcaDez(m.ano) && ipcaDez(ANO_BASE) ? m.remuneracao_media_nominal * ipcaDez(ANO_BASE) / ipcaDez(m.ano) : null);
    const ufUlt = r.uf_yearly.filter(x => x.ano === ult.ano && x.vinculos > 0).sort((a, b) => b.vinculos - a.vinculos);
    const lider = ufUlt[0], totV = ufUlt.reduce((a, b) => a + b.vinculos, 0);
    const tam = ult.estabelecimentos ? ult.vinculos / ult.estabelecimentos : null;
    const tamIni = prim.estabelecimentos ? prim.vinculos / prim.estabelecimentos : null;
    const remUlt = remReal[remReal.length - 1], remIni = remReal.find(v => v != null);

    leitura('#p-leitura-emprego', `${rotulo(st.seg)} · ${prim.ano}–${ult.ano}`, [
      `O setor tinha <strong>${num(ult.vinculos)}</strong> vínculos formais em ${ult.ano}, ${pct((ult.vinculos / prim.vinculos - 1) * 100, 1, true)} desde ${prim.ano} (${pct(cagr(prim.vinculos, ult.vinculos, ult.ano - prim.ano), 1, true)} ao ano).`,
      lider ? `<strong>${lider.nome_uf}</strong> concentra ${pct(lider.vinculos / totV * 100)} do emprego; os três maiores estados somam ${pct(ufUlt.slice(0, 3).reduce((a, b) => a + b.vinculos, 0) / totV * 100)}.` : null,
      tam && tamIni ? `O estabelecimento médio tem ${tam.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} empregados (eram ${tamIni.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} em ${prim.ano}).` : null,
      remUlt && remIni ? `A remuneração média real ${remUlt >= remIni ? 'subiu' : 'caiu'} ${pct(Math.abs((remUlt / remIni - 1) * 100))} no período, para R$ ${num(remUlt)} por mês (R$ de ${ANO_BASE}).` : null,
    ]);

    $('#p-cards-emprego').innerHTML = [
      card({ rotulo: `Vínculos formais · ${ult.ano}`, valor: num(ult.vinculos), serie: tot.map(x => x.vinculos), delta: (ult.vinculos / ant.vinculos - 1) * 100, sub: `vs ${ant.ano}` }),
      card({ rotulo: `Estabelecimentos · ${ult.ano}`, valor: num(ult.estabelecimentos), serie: tot.map(x => x.estabelecimentos), delta: (ult.estabelecimentos / ant.estabelecimentos - 1) * 100, sub: `vs ${ant.ano}` }),
      card({ rotulo: 'Empregados por estabelecimento', valor: tam ? tam.toLocaleString('pt-BR', { maximumFractionDigits: 1 }) : '-', serie: tot.map(x => x.estabelecimentos ? x.vinculos / x.estabelecimentos : null), sub: `${ult.ano}` }),
      card({ rotulo: `Remuneração média real · ${massa[massa.length - 1].ano}`, valor: remUlt ? 'R$ ' + num(remUlt) : '-', serie: remReal, delta: remReal.length > 1 ? (remUlt / remReal[remReal.length - 2] - 1) * 100 : null, sub: `vs ano anterior · R$ de ${ANO_BASE}` }),
    ].join('');

    // mapa
    const porUf = new Map(ufUlt.map(x => [x.uf, x]));
    const max = Math.max(...ufUlt.map(x => x.vinculos));
    $('#p-mapa-titulo').textContent = lider ? `${lider.nome_uf} lidera o emprego do setor` : 'Emprego por estado';
    const cel = (uf, [c, l]) => {
      const x = porUf.get(uf);
      const v = x ? x.vinculos : 0;
      const t = v ? Math.pow(v / max, 0.45) : 0;
      return `<button type="button" class="p-uf${st.uf === uf ? ' sel' : ''}${t > 0.55 ? ' claro' : ''}" style="grid-column:${c + 1};grid-row:${l + 1};--t:${t.toFixed(3)}" data-uf="${uf}" title="${x ? x.nome_uf + ': ' + num(v) + ' vínculos' : uf}">
        <span class="p-uf-sig">${uf}</span><span class="p-uf-val">${v ? fmt.compact(v) : '–'}</span></button>`;
    };
    $('#p-mapa').innerHTML = Object.entries(UF_GRID).map(([uf, pos]) => cel(uf, pos)).join('');
    $('#p-mapa-leg').innerHTML = `<span>menos</span><i></i><span>mais vínculos (${ult.ano})</span>${st.uf ? `<button type="button" id="p-uf-limpa">Ver Brasil</button>` : ''}`;

    // série do estado selecionado (ou Brasil)
    const serieUf = st.uf ? r.uf_yearly.filter(x => x.uf === st.uf) : tot;
    const nome = st.uf ? (porUf.get(st.uf) || {}).nome_uf || st.uf : 'Brasil';
    const s0 = serieUf[0], s1 = serieUf[serieUf.length - 1];
    $('#p-emp-serie-titulo').textContent = s0 && s1 ? `${nome}: ${s1.vinculos >= s0.vinculos ? 'emprego cresceu' : 'emprego caiu'} ${pct(Math.abs((s1.vinculos / s0.vinculos - 1) * 100), 0)} desde ${s0.ano}` : nome;
    $('#p-emp-serie-sub').textContent = `Vínculos formais, ${nome}, ${s0 ? s0.ano : ''}–${s1 ? s1.ano : ''}`;
    barChart($('#p-emp-serie'), {
      categories: serieUf.map(x => x.ano), formatY: fmt.compact, height: 260,
      series: [{ label: 'Vínculos', color: 'var(--accent)', values: serieUf.map(x => x.vinculos) }],
    });

    $('#p-rem-titulo').textContent = remUlt && remIni ? `Salário real ${remUlt >= remIni ? 'acima' : 'abaixo'} do início da série` : 'Remuneração média';
    lineChart($('#p-rem'), {
      categories: massa.map(m => m.ano), formatY: fmt.brl, height: 240,
      series: [
        { label: 'Nominal', color: 'var(--series-2)', values: massa.map(m => m.remuneracao_media_nominal) },
        { label: `Real (R$ de ${ANO_BASE})`, color: 'var(--accent)', values: remReal },
      ],
    });

    $('#p-rank-titulo').textContent = `Top 10 estados · ${ult.ano}`;
    $('#p-rank-uf').innerHTML = '<ul class="p-rank">' + ufUlt.slice(0, 10).map(x =>
      `<li class="${st.uf === x.uf ? 'sel' : ''}"><span>${x.nome_uf}</span><span class="p-rank-bar"><i style="width:${(x.vinculos / totV * 100 / (lider.vinculos / totV * 100) * 100).toFixed(1)}%"></i></span><strong>${num(x.vinculos)}</strong><em>${pct(x.vinculos / totV * 100)}</em></li>`).join('') + '</ul>';
  }

  // ---------- COMÉRCIO EXTERIOR ----------
  const CESTAS_EXTRA = [
    { id: 'natural', rotulo: 'Borracha natural' },
    { id: 'quimicos', rotulo: 'Insumos químicos' },
    { id: 'pneus', rotulo: 'Pneus novos' },
  ];

  function renderComex() {
    const c = sd().comex;
    const anos = anoFechado(c.yearly);
    const u = anos[anos.length - 1], a = anos[anos.length - 2], p = anos[0];
    const china = c.importacao_china_resto_yearly;
    const ch = y => { const r = china.find(x => x.ano === y); return r && (r.china_usd + r.resto_usd) ? r.china_usd / (r.china_usd + r.resto_usd) * 100 : null; };
    const chP = china.find(x => x.ano === p.ano), chU = china.find(x => x.ano === u.ano);
    const top = (c.top_paises_latest.importacao || [])[0];
    const totImp = u.importacao_usd;

    leitura('#p-leitura-comex', `${rotulo(st.seg)} · ${p.ano}–${u.ano}`, [
      `Em ${u.ano}, o setor importou <strong>${fmt.usd(u.importacao_usd)}</strong> e exportou ${fmt.usd(u.exportacao_usd)}: déficit de ${fmt.usd(u.importacao_usd - u.exportacao_usd)}.`,
      `Desde ${p.ano}, a importação cresceu ${pct(cagr(p.importacao_usd, u.importacao_usd, u.ano - p.ano), 1, true)} ao ano, contra ${pct(cagr(p.exportacao_usd, u.exportacao_usd, u.ano - p.ano), 1, true)} da exportação.`,
      chP && chU && chP.china_usd > 0 ? `A China passou de ${pct(ch(p.ano))} para <strong>${pct(ch(u.ano))}</strong> das importações, com crescimento de ${pct(cagr(chP.china_usd, chU.china_usd, u.ano - p.ano), 1, true)} ao ano, o principal vetor de concorrência apontado no diagnóstico setorial.` : null,
      top ? `${top.pais} é a principal origem (${pct(top.valor_usd / totImp * 100)} do total importado em ${c.top_paises_latest.ano}).` : null,
      `Pelo diagnóstico, os grupos de produto em que o Brasil "perde oportunidade" (consumo cresce, mas a importação ganha espaço) já somam 47% do consumo aparente.`,
    ]);

    $('#p-cards-comex').innerHTML = [
      card({ rotulo: `Importação · ${u.ano}`, valor: fmt.usd(u.importacao_usd), serie: anos.map(x => x.importacao_usd), delta: (u.importacao_usd / a.importacao_usd - 1) * 100, deltaRuim: true, sub: `vs ${a.ano}` }),
      card({ rotulo: `Exportação · ${u.ano}`, valor: fmt.usd(u.exportacao_usd), serie: anos.map(x => x.exportacao_usd), delta: (u.exportacao_usd / a.exportacao_usd - 1) * 100, sub: `vs ${a.ano}` }),
      card({ rotulo: `Saldo · ${u.ano}`, valor: fmt.usd(u.exportacao_usd - u.importacao_usd), serie: anos.map(x => x.exportacao_usd - x.importacao_usd), sub: 'US$ FOB' }),
      card({ rotulo: `China nas importações · ${u.ano}`, valor: pct(ch(u.ano)), serie: anos.map(x => ch(x.ano)), sub: `${pct(ch(p.ano))} em ${p.ano}` }),
    ].join('');

    $('#p-cestas').innerHTML = `<span class="p-cesta setor ativo">Cesta do setor</span>` +
      CESTAS_EXTRA.map(x => `<span class="p-cesta fora" title="Fora do setor · entra na próxima etapa">${x.rotulo}<small>fora do setor · em breve</small></span>`).join('');
    $('#p-comex-titulo').textContent = `Importação ${u.importacao_usd > p.importacao_usd * 2 ? 'mais que dobrou' : 'cresceu'} desde ${p.ano}`;
    lineChart($('#p-comex-serie'), {
      categories: anos.map(x => x.ano), formatY: fmt.usd, height: 280,
      series: [
        { label: 'Importação', color: 'var(--series-6)', values: anos.map(x => x.importacao_usd) },
        { label: 'Exportação', color: 'var(--series-4)', values: anos.map(x => x.exportacao_usd) },
      ],
    });

    const lista = (arr, alvo, tot, cor) => {
      const mx = arr.length ? arr[0].valor_usd : 1;
      $(alvo).innerHTML = '<ul class="p-rank">' + arr.slice(0, 8).map(x =>
        `<li><span>${x.pais}</span><span class="p-rank-bar"><i style="width:${(x.valor_usd / mx * 100).toFixed(1)}%;background:${cor}"></i></span><strong>${fmt.usd(x.valor_usd)}</strong><em>${tot ? pct(x.valor_usd / tot * 100) : ''}</em></li>`).join('') + '</ul>';
    };
    const anoTop = c.top_paises_latest.ano;
    const lin = c.yearly.find(x => x.ano === anoTop) || {};
    $('#p-orig-sub').textContent = `Principais origens, ${anoTop}, e % do total importado`;
    $('#p-dest-sub').textContent = `Principais destinos, ${anoTop}, e % do total exportado`;
    lista(c.top_paises_latest.importacao || [], '#p-orig', lin.importacao_usd, 'var(--series-6)');
    lista(c.top_paises_latest.exportacao || [], '#p-dest', lin.exportacao_usd, 'var(--series-4)');
  }

  // ---------- VISÃO GERAL ----------
  function renderVisao() {
    const r = sd().rais.uf_yearly_total, c = anoFechado(sd().comex.yearly), m = (sd().mercado || {}).yearly || [];
    const ru = r[r.length - 1], cu = c[c.length - 1], mu = m[m.length - 1];
    $('#p-cards-visao').innerHTML = [
      card({ rotulo: `Empregos formais · ${ru.ano}`, valor: num(ru.vinculos), serie: r.map(x => x.vinculos), delta: (ru.vinculos / r[r.length - 2].vinculos - 1) * 100, sub: 'vs ano anterior' }),
      mu ? card({ rotulo: `Consumo aparente · ${mu.ano}`, valor: fmt.brl(mu.consumo_aparente_real), serie: m.map(x => x.consumo_aparente_real), sub: `R$ de ${ANO_BASE}` }) : '',
      mu ? card({ rotulo: `Importados no mercado · ${mu.ano}`, valor: pct(mu.penetracao_importacao), serie: m.map(x => x.penetracao_importacao), sub: 'penetração da importação' }) : '',
      card({ rotulo: `Importação · ${cu.ano}`, valor: fmt.usd(cu.importacao_usd), serie: c.map(x => x.importacao_usd), delta: (cu.importacao_usd / c[c.length - 2].importacao_usd - 1) * 100, deltaRuim: true, sub: 'vs ano anterior' }),
    ].join('');
  }

  // ---------- eventos ----------
  function ligar() {
    $('#p-seg').addEventListener('click', e => {
      const b = e.target.closest('button[data-seg]');
      if (!b) return;
      st.seg = b.dataset.seg; st.uf = null; montarSeg(); renderAba();
    });
    $('#p-abas').addEventListener('click', e => { const b = e.target.closest('button[data-aba]'); if (b) trocarAba(b.dataset.aba); });
    $('#p-mapa').addEventListener('click', e => {
      const b = e.target.closest('button[data-uf]');
      if (!b) return;
      st.uf = st.uf === b.dataset.uf ? null : b.dataset.uf; renderEmprego();
    });
    $('#p-mapa-leg').addEventListener('click', e => { if (e.target.id === 'p-uf-limpa') { st.uf = null; renderEmprego(); } });
    $('#p-tema').addEventListener('click', () => {
      const r = document.documentElement;
      const escuro = r.dataset.theme !== 'dark';
      r.dataset.theme = escuro ? 'dark' : 'light';
      try { localStorage.setItem('p-tema', r.dataset.theme); } catch (e) { /* sem storage */ }
      renderAba();
    });
    try { const t = localStorage.getItem('p-tema'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* sem storage */ }
  }

  fetch('data/data.json?v=dev').then(r => r.json()).then(data => {
    st.data = data;
    st.seg = setores()[0].codigo;
    montarSeg();
    ligar();
    trocarAba('emprego');
  });
})();
