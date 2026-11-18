(function () {
  'use strict';
  const { lineChart, barChart, hBarChart, dualAxisLineChart, waterfallChart, donutChart, sankeyChart, dataTable, rankList, fmt, showTooltip, hideTooltip } = window.Charts;
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const CURRENT_YEAR = new Date().getFullYear();
  const CORES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)',
                 'var(--series-5)', 'var(--series-6)', 'var(--series-7)', 'var(--series-8)'];

  // Mapa UF -> região (mesma tabela do build_data.py), só pra mostrar na
  // dica do ranking de custo de energia qual região determina a tarifa.
  const UF_REGIAO_JS = {
    AC: 'Norte', AP: 'Norte', AM: 'Norte', PA: 'Norte', RO: 'Norte', RR: 'Norte', TO: 'Norte',
    AL: 'Nordeste', BA: 'Nordeste', CE: 'Nordeste', MA: 'Nordeste', PB: 'Nordeste',
    PE: 'Nordeste', PI: 'Nordeste', RN: 'Nordeste', SE: 'Nordeste',
    DF: 'Centro-Oeste', GO: 'Centro-Oeste', MT: 'Centro-Oeste', MS: 'Centro-Oeste',
    ES: 'Sudeste', MG: 'Sudeste', RJ: 'Sudeste', SP: 'Sudeste',
    PR: 'Sul', RS: 'Sul', SC: 'Sul',
  };

  // Recessões do Brasil (datação CODACE/FGV-IBRE), usadas como faixas de contexto.
  const RECESSOES = [
    { from: 200301, to: 200306, label: '2003' },
    { from: 200308, to: 200901, label: 'Crise financeira 2008–09' },
    { from: 201403, to: 201612, label: 'Recessão 2014–16' },
    { from: 202002, to: 202006, label: 'Covid-19 2020' },
  ];

  // Setor inicial = primeiro CNAE de config_painel.json (definido no boot).
  const state = { sector: null, view: 'home', data: null };
  // Filtro por bloco: cada seção tem sua própria cobertura real de dado
  // (Produção vai de 2002, RAIS de 2006, Comex varia até por segmento) —
  // um filtro único no topo não tinha como representar isso direito. lo/hi
  // de cada bloco nascem da cobertura real (calculada em initBlocks()), não
  // de um valor arbitrário compartilhado.
  const blocks = { producao: {}, emprego: {}, caged: {}, comex: {} };
  const $ = (sel, root) => (root || document).querySelector(sel);
  const MINUSC = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'com', 'para', 'a', 'o', 'no', 'na']);
  function titleCasePt(s) {
    return s.toLowerCase().split(' ').map((w, i) => {
      if (i > 0 && MINUSC.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(' ');
  }

  // ---------------------------------------------------------------------
  // Helpers de dados
  // ---------------------------------------------------------------------
  function filterAnnual(rows, lo, hi) { return rows.filter(r => r.ano >= lo && r.ano <= hi); }
  function filterMonthly(rows, lo, hi) { return rows.filter(r => r.ano >= lo && r.ano <= hi); }
  function monthLabel(k, long) {
    const ano = Math.floor(k / 100), mes = k % 100;
    return long ? MESES[mes - 1] + ' de ' + ano : MESES[mes - 1] + '/' + String(ano).slice(2);
  }
  function annualCategories(rowsArrays) {
    const keys = new Set();
    rowsArrays.forEach(rows => rows.forEach(r => keys.add(r.ano)));
    return Array.from(keys).sort((a, b) => a - b);
  }
  function monthlyCategories(rowsArrays) {
    const keys = new Set();
    rowsArrays.forEach(rows => rows.forEach(r => keys.add(r.ano * 100 + r.mes)));
    return Array.from(keys).sort((a, b) => a - b);
  }
  function seriesAnnual(rows, field, categories) {
    const map = new Map(rows.map(r => [r.ano, r[field]]));
    return categories.map(k => (map.has(k) ? map.get(k) : null));
  }
  function seriesMonthly(rows, field, categories) {
    const map = new Map(rows.map(r => [r.ano * 100 + r.mes, r[field]]));
    return categories.map(k => (map.has(k) ? map.get(k) : null));
  }
  function last(arr) { return arr.length ? arr[arr.length - 1] : null; }
  // Ano corrente vem parcial (Comex, CAGED): comparações e rankings anuais
  // usam o último ano fechado.
  function anoFechado(ano) { return ano === CURRENT_YEAR ? ano - 1 : ano; }
  function csS() { return state.data.sectors[state.sector]; }
  // Ano-base único das séries em R$ constantes (config_painel.json).
  function anoBasePrecos() { return state.data.meta.config.setor.ano_base_precos || 2024; }
  function shared() { return state.data.shared; }

  // Tudo o que é específico do setor (CNAEs, rótulos, textos) vem de
  // config_painel.json, repassado pelo build_data.py em meta.config.
  function cfg() { return state.data.meta.config; }
  function setorCfg() { return cfg().setor; }
  // CNAEs reais (cada um com seus arquivos) e recortes do painel: o agregado
  // opcional (ex.: "Borracha - Total", soma dos CNAEs) vem primeiro.
  // Como a margem operacional é calculada — mesmo texto no Painel Executivo,
  // no Financeiro e nas Referências.
  function margemFormula(escopo) {
    const alvo = escopo === 'grupo' ? `do grupo CNAE ${setorCfg().grupo_cnae}` : 'do segmento selecionado';
    return `Margem operacional = (receita líquida de vendas − total de custos e despesas) ÷ receita líquida de vendas, PIA-Empresa (IBGE), ${alvo}. `
      + `Os dois totais são publicados pelo IBGE, sem ajuste do painel; por isso a margem não é igual à de um balanço contábil.`;
  }
  // Série anual da PIA-Empresa por classe do segmento (2007 em diante).
  function seriePiaSegmento(codigo) {
    const ind = shared().financeiro.indicadores;
    return ind && ind.serie ? ind.serie.filter(r => r.recorte === codigo).sort((a, b) => a.ano - b.ano) : [];
  }
  function cnaeCodigos() { return cfg().cnaes.map(c => c.codigo); }
  function setores() { return (cfg().agregado ? [cfg().agregado] : []).concat(cfg().cnaes); }
  function cnaeCfg(codigo) { return setores().find(c => c.codigo === (codigo || state.sector)); }
  function codigoCurto(c) { return c.rotulo_curto_codigo || c.codigo; }
  function rotuloCnae(codigo) { const c = cnaeCfg(codigo); return c ? `${c.rotulo} (${codigoCurto(c)})` : codigo; }
  function isSectorView(view) { return setores().some(c => c.codigo === view); }
  // Frase que diz o que é o recorte: a definição do CNAE ou, no agregado,
  // quais CNAEs ele soma.
  function descricaoSetor(codigo) {
    const c = cnaeCfg(codigo);
    if (!c) return '';
    return c.componentes ? c.descricao : `CNAE ${c.cnae} — ${c.descricao}.`;
  }
  function temDecom() { return (shared().decom || []).length > 0; }
  // Média anual do índice de produção (só anos com 12 meses, pra não comparar
  // ano parcial com ano fechado).
  function producaoMediaAnual(campo) {
    const porAno = {};
    shared().producao.indice.forEach(r => {
      if (r[campo] != null) (porAno[r.ano] = porAno[r.ano] || []).push(r[campo]);
    });
    return Object.keys(porAno).map(Number).sort((a, b) => a - b)
      .filter(a => porAno[a].length === 12)
      .map(a => ({ ano: a, valor: porAno[a].reduce((x, y) => x + y, 0) / 12 }));
  }
  function ufName(uf) {
    if (uf === 'BR') return 'Brasil';
    const found = state.data.meta.uf_lista.find(u => u.uf === uf);
    return found ? found.nome : uf;
  }
  // "BR" é um pseudo-estado (agregado nacional já calculado nas séries do
  // pipeline, não soma dos estados reais) selecionável junto dos 27 estados
  // reais, igual ao padrão já usado em Energia Industrial.
  function ufFiltroLista() { return [{ uf: 'BR', nome: 'Brasil' }, ...state.data.meta.uf_lista]; }
  function ufsOrdenadas(ufsSet) { return ufFiltroLista().map(u => u.uf).filter(uf => ufsSet.has(uf)); }
  // Exclui BR das linhas de tendência quando estados reais também estão
  // selecionados: BR é o agregado nacional, magnitude bem maior que 1 estado
  // sozinho, e esmaga as linhas menores perto de zero num eixo linear
  // compartilhado (mesmo problema já corrigido em Energia Industrial). As
  // tabelas completas não são filtradas por estado, então BR sumir do
  // gráfico não tira informação de lugar nenhum. Só mantém BR no gráfico
  // quando é a única seleção (visão nacional pura, comportamento padrão).
  function combosParaGrafico(combos, ufsSel) {
    return (ufsSel.includes('BR') && ufsSel.length > 1) ? combos.filter(c => c.uf !== 'BR') : combos;
  }

  // ---------------------------------------------------------------------
  // Filtro por bloco: período (com os limites reais de cada bloco) e,
  // onde aplicável, estado. Widgets minimalistas, embutidos em cada seção
  // (não mais uma barra fixa no topo da página).
  // ---------------------------------------------------------------------
  function yearBounds(rowArrays) {
    let lo = Infinity, hi = -Infinity;
    rowArrays.forEach(rows => rows.forEach(r => { if (r.ano < lo) lo = r.ano; if (r.ano > hi) hi = r.ano; }));
    return isFinite(lo) ? { lo, hi } : { lo: CURRENT_YEAR, hi: CURRENT_YEAR };
  }

  function fillYearOptions(sel, lo, hi, selected) {
    const years = []; for (let y = lo; y <= hi; y++) years.push(y);
    sel.innerHTML = years.map(y => `<option value="${y}"${y === selected ? ' selected' : ''}>${y}</option>`).join('');
  }

  function wireBlockPeriod(bs, loSel, hiSel, onChange) {
    fillYearOptions(loSel, bs.boundsLo, bs.boundsHi, bs.lo);
    fillYearOptions(hiSel, bs.boundsLo, bs.boundsHi, bs.hi);
    loSel.addEventListener('change', () => { bs.lo = Math.min(Number(loSel.value), bs.hi); loSel.value = bs.lo; onChange(); });
    hiSel.addEventListener('change', () => { bs.hi = Math.max(Number(hiSel.value), bs.lo); hiSel.value = bs.hi; onChange(); });
  }

  // Multi-select de estado por bloco (Emprego/CAGED) — mesmo padrão de
  // renderEnergiaIndustrial, parametrizado pelo blockState e pelos
  // elementos DOM daquele bloco. Retorna {render, sync} pra outros pontos
  // do mesmo bloco (ex.: clique num ranking) atualizarem o widget depois
  // de mexer em bs.ufs/bs.focoUf por fora.
  function wireBlockUf(bs, btnEl, panelEl, wrapEl, onChange) {
    function render() {
      panelEl.innerHTML = ufFiltroLista().map(u => `
        <label class="multiselect-option">
          <input type="checkbox" value="${u.uf}"${bs.ufs.has(u.uf) ? ' checked' : ''}>
          ${u.nome}
        </label>`).join('');
      panelEl.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        if (inp.checked) { bs.ufs.add(inp.value); bs.focoUf = inp.value; }
        else if (bs.ufs.size > 1) {
          bs.ufs.delete(inp.value);
          if (bs.focoUf === inp.value) bs.focoUf = ufsOrdenadas(bs.ufs)[0];
        } else inp.checked = true; // sempre pelo menos 1 estado selecionado
        sync();
        onChange();
      }));
    }
    function sync() {
      const sel = ufsOrdenadas(bs.ufs);
      btnEl.textContent = sel.length <= 2 ? sel.map(uf => ufName(uf)).join(', ') : sel.length + ' estados';
    }
    btnEl.addEventListener('click', () => {
      const abrir = panelEl.hidden;
      panelEl.hidden = !abrir;
      btnEl.setAttribute('aria-expanded', String(abrir));
    });
    document.addEventListener('click', (evt) => {
      if (!wrapEl.contains(evt.target)) { panelEl.hidden = true; btnEl.setAttribute('aria-expanded', 'false'); }
    });
    render();
    sync();
    return { render, sync };
  }

  // Comex só usa 1 estado por vez (o gráfico de barras não compara vários
  // ao mesmo tempo) — um <select> simples é mais minimalista que o
  // dropdown de checkboxes usado em Emprego/CAGED.
  function wireComexUfSelect(bs, selEl, onChange) {
    selEl.innerHTML = ufFiltroLista().map(u => `<option value="${u.uf}">${u.nome}</option>`).join('');
    selEl.value = bs.focoUf;
    selEl.addEventListener('change', () => { bs.focoUf = selEl.value; onChange(); });
  }

  function initBlocks() {
    const sh = shared();
    const secs = cnaeCodigos().map(c => state.data.sectors[c]);

    const prod = yearBounds([sh.producao.indice]);
    blocks.producao = { lo: prod.lo, hi: prod.hi, boundsLo: prod.lo, boundsHi: prod.hi };

    const emp = yearBounds(secs.map(s => s.rais.uf_yearly_total));
    blocks.emprego = { lo: emp.lo, hi: emp.hi, boundsLo: emp.lo, boundsHi: emp.hi, ufs: new Set(['BR']), focoUf: 'BR' };

    const cagedLo = Math.min(...secs.map(s => Number(s.caged.coverage.inicio.slice(0, 4))));
    const cagedHi = Math.max(...secs.map(s => Number(s.caged.coverage.fim.slice(0, 4))));
    blocks.caged = { lo: cagedLo, hi: cagedHi, boundsLo: cagedLo, boundsHi: cagedHi, ufs: new Set(['BR']), focoUf: 'BR' };

    const comex = yearBounds(secs.map(s => s.comex.yearly));
    blocks.comex = { lo: comex.lo, hi: comex.hi, boundsLo: comex.lo, boundsHi: comex.hi, focoUf: 'BR' };
  }

  // ---------------------------------------------------------------------
  // 01 — Produção física
  // ---------------------------------------------------------------------

  // Comparativos: produção da divisão x indústria (PIM-PF, médias anuais,
  // base 100 no ano escolhido) e, no Financeiro, valor adicionado real e
  // pessoal ocupado do segmento x indústria de transformação (PIA, 2007 = 100).
  let producaoCmpBase = null;
  function renderProducaoCmp() {
    const bloco = $('#bloco-producao-cmp');
    const sh = shared();
    const cmp = sh.producao.comparativos;
    if (!bloco) return;
    if (!cmp) { bloco.style.display = 'none'; return; }
    const media = rows => {
      const por = {};
      rows.forEach(r => { if (r.indice_bruto != null) (por[r.ano] = por[r.ano] || []).push(r.indice_bruto); });
      const out = {};
      Object.entries(por).forEach(([a, v]) => { if (v.length === 12) out[a] = v.reduce((x, y) => x + y, 0) / 12; });
      return out;
    };
    const series = [
      { label: setorCfg().producao_titulo || 'Divisão do setor', color: 'var(--accent)', m: media(sh.producao.indice) },
      cmp.industria_transformacao ? { label: 'Indústria de transformação', color: 'var(--series-2)', m: media(cmp.industria_transformacao) } : null,
      cmp.industria_geral ? { label: 'Indústria geral', color: 'var(--series-8)', m: media(cmp.industria_geral) } : null,
    ].filter(Boolean);
    const anos = Object.keys(series[0].m).map(Number).filter(a => series.every(x => x.m[a] != null)).sort((a, b) => a - b);
    if (!anos.length) { bloco.style.display = 'none'; return; }
    if (!anos.includes(producaoCmpBase)) producaoCmpBase = anos[0];
    const sel = $('#producao-cmp-base');
    sel.innerHTML = anos.map(a => `<option value="${a}">${a}</option>`).join('');
    sel.value = producaoCmpBase;
    if (!sel.dataset.wired) { sel.addEventListener('change', () => { producaoCmpBase = +sel.value; renderProducaoCmp(); }); sel.dataset.wired = '1'; }
    const idx = x => anos.map(a => x.m[a] / x.m[producaoCmpBase] * 100);
    const u = anos[anos.length - 1];
    const vS = series[0].m[u] / series[0].m[producaoCmpBase] * 100, vI = series[1] ? series[1].m[u] / series[1].m[producaoCmpBase] * 100 : null;
    $('#producao-cmp-title').textContent = vI != null
      ? `Desde ${producaoCmpBase}, a produção do setor ${vS >= vI ? 'superou a' : 'ficou abaixo da'} indústria de transformação (${fmt.full1(vS)} x ${fmt.full1(vI)} em ${u})`
      : 'Produção do setor x indústria';
    $('#producao-cmp-sub').textContent = `Índice de produção física, média anual, base ${producaoCmpBase} = 100. A divisão inclui borracha e plástico.`;
    lineChart($('#chart-producao-cmp'), {
      categories: anos, formatY: fmt.full1, height: 260,
      series: series.map(x => ({ label: x.label, color: x.color, values: idx(x) })),
    });
  }

  function renderFinCmp() {
    const bloco = $('#bloco-fin-cmp');
    const ind = shared().financeiro.indicadores;
    if (!bloco) return;
    if (!ind || !ind.serie) { bloco.style.display = 'none'; return; }
    const de = rec => ind.serie.filter(r => r.recorte === rec).sort((a, b) => a.ano - b.ano);
    const sS = de(state.sector), sI = de('ind_transformacao');
    if (!sS.length || !sI.length) { bloco.style.display = 'none'; return; }
    const anos = sS.map(r => r.ano).filter(a => sI.some(r => r.ano === a));
    const base = (rows, k) => { const b = rows.find(r => r.ano === anos[0]); return anos.map(a => { const r = rows.find(x => x.ano === a); return r && b && r[k] != null && b[k] ? r[k] / b[k] * 100 : null; }); };
    // valor adicionado real = lucro bruto real + gastos de pessoal reais (mesmo deflator da tabela)
    const real = rows => anos.map(a => { const r = rows.find(x => x.ano === a); return r && r.lucro_bruto_real != null && r.gastos_pessoal_real != null ? r.lucro_bruto_real + r.gastos_pessoal_real : null; });
    const rS = real(sS), rI = real(sI);
    const idx = v => v.map(x => x != null && v[0] ? x / v[0] * 100 : null);
    const poS = base(sS, 'pessoal_ocupado'), poI = base(sI, 'pessoal_ocupado');
    const iS = idx(rS), iI = idx(rI);
    const u = anos.length - 1;
    $('#fin-cmp-title').textContent = iS[u] != null && iI[u] != null
      ? `Valor adicionado real: ${rotuloCnae(state.sector)} ${iS[u] >= iI[u] ? 'acima' : 'abaixo'} da indústria de transformação desde ${anos[0]} (${fmt.full1(iS[u])} x ${fmt.full1(iI[u])})`
      : 'Segmento x indústria de transformação';
    $('#fin-cmp-sub').textContent = `Índice ${anos[0]} = 100: valor adicionado em R$ constantes (IPCA) e pessoal ocupado. ${anos[u]} é da nova série da PIA.`;
    lineChart($('#chart-fin-cmp'), {
      categories: anos, formatY: fmt.full1, height: 260,
      series: [
        { label: `Valor adicionado real · ${rotuloCnae(state.sector)}`, color: 'var(--accent)', values: iS },
        { label: 'Valor adicionado real · ind. transformação', color: 'var(--series-2)', values: iI },
        { label: `Pessoal ocupado · ${rotuloCnae(state.sector)}`, color: 'var(--series-8)', values: poS },
        { label: 'Pessoal ocupado · ind. transformação', color: 'var(--series-5)', values: poI },
      ],
    });
  }

  function renderProducao() {
    renderProducaoCmp();
    const sh = shared();
    const sc = setorCfg();
    const bs = blocks.producao;

    $('#producao-section-note').textContent = sc.producao_descricao + ' Dado nacional, sem abertura por estado.';
    renderCaptionMeta($('#section-caption-producao'), { fonte: 'IBGE/PIM-PF', cobertura: 'producao' });

    const idx = filterMonthly(sh.producao.indice, bs.lo, bs.hi);
    const catIdx = idx.map(r => r.ano * 100 + r.mes);
    lineChart($('#chart-producao-dessaz'), {
      categories: catIdx, formatX: monthLabel, formatY: fmt.full1, height: 280,
      series: [
        { label: 'Mês a mês', color: 'var(--series-2)', values: idx.map(r => r.indice_bruto) },
        { label: 'Sem efeito sazonal', color: 'var(--series-3)', values: idx.map(r => r.indice_dessaz) },
      ]
    });

    lineChart($('#chart-producao-indice'), {
      categories: catIdx, formatX: monthLabel, formatY: fmt.full1, height: 280, bands: RECESSOES,
      series: [{ label: 'Sem efeito sazonal', color: 'var(--series-3)', values: idx.map(r => r.indice_dessaz), area: true }]
    });

    // Variação em 12 meses: índice bruto do mês contra o mesmo mês do ano
    // anterior (a comparação usual do IBGE, que já neutraliza a sazonalidade).
    const brutoPorMes = new Map(sh.producao.indice.map(r => [r.ano * 100 + r.mes, r.indice_bruto]));
    const var12 = idx.map(r => {
      const ant = brutoPorMes.get((r.ano - 1) * 100 + r.mes);
      return (ant && r.indice_bruto != null) ? ((r.indice_bruto - ant) / ant) * 100 : null;
    });
    lineChart($('#chart-producao-variacao'), {
      categories: catIdx, formatX: monthLabel, formatY: n => fmt.pct(n), height: 280, bands: RECESSOES,
      series: [{ label: 'Variação em 12 meses', color: 'var(--series-2)', values: var12 }]
    });

    const tableRows = [...sh.producao.indice].sort((a, b) => (b.ano * 100 + b.mes) - (a.ano * 100 + a.mes));
    dataTable($('#table-producao'), {
      columns: [
        { key: 'k', label: 'Mês', format: monthLabel },
        { key: 'indice_bruto', label: 'Índice (mês a mês)', align: 'right', format: fmt.full1 },
        { key: 'indice_dessaz', label: 'Índice sem efeito sazonal', align: 'right', format: fmt.full1 },
      ],
      rows: tableRows.map(r => ({ ...r, k: r.ano * 100 + r.mes })),
      pageSize: 12,
    });
  }

  // ---------------------------------------------------------------------
  // 02 — Financeiro
  // ---------------------------------------------------------------------
  function renderFinanceiro() {
    // Série PIA é curta (2007–2024, ~18 pontos anuais) — sempre mostra o
    // histórico completo, sem responder à régua de período (feita para
    // séries longas: produção mensal, RAIS, CAGED, comex/comtrade).
    const sh = shared();
    const sc = setorCfg();
    const finG = sh.financeiro.grupo;
    const catFin = finG.map(r => r.ano);

    $('#financeiro-section-note').textContent = `Os indicadores de desempenho e os comparativos são do segmento selecionado; os gráficos de VTI, receita e custos abaixo são do grupo ${sc.grupo_cnae} inteiro (${sc.grupo_descricao.toLowerCase()}), que inclui pneus novos. ${margemFormula('grupo')}`;
    $('#financeiro-table-sub').textContent = `${catFin[0]}–${last(catFin)}, valores correntes, clique no cabeçalho para ordenar`;
    $('#financeiro-por-cnae-title').textContent = cfg().cnaes.map(c => rotuloCnae(c.codigo)).join(' x ');

    dualAxisLineChart($('#chart-financeiro-vti-po'), {
      categories: catFin, formatYLeft: fmt.brl, formatYRight: fmt.compact, height: 280, plainAxis: true,
      seriesLeft: { label: 'VTI', color: 'var(--series-3)', values: finG.map(r => r.vti != null ? r.vti * 1000 : null) },
      seriesRight: { label: 'Pessoal ocupado', color: 'var(--series-2)', values: finG.map(r => r.pessoal_ocupado) },
    });

    const produtividade = finG.map(r => (r.vti != null && r.pessoal_ocupado) ? (r.vti * 1000) / r.pessoal_ocupado : null);
    lineChart($('#chart-financeiro-produtividade'), {
      categories: catFin, formatY: fmt.brl, height: 280,
      series: [{ label: 'VTI / pessoal ocupado', color: 'var(--series-2)', values: produtividade }]
    });

    barChart($('#chart-financeiro-receita-custos'), {
      categories: catFin, formatY: fmt.brl, height: 280,
      series: [
        { label: 'Receita líquida', color: 'var(--series-4)', values: finG.map(r => r.receita_liquida_total * 1000) },
        { label: 'Custos e despesas', color: 'var(--series-6)', values: finG.map(r => r.custos_despesas_totais * 1000) }
      ]
    });

    const latestFin = last(finG);
    $('#financeiro-waterfall-title').textContent = 'Decomposição de custos de ' + latestFin.ano;
    const materiasPrimas = latestFin.consumo_materias_primas || 0;
    const pessoal = latestFin.gastos_pessoal_total || 0;
    const custoTotal = latestFin.custos_despesas_totais || 0;
    const outros = custoTotal - materiasPrimas - pessoal;
    waterfallChart($('#chart-financeiro-waterfall'), {
      formatY: fmt.brl, height: 280,
      items: [
        { label: 'Matérias-primas', value: materiasPrimas * 1000 },
        { label: 'Pessoal', value: pessoal * 1000 },
        { label: 'Outros', value: outros * 1000 },
        { label: 'Custo total', value: custoTotal * 1000, isTotal: true },
      ]
    });

    dataTable($('#table-financeiro'), {
      columns: [
        { key: 'ano', label: 'Ano' },
        { key: 'numero_empresas', label: 'Nº unidades locais', align: 'right', format: fmt.full },
        { key: 'pessoal_ocupado', label: 'Pessoal ocupado', align: 'right', format: fmt.full },
        { key: 'vbpi', label: 'VBPI', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'vti', label: 'VTI', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'receita_liquida_total', label: 'Receita líquida', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'custos_despesas_totais', label: 'Custos totais', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'margem', label: 'Margem operacional', align: 'right', format: n => fmt.pct(n) },
      ],
      rows: [...finG].reverse().map(r => ({
        ...r,
        margem: (r.receita_liquida_total && r.custos_despesas_totais != null)
          ? ((r.receita_liquida_total - r.custos_despesas_totais) / r.receita_liquida_total) * 100 : null,
      })),
      pageSize: 20,
    });

    renderIndicadoresDesempenho(sh.financeiro.indicadores);
    renderFinCmp();
    renderOutrosIndicadores(sh.financeiro.indicadores);

    dataTable($('#table-financeiro-por-cnae'), {
      columns: [
        { key: 'cnae_label', label: 'Classe' },
        { key: 'numero_empresas', label: 'Nº empresas', align: 'right', format: fmt.full },
        { key: 'pessoal_ocupado', label: 'Pessoal ocupado', align: 'right', format: fmt.full },
        { key: 'vbpi', label: 'VBPI', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'vti', label: 'VTI', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'receita_liquida_total', label: 'Receita líquida', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'custos_despesas_totais', label: 'Custos totais', align: 'right', format: n => fmt.brlFull(n * 1000) },
        { key: 'margem', label: 'Margem operacional', align: 'right', format: n => fmt.pct(n) },
      ],
      rows: sh.financeiro.por_cnae_2024.map(r => ({
        ...r, cnae_label: rotuloCnae(r.cnae),
        margem: (r.receita_liquida_total && r.custos_despesas_totais != null)
          ? ((r.receita_liquida_total - r.custos_despesas_totais) / r.receita_liquida_total) * 100 : null,
      })),
    });
  }

  // Fonte simples no rodapé de cada gráfico/tabela, no padrão do diagnóstico
  // setorial (sem detalhar tabelas, filtros ou metodologia).
  const FONTES_EXHIBIT = {
    'exec-chart-crescimento': 'PIM-PF/IBGE, PIA/IBGE e RAIS/MTE',
    'exec-chart-comex': 'Comexstat', 'exec-chart-paises-imp': 'Comexstat',
    'exec-chart-margem': 'PIA/IBGE',
    'chart-producao-cmp': 'PIM-PF/IBGE', 'chart-fin-cmp': 'PIA/IBGE',
    'chart-producao-dessaz': 'PIM-PF/IBGE', 'chart-producao-indice': 'PIM-PF/IBGE',
    'chart-producao-variacao': 'PIM-PF/IBGE', 'table-producao': 'PIM-PF/IBGE',
    'table-indicadores-desempenho': 'PIA/IBGE', 'table-indicadores-outros': 'PIA/IBGE',
    'chart-financeiro-vti-po': 'PIA/IBGE', 'chart-financeiro-produtividade': 'PIA/IBGE',
    'chart-financeiro-receita-custos': 'PIA/IBGE', 'chart-financeiro-waterfall': 'PIA/IBGE',
    'table-financeiro': 'PIA/IBGE', 'table-financeiro-por-cnae': 'PIA/IBGE',
    'chart-caged-saldo': 'CAGED/MTE', 'chart-caged-movimentacao': 'CAGED/MTE',
    'chart-caged-tipo': 'CAGED/MTE', 'chart-caged-massa-salarial': 'CAGED/MTE',
    'rank-caged-saldo-uf': 'CAGED/MTE', 'table-caged-uf': 'CAGED/MTE',
    'chart-comex-participacao-mundial': 'Comtrade', 'table-comex-grupos-mundo': 'Comtrade', 'cx-mensal-chart': 'Comexstat', 'cx-ncm-chart': 'Comexstat', 'cx-ext-chart': 'Comexstat', 'comex-mundo-ano-select': 'Comtrade',
    'chart-mercado-ca': 'PIA/IBGE e Comexstat', 'chart-mercado-coef': 'PIA/IBGE e Comexstat',
    'table-mercado-produtos': 'PIA/IBGE e Comexstat',
    'table-decom': 'DECOM/GECEX',
    'ee-chart-exposicao-china': 'Comexstat e RAIS/MTE', 'ee-chart-bndes-percapita': 'BNDES e RAIS/MTE',
    'mun-mapa': 'RAIS/MTE e IBGE (malha municipal)', 'mun-ranking': 'RAIS/MTE',
    'cempre-mapa': 'CEMPRE/IBGE', 'cempre-serie': 'CEMPRE/IBGE', 'cempre-sal': 'CEMPRE/IBGE',
    'ee-chart-porte': 'RAIS/MTE', 'ee-chart-export-uf': 'Comexstat',
    'ee-chart-produtividade': 'PIA/IBGE', 'ee-chart-producao-emprego': 'PIM-PF/IBGE e RAIS/MTE',
    'chart-ei-consumo': 'EPE', 'rank-ei-composicao': 'EPE',
    'rank-ei-custo-estados': 'ANEEL', 'chart-ei-custo-tempo': 'ANEEL', 'table-ei-dados': 'EPE e ANEEL',
  };
  const FONTE_POR_PREFIXO = [['emprego', 'RAIS/MTE'], ['comex', 'Comexstat'], ['bndes', 'BNDES']];
  function aplicarFontesExhibits() {
    document.querySelectorAll('.exhibit, .exhibit-block').forEach(ex => {
      const cap = ex.querySelector(':scope > .exhibit-caption');
      if (!cap || cap.querySelector('.exhibit-fonte')) return;
      const ids = [...ex.querySelectorAll('[id]')].map(e => e.id);
      let fonte = ids.map(id => FONTES_EXHIBIT[id]).find(Boolean);
      if (!fonte) {
        const alvo = ids.find(id => /^(chart|rank|table)-/.test(id)) || '';
        const pref = FONTE_POR_PREFIXO.find(([p]) => alvo.split('-')[1] === p);
        fonte = pref && pref[1];
      }
      if (!fonte) return;
      const div = document.createElement('div');
      div.className = 'exhibit-fonte';
      div.textContent = `Fonte: ${fonte}. Elaboração: DECAP/FIESP.`;
      cap.appendChild(div);
    });
  }

  // Tabela "Pontos de destaque" do diagnóstico setorial (PIA-Empresa por
  // classe): variação entre o primeiro e o último ano, por recorte.
  let indicadoresAnoFinal = null;  // escolha do usuário (2023 ou último ano)
  function renderIndicadoresDesempenho(ind) {
    const bloco = $('#bloco-indicadores-desempenho');
    if (!ind || !ind.tabelas || !ind.tabelas.length) { bloco.style.display = 'none'; return; }
    bloco.style.display = '';
    const tabs = ind.tabelas;
    const tab = tabs.find(t => t.ano_final === indicadoresAnoFinal) || tabs[tabs.length - 1];
    const a0 = ind.ano_inicial, a1 = tab.ano_final;
    $('#indicadores-desempenho-title').textContent = `Indicadores de desempenho: variação ${a0}/${a1}`;
    $('#indicadores-desempenho-sub').textContent = `Valores em R$ constantes de ${ind.ano_base_precos}. `
      + (tab.nova_serie
        ? `${a1} é da nova série da PIA (IBGE), que tem quebra metodológica em relação aos anos anteriores.`
        : `Mesmo período do diagnóstico setorial.`);
    const seletor = tabs.length > 1
      ? `<div class="exec-seg-toggle indicadores-toggle">` + tabs.map(t =>
          `<button type="button" data-ano="${t.ano_final}" class="exec-seg-btn${t === tab ? ' active' : ''}">${a0}/${t.ano_final}${t.nova_serie ? ' (nova série)' : ''}</button>`).join('') + `</div>`
      : '';
    const fmtVal = (v, tipo) => {
      if (v == null || isNaN(v)) return '-';
      const n = (tipo !== 'nivel' && v > 0 ? '+' : '')
        + v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
      return n + (tipo === 'pp' ? ' p.p.' : '%');
    };
    const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const destaque = c => c.codigo === state.sector ? ' class="col-destaque"' : '';
    const cab = ind.colunas.map(c => `<th style="text-align:right"${destaque(c)}>${esc(c.rotulo)}</th>`).join('');
    const corpo = tab.linhas.map(l => `<tr><td>${esc(l.indicador)}</td>`
      + ind.colunas.map(c => `<td style="text-align:right"${destaque(c)}>${fmtVal(l.valores[c.codigo], l.tipo)}</td>`).join('')
      + '</tr>').join('');
    $('#table-indicadores-desempenho').innerHTML = seletor +
      `<div class="data-table-wrap"><table class="data-table tabela-indicadores"><thead><tr><th>Variável</th>${cab}</tr></thead><tbody>${corpo}</tbody></table></div>`;
    $('#table-indicadores-desempenho').querySelectorAll('.indicadores-toggle button').forEach(b =>
      b.addEventListener('click', () => { indicadoresAnoFinal = +b.dataset.ano; renderIndicadoresDesempenho(ind); }));
  }

  // ---------------------------------------------------------------------
  // Abas de seção + leitura executiva + cartões com minigráfico
  // ---------------------------------------------------------------------
  function mostrarSecao(id) {
    const metas = secoesVisiveis();
    if (!metas.some(m => m.target === id)) id = metas[0].target;
    state.secao = id;
    document.querySelectorAll('#data-view > section.section').forEach(sec => {
      const visivel = metas.some(m => m.target === sec.id);
      sec.hidden = !visivel || sec.id !== id;
    });
    document.querySelectorAll('#section-nav button').forEach(b => {
      const on = b.dataset.target === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  const pctL = (v, casas = 1, sinal = false) => v == null || !isFinite(v) ? '-' :
    (sinal && v > 0 ? '+' : '') + v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas }) + '%';
  const numL = v => v == null || !isFinite(v) ? '-' : Math.round(v).toLocaleString('pt-BR');
  const cagrL = (a, b, n) => a > 0 && b > 0 && n > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : null;
  const anoAtual = new Date().getFullYear();
  // Verbo conforme o sinal: "cresceu 5,6%" / "caiu 4,6%" / "ficou praticamente estável"
  const variou = (v, casas = 1, sufixo = '', verbos = ['cresceu', 'caiu']) => v == null || !isFinite(v) ? 'variou' :
    Math.abs(v) < 0.05 ? 'ficou praticamente estável' : `${v > 0 ? verbos[0] : verbos[1]} ${pctL(Math.abs(v), casas)}${sufixo}`;

  function sparkL(vals, cor = 'var(--accent)') {
    const v = vals.filter(x => x != null && isFinite(x));
    if (v.length < 2) return '';
    const w = 120, h = 32, min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
    const pts = vals.map((x, i) => x == null || !isFinite(x) ? null : [i / (vals.length - 1) * w, h - 3 - (x - min) / rng * (h - 6)]).filter(Boolean);
    const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const u = pts[pts.length - 1];
    return `<svg class="card-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}" fill="none" stroke="${cor}" stroke-width="1.8" stroke-linejoin="round"/><circle cx="${u[0]}" cy="${u[1]}" r="2.6" fill="${cor}"/></svg>`;
  }

  function cardL({ rotulo, valor, sub, serie, delta, deltaRuim }) {
    const cls = delta == null || !isFinite(delta) ? '' : ((delta >= 0) !== !!deltaRuim ? 'bom' : 'ruim');
    return `<div class="sec-card">
      <div class="sec-card-rot">${rotulo}</div>
      <div class="sec-card-linha"><span class="sec-card-val">${valor}</span>${sparkL(serie || [])}</div>
      <div class="sec-card-sub">${cls ? `<span class="sec-delta ${cls}">${pctL(delta, 1, true)}</span> ` : ''}${sub || ''}</div>
    </div>`;
  }

  // Garante a caixa de leitura + cartões logo abaixo do cabeçalho da seção.
  function caixaSecao(secId) {
    const sec = document.getElementById(secId);
    if (!sec) return null;
    let box = sec.querySelector(':scope > .leitura-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'leitura-box';
      box.innerHTML = '<div class="leitura-exec"></div><div class="sec-cards"></div>';
      const cab = sec.querySelector(':scope > .section-header');
      cab ? cab.insertAdjacentElement('afterend', box) : sec.prepend(box);
    }
    return box;
  }

  function preencherSecao(secId, titulo, itens, cards) {
    const box = caixaSecao(secId);
    if (!box) return;
    const lis = (itens || []).filter(Boolean);
    box.querySelector('.leitura-exec').innerHTML = lis.length
      ? `<div class="leitura-cab"><span class="leitura-tag">Leitura executiva</span>${titulo}</div><ul>${lis.map(t => `<li>${t}</li>`).join('')}</ul>` : '';
    box.querySelector('.leitura-exec').style.display = lis.length ? '' : 'none';
    const cs = (cards || []).filter(Boolean);
    box.querySelector('.sec-cards').innerHTML = cs.join('');
    box.querySelector('.sec-cards').style.display = cs.length ? '' : 'none';
  }

  function renderLeituras() {
    const s = csS();
    const nome = rotuloCnae(state.sector);
    const sh = shared();
    const ab = anoBasePrecos();

    // Produção (índice da divisão, mensal)
    const pi = sh.producao.indice || [];
    if (pi.length > 13) {
      const porAno = {};
      pi.forEach(r => { (porAno[r.ano] = porAno[r.ano] || []).push(r.indice_bruto); });
      const anosC = Object.keys(porAno).map(Number).filter(a => porAno[a].length === 12).sort((a, b) => a - b);
      const media = a => porAno[a].reduce((x, y) => x + y, 0) / 12;
      const u = pi[pi.length - 1], ua = pi.find(r => r.ano === u.ano - 1 && r.mes === u.mes);
      const acum = m => pi.filter(r => r.ano === m && r.mes <= u.mes).reduce((x, r) => x + r.indice_bruto, 0);
      const ytd = acum(u.ano - 1) ? (acum(u.ano) / acum(u.ano - 1) - 1) * 100 : null;
      const a1 = anosC[anosC.length - 1], a0 = anosC[anosC.length - 2];
      const pico = anosC.reduce((b, a) => media(a) > media(b) ? a : b, anosC[0]);
      preencherSecao('block-producao', `${setorCfg().producao_titulo}`, [
        ytd != null ? `No acumulado de ${u.ano} até ${MESES[u.mes - 1]}, a produção está ${Math.abs(ytd) < 0.05 ? 'praticamente igual ao' : pctL(Math.abs(ytd), 1) + (ytd > 0 ? ' acima do' : ' abaixo do')} mesmo período de ${u.ano - 1}.` : null,
        a0 ? `Em ${a1}, a produção média ${variou((media(a1) / media(a0) - 1) * 100)} em relação a ${a0}.` : null,
        pico !== a1 ? `O maior nível anual da série recente foi em ${pico}; em ${a1}, a produção estava ${pctL(Math.abs((media(a1) / media(pico) - 1) * 100), 1)} abaixo desse pico.` : `${a1} é o maior nível anual da série recente.`,
        'O índice do IBGE cobre a divisão borracha e plástico inteira: é o mesmo para os dois segmentos.',
      ], [
        cardL({ rotulo: `Índice · ${MESES[u.mes - 1]}/${u.ano}`, valor: fmt.full1(u.indice_bruto), serie: anosC.map(media), delta: ua ? (u.indice_bruto / ua.indice_bruto - 1) * 100 : null, sub: `vs ${MESES[u.mes - 1]}/${u.ano - 1}` }),
        cardL({ rotulo: `Acumulado ${u.ano}`, valor: pctL(ytd, 1, true), serie: [], sub: `vs mesmo período de ${u.ano - 1}` }),
        cardL({ rotulo: `Média de ${a1}`, valor: fmt.full1(media(a1)), serie: anosC.map(media), delta: a0 ? (media(a1) / media(a0) - 1) * 100 : null, sub: `vs ${a0}` }),
      ]);
    }

    // Financeiro / indicadores
    const ind = sh.financeiro.indicadores;
    if (ind && ind.tabelas) {
      const tab = ind.tabelas[ind.tabelas.length - 1];
      const val = (nomeL, cod) => { const l = tab.linhas.find(x => x.indicador.startsWith(nomeL)); return l ? l.valores[cod] : null; };
      const out = ind.outros;
      const oval = (chave, cod) => { const l = out && out.linhas.find(x => x.indicador.startsWith(chave)); return l ? l.valores[cod] : null; };
      const cod = state.sector, it = 'ind_transformacao';
      preencherSecao('block-financeiro', `${nome} · ${ind.ano_inicial}–${tab.ano_final}`, [
        `A margem bruta de ${tab.ano_final} foi de <strong>${pctL(val('Margem bruta (', cod))}</strong>, contra ${pctL(val('Margem bruta (', it))} na indústria de transformação.`,
        `Desde ${ind.ano_inicial}, o lucro bruto variou ${pctL(val('Lucro bruto', cod), 1, true)} em termos reais (indústria de transformação: ${pctL(val('Lucro bruto', it), 1, true)}).`,
        oval('Produtividade: valor', cod) != null ? `A produtividade (valor adicionado por pessoa) é de R$ ${numL(oval('Produtividade: valor', cod))} mil, ${pctL((oval('Produtividade: valor', cod) / oval('Produtividade: valor', it) - 1) * 100, 0)} em relação à média da indústria.` : null,
        oval('Gastos de pessoal', cod) != null ? `Os gastos de pessoal consomem ${pctL(oval('Gastos de pessoal', cod), 0)} do valor adicionado (indústria: ${pctL(oval('Gastos de pessoal', it), 0)}): setor intensivo em mão de obra.` : null,
      ]);
    }

    // Emprego (RAIS)
    const r = s.rais, tot = r.uf_yearly_total;
    if (tot && tot.length > 1) {
      const u = tot[tot.length - 1], a = tot[tot.length - 2], p = tot[0];
      const ufU = r.uf_yearly.filter(x => x.ano === u.ano && x.vinculos > 0).sort((x, y) => y.vinculos - x.vinculos);
      const totV = ufU.reduce((x, y) => x + y.vinculos, 0);
      const massa = r.massa_nacional_yearly || [];
      const dez = ano => { const m = sh.macro.find(x => x.ano === ano && x.mes === 12); return m ? m.ipca : null; };
      const real = massa.map(m => m.remuneracao_media_nominal && dez(m.ano) && dez(ab) ? m.remuneracao_media_nominal * dez(ab) / dez(m.ano) : null);
      const rU = real[real.length - 1], rI = real.find(v => v != null);
      const tam = u.estabelecimentos ? u.vinculos / u.estabelecimentos : null, tamI = p.estabelecimentos ? p.vinculos / p.estabelecimentos : null;
      const ce = s.cempre && s.cempre.brasil;
      const ceU = ce && ce[ce.length - 1], ceA = ce && ce[ce.length - 2];
      const ceInd = s.cempre && s.cempre.ind_transformacao_brasil.find(x => ceU && x.ano === ceU.ano);
      preencherSecao('block-emprego', `${nome} · ${p.ano}–${u.ano}`, [
        ceU && ceU.empresas ? `Segundo o CEMPRE/IBGE, o segmento tinha <strong>${numL(ceU.empresas)} empresas ativas</strong> em ${ceU.ano}, com ${numL(ceU.pessoal_ocupado)} pessoas ocupadas.` : null,
        ceU && ceInd && ceU.salario_medio_mensal && ceInd.salario_medio_mensal ? `O salário médio do segmento é ${pctL(Math.abs(1 - ceU.salario_medio_mensal / ceInd.salario_medio_mensal) * 100, 0)} ${ceU.salario_medio_mensal < ceInd.salario_medio_mensal ? 'menor' : 'maior'} que o da indústria de transformação.` : null,
        `O segmento tinha <strong>${numL(u.vinculos)}</strong> vínculos formais em ${u.ano}, ${pctL((u.vinculos / p.vinculos - 1) * 100, 1, true)} desde ${p.ano}.`,
        ufU[0] ? `<strong>${ufU[0].nome_uf}</strong> concentra ${pctL(ufU[0].vinculos / totV * 100)} do emprego; os três maiores estados somam ${pctL(ufU.slice(0, 3).reduce((x, y) => x + y.vinculos, 0) / totV * 100)}.` : null,
        tam && tamI ? `O estabelecimento médio tem ${fmt.full1(tam)} empregados (eram ${fmt.full1(tamI)} em ${p.ano}).` : null,
        rU && rI ? `A remuneração média real ${rU >= rI ? 'subiu' : 'caiu'} ${pctL(Math.abs((rU / rI - 1) * 100))} desde ${massa[0].ano}, para R$ ${numL(rU)} por mês (R$ de ${ab}).` : null,
      ], [
        ceU && ceU.empresas ? cardL({ rotulo: `Empresas ativas · ${ceU.ano}`, valor: numL(ceU.empresas), serie: ce.map(x => x.empresas), delta: ceA && ceA.empresas ? (ceU.empresas / ceA.empresas - 1) * 100 : null, sub: `vs ${ceA ? ceA.ano : ''} · CEMPRE` }) : null,
        cardL({ rotulo: `Vínculos formais · ${u.ano}`, valor: numL(u.vinculos), serie: tot.map(x => x.vinculos), delta: (u.vinculos / a.vinculos - 1) * 100, sub: `vs ${a.ano}` }),
        cardL({ rotulo: `Estabelecimentos · ${u.ano}`, valor: numL(u.estabelecimentos), serie: tot.map(x => x.estabelecimentos), delta: (u.estabelecimentos / a.estabelecimentos - 1) * 100, sub: `vs ${a.ano}` }),
        cardL({ rotulo: 'Empregados por estabelecimento', valor: tam ? fmt.full1(tam) : '-', serie: tot.map(x => x.estabelecimentos ? x.vinculos / x.estabelecimentos : null), sub: `${u.ano}` }),
        rU ? cardL({ rotulo: `Remuneração média real · ${massa[massa.length - 1].ano}`, valor: 'R$ ' + numL(rU), serie: real, delta: real.length > 1 && real[real.length - 2] ? (rU / real[real.length - 2] - 1) * 100 : null, sub: `vs ano anterior · R$ de ${ab}` }) : null,
      ]);
    }

    // CAGED
    const cg = s.caged && s.caged.saldo_monthly_national;
    if (cg && cg.length > 12) {
      const u = cg[cg.length - 1];
      const ano = cg.filter(x => x.ano === u.ano), anoAnt = cg.filter(x => x.ano === u.ano - 1 && x.mes <= u.mes);
      const soma = arr => arr.reduce((x, y) => x + (y.saldo || 0), 0);
      const u12 = cg.slice(-12);
      preencherSecao('block-caged', `${nome} · até ${MESES[u.mes - 1]}/${u.ano}`, [
        `De janeiro a ${MESES[u.mes - 1]} de ${u.ano}, o saldo de empregos formais foi de <strong>${soma(ano) >= 0 ? '+' : ''}${numL(soma(ano))}</strong> (mesmo período de ${u.ano - 1}: ${soma(anoAnt) >= 0 ? '+' : ''}${numL(soma(anoAnt))}).`,
        `Nos últimos 12 meses, o saldo acumulado é de ${soma(u12) >= 0 ? '+' : ''}${numL(soma(u12))} vagas.`,
      ], [
        cardL({ rotulo: `Saldo em ${MESES[u.mes - 1]}/${u.ano}`, valor: (u.saldo >= 0 ? '+' : '') + numL(u.saldo), serie: cg.slice(-24).map(x => x.saldo), sub: 'admissões − desligamentos' }),
        cardL({ rotulo: `Saldo no ano · ${u.ano}`, valor: (soma(ano) >= 0 ? '+' : '') + numL(soma(ano)), serie: [], sub: `até ${MESES[u.mes - 1]}` }),
        cardL({ rotulo: 'Saldo em 12 meses', valor: (soma(u12) >= 0 ? '+' : '') + numL(soma(u12)), serie: [], sub: `até ${MESES[u.mes - 1]}/${u.ano}` }),
      ]);
    }

    // Comércio exterior
    const c = s.comex;
    const anos = (c.yearly || []).filter(x => x.ano < anoAtual);
    if (anos.length > 2) {
      const u = anos[anos.length - 1], a = anos[anos.length - 2], p = anos[0];
      const chi = c.importacao_china_resto_yearly || [];
      const share = y => { const x = chi.find(z => z.ano === y); return x && (x.china_usd + x.resto_usd) ? x.china_usd / (x.china_usd + x.resto_usd) * 100 : null; };
      const cP = chi.find(x => x.ano === p.ano), cU = chi.find(x => x.ano === u.ano);
      const top = (c.top_paises_latest.importacao || [])[0];
      const linTop = c.yearly.find(x => x.ano === c.top_paises_latest.ano) || {};
      const rk = (s.comtrade && s.comtrade.ranking_exportadores) || {};
      const anoRk = Object.keys(rk).map(Number).sort((x, y) => y - x)[0];
      const bra = anoRk ? (rk[anoRk].itens || []).find(x => x.iso2 === 'br') : null;
      preencherSecao('block-comex', `${nome} · ${p.ano}–${u.ano}`, [
        `Em ${u.ano}, o segmento importou <strong>${fmt.usd(u.importacao_usd)}</strong> e exportou ${fmt.usd(u.exportacao_usd)}: ${u.importacao_usd > u.exportacao_usd ? 'déficit' : 'superávit'} de ${fmt.usd(Math.abs(u.importacao_usd - u.exportacao_usd))}.`,
        `Desde ${p.ano}, a importação ${variou(cagrL(p.importacao_usd, u.importacao_usd, u.ano - p.ano), 1, ' ao ano')}, e a exportação ${variou(cagrL(p.exportacao_usd, u.exportacao_usd, u.ano - p.ano), 1, ' ao ano')}.`,
        cP && cU && cP.china_usd > 0 ? `A China passou de ${pctL(share(p.ano))} para <strong>${pctL(share(u.ano))}</strong> das importações (crescimento de ${pctL(cagrL(cP.china_usd, cU.china_usd, u.ano - p.ano), 1, true)} ao ano), o principal vetor de concorrência apontado no diagnóstico setorial.` : null,
        top && linTop.importacao_usd && !(top.pais === 'China' && cP && cP.china_usd > 0) ? `${top.pais} é a principal origem, com ${pctL(top.valor_usd / linTop.importacao_usd * 100)} do total importado em ${c.top_paises_latest.ano}.` : null,
        bra ? `No comércio mundial, o Brasil foi o <strong>${bra.pos}º exportador</strong> desses produtos em ${anoRk}, com ${pctL(bra.pct_mundo, 2)} do total.` : null,
        (() => { const gm = (s.comtrade || {}).grupos_mundo; const mx = gm && gm.itens.filter(x => x.brasil_pos).sort((a, b) => b.brasil_pct - a.brasil_pct)[0]; return mx ? `O grupo em que o Brasil tem mais presença no mercado mundial é "${mx.grupo.toLowerCase()}" (${pctL(mx.brasil_pct, 2)}, ${mx.brasil_pos}º lugar em ${gm.ano}).` : null; })(),
      ], [
        cardL({ rotulo: `Importação · ${u.ano}`, valor: fmt.usd(u.importacao_usd), serie: anos.map(x => x.importacao_usd), delta: (u.importacao_usd / a.importacao_usd - 1) * 100, deltaRuim: true, sub: `vs ${a.ano}` }),
        cardL({ rotulo: `Exportação · ${u.ano}`, valor: fmt.usd(u.exportacao_usd), serie: anos.map(x => x.exportacao_usd), delta: (u.exportacao_usd / a.exportacao_usd - 1) * 100, sub: `vs ${a.ano}` }),
        cardL({ rotulo: `Saldo · ${u.ano}`, valor: fmt.usd(u.exportacao_usd - u.importacao_usd), serie: anos.map(x => x.exportacao_usd - x.importacao_usd), sub: 'US$ FOB' }),
        share(u.ano) != null && share(u.ano) > 0 ? cardL({ rotulo: `China nas importações · ${u.ano}`, valor: pctL(share(u.ano)), serie: anos.map(x => share(x.ano)), sub: `${pctL(share(p.ano))} em ${p.ano}` }) : null,
      ]);
    }

    // Mercado doméstico
    const m = s.mercado && s.mercado.yearly;
    if (m && m.length > 1) {
      const u = m[m.length - 1], p = m[0];
      preencherSecao('block-mercado', `${nome} · ${p.ano}–${u.ano}`, [
        `O mercado brasileiro desses produtos (consumo aparente) foi de <strong>${fmt.brl(u.consumo_aparente_real)}</strong> em ${u.ano}; em termos reais, ${variou((u.consumo_aparente_real / p.consumo_aparente_real - 1) * 100)} desde ${p.ano}.`,
        `Os importados atendem <strong>${pctL(u.penetracao_importacao)}</strong> desse mercado (eram ${pctL(p.penetracao_importacao)} em ${p.ano}); ${pctL(u.coef_exportacao)} da produção nacional é exportada.`,
        (() => {
          const gC = cagrL(p.consumo_aparente_real, u.consumo_aparente_real, u.ano - p.ano), gP = cagrL(p.producao_real, u.producao_real, u.ano - p.ano);
          const base = `O consumo ${variou(gC, 1, ' ao ano')}, e a produção nacional ${variou(gP, 1, ' ao ano')}`;
          if (gC > 0 && u.penetracao_importacao > p.penetracao_importacao + 1) return base + ': o crescimento da demanda foi atendido sobretudo por importados.';
          if (gC < 0 && u.penetracao_importacao < p.penetracao_importacao - 1) return base + ': o mercado encolheu, mas a produção nacional ganhou espaço sobre o importado.';
          if (gC < 0) return base + ': o mercado encolheu no período.';
          return base + '.';
        })(),
        (cnaeCfg(state.sector).componentes || [state.sector]).includes('2219') ? 'Pelo diagnóstico setorial, os grupos de produto de artefatos em "oportunidade perdida" (consumo cresce, mas a importação ganha espaço) somam 47% do consumo aparente.' : null,
      ], [
        cardL({ rotulo: `Consumo aparente · ${u.ano}`, valor: fmt.brl(u.consumo_aparente_real), serie: m.map(x => x.consumo_aparente_real), sub: `R$ de ${ab}` }),
        cardL({ rotulo: `Penetração da importação · ${u.ano}`, valor: pctL(u.penetracao_importacao), serie: m.map(x => x.penetracao_importacao), sub: `${pctL(p.penetracao_importacao)} em ${p.ano}` }),
        cardL({ rotulo: `Coeficiente de exportação · ${u.ano}`, valor: pctL(u.coef_exportacao), serie: m.map(x => x.coef_exportacao), sub: `${pctL(p.coef_exportacao)} em ${p.ano}` }),
      ]);
    }

    // BNDES
    const bn = (s.bndes && s.bndes.yearly || []).filter(x => x.ano < anoAtual);
    if (bn.length > 2) {
      const u = bn[bn.length - 1];
      const ult5 = bn.slice(-5), media5 = ult5.reduce((x, y) => x + (y.valor_desembolsado || 0), 0) / ult5.length;
      const ufs = (s.bndes.uf_total || []).slice().sort((x, y) => (y.valor_desembolsado || 0) - (x.valor_desembolsado || 0));
      const totUf = ufs.reduce((x, y) => x + (y.valor_desembolsado || 0), 0);
      preencherSecao('block-bndes', `${nome}`, [
        `O BNDES desembolsou <strong>${fmt.brl(u.valor_desembolsado)}</strong> para o segmento em ${u.ano}; a média dos últimos cinco anos é de ${fmt.brl(media5)} por ano (R$ correntes).`,
        ufs[0] && totUf ? `${ufs[0].nome_uf || ufs[0].uf} recebeu ${pctL(ufs[0].valor_desembolsado / totUf * 100)} dos desembolsos da série.` : null,
      ], [
        cardL({ rotulo: `Desembolso · ${u.ano}`, valor: fmt.brl(u.valor_desembolsado), serie: bn.map(x => x.valor_desembolsado), delta: bn.length > 1 && bn[bn.length - 2].valor_desembolsado ? (u.valor_desembolsado / bn[bn.length - 2].valor_desembolsado - 1) * 100 : null, sub: 'vs ano anterior' }),
        cardL({ rotulo: 'Média dos últimos 5 anos', valor: fmt.brl(media5), serie: [], sub: 'R$ correntes por ano' }),
      ]);
    }
  }

  // Tabela extra do Financeiro: outros indicadores da DRE (último ano)
  function renderOutrosIndicadores(ind) {
    const alvo = $('#table-indicadores-outros');
    if (!alvo) return;
    const o = ind && ind.outros;
    if (!o) { alvo.closest('.exhibit-block').style.display = 'none'; return; }
    $('#indicadores-outros-title').textContent = `Outros indicadores de desempenho, ${o.ano}`;
    const f = (v, t) => v == null || !isFinite(v) ? '-' : t === 'pct' ? pctL(v) : t === 'rs' ? 'R$ ' + numL(v) : 'R$ ' + numL(v) + ' mil';
    const esc = t => String(t).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const dest = cc => cc.codigo === state.sector ? ' class="col-destaque"' : '';
    alvo.innerHTML = `<div class="data-table-wrap"><table class="data-table tabela-indicadores"><thead><tr><th>Indicador</th>${ind.colunas.map(cc => `<th style="text-align:right"${dest(cc)}>${esc(cc.rotulo)}</th>`).join('')}</tr></thead><tbody>`
      + o.linhas.map(l => `<tr><td>${esc(l.indicador)}</td>${ind.colunas.map(cc => `<td style="text-align:right"${dest(cc)}>${f(l.valores[cc.codigo], l.tipo)}</td>`).join('')}</tr>`).join('')
      + '</tbody></table></div>';
  }

  // Tema claro/escuro (preferência só neste navegador)
  function setupTema() {
    const raiz = document.documentElement;
    try { const t = localStorage.getItem('painel-tema'); if (t) raiz.dataset.theme = t; } catch (e) { /* sem storage */ }
    const btn = $('#tema-btn');
    if (btn) btn.addEventListener('click', () => {
      raiz.dataset.theme = raiz.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('painel-tema', raiz.dataset.theme); } catch (e) { /* sem storage */ }
    });
  }

  // ---------------------------------------------------------------------
  // Empresas ativas (CEMPRE/IBGE): mapa por UF, série e salário médio real
  // comparado com a indústria de transformação. Clique no estado filtra.
  // ---------------------------------------------------------------------
  const UF_GRADE = {
    RR: [2, 0], AP: [4, 0],
    AM: [1, 1], PA: [3, 1], MA: [4, 1], CE: [5, 1], RN: [6, 1],
    AC: [0, 2], RO: [1, 2], MT: [2, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
    GO: [3, 3], DF: [4, 3], BA: [5, 3], AL: [6, 3],
    MS: [2, 4], SP: [3, 4], MG: [4, 4], ES: [5, 4], SE: [6, 4],
    PR: [3, 5], RJ: [4, 5],
    SC: [3, 6],
    RS: [3, 7],
  };
  const NOME_UF = { RO: 'Rondônia', AC: 'Acre', AM: 'Amazonas', RR: 'Roraima', PA: 'Pará', AP: 'Amapá', TO: 'Tocantins', MA: 'Maranhão', PI: 'Piauí', CE: 'Ceará', RN: 'Rio Grande do Norte', PB: 'Paraíba', PE: 'Pernambuco', AL: 'Alagoas', SE: 'Sergipe', BA: 'Bahia', MG: 'Minas Gerais', ES: 'Espírito Santo', RJ: 'Rio de Janeiro', SP: 'São Paulo', PR: 'Paraná', SC: 'Santa Catarina', RS: 'Rio Grande do Sul', MS: 'Mato Grosso do Sul', MT: 'Mato Grosso', GO: 'Goiás', DF: 'Distrito Federal' };
  const cempreSt = { uf: null };

  function renderCempre() {
    const bloco = $('#bloco-cempre');
    const c = csS().cempre;
    if (!bloco) return;
    if (!c || !c.brasil || !c.brasil.length) { bloco.style.display = 'none'; return; }
    bloco.style.display = '';
    const ab = anoBasePrecos();
    const dez = ano => { const m = shared().macro.find(x => x.ano === ano && x.mes === 12); return m ? m.ipca : null; };
    const real = r => r && r.salario_medio_mensal && dez(r.ano) && dez(ab) ? r.salario_medio_mensal * dez(ab) / dez(r.ano) : null;
    const ufs = c.uf_ultimo_ano;
    const ano = c.brasil[c.brasil.length - 1].ano;
    const totEmp = c.brasil[c.brasil.length - 1].empresas;
    const lider = ufs.filter(x => x.empresas).sort((a, b) => b.empresas - a.empresas)[0];
    if (cempreSt.uf && !ufs.some(x => x.sigla === cempreSt.uf)) cempreSt.uf = null;

    // mapa
    const porUf = new Map(ufs.map(x => [x.sigla, x]));
    const max = Math.max(...ufs.map(x => x.empresas || 0), 1);
    $('#cempre-mapa-titulo').textContent = lider ? `${NOME_UF[lider.sigla]} concentra ${pctL(lider.empresas / totEmp * 100, 0)} das empresas` : 'Empresas ativas por estado';
    $('#cempre-mapa').innerHTML = Object.entries(UF_GRADE).map(([uf, [col, lin]]) => {
      const x = porUf.get(uf), v = x ? x.empresas : null;
      const t = v ? Math.pow(v / max, 0.45) : 0;
      const txt = v == null ? (x ? 'sigilo' : '–') : fmt.compact(v);
      return `<button type="button" class="uf-tile${cempreSt.uf === uf ? ' sel' : ''}${t > 0.55 ? ' claro' : ''}" style="grid-column:${col + 1};grid-row:${lin + 1};--t:${t.toFixed(3)}" data-uf="${uf}" title="${NOME_UF[uf]}: ${v == null ? 'sem dado publicado' : numL(v) + ' empresas'}"><span class="uf-sig">${uf}</span><span class="uf-val">${txt}</span></button>`;
    }).join('');
    $('#cempre-mapa-leg').innerHTML = `<span>menos</span><i></i><span>mais empresas (${ano})</span>` + (cempreSt.uf ? '<button type="button" data-uf="">Ver Brasil</button>' : '');

    // série (Brasil ou UF escolhida)
    const serie = cempreSt.uf ? c.uf_yearly.filter(x => x.sigla === cempreSt.uf) : c.brasil;
    const nome = cempreSt.uf ? NOME_UF[cempreSt.uf] : 'Brasil';
    const s0 = serie.find(x => x.empresas != null), s1 = serie[serie.length - 1];
    $('#cempre-serie-titulo').textContent = s0 && s1 && s1.empresas != null
      ? `${nome}: ${s1.empresas >= s0.empresas ? 'mais' : 'menos'} empresas que em ${s0.ano} (${pctL((s1.empresas / s0.empresas - 1) * 100, 0, true)})` : nome;
    barChart($('#cempre-serie'), {
      categories: serie.map(x => x.ano), formatY: fmt.full, height: 250,
      series: [{ label: 'Empresas ativas', color: 'var(--accent)', values: serie.map(x => x.empresas) }],
    });

    // salário médio real: setor x indústria de transformação (Brasil ou UF)
    const ind = cempreSt.uf
      ? null
      : c.ind_transformacao_brasil;
    const sR = serie.map(real);
    const iR = ind ? serie.map(r => real(ind.find(x => x.ano === r.ano))) : null;
    const indUf = cempreSt.uf ? c.ind_transformacao_uf_ultimo_ano.find(x => x.sigla === cempreSt.uf) : null;
    const sU = sR[sR.length - 1], iU = iR ? iR[iR.length - 1] : real(indUf);
    $('#cempre-sal-titulo').textContent = sU && iU
      ? `Salário do setor ${sU < iU ? pctL((1 - sU / iU) * 100, 0) + ' abaixo' : pctL((sU / iU - 1) * 100, 0) + ' acima'} da indústria de transformação`
      : 'Salário médio mensal real';
    $('#cempre-sal-sub').textContent = `${nome}, salário médio mensal dos assalariados (13 salários por ano), R$ de ${ab}` + (cempreSt.uf ? `. Indústria de transformação no estado em ${ano}: ${iU ? 'R$ ' + numL(iU) : 'sem dado'}` : '');
    lineChart($('#cempre-sal'), {
      categories: serie.map(x => x.ano), formatY: fmt.brl, height: 250,
      series: [
        { label: rotuloCnae(state.sector), color: 'var(--accent)', values: sR },
        iR ? { label: 'Indústria de transformação', color: 'var(--series-2)', values: iR } : null,
      ].filter(Boolean),
    });
  }

  function setupCempre() {
    const alvo = $('#bloco-cempre');
    if (!alvo) return;
    alvo.addEventListener('click', e => {
      const b = e.target.closest('button[data-uf]');
      if (!b) return;
      cempreSt.uf = b.dataset.uf && cempreSt.uf !== b.dataset.uf ? b.dataset.uf : null;
      renderCempre();
      if (cempreSt.uf && COD_POR_SIGLA[cempreSt.uf] && munDados() && munDados().itens.some(x => x.uf === COD_POR_SIGLA[cempreSt.uf])) {
        munSt.uf = COD_POR_SIGLA[cempreSt.uf];
        renderMunicipios();
      }
    });
  }

  // ---------------------------------------------------------------------
  // Emprego por município (RAIS, microdados do PDET): mapa do estado
  // escolhido, colorido pelos vínculos do setor, e ranking com a comparação
  // com a indústria de transformação no mesmo município.
  // ---------------------------------------------------------------------
  const munSt = { uf: null, geo: {}, carregando: null, met: 'vinc' };
  const SIGLA_POR_COD = { '11': 'RO', '12': 'AC', '13': 'AM', '14': 'RR', '15': 'PA', '16': 'AP', '17': 'TO', '21': 'MA', '22': 'PI', '23': 'CE', '24': 'RN', '25': 'PB', '26': 'PE', '27': 'AL', '28': 'SE', '29': 'BA', '31': 'MG', '32': 'ES', '33': 'RJ', '35': 'SP', '41': 'PR', '42': 'SC', '43': 'RS', '50': 'MS', '51': 'MT', '52': 'GO', '53': 'DF' };
  const COD_POR_SIGLA = Object.fromEntries(Object.entries(SIGLA_POR_COD).map(([c, s]) => [s, c]));

  function munDados() { return csS().municipios; }

  function renderMunicipios() {
    const bloco = $('#bloco-municipios');
    const m = munDados();
    if (!bloco) return;
    if (!m || !m.itens.length) { bloco.style.display = 'none'; return; }
    bloco.style.display = '';
    // UFs com presença do setor, ordenadas por vínculos
    const porUf = {};
    m.itens.forEach(x => { porUf[x.uf] = (porUf[x.uf] || 0) + x.vinc; });
    const ufs = Object.keys(porUf).sort((a, b) => porUf[b] - porUf[a]);
    if (!munSt.uf || !porUf[munSt.uf]) munSt.uf = ufs[0];
    const sel = $('#mun-uf');
    sel.innerHTML = ufs.map(c => `<option value="${c}">${NOME_UF[SIGLA_POR_COD[c]] || c} (${numL(porUf[c])} vínculos)</option>`).join('');
    sel.value = munSt.uf;
    desenharMapaMun();
    rankingMun();
  }

  function rankingMun() {
    const m = munDados();
    const itens = m.itens.filter(x => x.uf === munSt.uf);
    const nomeUf = NOME_UF[SIGLA_POR_COD[munSt.uf]] || munSt.uf;
    const tot = itens.reduce((a, b) => a + b.vinc, 0);
    const top = itens[0];
    const temCx = !!(m.comex && m.comex.itens.length);
    const cxUf = temCx ? m.comex.itens.filter(x => x.uf === munSt.uf) : [];
    const metAtiva = temCx ? munSt.met : 'vinc';
    $('#mun-metrica').style.display = temCx ? '' : 'none';
    if (metAtiva !== 'vinc') {
      const ord = cxUf.slice().sort((a, b) => b[metAtiva] - a[metAtiva]);
      const totM = ord.reduce((a, b) => a + b[metAtiva], 0);
      const nomeMet = metAtiva === 'exp' ? 'exportação' : 'importação';
      $('#mun-titulo').textContent = ord[0] && ord[0][metAtiva] ? `${ord[0].nome} lidera a ${nomeMet} do setor em ${nomeUf} (${pctL(ord[0][metAtiva] / totM * 100, 0)} do estado)` : nomeUf;
      $('#mun-sub').textContent = `${nomeMet.charAt(0).toUpperCase() + nomeMet.slice(1)} do setor por município da empresa, US$ FOB, ${m.comex.ano}. Grupos de produto do Sistema Harmonizado (4 dígitos), mais amplos que a cesta de NCM do painel.`;
      $('#mun-ranking').innerHTML = `<div class="data-table-wrap"><table class="data-table tabela-mun"><thead><tr><th>Município</th><th style="text-align:right">Exportação</th><th style="text-align:right">Importação</th><th style="text-align:right">% do estado</th><th style="text-align:right">Posição no Brasil (exportação)</th></tr></thead><tbody>`
        + ord.slice(0, 12).map(x => `<tr><td>${x.nome}</td><td style="text-align:right">${fmt.usd(x.exp)}</td><td style="text-align:right">${fmt.usd(x.imp)}</td><td style="text-align:right">${totM ? pctL(x[metAtiva] / totM * 100) : '-'}</td><td style="text-align:right">${x.pos_exp ? x.pos_exp + 'º' : '-'}</td></tr>`).join('') + '</tbody></table></div>';
      $('#mun-ranking-sub').textContent = `12 maiores municípios em ${nomeMet} do setor em ${nomeUf}, ${m.comex.ano}.`;
      return;
    }
    $('#mun-titulo').textContent = top ? `${top.nome} lidera o emprego do setor em ${nomeUf}` : nomeUf;
    $('#mun-sub').textContent = `Vínculos formais do setor por município, ${m.ano}. Passe o mouse para ver o detalhe; tons mais escuros = mais vínculos. ${itens.length} municípios com o setor no estado.`;
    const temRem = itens.some(x => x.remun != null);
    const tam = (e, v) => e ? v / e : null;
    const linhas = itens.slice(0, 12).map(x => {
      const ts = tam(x.estab, x.vinc), ti = tam(x.ind_estab, x.ind_vinc);
      const peso = x.ind_vinc ? x.vinc / x.ind_vinc * 100 : null;
      return `<tr><td>${x.nome}</td><td style="text-align:right">${numL(x.vinc)}</td><td style="text-align:right">${pctL(x.vinc / tot * 100)}</td>
        <td style="text-align:right">${numL(x.estab)}</td><td style="text-align:right">${ts ? fmt.full1(ts) : '-'} <span class="mun-cmp">ind. ${ti ? fmt.full1(ti) : '-'}</span></td>
        <td style="text-align:right">${peso != null ? pctL(peso) : '-'}</td>
        ${temRem ? `<td style="text-align:right">${x.remun ? 'R$ ' + numL(x.remun) : '-'} <span class="mun-cmp">ind. ${x.ind_remun ? 'R$ ' + numL(x.ind_remun) : '-'}</span></td>` : ''}</tr>`;
    }).join('');
    $('#mun-ranking').innerHTML = `<div class="data-table-wrap"><table class="data-table tabela-mun"><thead><tr><th>Município</th><th style="text-align:right">Vínculos</th><th style="text-align:right">% do estado</th><th style="text-align:right">Estabelec.</th><th style="text-align:right">Empregados por estabelec.</th><th style="text-align:right">Peso na indústria local</th>${temRem ? `<th style="text-align:right">Remuneração média (dez/${m.ano_remun})</th>` : ''}</tr></thead><tbody>${linhas}</tbody></table></div>`;
    $('#mun-ranking-sub').textContent = `12 maiores municípios do setor em ${nomeUf}. "ind." = média da indústria de transformação no mesmo município; "peso na indústria local" = vínculos do setor / vínculos da indústria de transformação do município.`;
  }

  async function carregarGeo(uf) {
    if (munSt.geo[uf]) return munSt.geo[uf];
    const r = await fetch(`assets/geo/mun-${uf}.json`);
    munSt.geo[uf] = await r.json();
    return munSt.geo[uf];
  }

  async function desenharMapaMun() {
    const alvo = $('#mun-mapa');
    const uf = munSt.uf;
    alvo.innerHTML = '<div class="empty-note">Carregando mapa…</div>';
    let geo;
    try { geo = await carregarGeo(uf); } catch (e) { alvo.innerHTML = '<div class="empty-note">Mapa indisponível.</div>'; return; }
    if (munSt.uf !== uf) return;  // trocou de estado durante o carregamento
    const m = munDados();
    const porId = new Map(m.itens.filter(x => x.uf === uf).map(x => [x.id, x]));
    const cxPorId = new Map(((m.comex && m.comex.itens) || []).filter(x => x.uf === uf).map(x => [x.id, x]));
    const met = (m.comex && m.comex.itens.length) ? munSt.met : 'vinc';
    const valor = id => met === 'vinc' ? ((porId.get(id) || {}).vinc || 0) : ((cxPorId.get(id) || {})[met] || 0);
    // projeção equiretangular com correção pela latitude média
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    geo.features.forEach(f => f.geometry.coordinates.forEach(p => p.forEach(r => r.forEach(([x, y]) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
    }))));
    const k = Math.cos((minY + maxY) / 2 * Math.PI / 180);
    const W = 600, larg = (maxX - minX) * k, alt = maxY - minY;
    const esc = W / larg, H = Math.max(200, alt * esc);
    const px = x => ((x - minX) * k * esc).toFixed(1), py = y => ((maxY - y) * esc).toFixed(1);
    const ids = met === 'vinc' ? [...porId.keys()] : [...cxPorId.keys()];
    const maxV = Math.max(...ids.map(valor), 1);
    const corMet = { vinc: 'var(--accent)', exp: 'var(--series-4)', imp: 'var(--series-6)' }[met];
    const paths = geo.features.map(f => {
      const d = f.geometry.coordinates.map(p => p.map(r => 'M' + r.map(([x, y]) => px(x) + ',' + py(y)).join('L') + 'Z').join('')).join('');
      const v = valor(f.properties.id);
      const t = v > 0 ? Math.max(0.12, Math.log1p(v) / Math.log1p(maxV)) : 0;
      return `<path d="${d}" data-id="${f.properties.id}" data-nome="${f.properties.nome.replace(/"/g, '&quot;')}" style="--t:${t.toFixed(3)};--cor:${corMet}" class="mun-path${v > 0 ? ' tem' : ''}"/>`;
    }).join('');
    alvo.innerHTML = `<svg viewBox="0 0 ${W} ${H.toFixed(0)}" class="mun-svg" role="img" aria-label="Mapa de municípios">${paths}</svg>`;
    const svg = alvo.querySelector('svg');
    svg.addEventListener('mousemove', e => {
      const p = e.target.closest('path');
      if (!p) { window.Charts.hideTooltip(); return; }
      const it = porId.get(p.dataset.id);
      const cxi = cxPorId.get(p.dataset.id);
      const rowsCx = cxi ? [{ label: `Exportação (${m.comex.ano})`, value: fmt.usd(cxi.exp) + (cxi.pos_exp ? ` · ${cxi.pos_exp}º no Brasil` : '') }, { label: `Importação (${m.comex.ano})`, value: fmt.usd(cxi.imp) }] : [];
      const rows = (it ? [
        { label: 'Vínculos do setor', value: numL(it.vinc) },
        { label: 'Estabelecimentos', value: numL(it.estab) },
        { label: 'Empregados por estabelecimento', value: it.estab ? fmt.full1(it.vinc / it.estab) + (it.ind_estab ? ` (ind. ${fmt.full1(it.ind_vinc / it.ind_estab)})` : '') : '-' },
        { label: 'Peso na indústria local', value: it.ind_vinc ? pctL(it.vinc / it.ind_vinc * 100) : '-' },
      ].concat(it.remun ? [{ label: 'Remuneração média', value: 'R$ ' + numL(it.remun) + (it.ind_remun ? ` (ind. R$ ${numL(it.ind_remun)})` : '') }] : [])
        : [{ label: 'Sem vínculos do setor', value: '' }]).concat(rowsCx);
      window.Charts.showTooltip(e.clientX, e.clientY, p.dataset.nome, rows);
    });
    svg.addEventListener('mouseleave', () => window.Charts.hideTooltip());
  }

  function setupMunicipios() {
    const sel = $('#mun-uf');
    if (!sel) return;
    $('#mun-metrica').addEventListener('click', e => {
      const b = e.target.closest('button[data-met]');
      if (!b) return;
      munSt.met = b.dataset.met;
      $('#mun-metrica').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      desenharMapaMun(); rankingMun();
    });
    sel.addEventListener('change', () => { munSt.uf = sel.value; desenharMapaMun(); rankingMun(); });
  }

  // ---------------------------------------------------------------------
  // Simulador de cenários: perguntas com alternativas fixas; cada
  // combinação leva a um resultado calculado com os dados do segmento.
  // Base: sectors[x].simulador (valores do ano-base, R$ de 2024, e ritmos
  // históricos), sectors[x].mercado, shared.simulador_impacto e cadeia.
  // ---------------------------------------------------------------------
  const CEN_HORIZONTE = 2030;
  const cen = { seg: null, aba: 'china', resp: { china: { imp: 'ritmo', prod: 'estagnada' }, cambio: { dolar: 'atual' }, demanda: { veic: 'estavel', fam: 'estavel' } } };

  const CEN_PERGUNTAS = {
    china: [
      { id: 'imp', texto: 'O que vai acontecer com as importações vindas da China até 2030?', opcoes: [
        { id: 'ritmo', rotulo: 'Continuam no ritmo atual', expl: 'a importação da China segue crescendo no ritmo médio dos últimos anos' },
        { id: 'desacelera', rotulo: 'Desaceleram', expl: 'a importação da China passa a crescer no mesmo ritmo das demais origens' },
        { id: 'caem', rotulo: 'Caem (defesa comercial, frete mais caro)', expl: 'a importação da China cai 5% ao ano' },
      ] },
      { id: 'prod', texto: 'E a produção nacional?', opcoes: [
        { id: 'estagnada', rotulo: 'Fica estagnada, como na última década', expl: 'a produção nacional segue o ritmo histórico, praticamente parada' },
        { id: 'acompanha', rotulo: 'Cresce acompanhando o mercado', expl: 'a produção nacional cresce no mesmo ritmo histórico do consumo aparente' },
        { id: 'ganha', rotulo: 'Ganha espaço, com investimento', expl: 'a produção nacional cresce 2 pontos percentuais ao ano acima do mercado' },
      ] },
    ],
    cambio: [
      { id: 'dolar', texto: 'Para onde vai o dólar?', opcoes: [
        { id: 'baixo', rotulo: 'Cai para cerca de R$ 5,00', v: 5.0 },
        { id: 'atual', rotulo: 'Fica perto de R$ 5,50, como hoje', v: 5.5 },
        { id: 'alto', rotulo: 'Sobe para cerca de R$ 6,00', v: 6.0 },
      ] },
    ],
    demanda: [
      { id: 'veic', texto: 'Como fica a demanda de veículos e transporte (montadoras, autopeças, transportadoras) até 2030?', opcoes: [
        { id: 'retracao', rotulo: 'Desacelera (2 p.p. ao ano abaixo do ritmo atual)', v: -2 },
        { id: 'estavel', rotulo: 'Segue o ritmo atual', v: 0 },
        { id: 'crescimento', rotulo: 'Acelera (2 p.p. ao ano acima do ritmo atual)', v: 2 },
      ] },
      { id: 'fam', texto: 'E o consumo das famílias (reposição de peças, artigos de borracha)?', opcoes: [
        { id: 'retracao', rotulo: 'Desacelera (1 p.p. ao ano abaixo)', v: -1 },
        { id: 'estavel', rotulo: 'Segue o ritmo atual', v: 0 },
        { id: 'crescimento', rotulo: 'Acelera (1 p.p. ao ano acima)', v: 1 },
      ] },
    ],
  };

  function cenBase() {
    const sd = state.data.sectors[cen.seg];
    const s = sd && sd.simulador;
    return s ? { sd, s, g: s.segmento, n: CEN_HORIZONTE - s.ano_base } : null;
  }
  function cenCoef() {
    const c = shared().simulador_impacto;
    if (!c) return null;
    return { dir: c.diretos[cen.seg], cad: c.cadeia };
  }
  function cenEmpregos(deltaRs) {
    const c = cenCoef();
    if (!c || !c.dir) return null;
    const mi = deltaRs / 1e6;
    const dir = mi * c.dir.empregos_por_milhao;
    const ind = c.cad && c.cad.empregos_indiretos_por_milhao ? mi * (c.cad.multiplicador - 1) * c.cad.empregos_indiretos_por_milhao : null;
    return { dir, ind };
  }
  function arredE(n) {
    if (n == null || !isFinite(n)) return '-';
    const a = Math.abs(n), r = a >= 1000 ? Math.round(a / 100) * 100 : a >= 100 ? Math.round(a / 10) * 10 : Math.round(a);
    return r.toLocaleString('pt-BR');
  }
  const taxaFmt = v => (v > 0 ? '+' : '') + v.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '% ao ano';

  function cenPerguntasHtml(cenId) {
    return CEN_PERGUNTAS[cenId].map(q => `<fieldset class="cen-q"><legend>${q.texto}</legend>` + q.opcoes.map(o =>
      `<label class="cen-op${cen.resp[cenId][q.id] === o.id ? ' sel' : ''}"><input type="radio" name="cen-${cenId}-${q.id}" value="${o.id}" data-cen="${cenId}" data-q="${q.id}"${cen.resp[cenId][q.id] === o.id ? ' checked' : ''}>${o.rotulo}</label>`).join('') + '</fieldset>').join('');
  }

  function cenResultado(titulo, frases, cards) {
    return `<div class="cen-res-cab">${titulo}</div><div class="sec-cards cen-cards">${cards.filter(Boolean).join('')}</div><ul class="cen-texto">${frases.filter(Boolean).map(f => `<li>${f}</li>`).join('')}</ul>`;
  }

  // ---- Cenário 1: China x produção ----
  function cenChina() {
    const b = cenBase();
    const el = $('#cen-china-resultado');
    $('#cen-china-perguntas').innerHTML = cenPerguntasHtml('china');
    if (!b) { el.innerHTML = '<div class="empty-note">Sem dados para este segmento.</div>'; return; }
    const { g, n, s, sd } = b;
    const temChina = g.importacao_china != null && g.importacao_china > 0;
    const m = (sd.mercado || {}).yearly || [];
    const gCA = m.length > 1 ? (Math.pow(m[m.length - 1].consumo_aparente_real / m[0].consumo_aparente_real, 1 / (m[m.length - 1].ano - m[0].ano)) - 1) * 100 : 0;
    const r = cen.resp.china;
    const gChina = !temChina ? 0 : r.imp === 'ritmo' ? (g.g_importacao_china || 0) : r.imp === 'desacelera' ? (g.g_importacao_resto || 0) : -5;
    const gResto = temChina ? (g.g_importacao_resto || 0) : (g.g_importacao || 0);
    const gProd = r.prod === 'estagnada' ? (g.g_producao || 0) : r.prod === 'acompanha' ? gCA : gCA + 2;
    const gExp = g.g_exportacao || 0;
    const f = x => Math.pow(1 + x / 100, n);
    const p0 = g.producao, x0 = g.exportacao, mc0 = temChina ? g.importacao_china : 0, mr0 = temChina ? g.importacao_resto : g.importacao;
    const p1 = p0 * f(gProd), x1 = x0 * f(gExp), mc1 = mc0 * f(gChina), mr1 = mr0 * f(gResto);
    const ca0 = p0 + mc0 + mr0 - x0, ca1 = p1 + mc1 + mr1 - x1;
    const pen0 = (mc0 + mr0) / ca0 * 100, pen1 = (mc1 + mr1) / ca1 * 100;
    const ch0 = mc0 / ca0 * 100, ch1 = mc1 / ca1 * 100;
    const emp = cenEmpregos(p1 - p0);
    const dPen = pen1 - pen0;
    const leitura = dPen > 5 ? 'o setor <strong>perde espaço no próprio mercado</strong>: o consumo cresce, mas a demanda adicional é atendida sobretudo por importados'
      : dPen < -2 ? 'o setor <strong>recupera mercado</strong> frente aos importados'
      : 'o setor <strong>mantém, grosso modo, sua posição</strong> no mercado brasileiro';
    const q = CEN_PERGUNTAS.china;
    const expl = id => q.find(x => x.id === id).opcoes.find(o => o.id === r[id]).expl;
    el.innerHTML = cenResultado(`Em ${CEN_HORIZONTE}, nesse cenário:`, [
      `Os importados passariam de ${pctL(pen0)} para <strong>${pctL(pen1)}</strong> do mercado brasileiro${temChina ? `, e a China, de ${pctL(ch0)} para <strong>${pctL(ch1)}</strong>` : ''}: ${leitura}.`,
      `A produção nacional ficaria ${fmt.brl(Math.abs(p1 - p0))} ${p1 >= p0 ? 'maior' : 'menor'} que em ${s.ano_base} (${pctL((p1 / p0 - 1) * 100, 0, true)})${emp ? `, o equivalente a cerca de <strong>${arredE(emp.dir)} empregos diretos</strong>${emp.ind != null ? ` e ${arredE(emp.ind)} na cadeia de fornecedores` : ''} ${p1 >= p0 ? 'a mais' : 'a menos'}` : ''}.`,
      `Por quê: ${expl('imp')} (${taxaFmt(gChina)}) e ${expl('prod')} (${taxaFmt(gProd)}); a exportação e as demais importações seguem o ritmo histórico.`,
      !temChina ? 'Neste segmento quase não há importação da China; o cenário pesa pouco aqui.' : null,
    ], [
      cardL({ rotulo: `Importados no mercado · ${CEN_HORIZONTE}`, valor: pctL(pen1), serie: [], sub: `${pctL(pen0)} em ${s.ano_base}` }),
      temChina ? cardL({ rotulo: `China no mercado · ${CEN_HORIZONTE}`, valor: pctL(ch1), serie: [], sub: `${pctL(ch0)} em ${s.ano_base}` }) : null,
      cardL({ rotulo: `Produção nacional · ${CEN_HORIZONTE}`, valor: fmt.brl(p1), serie: [], delta: (p1 / p0 - 1) * 100, sub: `vs ${s.ano_base} · R$ de ${anoBasePrecos()}` }),
      emp ? cardL({ rotulo: 'Empregos diretos', valor: (p1 >= p0 ? '+' : '−') + arredE(emp.dir), serie: [], sub: 'variação estimada no segmento' }) : null,
    ]);
  }

  // ---- Cenário 2: câmbio (qualitativo, com evidência histórica) ----
  function cenCambio() {
    $('#cen-cambio-perguntas').innerHTML = cenPerguntasHtml('cambio');
    const sd = state.data.sectors[cen.seg];
    const dol = {};
    shared().macro.forEach(x => { if (x.dolar != null) (dol[x.ano] = dol[x.ano] || []).push(x.dolar); });
    const dMed = a => dol[a] && dol[a].length >= 12 ? dol[a].reduce((p, q) => p + q, 0) / dol[a].length : null;
    const anos = (sd.comex.yearly || []).filter(x => x.ano < anoAtual && x.ano >= 2007 && dMed(x.ano));
    const cad = (state.data.cadeia.atividades || []).find(a => a.cod === state.data.cadeia.config.atividade);
    const pctImp = cad && cad.pct_insumos_importados ? cad.pct_insumos_importados * 100 : null;
    const ult = anos[anos.length - 1];
    const r = cen.resp.cambio.dolar;
    // Sensibilidade da importação ao dólar observada no histórico do segmento:
    // inclinação de Δln(importação US$) contra Δln(dólar médio), ano a ano.
    const pares = [];
    for (let i = 1; i < anos.length; i++) {
      const a0 = anos[i - 1], a1 = anos[i];
      if (a1.ano - a0.ano === 1 && a0.importacao_usd > 0 && a1.importacao_usd > 0)
        pares.push([Math.log(dMed(a1.ano) / dMed(a0.ano)), Math.log(a1.importacao_usd / a0.importacao_usd)]);
    }
    let elast = null;
    if (pares.length >= 15) {
      const mx = pares.reduce((p, q) => p + q[0], 0) / pares.length, my = pares.reduce((p, q) => p + q[1], 0) / pares.length;
      const sxy = pares.reduce((p, q) => p + (q[0] - mx) * (q[1] - my), 0), sxx = pares.reduce((p, q) => p + (q[0] - mx) ** 2, 0), syy = pares.reduce((p, q) => p + (q[1] - my) ** 2, 0);
      const corr = sxy / Math.sqrt(sxx * syy);
      if (sxx > 0 && corr <= -0.4) elast = sxy / sxx;
    }
    const alvo = CEN_PERGUNTAS.cambio[0].opcoes.find(o => o.id === r).v;
    const dAtual = ult ? dMed(ult.ano) : null;
    const varDol = dAtual ? (alvo / dAtual - 1) * 100 : null;
    const impEst = elast != null && ult ? ult.importacao_usd * Math.pow(alvo / dAtual, elast) : null;
    const varImp = impEst != null ? (impEst / ult.importacao_usd - 1) * 100 : null;
    const varCusto = pctImp != null && varDol != null ? pctImp / 100 * varDol : null;
    const numeros = varDol == null ? null
      : `Com o dólar a R$ ${alvo.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} (${pctL(varDol, 1, true)} em relação à média de ${ult.ano}), `
        + (varImp != null ? `no primeiro ano com esse câmbio a importação anual do segmento tenderia a ficar cerca de <strong>${pctL(Math.abs(varImp), 0)} ${varImp >= 0 ? 'maior' : 'menor'}</strong> que em ${ult.ano}: em torno de ${fmt.usd(impEst)} no ano, em vez de ${fmt.usd(ult.importacao_usd)}` : 'não há histórico suficiente neste segmento para estimar o efeito na importação')
        + (varCusto != null ? `, e o custo dos insumos ${varCusto >= 0 ? 'subiria' : 'cairia'} cerca de ${pctL(Math.abs(varCusto), 1)}` : '') + '.';
    const textos = {
      baixo: [
        'Com o dólar mais barato, o produto importado chega mais barato em reais: a <strong>pressão sobre a produção nacional aumenta</strong> e a penetração da importação tende a subir mais rápido que no ritmo atual.',
        'A exportação perde competitividade, porque o produto brasileiro fica mais caro lá fora.',
        pctImp ? `Por outro lado, os insumos importados ficam mais baratos: ${pctL(pctImp, 0)} dos insumos da atividade borracha e plástico vêm de fora, o que alivia custos.` : null,
        'Em resumo: alívio de custos, mas mais concorrência. O cenário 1, com as importações chinesas "no ritmo atual", tende a ficar ainda mais desfavorável.',
      ],
      atual: [
        'Com o dólar perto do nível atual, as tendências recentes se mantêm: a referência é o cenário 1 com "ritmo atual".',
        (() => {
          const desde = anos.filter(x => dMed(x.ano) >= 5);
          if (desde.length < 2) return null;
          const maior = anos.reduce((p, q) => q.importacao_usd > p.importacao_usd ? q : p, anos[0]);
          return `Desde ${desde[0].ano}, com o dólar acima de R$ 5, a importação do setor passou de ${fmt.usd(desde[0].importacao_usd)} para ${fmt.usd(desde[desde.length - 1].importacao_usd)}${maior.ano === desde[desde.length - 1].ano ? ', o maior valor da série' : ''}: o câmbio sozinho não tem freado a concorrência, em especial a chinesa.`;
        })(),
      ],
      alto: [
        'Com o dólar mais caro, o importado encarece em reais: há um <strong>alívio de curto prazo para a produção nacional</strong>, e a exportação ganha competitividade.',
        pctImp ? `Mas ${pctL(pctImp, 0)} dos insumos da atividade borracha e plástico são importados (borracha, químicos, negro de fumo): o custo de produção também sobe, o que reduz parte do ganho.` : 'Mas parte dos insumos é importada, o que eleva o custo de produção.',
        'O histórico mostra que, nos anos de dólar em alta, a importação em dólares recuou, mas voltou a crescer quando o câmbio se estabilizou.',
      ],
    };
    const notaElast = elast != null ? `Estimativa pela relação observada entre ${anos[0].ano} e ${ult.ano}: em média, cada 10% de alta do dólar veio acompanhada de queda de ${pctL(Math.abs(elast) * 10, 0)} na importação do segmento no mesmo ano. É um efeito de curto prazo (no mesmo ano da mudança do dólar), não uma projeção para ${CEN_HORIZONTE} como nos outros cenários: preços externos, demanda e frete também pesam.` : null;
    $('#cen-cambio-resultado').innerHTML = cenResultado('No primeiro ano com esse câmbio:', [numeros].concat(textos[r], [notaElast]), [
      cardL({ rotulo: 'Dólar no cenário', valor: 'R$ ' + alvo.toLocaleString('pt-BR', { minimumFractionDigits: 2 }), serie: [], sub: dAtual ? `média de ${ult.ano}: R$ ${dAtual.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '' }),
      impEst != null ? cardL({ rotulo: 'Importação no ano (estimada)', valor: fmt.usd(impEst), serie: [], delta: varImp, deltaRuim: true, sub: `1º ano com esse câmbio · ${ult.ano}: ${fmt.usd(ult.importacao_usd)}` }) : null,
      varCusto != null ? cardL({ rotulo: 'Custo dos insumos', valor: pctL(varCusto, 1, true), serie: [], sub: `${pctL(pctImp, 0)} dos insumos são importados` }) : null,
    ]);
    dualAxisLineChart($('#cen-cambio-chart'), {
      categories: anos.map(x => x.ano), formatYLeft: fmt.usd, formatYRight: v => 'R$ ' + v.toLocaleString('pt-BR', { maximumFractionDigits: 1 }), height: 260, plainAxis: true,
      seriesLeft: { label: 'Importação (US$ FOB)', color: 'var(--series-6)', values: anos.map(x => x.importacao_usd) },
      seriesRight: { label: 'Dólar médio (R$)', color: 'var(--series-2)', values: anos.map(x => dMed(x.ano)) },
    });
    $('#cen-cambio-sub').textContent = `${rotuloCnae(cen.seg)}: importação anual em US$ e dólar médio do ano, ${anos.length ? anos[0].ano + '–' + ult.ano : ''}. Câmbio não é simulado em números: o efeito depende de preços, contratos e da reação dos concorrentes.`;
  }

  // ---- Cenário 3: demanda dos clientes ----
  function cenDemanda() {
    $('#cen-demanda-perguntas').innerHTML = cenPerguntasHtml('demanda');
    const b = cenBase();
    const el = $('#cen-demanda-resultado');
    const c = state.data.cadeia;
    if (!b || !c) { el.innerHTML = '<div class="empty-note">Sem dados para este segmento.</div>'; return; }
    const anoD = Math.max(...c.produto.destinos.map(x => x.ano));
    const ds = c.produto.destinos.filter(x => x.ano === anoD);
    const tot = ds.reduce((p, q) => p + q.valor, 0);
    const share = cods => ds.filter(x => x.tipo === 'atividade' && cods.includes(x.cod)).reduce((p, q) => p + q.valor, 0) / tot;
    const shVeic = share(['2991', '2992', '4900', '4500']);
    const shFam = ds.filter(x => x.tipo === 'demanda_final' && x.cod === 'familias').reduce((p, q) => p + q.valor, 0) / tot;
    const r = cen.resp.demanda;
    const opV = CEN_PERGUNTAS.demanda[0].opcoes.find(o => o.id === r.veic);
    const opF = CEN_PERGUNTAS.demanda[1].opcoes.find(o => o.id === r.fam);
    const { g, s, sd, n } = b;
    // Ritmo atual = crescimento médio anual real do consumo aparente do segmento.
    const m = (sd.mercado || {}).yearly || [];
    const gCA = m.length > 1 ? (Math.pow(m[m.length - 1].consumo_aparente_real / m[0].consumo_aparente_real, 1 / (m[m.length - 1].ano - m[0].ano)) - 1) * 100 : 0;
    // "Segue o Focus": o bloco cresce no ritmo esperado pelo mercado (diferença em relação ao ritmo atual)
    const dV = opV.focus != null ? opV.focus - gCA : opV.v;
    const dF = opF.focus != null ? opF.focus - gCA : opF.v;
    const gTot = gCA + shVeic * dV + shFam * dF;          // % ao ano da demanda total
    const ca = g.producao + g.importacao - g.exportacao;
    const partNac = ca > 0 ? Math.max(0, 1 - g.importacao / ca) : 1;
    const caRef = ca * Math.pow(1 + gCA / 100, n), caCen = ca * Math.pow(1 + gTot / 100, n);
    const dDem = (caCen / caRef - 1) * 100;              // diferença em relação ao ritmo atual, em 2030
    const dProd = (caCen - caRef) * partNac;
    const dProdTot = (caCen - ca) * partNac;
    const emp = cenEmpregos(dProd);
    const empTot = cenEmpregos(dProdTot);
    const sentido = dDem > 0.05 ? 'acima do' : dDem < -0.05 ? 'abaixo do' : 'igual ao';
    el.innerHTML = cenResultado(`Até ${CEN_HORIZONTE}, nesse cenário:`, [
      `O mercado do segmento cresceria ${pctL(gTot, 1, true)} ao ano, ${sentido} ritmo atual (${pctL(gCA, 1, true)} ao ano). Veículos e transporte respondem por ${pctL(shVeic * 100, 0)} das vendas de artigos de borracha e o consumo das famílias por ${pctL(shFam * 100, 0)}.`,
      `Mantida a fatia atual da produção nacional no mercado (${pctL(partNac * 100, 0)}), a produção chegaria a ${CEN_HORIZONTE} com ${fmt.brl(Math.abs(dProdTot))} ${dProdTot >= 0 ? 'a mais' : 'a menos'} por ano que em ${s.ano_base}${empTot ? `, cerca de <strong>${arredE(empTot.dir)} empregos diretos</strong>${empTot.ind != null ? ` e ${arredE(empTot.ind)} na cadeia` : ''} ${dProdTot >= 0 ? 'a mais' : 'a menos'}` : ''}.`,
      Math.abs(dProd) > 1 ? `Em relação ao ritmo atual, são ${fmt.brl(Math.abs(dProd))} ${dProd >= 0 ? 'a mais' : 'a menos'} de produção por ano${emp ? `, cerca de <strong>${arredE(emp.dir)} empregos diretos</strong>${emp.ind != null ? ` e ${arredE(emp.ind)} na cadeia` : ''} ${dProd >= 0 ? 'a mais' : 'a menos'}` : ''}.` : 'Com as duas demandas no ritmo atual, este é o cenário de referência.',
      dDem > 0 ? 'Atenção: se a importação mantiver o ritmo do cenário 1, parte desse crescimento pode ir para o produto importado, e não para a produção nacional.' : dDem < 0 ? 'Com demanda menor, a concorrência com o importado tende a ficar mais acirrada, o que pode ampliar a perda.' : null,
      `Pesos dos clientes: Contas Nacionais/IBGE (${anoD}), para todos os artigos de borracha, inclusive pneus novos; servem como aproximação para o segmento.`,
    ], [
      cardL({ rotulo: 'Crescimento do mercado', valor: pctL(gTot, 1, true), serie: [], sub: `ao ano · ritmo atual ${pctL(gCA, 1, true)}` }),
      cardL({ rotulo: `Produção nacional · ${s.ano_base}–${CEN_HORIZONTE}`, valor: (dProdTot >= 0 ? '+' : '−') + fmt.brl(Math.abs(dProdTot)), serie: [], sub: Math.abs(dProd) > 1 ? `${dProd >= 0 ? '+' : '−'}${fmt.brl(Math.abs(dProd))} vs ritmo atual · R$ de ${anoBasePrecos()}` : `por ano em ${CEN_HORIZONTE} · R$ de ${anoBasePrecos()}` }),
      empTot ? cardL({ rotulo: `Empregos diretos · ${s.ano_base}–${CEN_HORIZONTE}`, valor: (dProdTot >= 0 ? '+' : '−') + arredE(empTot.dir), serie: [], sub: emp && Math.abs(dProd) > 1 ? `${dProd >= 0 ? '+' : '−'}${arredE(emp.dir)} vs ritmo atual` : (empTot.ind != null ? `e ${arredE(empTot.ind)} na cadeia` : 'no segmento') }) : null,
    ]);
  }

  // ---------------------------------------------------------------------
  // Compare sua empresa: o usuário informa estado, município, empregados,
  // salário médio e (opcional) faturamento; o painel compara com o setor e
  // a indústria de transformação no município (RAIS), no estado (CEMPRE) e
  // no Brasil (CEMPRE e PIA). Nada é gravado nem enviado: tudo no navegador.
  // ---------------------------------------------------------------------
  const emp = { uf: null, mun: '', func: '', sal: '', fat: '', exp: '', custos: '', inv: '' };

  function setupEmpresa() {
    const box = $('#cen-empresa-form');
    if (!box) return;
    box.addEventListener('input', e => {
      const k = e.target.dataset.campo;
      if (!k) return;
      emp[k] = e.target.value;
      if (k === 'uf') { emp.mun = ''; renderEmpresa(true); } else renderEmpresa(false);
    });
  }

  function renderEmpresa(refazForm) {
    const box = $('#cen-empresa-form');
    if (!box) return;
    const sd = state.data.sectors[cen.seg];
    const mun = sd.municipios, ce = sd.cempre;
    if (!mun || !ce) { box.innerHTML = '<div class="empty-note">Sem dados para este segmento.</div>'; $('#cen-empresa-res').innerHTML = ''; return; }
    const ufsCod = [...new Set(mun.itens.map(x => x.uf))].sort((a, b) => (NOME_UF[SIGLA_POR_COD[a]] || a).localeCompare(NOME_UF[SIGLA_POR_COD[b]] || b));
    if (!emp.uf || !ufsCod.includes(emp.uf)) { emp.uf = ufsCod.includes('35') ? '35' : ufsCod[0]; emp.mun = ''; refazForm = true; }
    const muns = mun.itens.filter(x => x.uf === emp.uf).sort((a, b) => a.nome.localeCompare(b.nome));
    if (refazForm || !box.dataset.pronto || box.dataset.seg !== cen.seg) {
      box.innerHTML = `
        <label class="emp-campo"><span>Estado</span><select data-campo="uf">${ufsCod.map(c => `<option value="${c}"${c === emp.uf ? ' selected' : ''}>${NOME_UF[SIGLA_POR_COD[c]] || c}</option>`).join('')}</select></label>
        <label class="emp-campo"><span>Município</span><select data-campo="mun"><option value="">(não informar)</option>${muns.map(m => `<option value="${m.id}"${m.id === emp.mun ? ' selected' : ''}>${m.nome}</option>`).join('')}</select></label>
        <label class="emp-campo"><span>Número de empregados</span><input type="number" min="1" step="1" inputmode="numeric" data-campo="func" value="${emp.func}" placeholder="ex.: 45"></label>
        <label class="emp-campo"><span>Salário médio mensal (R$)</span><input type="number" min="0" step="50" inputmode="decimal" data-campo="sal" value="${emp.sal}" placeholder="ex.: 3500"></label>
        <label class="emp-campo"><span>Faturamento anual (R$, opcional)</span><input type="number" min="0" step="10000" inputmode="decimal" data-campo="fat" value="${emp.fat}" placeholder="ex.: 12000000"></label>
        <label class="emp-campo"><span>Custos e despesas totais no ano (R$, opcional)</span><input type="number" min="0" step="10000" inputmode="decimal" data-campo="custos" value="${emp.custos}" placeholder="ex.: 27000000"></label>
        <label class="emp-campo"><span>Investimento no ano (R$, opcional)</span><input type="number" min="0" step="10000" inputmode="decimal" data-campo="inv" value="${emp.inv}" placeholder="ex.: 900000"></label>
        <label class="emp-campo"><span>Exportação anual (US$, opcional)</span><input type="number" min="0" step="10000" inputmode="decimal" data-campo="exp" value="${emp.exp}" placeholder="ex.: 500000"></label>
        <p class="emp-privado">🔒 Os valores ficam só no seu navegador: nada é salvo nem enviado.</p>`;
      box.dataset.pronto = '1';
      box.dataset.seg = cen.seg;
    }
    const m = muns.find(x => x.id === emp.mun);
    const sigla = SIGLA_POR_COD[emp.uf];
    const ceUf = ce.uf_ultimo_ano.find(x => x.uf === emp.uf), ceInd = ce.ind_transformacao_uf_ultimo_ano.find(x => x.uf === emp.uf);
    const ceBr = ce.brasil[ce.brasil.length - 1];
    const ind = shared().financeiro.indicadores;
    const pia = ind && ind.serie ? ind.serie.filter(r => r.recorte === cen.seg).sort((a, b) => b.ano - a.ano)[0] : null;
    const piaInd = ind && ind.serie ? ind.serie.filter(r => r.recorte === 'ind_transformacao').sort((a, b) => b.ano - a.ano)[0] : null;
    const func = +emp.func || null, sal = +emp.sal || null, fat = +emp.fat || null;
    const tam = (v, e) => v && e ? v / e : null;
    const salCe = r => r && r.salario_medio_mensal ? r.salario_medio_mensal : null;
    const fatPo = r => r && r.receita_liquida && r.pessoal_ocupado ? r.receita_liquida * 1000 / r.pessoal_ocupado : null;
    const linhas = [
      { nome: 'Empregados por empresa', sua: func, fmtv: v => fmt.full1(v),
        ref: [m ? tam(m.vinc, m.estab) : null, m ? tam(m.ind_vinc, m.ind_estab) : null, ceUf ? tam(ceUf.pessoal_ocupado, ceUf.empresas) : null, ceInd ? tam(ceInd.pessoal_ocupado, ceInd.empresas) : null, tam(ceBr.pessoal_ocupado, ceBr.empresas)] },
      { nome: 'Salário médio mensal', sua: sal, fmtv: v => 'R$ ' + numL(v),
        ref: [m ? m.remun : null, m ? m.ind_remun : null, salCe(ceUf), salCe(ceInd), salCe(ceBr)] },
      { nome: 'Faturamento por empregado (ao ano)', sua: fat && func ? fat / func : null, fmtv: v => fmt.brl(v),
        ref: [null, null, null, null, fatPo(pia)], extra: fatPo(piaInd) },
      (() => {
        // Exportação / faturamento: empresa (US$ convertido pelo dólar médio do último ano fechado) x coeficiente de exportação do segmento
        const dl = (shared().macro || []).filter(r => r.dolar && r.ano === anoAtual - 1).map(r => r.dolar);
        const dolar = dl.length ? dl.reduce((a, b) => a + b, 0) / dl.length : null;
        const expE = +emp.exp || null;
        const coefSeg = ((sd.mercado || {}).yearly || []).slice(-1)[0];
        return { nome: 'Exportação / faturamento', pp: true, sua: expE && fat && dolar ? expE * dolar / fat * 100 : null, fmtv: v => pctL(v),
          ref: [null, null, null, null, coefSeg ? coefSeg.coef_exportacao : null] };
      })(),
    ];
    // Indicadores de gestão contra a média do segmento no Brasil (PIA-Empresa, último ano)
    const custos = +emp.custos || null, inv = +emp.inv || null;
    const rlv = pia && pia.receita_liquida ? pia.receita_liquida : null;
    const margSeg = rlv && pia.custos_despesas_total != null ? (pia.receita_liquida - pia.custos_despesas_total) / rlv * 100 : null;
    const folhaSeg = rlv && pia.salarios_total ? pia.salarios_total / rlv * 100 : null;
    const invSeg = rlv && pia.aquisicoes != null ? (pia.aquisicoes + (pia.melhorias || 0)) / rlv * 100 : null;
    linhas.push(
      { nome: 'Margem operacional', pp: true, sua: fat && custos != null ? (fat - custos) / fat * 100 : null, fmtv: v => pctL(v), ref: [null, null, null, null, margSeg] },
      { nome: 'Salários / faturamento', pp: true, sua: fat && sal && func ? sal * 13 * func / fat * 100 : null, fmtv: v => pctL(v), ref: [null, null, null, null, folhaSeg], menorMelhor: true },
      { nome: 'Investimento / faturamento', pp: true, sua: fat && inv != null ? inv / fat * 100 : null, fmtv: v => pctL(v), ref: [null, null, null, null, invSeg] },
    );
    const cols = [m ? `Setor em ${m.nome}` : 'Setor no município', m ? `Indústria em ${m.nome}` : 'Indústria no município', `Setor em ${sigla}`, `Indústria em ${sigla}`, 'Setor no Brasil'];
    const cmp = (v, r, pp, menorMelhor) => v != null && r ? `<span class="emp-cmp ${(v >= r) !== !!menorMelhor ? 'acima' : 'abaixo'}">${pp ? (v - r > 0 ? '+' : '') + (v - r).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' p.p.' : pctL((v / r - 1) * 100, 0, true)}</span>` : '';
    const corpo = linhas.map(l => `<tr><td>${l.nome}</td><td class="emp-sua">${l.sua != null ? l.fmtv(l.sua) : '<span class="emp-vazio">informe</span>'}</td>`
      + l.ref.map(r => `<td style="text-align:right">${r != null ? l.fmtv(r) + cmp(l.sua, r, l.pp, l.menorMelhor) : '-'}</td>`).join('') + '</tr>').join('');
    // frases
    const fr = [];
    if (sal && m && m.remun) fr.push(`Sua empresa paga ${pctL(Math.abs((sal / m.remun - 1) * 100), 0)} ${sal >= m.remun ? 'acima' : 'abaixo'} da média do setor em ${m.nome}${m.ind_remun ? ` e ${pctL(Math.abs((sal / m.ind_remun - 1) * 100), 0)} ${sal >= m.ind_remun ? 'acima' : 'abaixo'} da média da indústria local` : ''}.`);
    else if (sal && salCe(ceUf)) fr.push(`Sua empresa paga ${pctL(Math.abs((sal / salCe(ceUf) - 1) * 100), 0)} ${sal >= salCe(ceUf) ? 'acima' : 'abaixo'} da média do setor em ${NOME_UF[sigla]}.`);
    if (func) {
      const porte = func < 20 ? 'micro ou pequena (até 19 empregados)' : func < 100 ? 'pequena a média (20 a 99)' : func < 500 ? 'média (100 a 499)' : 'grande (500 ou mais)';
      fr.push(`Pelo número de empregados, é uma empresa ${porte}; a média do setor no Brasil é de ${fmt.full1(tam(ceBr.pessoal_ocupado, ceBr.empresas))} pessoas por empresa.`);
    }
    if (fat && func && fatPo(pia)) fr.push(`O faturamento por empregado é ${pctL(Math.abs((fat / func / fatPo(pia) - 1) * 100), 0)} ${fat / func >= fatPo(pia) ? 'maior' : 'menor'} que a média do segmento no Brasil (${fmt.brl(fatPo(pia))} por pessoa ao ano${fatPo(piaInd) ? `; indústria de transformação: ${fmt.brl(fatPo(piaInd))}` : ''}).`);
    // Exportação: intensidade (exportação / faturamento) e peso no município
    const expUsd = +emp.exp || null;
    if (expUsd) {
      const dolares = (shared().macro || []).filter(r => r.dolar && r.ano === anoAtual - 1).map(r => r.dolar);
      const dolar = dolares.length ? dolares.reduce((a, b) => a + b, 0) / dolares.length : null;
      const coef = ((sd.mercado || {}).yearly || []).slice(-1)[0];
      if (fat && dolar) {
        const intens = expUsd * dolar / fat * 100;
        fr.push(`Sua empresa exporta cerca de ${pctL(intens, 0)} do faturamento${coef && coef.coef_exportacao != null ? `; no segmento, ${pctL(coef.coef_exportacao, 0)} da produção nacional vai para o exterior (${coef.ano})` : ''}.`);
      }
      const cxm = m && mun.comex && mun.comex.itens.length ? mun.comex.itens.find(x => x.id === m.id) : null;
      if (cxm && cxm.exp > 0) fr.push(`Isso equivale a ${pctL(expUsd / cxm.exp * 100, 1)} das exportações do setor em ${m.nome} (${fmt.usd(cxm.exp)} em ${mun.comex.ano}${cxm.pos_exp ? `, ${cxm.pos_exp}º município exportador do país` : ''}).`);
      else if (m && mun.comex && mun.comex.itens.length) fr.push(`${m.nome} não teve exportação do setor registrada em ${mun.comex.ano}.`);
    }
    // Pontos de atenção: onde a empresa está abaixo (ou acima, quando isso pesa) da média do segmento
    const pontos = [];
    const salRef = m && m.remun ? m.remun : salCe(ceUf);
    const fatRef = fatPo(pia);
    if (fat && func && fatRef) { const d = (fat / func / fatRef - 1) * 100; if (Math.abs(d) >= 5) pontos.push([d < 0, `Faturamento por empregado ${pctL(Math.abs(d), 0)} ${d < 0 ? 'abaixo' : 'acima'} da média do segmento: indicador de produtividade.`]); }
    if (sal && salRef) { const d = (sal / salRef - 1) * 100; if (Math.abs(d) >= 5) pontos.push([d < 0, `Salário médio ${pctL(Math.abs(d), 0)} ${d < 0 ? 'abaixo' : 'acima'} da média do setor ${m && m.remun ? 'no município' : 'no estado'}${d < 0 ? ': pode pesar na retenção de mão de obra' : ''}.`]); }
    linhas.filter(l => l.pp && l.sua != null && l.ref[4] != null).forEach(l => {
      const d = l.sua - l.ref[4];
      if (Math.abs(d) < 1) return;
      const ruim = l.menorMelhor ? d > 0 : d < 0;
      pontos.push([ruim, `${l.nome}: ${pctL(l.sua, 1)}, ${Math.abs(d).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} p.p. ${d > 0 ? 'acima' : 'abaixo'} da média do segmento (${pctL(l.ref[4], 1)}).`]);
    });
    pontos.sort((a, b) => (b[0] ? 1 : 0) - (a[0] ? 1 : 0));
    const pontosHtml = pontos.length ? `<div class="emp-pontos"><div class="emp-pontos-cab">Pontos de atenção (comparação com a média do segmento)</div><ul>${pontos.map(([ruim, t]) => `<li class="${ruim ? 'ruim' : 'bom'}">${t}</li>`).join('')}</ul><p class="emp-nota">Comparação objetiva com médias do setor; cada empresa tem particularidades (mix de produtos, porte, mercado) que essas médias não captam.</p></div>` : '';
    $('#cen-empresa-res').innerHTML = pontosHtml + `
      ${fr.length ? `<ul class="cen-texto">${fr.map(f => `<li>${f}</li>`).join('')}</ul>` : '<p class="emp-dica">Preencha os campos ao lado para ver a comparação.</p>'}
      <div class="data-table-wrap"><table class="data-table tabela-emp"><thead><tr><th>Indicador</th><th>Sua empresa</th>${cols.map(c => `<th style="text-align:right">${c}</th>`).join('')}</tr></thead><tbody>${corpo}</tbody></table></div>
      <p class="emp-nota">Município: RAIS ${mun.ano_remun || mun.ano} (salário = remuneração média de dezembro dos vínculos ativos). Estado e Brasil: CEMPRE ${ceBr.ano} (salário médio mensal com 13 salários por ano). Faturamento por empregado: PIA-Empresa ${pia ? pia.ano : ''}, segmento no Brasil. Percentuais = diferença da sua empresa em relação a cada média.</p>`;
  }


  // Expectativas de mercado (boletim Focus/BCB): cartão no topo do simulador
  // e opção "Segue o Focus" nos cenários de câmbio e de demanda.
  function focusVal(ind, ano) { const f = shared().focus; return f && f.indicadores[ind] ? f.indicadores[ind][String(ano)] : null; }
  function focusMedia(ind, ini, fim) {
    const v = []; for (let a = ini; a <= fim; a++) { const x = focusVal(ind, a); if (x != null) v.push(x); }
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  function renderFocus() {
    const box = $('#cen-focus');
    const f = shared().focus;
    if (!box) return;
    if (!f) { box.style.display = 'none'; return; }
    const anos = [anoAtual, anoAtual + 1, anoAtual + 2, anoAtual + 3];
    const linhas = [
      ['Selic (fim do ano)', 'Selic', v => pctL(v, 2)],
      ['IPCA', 'IPCA', v => pctL(v, 1)],
      ['Dólar (fim do ano)', 'Câmbio', v => 'R$ ' + v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
      ['PIB', 'PIB Total', v => pctL(v, 1, true)],
      ['PIB da indústria', 'PIB Indústria', v => pctL(v, 1, true)],
      ['Consumo das famílias', 'PIB Despesa de consumo das famílias', v => pctL(v, 1, true)],
    ].filter(l => f.indicadores[l[1]]);
    const s0 = focusVal('Selic', anoAtual), s2 = focusVal('Selic', anoAtual + 2);
    const ipca2 = focusVal('IPCA', anoAtual + 2);
    const jr = s0 != null && s2 != null ? `<p class="focus-juros"><strong>Juros:</strong> o mercado espera a Selic em ${pctL(s0, 2)} no fim de ${anoAtual} e em ${pctL(s2, 2)} em ${anoAtual + 2}${ipca2 != null ? ` (juro real perto de ${pctL(((1 + s2 / 100) / (1 + ipca2 / 100) - 1) * 100, 1)})` : ''}. Juros altos encarecem o capital de giro e o investimento, e costumam frear a demanda de bens duráveis e de veículos, os principais clientes do setor; a queda gradual tende a aliviar esse efeito ao longo do período. O efeito não é calculado em números: não há relação histórica estável entre a Selic e a produção do setor.</p>` : '';
    const d = f.data.split('-').reverse().join('/');
    box.style.display = '';
    box.innerHTML = `<div class="focus-cab"><span class="leitura-tag">O que o mercado espera</span>Boletim Focus (Banco Central), pesquisa de ${d}</div>
      <div class="data-table-wrap"><table class="data-table focus-tab"><thead><tr><th>Indicador</th>${anos.map(a => `<th style="text-align:right">${a}</th>`).join('')}</tr></thead><tbody>`
      + linhas.map(l => `<tr><td>${l[0]}</td>${anos.map(a => { const v = focusVal(l[1], a); return `<td style="text-align:right">${v != null ? l[2](v) : '-'}</td>`; }).join('')}</tr>`).join('')
      + `</tbody></table></div>${jr}<p class="focus-nota">O dólar e o crescimento esperados também aparecem como opção "Segue o Focus" no Simulador de cenários. Fonte: Focus/BCB. Elaboração: DECAP/FIESP.</p>`;
    const nota = $('#cen-nota-focus');
    if (nota) nota.innerHTML = `As opções "Segue o Focus" usam as expectativas de mercado do boletim Focus (Banco Central, pesquisa de ${d}), que estão na aba Expectativas de mercado em Dados do setor.`;
  }

  function aplicarFocusNosCenarios() {
    const f = shared().focus;
    if (!f) return;
    const dol = focusVal('Câmbio', anoAtual + 1);
    const opc = CEN_PERGUNTAS.cambio[0].opcoes;
    if (dol != null && !opc.some(o => o.id === 'focus')) opc.push({ id: 'focus', rotulo: `Segue o Focus: R$ ${dol.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} em ${anoAtual + 1}`, v: dol });
    const gInd = focusMedia('PIB Indústria', anoAtual, CEN_HORIZONTE);
    const gFam = focusMedia('PIB Despesa de consumo das famílias', anoAtual, CEN_HORIZONTE);
    const [qV, qF] = CEN_PERGUNTAS.demanda;
    if (gInd != null && !qV.opcoes.some(o => o.id === 'focus')) qV.opcoes.push({ id: 'focus', rotulo: `Segue o Focus: PIB da indústria de ${pctL(gInd, 1, true)} ao ano`, focus: gInd });
    if (gFam != null && !qF.opcoes.some(o => o.id === 'focus')) qF.opcoes.push({ id: 'focus', rotulo: `Segue o Focus: consumo das famílias de ${pctL(gFam, 1, true)} ao ano`, focus: gFam });
  }

  function renderCenarios() {
    if (!$('#cen-seg')) return;
    if (cen.aba === 'china') cenChina();
    if (cen.aba === 'cambio') cenCambio();
    if (cen.aba === 'demanda') cenDemanda();
    if (cen.aba === 'empresa') renderEmpresa(false);
  }

  function setupCenarios() {
    const segBox = $('#cen-seg');
    if (!segBox) return;
    aplicarFocusNosCenarios();
    renderFocus();
    const disp = setores().filter(c => state.data.sectors[c.codigo] && state.data.sectors[c.codigo].simulador);
    if (!disp.length) return;
    cen.seg = disp[0].codigo;
    const marcarSeg = () => segBox.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.seg === cen.seg));
    segBox.innerHTML = disp.map(c => `<button type="button" class="seg-btn" data-seg="${c.codigo}"><span class="seg-btn-nome">${c.rotulo_exec || c.rotulo}</span><span class="seg-btn-cnae">${codigoCurto(c)}</span></button>`).join('');
    marcarSeg();
    segBox.addEventListener('click', e => { const b = e.target.closest('button[data-seg]'); if (b) { cen.seg = b.dataset.seg; marcarSeg(); renderCenarios(); } });
    $('#cen-abas').addEventListener('click', e => {
      const b = e.target.closest('button[data-cen]');
      if (!b) return;
      cen.aba = b.dataset.cen;
      $('#cen-abas').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.cen-painel').forEach(p => { p.hidden = p.dataset.cen !== cen.aba; });
      renderCenarios();
    });
    $('#simulador-view').addEventListener('change', e => {
      const i = e.target;
      if (i.type !== 'radio' || !i.dataset.cen) return;
      cen.resp[i.dataset.cen][i.dataset.q] = i.value;
      renderCenarios();
    });
    setupEmpresa();
    renderCenarios();
  }

  // ---------------------------------------------------------------------
  // 03 — Emprego formal (RAIS)
  // ---------------------------------------------------------------------
  function renderEmprego() {
    renderCempre();
    renderMunicipios();
    const s = csS();
    const bs = blocks.emprego;

    // Combos: 1 linha por estado marcado no filtro (BR usa o total nacional
    // já calculado no pipeline, não a soma dos estados reais selecionados) —
    // mesmo padrão de renderEnergiaIndustrial, aplicado aqui às 2 séries
    // anuais que já têm abertura por UF na fonte (vínculos e estabelecimentos).
    const ufsSel = ufsOrdenadas(bs.ufs);
    const combos = ufsSel.map(uf => {
      const rows = uf === 'BR'
        ? s.rais.uf_yearly_total
        : s.rais.uf_yearly.filter(r => r.uf === uf);
      return { uf, nome: ufName(uf), rows: filterAnnual(rows, bs.lo, bs.hi) };
    });
    const combosGrafico = combosParaGrafico(combos, ufsSel);
    const catRais = annualCategories(combosGrafico.map(c => c.rows));
    lineChart($('#chart-emprego-rais'), {
      categories: catRais, formatY: fmt.full, height: 280,
      series: combosGrafico.map((c, i) => ({
        label: c.nome, color: CORES[i % CORES.length],
        values: seriesAnnual(c.rows, 'vinculos', catRais), area: combosGrafico.length === 1,
      })),
    });

    const tamRows = filterAnnual(s.rais.tamanho_yearly, bs.lo, bs.hi);
    const catsTam = annualCategories([tamRows]);
    const faixas = Array.from(new Set(tamRows.map(r => r.faixa)));
    const seriesTam = faixas.map((faixa, i) => ({
      label: faixa, color: CORES[i % CORES.length],
      values: catsTam.map(ano => { const row = tamRows.find(r => r.ano === ano && r.faixa === faixa); return row ? row.vinculos : 0; })
    }));
    barChart($('#chart-emprego-tamanho'), { categories: catsTam, formatY: fmt.full, height: 280, stacked: true, series: seriesTam });

    // Ranking: todos os estados com dado no ano mais recente (sem linha de
    // referência — vínculos é um total absoluto, e o "Brasil" é a soma dos
    // estados, não uma taxa comparável como o custo de energia). Estados
    // marcados no filtro ficam destacados; clicar numa barra adiciona aquele
    // estado ao filtro.
    const totalLatest = last(s.rais.uf_yearly_total);
    const ufRanking = s.rais.uf_yearly.filter(r => r.ano === totalLatest.ano).sort((a, b) => b.vinculos - a.vinculos);
    $('#emprego-uf-sub').textContent = 'Ano de ' + totalLatest.ano + ', clique numa barra para adicionar ao filtro';
    hBarChart($('#rank-emprego-uf'), {
      items: ufRanking.map(r => ({ uf: r.uf, label: r.nome_uf, value: r.vinculos, color: bs.ufs.has(r.uf) ? 'var(--series-3)' : 'var(--series-2)' })),
      formatVal: fmt.full,
      onClick: (it) => { bs.ufs.add(it.uf); bs.focoUf = it.uf; empregoUfCtl.render(); empregoUfCtl.sync(); renderEmprego(); },
    });

    lineChart($('#chart-emprego-razao'), {
      categories: catRais, formatY: fmt.full1, height: 280,
      series: combosGrafico.map((c, i) => ({
        label: c.nome, color: CORES[i % CORES.length],
        values: catRais.map(ano => { const r = c.rows.find(x => x.ano === ano); return r && r.estabelecimentos ? r.vinculos / r.estabelecimentos : null; }),
      })),
    });

    const escRows = filterAnnual(s.rais.escolaridade_yearly, bs.lo, bs.hi);
    const catEsc = annualCategories([escRows]);
    const categoriasEsc = Array.from(new Set(escRows.map(r => r.categoria)));
    const seriesEsc = categoriasEsc.map((cat, i) => ({
      label: titleCasePt(cat), color: CORES[i % CORES.length],
      values: catEsc.map(ano => { const row = escRows.find(r => r.ano === ano && r.categoria === cat); return row ? row.frequencia : 0; })
    }));
    lineChart($('#chart-emprego-escolaridade-evolucao'), { categories: catEsc, formatY: fmt.full, height: 280, stacked: true, series: seriesEsc });

    const esc = s.rais.escolaridade_latest;
    $('#emprego-escolaridade-sub').textContent = 'Retrato de ' + esc.ano;
    rankList($('#rank-emprego-escolaridade'), esc.items.slice(0, 8).map(i => ({ label: titleCasePt(i.categoria), value: i.frequencia })), { formatVal: fmt.full, color: 'var(--series-2)' });

    const ocup = s.rais.ocupacao_agrupada_latest;
    $('#emprego-ocupacao-sub').textContent = 'Retrato de ' + ocup.ano;
    rankList($('#rank-emprego-ocupacao'), ocup.items.slice(0, 8).map(i => ({ label: titleCasePt(i.categoria), value: i.frequencia })), { formatVal: fmt.full, color: 'var(--series-2)' });

    const top8 = ocup.items.slice(0, 8);
    const totalOcup = ocup.items.reduce((a, i) => a + i.frequencia, 0);
    const outrasOcup = Math.max(0, totalOcup - top8.reduce((a, i) => a + i.frequencia, 0));
    donutChart($('#chart-emprego-ocupacao-donut'), {
      formatVal: fmt.full, size: 200,
      items: [...top8.map((i, idx) => ({ label: titleCasePt(i.categoria), value: i.frequencia, color: CORES[idx % CORES.length] })),
      { label: 'Outras ocupações', value: outrasOcup, color: 'var(--baseline)' }]
    });

    const ORDEM_TEMPO = ['Ate 2,9 meses', '3,0 a 5,9 meses', '6,0 a 11,9 meses', '12,0 a 23,9 meses',
      '24,0 a 35,9 meses', '36,0 a 59,9 meses', '60,0 a 119,9 meses', '120,0 meses ou mais'];
    const CURTA = new Set(['Ate 2,9 meses', '3,0 a 5,9 meses', '6,0 a 11,9 meses']);
    const LABELS_TEMPO = {
      'Ate 2,9 meses': '< 3m', '3,0 a 5,9 meses': '3–6m', '6,0 a 11,9 meses': '6–12m',
      '12,0 a 23,9 meses': '1–2a', '24,0 a 35,9 meses': '2–3a', '36,0 a 59,9 meses': '3–5a',
      '60,0 a 119,9 meses': '5–10a', '120,0 meses ou mais': '10a+',
    };
    const tempo = s.rais.tempo_emprego_latest;
    const itemsTempo = ORDEM_TEMPO.map(cat => tempo.items.find(i => i.categoria === cat)).filter(Boolean);
    barChart($('#chart-emprego-tempo'), {
      categories: itemsTempo.map(i => LABELS_TEMPO[i.categoria] || i.categoria), formatY: fmt.full, height: 280,
      series: [{ label: 'Vínculos', color: 'var(--series-2)', values: itemsTempo.map(i => CURTA.has(i.categoria) ? -i.frequencia : i.frequencia) }]
    });

    const sh = shared();
    function ipcaDezembro(ano) {
      const row = sh.macro.find(r => r.ano === ano && r.mes === 12);
      return row ? row.ipca : null;
    }
    const massaRows = filterAnnual(s.rais.massa_nacional_yearly, bs.lo, bs.hi);
    const anoRefMassa = anoBasePrecos();
    const ipcaRef = ipcaDezembro(anoRefMassa);
    const remReal = massaRows.map(r => {
      const ipcaAno = ipcaDezembro(r.ano);
      return (r.remuneracao_media_nominal != null && ipcaAno && ipcaRef) ? r.remuneracao_media_nominal * (ipcaRef / ipcaAno) : null;
    });
    lineChart($('#chart-emprego-remuneracao'), {
      categories: massaRows.map(r => r.ano), formatY: fmt.brl, height: 280,
      series: [
        { label: 'Real (R$ de ' + (anoRefMassa || '') + ')', color: 'var(--series-3)', values: remReal },
      ]
    });

    $('#emprego-uf-table-sub').textContent = 'Ano de ' + totalLatest.ano + ', todas as UFs com dado';
    const ufTableRows = s.rais.uf_yearly.filter(r => r.ano === totalLatest.ano).sort((a, b) => b.vinculos - a.vinculos);
    dataTable($('#table-emprego-uf'), {
      columns: [
        { key: 'nome_uf', label: 'UF' },
        { key: 'estabelecimentos', label: 'Estabelecimentos', align: 'right', format: fmt.full },
        { key: 'vinculos', label: 'Vínculos', align: 'right', format: fmt.full },
        { key: 'razao', label: 'Vínculos / estabelecimento', align: 'right', format: fmt.full1 },
      ],
      rows: ufTableRows.map(r => ({ ...r, razao: r.estabelecimentos ? r.vinculos / r.estabelecimentos : null })),
      pageSize: 10,
    });

    const ocupDet = s.rais.ocupacao_detalhada_latest;
    $('#emprego-ocupacao-detalhada-sub').textContent = 'RAIS, sem agrupamento, retrato de ' + ocupDet.ano + '. Clique no cabeçalho para ordenar.';
    dataTable($('#table-emprego-ocupacao-detalhada'), {
      columns: [
        { key: 'categoria', label: 'Ocupação', format: titleCasePt },
        { key: 'frequencia', label: 'Vínculos', align: 'right', format: fmt.full },
      ],
      rows: ocupDet.items,
      pageSize: 15,
    });
  }

  // ---------------------------------------------------------------------
  // 04 — CAGED
  // ---------------------------------------------------------------------
  function renderCaged() {
    const s = csS();
    const bs = blocks.caged;

    $('#caged-coverage-note').textContent = `Dado mês a mês (admissões e desligamentos) — mais detalhado no tempo do que a RAIS, que só fecha uma vez por ano. Cobertura: ${s.caged.coverage.inicio} a ${s.caged.coverage.fim}. Clique numa barra do ranking por UF para adicionar aquele estado ao filtro abaixo.`;

    // Combos: 1 linha por estado marcado no filtro (mesmo padrão de
    // renderEmprego/renderEnergiaIndustrial), usando as séries mensais por
    // UF do CAGED (BR usa o total nacional já existente).
    const ufsSel = ufsOrdenadas(bs.ufs);
    const combosSaldo = ufsSel.map(uf => {
      const rows = uf === 'BR' ? s.caged.saldo_monthly_national : s.caged.saldo_uf_monthly.filter(r => r.uf === uf);
      return { uf, nome: ufName(uf), rows: filterMonthly(rows, bs.lo, bs.hi) };
    });
    const combosSaldoGrafico = combosParaGrafico(combosSaldo, ufsSel);
    const catSaldo = monthlyCategories(combosSaldoGrafico.map(c => c.rows));
    lineChart($('#chart-caged-saldo'), {
      categories: catSaldo, formatX: monthLabel, formatY: fmt.full, height: 280,
      series: combosSaldoGrafico.map((c, i) => ({
        label: c.nome, color: CORES[i % CORES.length],
        values: seriesMonthly(c.rows, 'saldo', catSaldo), area: combosSaldoGrafico.length === 1,
      })),
    });

    const tipoMonthly = filterMonthly(s.caged.tipo_movimentacao_monthly, bs.lo, bs.hi);
    lineChart($('#chart-caged-movimentacao'), {
      categories: tipoMonthly.map(r => r.ano * 100 + r.mes), formatX: monthLabel, formatY: fmt.compact, height: 280, stacked: true,
      series: [
        { label: 'Admissões', color: 'var(--series-4)', values: tipoMonthly.map(r => r.admissoes) },
        { label: 'Desligamentos', color: 'var(--series-6)', values: tipoMonthly.map(r => r.desligamentos) },
      ]
    });

    // Rótulos curtos: a categoria completa ("Desligamento por demissão sem
    // justa causa, térm de contrato prz det, térm contrato") não cabe como
    // rótulo de gráfico — usa uma versão resumida, igual ao padrão já usado
    // em LABELS_TEMPO mais abaixo.
    const LABELS_DESLIGAMENTO = {
      'Desligamento por demissão sem justa causa, térm de contrato prz det, térm contrato': 'Sem justa causa / fim de contrato',
      'Desligamento a pedido': 'A pedido do empregado',
      'Desligamento por demissão com justa causa': 'Com justa causa',
      'Desligamento por morte': 'Óbito',
      'Desligamento por acordo empregado e empregador': 'Acordo mútuo',
      'Desligamento por aposentadoria': 'Aposentadoria',
    };
    const tipoBreak = s.caged.tipo_movimentacao_breakdown_total.filter(t => /desligamento/i.test(t.tipo))
      .sort((a, b) => b.quantidade - a.quantidade);
    hBarChart($('#chart-caged-tipo'), {
      items: tipoBreak.map(t => ({ label: LABELS_DESLIGAMENTO[t.tipo] || t.tipo, value: t.quantidade, color: 'var(--series-6)' })),
      formatVal: fmt.full,
    });

    // Massa salarial: na fundição o campo caía ~98% em jan/2020 (transição
    // pro novo CAGED) e a série era cortada em dez/2019. Na coleta da
    // borracha (tratar_caged.R) a junção antigo + novo é contínua, sem
    // quebra, então a série vai inteira num gráfico só.
    const combosSalario = ufsSel.map(uf => {
      const rows = uf === 'BR' ? s.caged.salario_monthly_national : s.caged.salario_uf_monthly.filter(r => r.uf === uf);
      return { uf, nome: ufName(uf), rows: filterMonthly(rows, bs.lo, bs.hi) };
    });
    const combosSalarioGrafico = combosParaGrafico(combosSalario, ufsSel);
    const catSalario = monthlyCategories(combosSalarioGrafico.map(c => c.rows));
    lineChart($('#chart-caged-massa-salarial'), {
      categories: catSalario, formatX: monthLabel, formatY: fmt.brl, height: 280,
      series: combosSalarioGrafico.map((c, i) => ({
        label: c.nome, color: CORES[i % CORES.length],
        values: seriesMonthly(c.rows, 'massa_salarial', catSalario),
      })),
    });

    // Ranking: soma do saldo no período selecionado, todos os estados com
    // dado. Referência em zero é natural aqui (positivo = contratou líquido,
    // negativo = demitiu líquido) — diferente de vínculos/desembolso, que
    // são totais absolutos sem um "zero" comparável.
    const saldoUfRows = s.caged.saldo_uf_monthly.filter(r => r.ano >= bs.lo && r.ano <= bs.hi);
    const saldoPorUf = {};
    saldoUfRows.forEach(r => { saldoPorUf[r.uf] = (saldoPorUf[r.uf] || 0) + r.saldo; });
    const saldoUfSorted = Object.entries(saldoPorUf).map(([uf, saldo]) => ({ uf, saldo }))
      .sort((a, b) => Math.abs(b.saldo) - Math.abs(a.saldo));
    hBarChart($('#rank-caged-saldo-uf'), {
      items: saldoUfSorted.map(r => ({
        uf: r.uf, label: ufName(r.uf), value: r.saldo,
        color: bs.ufs.has(r.uf) ? 'var(--series-3)' : (r.saldo >= 0 ? 'var(--good)' : 'var(--bad)'),
      })),
      formatVal: fmt.full,
      reference: { value: 0, label: 'Zero' },
      onClick: (it) => { bs.ufs.add(it.uf); bs.focoUf = it.uf; cagedUfCtl.render(); cagedUfCtl.sync(); renderCaged(); },
    });

    dataTable($('#table-caged-uf'), {
      columns: [
        { key: 'uf_nome', label: 'UF' },
        { key: 'saldo', label: 'Saldo acumulado', align: 'right', format: fmt.full },
      ],
      rows: saldoUfSorted.map(r => ({ uf_nome: ufName(r.uf), saldo: r.saldo })),
      pageSize: 10,
    });
  }

  // ---------------------------------------------------------------------
  // 05 — Comércio exterior
  // ---------------------------------------------------------------------
  function renderComex() {
    const s = csS();
    const bs = blocks.comex;

    // Não existe correspondência oficial CNAE -> NCM: todo o bloco usa uma
    // cesta de NCMs por segmento (config_painel.json, cesta_ncm), igual em
    // todos os gráficos (balança, UF, país e produtos).
    const cc = cnaeCfg();
    const metodologiaNote = $('#comex-metodologia-note');
    metodologiaNote.style.display = '';
    metodologiaNote.textContent = 'Cesta de produtos usada em todo este bloco: ' + cc.cesta_ncm;
    // Segmento com comércio exterior residual: os gráficos continuam, mas
    // com aviso em destaque (variações sobre valores tão pequenos enganam).
    const residualNote = $('#comex-residual-note');
    residualNote.style.display = cc.comex_residual ? '' : 'none';
    residualNote.textContent = cc.comex_residual ? cc.nota_comex : '';
    const ufAvailable = new Set(s.comex.uf_yearly.map(r => r.uf));
    let rows, note = '';
    if (bs.focoUf === 'BR' || !ufAvailable.has(bs.focoUf)) {
      rows = filterAnnual(s.comex.yearly, bs.lo, bs.hi);
      if (bs.focoUf !== 'BR') note = 'Estado sem dado detalhado nesta base; mostrando total nacional do setor.';
    } else {
      const ufRows = s.comex.uf_yearly.filter(r => r.uf === bs.focoUf);
      const years = annualCategories([ufRows]);
      rows = years.map(ano => {
        const exp = ufRows.find(r => r.ano === ano && r.fluxo === 'Exportação');
        const imp = ufRows.find(r => r.ano === ano && r.fluxo === 'Importação');
        return { ano, exportacao_usd: exp ? exp.valor_usd : 0, importacao_usd: imp ? imp.valor_usd : 0 };
      });
      rows = filterAnnual(rows, bs.lo, bs.hi);
    }
    $('#comex-uf-note') && ($('#comex-uf-note').textContent = note);
    $('#comex-foco-sub').textContent = 'US$ FOB por ano, ' + ufName(bs.focoUf);

    const rowsBalanca = filterAnnual(s.comex.yearly, bs.lo, bs.hi);
    const balancaTemAnoParcial = rowsBalanca.some(r => r.ano === CURRENT_YEAR);
    $('#comex-balanca-sub').textContent = `Exportação, importação e saldo, em milhões de R$ de ${anoBasePrecos()}, Brasil`
      + (balancaTemAnoParcial ? ` (${CURRENT_YEAR} é ano parcial)` : '');
    lineChart($('#chart-comex-balanca'), {
      categories: rowsBalanca.map(r => r.ano), formatY: fmt.full, formatEndLabel: fmt.full, height: 280, endLabels: true,
      series: [
        { label: 'Exportação', color: 'var(--series-4)', values: rowsBalanca.map(r => r.exportacao_brl_real) },
        { label: 'Importação', color: 'var(--series-6)', values: rowsBalanca.map(r => r.importacao_brl_real) },
        { label: 'Saldo', color: 'var(--series-3)', values: rowsBalanca.map(r => r.saldo_brl_real) },
      ]
    });

    const cat = rows.map(r => r.ano);
    barChart($('#chart-comex-brasil'), {
      categories: cat, formatY: fmt.usd, height: 280,
      series: [
        { label: 'Exportação', color: 'var(--series-4)', values: rows.map(r => r.exportacao_usd) },
        { label: 'Importação', color: 'var(--series-6)', values: rows.map(r => -r.importacao_usd) }
      ]
    });

    const rowsKg = filterAnnual(s.comex.yearly, bs.lo, bs.hi);
    barChart($('#chart-comex-brasil-kg'), {
      categories: rowsKg.map(r => r.ano), formatY: n => fmt.compact(n) + ' kg', height: 280,
      series: [
        { label: 'Exportação', color: 'var(--series-4)', values: rowsKg.map(r => r.exportacao_kg) },
        { label: 'Importação', color: 'var(--series-6)', values: rowsKg.map(r => -r.importacao_kg) }
      ]
    });

    const topY = s.comex.top_paises_yearly;
    const filteredYearly = topY.yearly.filter(r => r.ano >= bs.lo && r.ano <= bs.hi);
    const seriesTopPaises = topY.paises.map((pais, i) => ({
      label: pais, color: CORES[i % CORES.length], values: filteredYearly.map(r => r[pais] || 0)
    }));
    seriesTopPaises.push({ label: 'Outros', color: 'var(--baseline)', values: filteredYearly.map(r => r.Outros || 0) });
    barChart($('#chart-comex-top-paises-tempo'), {
      categories: filteredYearly.map(r => r.ano), formatY: fmt.usd, height: 280, stacked: true, shareInTooltip: true, series: seriesTopPaises
    });

    const topYImp = s.comex.top_paises_imp_yearly;
    const filteredYearlyImp = topYImp.yearly.filter(r => r.ano >= bs.lo && r.ano <= bs.hi);
    const seriesTopPaisesImp = topYImp.paises.map((pais, i) => ({
      label: pais, color: CORES[i % CORES.length], values: filteredYearlyImp.map(r => r[pais] || 0)
    }));
    seriesTopPaisesImp.push({ label: 'Outros', color: 'var(--baseline)', values: filteredYearlyImp.map(r => r.Outros || 0) });
    barChart($('#chart-comex-top-paises-imp-tempo'), {
      categories: filteredYearlyImp.map(r => r.ano), formatY: fmt.usd, height: 280, stacked: true, shareInTooltip: true, series: seriesTopPaisesImp
    });

    const ctBr = filterAnnual(s.comtrade.brazil_yearly, bs.lo, bs.hi);
    const ctWorld = filterAnnual(s.comtrade.world_yearly, bs.lo, bs.hi);
    const catCt = annualCategories([ctBr, ctWorld]);
    renderRankingMundial();
    renderGruposMundo();
    renderComexAmpliado();

    const participacaoMundo = catCt.map(ano => {
      const b = ctBr.find(r => r.ano === ano), w = ctWorld.find(r => r.ano === ano);
      return (b && w && w.export_usd) ? (b.export_usd / w.export_usd) * 100 : null;
    });
    lineChart($('#chart-comex-participacao-mundial'), {
      categories: catCt, formatY: pct2, height: 280,
      series: [{ label: 'Participação do Brasil', color: 'var(--series-4)', values: participacaoMundo, area: true }]
    });

    const top = s.comex.top_paises_latest;

    $('#comex-paises-table-sub').textContent = 'Ano de ' + top.ano;
    const paisesSet = new Set([...top.exportacao.map(i => i.pais), ...top.importacao.map(i => i.pais)]);
    const expByPais = new Map(top.exportacao.map(i => [i.pais, i.valor_usd]));
    const impByPais = new Map(top.importacao.map(i => [i.pais, i.valor_usd]));
    const paisesTableRows = Array.from(paisesSet).map(pais => ({
      pais, exportacao_usd: expByPais.get(pais) || 0, importacao_usd: impByPais.get(pais) || 0,
    })).sort((a, b) => (b.exportacao_usd + b.importacao_usd) - (a.exportacao_usd + a.importacao_usd));
    dataTable($('#table-comex-paises'), {
      columns: [
        { key: 'pais', label: 'País' },
        { key: 'exportacao_usd', label: 'Exportação', align: 'right', format: fmt.usdFull },
        { key: 'importacao_usd', label: 'Importação', align: 'right', format: fmt.usdFull },
      ],
      rows: paisesTableRows,
      pageSize: 8,
    });

    const ufAnoMax = anoFechado(Math.max(...s.comex.uf_yearly.map(r => r.ano)));
    const rankExpUf = Array.from(new Set(s.comex.uf_yearly.map(r => r.uf))).map(uf => {
      const exp = s.comex.uf_yearly.find(r => r.uf === uf && r.ano === ufAnoMax && r.fluxo === 'Exportação');
      return exp ? { uf, label: exp.nome_uf, value: exp.valor_usd } : null;
    }).filter(Boolean).sort((a, b) => b.value - a.value);
    $('#comex-uf-rank-sub').textContent = 'UF de origem do produto, exportação de ' + ufAnoMax + '. Clique numa barra para trocar o foco.';
    hBarChart($('#rank-comex-uf'), {
      items: rankExpUf.map(r => ({ uf: r.uf, label: r.label, value: r.value, color: r.uf === bs.focoUf ? 'var(--series-3)' : 'var(--series-4)' })),
      formatVal: fmt.usd,
      onClick: (it) => { bs.focoUf = it.uf; $('#comex-uf-select').value = it.uf; renderComex(); },
    });
    $('#comex-uf-table-sub').textContent = 'Ano de ' + ufAnoMax + ', principais UFs produtoras';
    const ufNomes = Array.from(new Set(s.comex.uf_yearly.map(r => r.nome_uf)));
    const ufTableRows = ufNomes.map(nome_uf => {
      const exp = s.comex.uf_yearly.find(r => r.nome_uf === nome_uf && r.ano === ufAnoMax && r.fluxo === 'Exportação');
      const imp = s.comex.uf_yearly.find(r => r.nome_uf === nome_uf && r.ano === ufAnoMax && r.fluxo === 'Importação');
      return { nome_uf, exportacao_usd: exp ? exp.valor_usd : 0, importacao_usd: imp ? imp.valor_usd : 0 };
    }).sort((a, b) => b.exportacao_usd - a.exportacao_usd);
    dataTable($('#table-comex-uf'), {
      columns: [
        { key: 'nome_uf', label: 'UF' },
        { key: 'exportacao_usd', label: 'Exportação', align: 'right', format: fmt.usdFull },
        { key: 'importacao_usd', label: 'Importação', align: 'right', format: fmt.usdFull },
      ],
      rows: ufTableRows,
      pageSize: 8,
    });

    // Produtos (NCM) e preço médio (US$/kg), da mesma cesta de NCMs.
    const ncm = s.comex.ncm || {};
    const ncmWrap = $('#comex-ncm-wrap');
    if (ncm.exportacao || ncm.importacao) {
      ncmWrap.style.display = '';
      const ncmCols = [
        { key: 'ncm', label: 'NCM' },
        { key: 'descricao', label: 'Descrição', wrap: true },
        { key: 'valor_usd', label: 'Valor US$ FOB', align: 'right', format: fmt.usdFull },
        { key: 'kg', label: 'Quilograma líquido', align: 'right', format: fmt.full },
        { key: 'preco_medio_usd_kg', label: 'Preço médio (US$/kg)', align: 'right', format: n => n == null ? '-' : 'US$ ' + fmt.full1(n) },
      ];
      const grupoCols = [
        { key: 'grupo', label: 'Grupo de produto', wrap: true },
        { key: 'valor_usd', label: 'Valor US$ FOB', align: 'right', format: fmt.usdFull },
        { key: 'pct_total', label: '% do total', align: 'right', format: n => fmt.pct(n) },
        { key: 'preco_medio_usd_kg', label: 'Preço médio (US$/kg)', align: 'right', format: n => n == null ? '-' : 'US$ ' + fmt.full1(n) },
      ];
      // Padrão: agrupado por componente (grupo de produto) do diagnóstico
      // FIESP; o botão "Por NCM" abre o detalhe por código.
      const desenharProdutos = (dado, alvo, sub, toggle) => {
        const porNcm = state.comexProdutosPorNcm || !dado.latest.grupos;
        $(sub).textContent = (porNcm ? 'Por código NCM, ' : 'Por grupo de produto, ') + dado.latest.ano;
        $(toggle).style.display = dado.latest.grupos ? '' : 'none';
        $(toggle).querySelectorAll('button').forEach(b =>
          b.classList.toggle('active', (b.dataset.modo === 'ncm') === porNcm));
        dataTable($(alvo), porNcm
          ? { columns: ncmCols, rows: dado.latest.itens, pageSize: 8 }
          : { columns: grupoCols, rows: dado.latest.grupos, pageSize: 10 });
      };
      const desenharTodos = () => {
        if (ncm.exportacao) desenharProdutos(ncm.exportacao, '#table-comex-ncm-exp', '#comex-ncm-exp-sub', '#comex-ncm-exp-toggle');
        if (ncm.importacao) desenharProdutos(ncm.importacao, '#table-comex-ncm-imp', '#comex-ncm-imp-sub', '#comex-ncm-imp-toggle');
      };
      document.querySelectorAll('#comex-ncm-exp-toggle button, #comex-ncm-imp-toggle button').forEach(b => {
        if (b.dataset.wired) return;
        b.dataset.wired = '1';
        b.addEventListener('click', () => { state.comexProdutosPorNcm = b.dataset.modo === 'ncm'; desenharTodos(); });
      });
      desenharTodos();
      const catPreco = annualCategories([
        (ncm.exportacao && ncm.exportacao.preco_medio_yearly) || [],
        (ncm.importacao && ncm.importacao.preco_medio_yearly) || [],
      ]);
      lineChart($('#chart-comex-preco-medio'), {
        categories: catPreco, formatY: n => 'US$ ' + fmt.full1(n), height: 280,
        series: [
          ncm.exportacao ? { label: 'Exportação', color: 'var(--series-4)', values: seriesAnnual(ncm.exportacao.preco_medio_yearly, 'preco_medio_usd_kg', catPreco) } : null,
          ncm.importacao ? { label: 'Importação', color: 'var(--series-6)', values: seriesAnnual(ncm.importacao.preco_medio_yearly, 'preco_medio_usd_kg', catPreco) } : null,
        ].filter(Boolean),
      });
    } else {
      ncmWrap.style.display = 'none';
      $('#table-comex-ncm-exp').innerHTML = '';
      $('#table-comex-ncm-imp').innerHTML = '';
      $('#chart-comex-preco-medio').innerHTML = '';
    }
  }

  // Participação no mundo é pequena (décimos de ponto): duas casas decimais.
  function pct2(n) {
    return n == null || isNaN(n) ? '-' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
  }


  // ---------------------------------------------------------------------
  // Comércio exterior ampliado (base bruta do MDIC): visão mensal com FOB
  // ou CIF, filtro por NCM e cestas fora do setor (outra cor, tracejadas).
  // ---------------------------------------------------------------------
  const cxSt = { valor: 'fob', meses: 36, ncms: null, busca: '' };

  function renderComexAmpliado() {
    const s = csS(), c = s.comex;
    const bloco = $('#bloco-comex-ampliado');
    if (!bloco) return;
    if (!c.mensal || !c.mensal.length) { bloco.style.display = 'none'; return; }
    bloco.style.display = '';

    // ---- mensal ----
    const ult = c.mensal.slice(cxSt.meses ? -cxSt.meses : 0);
    const rotMes = r => `${MESES[r.mes - 1]}/${String(r.ano).slice(2)}`;
    const impK = cxSt.valor === 'cif' ? 'importacao_cif' : 'importacao_fob';
    const u = c.mensal[c.mensal.length - 1];
    const ua = c.mensal.find(r => r.ano === u.ano - 1 && r.mes === u.mes);
    const acum = (ano, k) => c.mensal.filter(r => r.ano === ano && r.mes <= u.mes).reduce((a, r) => a + r[k], 0);
    const varAc = acum(u.ano - 1, impK) ? (acum(u.ano, impK) / acum(u.ano - 1, impK) - 1) * 100 : null;
    $('#cx-mensal-title').textContent = varAc != null
      ? `Importação de jan a ${MESES[u.mes - 1]}/${u.ano}: ${varAc >= 0 ? 'alta' : 'queda'} de ${pctL(Math.abs(varAc), 1)} sobre o mesmo período de ${u.ano - 1}`
      : 'Exportação e importação, mês a mês';
    $('#cx-mensal-sub').textContent = `US$ por mês, até ${MESES[u.mes - 1]}/${u.ano}. Importação em ${cxSt.valor === 'cif' ? 'CIF (com frete e seguro)' : 'FOB'}; exportação sempre em FOB.`
      + (ua ? ` Em ${MESES[u.mes - 1]}/${u.ano}: importação de ${fmt.usd(u[impK])} (${pctL((u[impK] / ua[impK] - 1) * 100, 0, true)} contra ${MESES[u.mes - 1]}/${u.ano - 1}).` : '');
    lineChart($('#cx-mensal-chart'), {
      categories: ult.map(rotMes), formatY: fmt.usd, height: 260,
      series: [
        { label: `Importação (${cxSt.valor.toUpperCase()})`, color: 'var(--series-6)', values: ult.map(r => r[impK]) },
        { label: 'Exportação (FOB)', color: 'var(--series-4)', values: ult.map(r => r.exportacao_fob) },
      ],
    });
    document.querySelectorAll('#cx-valor button').forEach(b => b.classList.toggle('active', b.dataset.v === cxSt.valor));
    document.querySelectorAll('#cx-meses button').forEach(b => b.classList.toggle('active', +b.dataset.m === cxSt.meses));

    // ---- filtro por NCM ----
    const lista = c.ncm_anual || [];
    if (!cxSt.ncms || !cxSt.ncms.every(n => lista.some(x => x.ncm === n))) cxSt.ncms = lista.map(x => x.ncm);
    const busca = cxSt.busca.trim().toLowerCase();
    const visiveis = lista.filter(x => !busca || x.ncm.includes(busca.replace(/\D/g, '') || '§') || (x.descricao || '').toLowerCase().includes(busca));
    $('#cx-ncm-lista').innerHTML = visiveis.map(x => `<label class="cx-ncm-item"><input type="checkbox" value="${x.ncm}"${cxSt.ncms.includes(x.ncm) ? ' checked' : ''}><span class="mono">${x.ncm.replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}</span> ${(x.descricao || '').replace(/</g, '&lt;')}</label>`).join('') || '<div class="empty-note">Nenhuma NCM encontrada.</div>';
    $('#cx-ncm-cont').textContent = `${cxSt.ncms.length} de ${lista.length} NCMs selecionadas`;
    const sel = lista.filter(x => cxSt.ncms.includes(x.ncm));
    const anos = [...new Set(sel.flatMap(x => x.serie.map(r => r.ano)))].filter(a => a < anoAtual).sort((a, b) => a - b);
    const soma = k => anos.map(a => sel.reduce((t, x) => t + ((x.serie.find(r => r.ano === a) || {})[k] || 0), 0));
    const imp = soma(cxSt.valor === 'cif' ? 'imp_cif' : 'imp'), exp = soma('exp');
    $('#cx-ncm-title').textContent = sel.length === lista.length ? 'Toda a cesta do segmento' : `${sel.length} NCM${sel.length === 1 ? '' : 's'} selecionada${sel.length === 1 ? '' : 's'}`;
    $('#cx-ncm-sub').textContent = `Exportação (FOB) e importação (${cxSt.valor.toUpperCase()}) por ano, anos fechados. Marque ou desmarque NCMs para recalcular.`;
    barChart($('#cx-ncm-chart'), {
      categories: anos, formatY: fmt.usd, height: 260,
      series: [
        { label: `Importação (${cxSt.valor.toUpperCase()})`, color: 'var(--series-6)', values: imp },
        { label: 'Exportação (FOB)', color: 'var(--series-4)', values: exp },
      ],
    });

    // ---- cestas fora do setor ----
    const ext = shared().comex_externas || [];
    const anosE = [...new Set(ext.flatMap(e => e.serie.map(r => r.ano)))].sort((a, b) => a - b);
    const setorAnual = anosE.map(a => c.mensal.filter(r => r.ano === a).reduce((t, r) => t + r[impK], 0) || null);
    const CORES_EXT = ['#5b7fa6', '#7aa6c2', '#3f6590', '#9cb3c9'];
    const kE = cxSt.valor === 'cif' ? 'imp_cif' : 'imp';
    lineChart($('#cx-ext-chart'), {
      categories: anosE, formatY: fmt.usd, height: 280,
      series: [{ label: `Importação do segmento (${rotuloCnae(state.sector)})`, color: 'var(--series-6)', values: setorAnual }]
        .concat(ext.map((e, i) => ({ label: `${e.rotulo} (fora do setor)`, color: CORES_EXT[i % CORES_EXT.length], dashed: true, values: anosE.map(a => (e.serie.find(r => r.ano === a) || {})[kE] || null) }))),
    });
    const ue = anosE[anosE.length - 1];
    const maior = ext.map(e => ({ e, v: (e.serie.find(r => r.ano === ue) || {})[kE] || 0 })).sort((a, b) => b.v - a.v)[0];
    $('#cx-ext-title').textContent = maior ? `Na cadeia, ${maior.e.rotulo.toLowerCase()} é o maior item importado fora do setor (${fmt.usd(maior.v)} em ${ue})` : 'Produtos relacionados, fora do setor';
    $('#cx-ext-sub').textContent = `Importação anual (${cxSt.valor.toUpperCase()}) de matérias-primas e produtos relacionados que NÃO fazem parte do setor (linhas tracejadas, em azul), comparada à importação do segmento (vermelho). Borracha natural e sintética e insumos químicos são insumos do setor; pneus novos são outro segmento da indústria da borracha.`;
  }

  function setupComexAmpliado() {
    const bloco = $('#bloco-comex-ampliado');
    if (!bloco) return;
    bloco.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.v) { cxSt.valor = b.dataset.v; renderComexAmpliado(); }
      if (b.dataset.m !== undefined) { cxSt.meses = +b.dataset.m; renderComexAmpliado(); }
      if (b.id === 'cx-ncm-todos') { cxSt.ncms = (csS().comex.ncm_anual || []).map(x => x.ncm); renderComexAmpliado(); }
      if (b.id === 'cx-ncm-nenhum') { cxSt.ncms = []; renderComexAmpliado(); }
    });
    bloco.addEventListener('change', e => {
      if (e.target.matches('#cx-ncm-lista input[type=checkbox]')) {
        const v = e.target.value;
        cxSt.ncms = e.target.checked ? [...new Set(cxSt.ncms.concat(v))] : cxSt.ncms.filter(n => n !== v);
        renderComexAmpliado();
      }
    });
    $('#cx-ncm-busca').addEventListener('input', e => { cxSt.busca = e.target.value; renderComexAmpliado(); });
  }

  // Comércio mundial por grupo de produto (Comtrade, SH4): tamanho do mercado
  // mundial, crescimento, participação e posição do Brasil e países líderes.
  function renderGruposMundo() {
    const alvo = $('#table-comex-grupos-mundo');
    if (!alvo) return;
    const g = (csS().comtrade || {}).grupos_mundo;
    if (!g || !g.itens.length) { alvo.closest('.exhibit-block').style.display = 'none'; return; }
    alvo.closest('.exhibit-block').style.display = '';
    const bandeira = l => l.iso2 ? `<img class="flag" src="https://flagcdn.com/20x15/${l.iso2}.png" srcset="https://flagcdn.com/40x30/${l.iso2}.png 2x" width="20" height="15" alt="" loading="lazy">` : '';
    const melhor = g.itens.filter(x => x.brasil_pos).sort((a, b) => b.brasil_pct - a.brasil_pct)[0];
    $('#comex-grupos-mundo-title').textContent = melhor
      ? `Brasil tem mais presença em "${melhor.grupo.toLowerCase()}": ${pctL(melhor.brasil_pct, 2)} do mundo, ${melhor.brasil_pos}º lugar`
      : 'Comércio mundial por grupo de produto';
    $('#comex-grupos-mundo-sub').textContent = `Exportações mundiais por grupo do Sistema Harmonizado (4 dígitos), ${g.ano}; crescimento médio anual ${g.ano_inicial}–${g.ano}. Os grupos internacionais são mais amplos que os do diagnóstico (NCM de 8 dígitos). ${g.ano} é o ano mais recente com cobertura completa de países no Comtrade.`;
    dataTable(alvo, {
      columns: [
        { key: 'grupo', label: 'Grupo de produto', wrap: '200px' },
        { key: 'mundo_usd', label: `Mundo, ${g.ano}`, align: 'right', format: fmt.usd },
        { key: 'cresc_aa', label: 'Cresc. ao ano', align: 'right', format: v => pctL(v, 1, true) },
        { key: 'brasil_usd', label: 'Brasil', align: 'right', format: fmt.usd },
        { key: 'brasil_pct', label: '% Brasil', align: 'right', format: v => pctL(v, 2) },
        { key: 'brasil_pos', label: 'Posição', align: 'right', format: v => v ? v + 'º' : '-' },
        { key: 'lideres', label: 'Maiores exportadores', wrap: '240px', html: v => (v || []).map(l => `<span class="lider">${bandeira(l)}${l.pais} <em>${pctL(l.pct, 0)}</em></span>`).join('') },
      ],
      rows: g.itens,
      pageSize: 14,
    });
  }

  // Ranking mundial de exportadores (Comtrade) com seletor de ano próprio —
  // não segue a régua de período do bloco, é um retrato de um ano.
  function renderRankingMundial() {
    const rk = csS().comtrade.ranking_exportadores || {};
    const anos = Object.keys(rk).map(Number).sort((a, b) => b - a);
    const sel = $('#comex-mundo-ano-select');
    const atual = Number(sel.value);
    sel.innerHTML = anos.map(a => `<option value="${a}">${a}</option>`).join('');
    sel.value = anos.includes(atual) ? atual : anos[0];
    if (!sel.dataset.wired) {
      sel.addEventListener('change', renderRankingMundial);
      sel.dataset.wired = '1';
    }
    const dado = rk[sel.value];
    if (!dado) { $('#table-comex-ranking-mundial').innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>'; return; }
    const bra = dado.itens.find(r => r.iso2 === 'br');
    $('#comex-ranking-mundial-sub').textContent = `Maiores exportadores do mundo dos produtos do segmento em ${sel.value} (Comtrade, ${dado.n_paises} países declarantes), US$ FOB e % do total mundial.`
      + (bra ? ` Brasil em ${bra.pos}º lugar, com ${pct2(bra.pct_mundo)}.` : ' Brasil sem exportação declarada no ano.');
    const bandeira = r => r.iso2
      ? `<img class="flag" src="https://flagcdn.com/20x15/${r.iso2}.png" srcset="https://flagcdn.com/40x30/${r.iso2}.png 2x" width="20" height="15" alt="" loading="lazy">`
      : '<span class="flag flag-vazia"></span>';
    dataTable($('#table-comex-ranking-mundial'), {
      columns: [
        { key: 'pos', label: '#', align: 'right', format: n => n + 'º' },
        { key: 'pais', label: 'País', html: (v, r) => `${bandeira(r)}${v}` },
        { key: 'valor_usd', label: 'Exportação', align: 'right', format: fmt.usd },
        { key: 'pct_mundo', label: '% do mundo', align: 'right', format: pct2 },
      ],
      rows: dado.itens,
      rowClass: r => (r.iso2 === 'br' ? 'row-destaque' : ''),
    });
  }

  // ---------------------------------------------------------------------
  // Mercado doméstico: consumo aparente, coeficiente de exportação e
  // penetração da importação (método do diagnóstico setorial da FIESP).
  // Produção da PIA-Produto (IBGE) na mesma cesta de produtos do comércio
  // exterior. Série completa, sem filtro de período (PIA é anual e curta).
  // ---------------------------------------------------------------------
  function renderMercado() {
    const m = csS().mercado;
    const bloco = $('#block-mercado');
    bloco.hidden = !m;
    if (!m) return;
    const y = m.yearly;
    const anos = y.map(r => r.ano);
    const base = m.ano_base_real;
    const sigilos = Math.max(...y.map(r => r.produtos_sigilo));
    $('#mercado-section-note').textContent =
      `Consumo aparente = produção nacional + importação − exportação: o tamanho do mercado brasileiro dos produtos do segmento, venha a oferta de onde vier. `
      + `Coeficiente de exportação = exportação ÷ produção; penetração da importação = importação ÷ consumo aparente. `
      + `Produção: IBGE, PIA-Produto, valor da produção dos mesmos produtos da cesta do comércio exterior (sem serviços e sem pneus novos); comércio: MDIC/Comex Stat, convertido pelo câmbio médio do ano. `
      + (sigilos ? `Alguns produtos têm valor em sigilo no IBGE em certos anos (até ${sigilos} por ano) e ficam fora da produção, o que puxa o consumo aparente um pouco para baixo. ` : '')
      + `Mesmo método do diagnóstico setorial da FIESP.`;
    $('#mercado-ca-sub').textContent = `Produção + importação − exportação, R$ de ${base} (IPCA), ${anos[0]}–${last(anos)}`;
    lineChart($('#chart-mercado-ca'), {
      categories: anos, formatY: fmt.brl, height: 280,
      series: [
        { label: 'Consumo aparente', color: 'var(--series-1)', values: y.map(r => r.consumo_aparente_real), area: true },
        { label: 'Produção nacional', color: 'var(--series-2)', values: y.map(r => r.producao_real) },
        { label: 'Importação', color: 'var(--series-6)', values: y.map(r => r.importacao_real) },
        { label: 'Exportação', color: 'var(--series-4)', values: y.map(r => r.exportacao_real) },
      ],
    });
    lineChart($('#chart-mercado-coef'), {
      categories: anos, formatY: n => fmt.pct(n), height: 280,
      series: [
        { label: 'Penetração da importação', color: 'var(--series-6)', values: y.map(r => r.penetracao_importacao) },
        { label: 'Coeficiente de exportação', color: 'var(--series-4)', values: y.map(r => r.coef_exportacao) },
      ],
    });

    const pr = m.produtos;
    const ini = new Map(pr.itens_inicial.map(i => [i.componente, i]));
    $('#mercado-produtos-sub').textContent = `${pr.ano}, R$ correntes, ordenado pelo consumo aparente. `
      + `Variação da penetração em pontos percentuais desde ${pr.ano_inicial}. * produção parcial: parte dos subprodutos em sigilo no IBGE. Clique no cabeçalho para ordenar.`;
    dataTable($('#table-mercado-produtos'), {
      columns: [
        { key: 'descricao_tab', label: 'Produto' },
        { key: 'consumo_aparente', label: 'Consumo aparente', align: 'right', format: fmt.brl },
        { key: 'producao', label: 'Produção', align: 'right', format: fmt.brl },
        { key: 'coef_exportacao', label: 'Coef. exportação', align: 'right', format: n => fmt.pct(n) },
        { key: 'penetracao_importacao', label: 'Penetração importação', align: 'right', format: n => fmt.pct(n) },
        { key: 'var_penetracao', label: `Var. penetração desde ${pr.ano_inicial}`, align: 'right',
          format: n => n == null ? '-' : (n > 0 ? '+' : '') + fmt.full1(n) + ' p.p.' },
      ],
      rows: pr.itens.map(i => {
        const a = ini.get(i.componente);
        return {
          ...i, descricao_tab: i.descricao + (i.sigilo ? ' *' : ''),
          var_penetracao: (a && a.penetracao_importacao != null && i.penetracao_importacao != null)
            ? i.penetracao_importacao - a.penetracao_importacao : null,
        };
      }),
      pageSize: 10,
    });
  }

  // ---------------------------------------------------------------------
  // 06 — BNDES
  // ---------------------------------------------------------------------
  const PORTES_ORDEM = ['GRANDE', 'MÉDIA', 'PEQUENA', 'MICRO'];
  const CORES_PORTE = { GRANDE: 'var(--series-6)', 'MÉDIA': 'var(--series-8)', PEQUENA: 'var(--series-4)', MICRO: 'var(--series-2)' };

  function renderBndes() {
    const s = csS();
    const anoIni = s.bndes.yearly[0].ano, anoFim = last(s.bndes.yearly).ano;
    $('#bndes-section-note').textContent = `Desembolsos específicos do segmento selecionado (${rotuloCnae()}), em R$ correntes, operações automáticas e não automáticas. `
      + `Sempre em série completa (${anoIni}–${anoFim}${anoFim === CURRENT_YEAR ? ', ano corrente parcial' : ''}), sem filtro de período ou estado — o BNDES não desembolsa o mesmo valor em todo estado, então o ranking por UF abaixo já mostra o retrato real, sem precisar recortar por período.`;

    // BNDES não responde ao filtro de período nem ao de estado nestes 3
    // exhibits (desembolso anual, porte ao longo do tempo, concentração):
    // dado anual e esparso, cortar pelo período padrão (2016-2026) escondia
    // a maior parte do histórico (2002-2026) — mesmo motivo pelo qual
    // Financeiro (PIA) também é exibido sempre em série completa. Comparar
    // por estado não faz sentido aqui (desembolso não é distribuído
    // uniformemente Brasil afora); quem quer ver por estado usa o ranking
    // abaixo, que já é o lugar certo pra isso.
    lineChart($('#chart-bndes-ano'), {
      categories: s.bndes.yearly.map(r => r.ano), formatY: fmt.brl, height: 280,
      series: [{ label: 'Desembolsado', color: 'var(--series-8)', values: s.bndes.yearly.map(r => r.valor_desembolsado), area: true }],
    });

    // Ranking: todos os estados com dado, acumulado no histórico completo.
    // Sem linha de referência (desembolso é um total absoluto, Brasil = soma
    // dos estados) e sem clique (BNDES não tem filtro nesta seção — ver nota
    // acima; o ranking já é o retrato completo, não uma seleção recortável).
    hBarChart($('#rank-bndes-uf'), {
      items: s.bndes.uf_total.map(i => ({ uf: i.uf, label: i.nome_uf, value: i.valor_desembolsado, color: 'var(--series-8)' })),
      formatVal: fmt.brl,
    });

    // Desembolso por porte ao longo do tempo (barra empilhada) + concentração (donut) —
    // as duas leituras que a tabela de 200+ linhas não deixa claras de cara.
    const catsPorte = Array.from(new Set(s.bndes.table.map(r => r.ano))).sort((a, b) => a - b);
    const seriesPorte = PORTES_ORDEM.filter(p => s.bndes.table.some(r => r.porte === p)).map(porte => ({
      label: titleCasePt(porte), color: CORES_PORTE[porte] || 'var(--series-1)',
      values: catsPorte.map(ano => s.bndes.table
        .filter(r => r.ano === ano && r.porte === porte)
        .reduce((a, r) => a + (r.valor_desembolsado || 0), 0))
    }));
    barChart($('#chart-bndes-porte'), { categories: catsPorte, formatY: fmt.brl, height: 280, stacked: true, series: seriesPorte });

    const totalPorte = {};
    s.bndes.table.forEach(r => { totalPorte[r.porte] = (totalPorte[r.porte] || 0) + (r.valor_desembolsado || 0); });
    const totalGeral = Object.values(totalPorte).reduce((a, v) => a + v, 0);
    const grandePct = totalGeral ? ((totalPorte.GRANDE || 0) / totalGeral) * 100 : null;
    $('#bndes-concentracao-sub').textContent = grandePct != null
      ? `Grande porte: ${fmt.full1(grandePct)}% do desembolsado (todo o histórico)`
      : 'Acumulado no histórico completo';
    donutChart($('#chart-bndes-concentracao'), {
      formatVal: fmt.brl, size: 200,
      items: PORTES_ORDEM.filter(p => totalPorte[p]).map(p => ({ label: titleCasePt(p), value: totalPorte[p], color: CORES_PORTE[p] }))
    });

    dataTable($('#table-bndes'), {
      columns: [
        { key: 'ano', label: 'Ano' },
        { key: 'porte', label: 'Porte' },
        { key: 'instrumento', label: 'Instrumento' },
        { key: 'valor_contratado', label: 'Contratado', align: 'right', format: fmt.brl },
        { key: 'valor_desembolsado', label: 'Desembolsado', align: 'right', format: fmt.brl },
      ],
      rows: s.bndes.table,
      pageSize: 10,
    });

    dataTable($('#table-bndes-uf'), {
      columns: [
        { key: 'nome_uf', label: 'UF' },
        { key: 'valor_desembolsado', label: 'Desembolsado (acumulado)', align: 'right', format: fmt.brlFull },
      ],
      rows: s.bndes.uf_total,
      pageSize: 10,
    });
  }

  // ---------------------------------------------------------------------
  // DECOM (bloco opcional — ver blocos_opcionais em config_painel.json)
  // ---------------------------------------------------------------------
  function classifyDecomStatus(status) {
    const s = String(status || '');
    if (/sem medida/i.test(s)) return { emoji: '⚫', label: 'Sem medida' };
    if (/encerrad/i.test(s)) return { emoji: '🔴', label: 'Encerrado' };
    if (/históric|investigad/i.test(s)) return { emoji: '🟡', label: 'Histórico' };
    if (/prorrogad|em vigor|compensat|antidumping|salvaguarda/i.test(s)) return { emoji: '🟢', label: 'Medida ativa' };
    return { emoji: '⚪', label: s };
  }

  function renderDecom() {
    const sh = shared();
    $('#block-decom').hidden = !temDecom();
    if (!temDecom()) return;
    dataTable($('#table-decom'), {
      columns: [
        { key: 'ncm', label: 'NCM' },
        { key: 'pais', label: 'País' },
        { key: 'status', label: 'Status', format: raw => { const c = classifyDecomStatus(raw); return c.emoji + ' ' + c.label; } },
        { key: 'aliquota', label: 'Alíquota' },
        { key: 'data_resolucao', label: 'Resolução' },
        { key: 'circular', label: 'Referência' },
      ],
      rows: sh.decom,
    });

    const ativas = sh.decom.filter(d => classifyDecomStatus(d.status).label === 'Medida ativa').length;
    $('#decom-highlight').innerHTML = `<strong>${ativas}</strong> medida${ativas === 1 ? '' : 's'} ativa${ativas === 1 ? '' : 's'} hoje · <strong>${sh.decom.length}</strong> processo${sh.decom.length === 1 ? '' : 's'} no histórico`;
  }

  // ---------------------------------------------------------------------
  // 08 — Estudos especiais: mesma lógica de 5 modelos consagrados da
  // economia (Autor-Dorn-Hanson, Acemoglu-Restrepo, Melitz, Hsieh-Klenow,
  // Rodrik), alimentada com os dados já tratados no restante do painel.
  // Não são as regressões originais (exigiriam microdado de empresa que não
  // existe publicamente no Brasil) — são gráficos simples (sem dispersão
  // nem regressão), pensados pra quem não é economista de formação. Nos
  // rankings, estados sem dado são excluídos em vez de aparecer zerados.
  // ---------------------------------------------------------------------
  function renderEstudosEspeciais() {
    const s = csS();
    const sh = shared();

    // 1) Exposição ao choque chinês, por estado (Autor, Dorn & Hanson, 2013):
    // peso do estado no emprego do setor (ano-base) x variação da participação
    // chinesa nas importações do setor (primeiro ao último ano com dado).
    const anosRais = s.rais.uf_yearly.map(r => r.ano);
    const anoBaseRais = Math.min(...anosRais);
    const baseUf = s.rais.uf_yearly.filter(r => r.ano === anoBaseRais && r.vinculos > 0);
    const vincNacionalBase = baseUf.reduce((a, r) => a + r.vinculos, 0);
    const china = s.comex.importacao_china_resto_yearly;
    const chinaPct = r => (r.china_usd + r.resto_usd) ? (r.china_usd / (r.china_usd + r.resto_usd)) * 100 : null;
    const anoChinaBase = Math.min(...china.map(r => r.ano)), anoChinaFim = anoFechado(Math.max(...china.map(r => r.ano)));
    const chinaBase = china.find(r => r.ano === anoChinaBase), chinaFim = china.find(r => r.ano === anoChinaFim);
    const choqueNacional = (chinaBase && chinaFim) ? chinaPct(chinaFim) - chinaPct(chinaBase) : 0;

    // Contexto adicional: concentração das importações entre os principais
    // fornecedores (não só o efeito China isolado) e, se o painel tiver o
    // bloco DECOM, as medidas de defesa comercial em vigor.
    const impTop = s.comex.top_paises_latest.importacao;
    const impAno = s.comex.top_paises_latest.ano;
    const impTop10Total = impTop.reduce((a, r) => a + r.valor_usd, 0);
    const chinaImpTop = impTop.find(r => r.pais === 'China');
    const pctChinaImpAtual = (chinaImpTop && impTop10Total) ? (chinaImpTop.valor_usd / impTop10Total) * 100 : null;
    const decomAtivas = temDecom() ? sh.decom.filter(d => classifyDecomStatus(d.status).label === 'Medida ativa').length : null;
    const residual = cnaeCfg().comex_residual;
    $('#ee-analise-china').innerHTML = (residual ? `${cnaeCfg().nota_comex} ` : '')
      + (pctChinaImpAtual != null
        ? `Em ${impAno}, a China responde por <strong>${fmt.full1(pctChinaImpAtual)}%</strong> das importações do segmento entre os 10 maiores fornecedores. `
        : `Em ${impAno}, a China não aparece entre os 10 maiores fornecedores do segmento. `)
      + (decomAtivas != null
        ? `O Brasil mantém hoje <strong>${decomAtivas}</strong> medida${decomAtivas === 1 ? '' : 's'} de defesa comercial em vigor para produtos do setor. `
        : '')
      + (residual ? '' : `O gráfico a seguir isola o efeito específico da China, ponderando o peso de cada estado no emprego do segmento pela variação da participação chinesa nas importações entre ${anoChinaBase} e ${anoChinaFim}.`);

    // Corta em 0,05 p.p. (não só > 0): um valor entre 0 e 0,05 arredonda pra
    // "0,0 p.p." no rótulo (fmt.full1), o que parecia estado sem dado — e
    // limita a 8 barras pra caber sem rolagem, mesmo padrão do resto do painel.
    const exposicaoUf = baseUf.map(r => ({
      uf: r.uf, label: r.nome_uf, value: vincNacionalBase ? (r.vinculos / vincNacionalBase) * choqueNacional : 0,
    })).filter(r => r.value >= 0.05).sort((a, b) => b.value - a.value).slice(0, 8);
    hBarChart($('#ee-chart-exposicao-china'), {
      items: exposicaoUf.map(r => ({ uf: r.uf, label: r.label, value: r.value, color: 'var(--series-6)' })),
      formatVal: n => fmt.full1(n) + ' p.p.',
    });
    if (!exposicaoUf.length) {
      $('#ee-chart-exposicao-china').innerHTML = `<div class="empty-note">${residual
        ? 'Indicador não calculado: comércio exterior residual neste segmento.'
        : `A participação chinesa nas importações do segmento não cresceu entre ${anoChinaBase} e ${anoChinaFim}.`}</div>`;
    }
    const topExp = exposicaoUf[0];
    $('#ee-evidence-china').innerHTML = topExp
      ? `<strong>${topExp.label}</strong> é o estado do setor mais exposto ao choque chinês (indicador de <strong>${fmt.full1(topExp.value)} pontos percentuais</strong>). No total, a China ganhou <strong>${fmt.full1(choqueNacional)} p.p.</strong> de participação nas importações do setor entre ${anoChinaBase} e ${anoChinaFim}.`
      : '';

    // 2) Investimento (BNDES per capita) x emprego (Acemoglu & Restrepo, 2020, proxy).
    const anoFimVinc = Math.max(...anosRais);
    const vincFimPorUf = new Map(s.rais.uf_yearly.filter(r => r.ano === anoFimVinc).map(r => [r.uf, r.vinculos]));

    // Contexto adicional: tamanho e concentração do crédito, não só o
    // recorte por vínculo. totalPorteBn/grandePctBn são reaproveitados mais
    // abaixo, no resumo executivo do topo da seção.
    const bndesHistorico = s.bndes.yearly.reduce((a, r) => a + (r.valor_desembolsado || 0), 0);
    const bndesRecentes = s.bndes.yearly.slice(-3);
    const bndesMediaRecente = bndesRecentes.length ? bndesRecentes.reduce((a, r) => a + (r.valor_desembolsado || 0), 0) / bndesRecentes.length : null;
    const totalPorteBn = {};
    s.bndes.porte_total.forEach(p => { totalPorteBn[p.porte] = p.valor_desembolsado; });
    const totalGeralBn = Object.values(totalPorteBn).reduce((a, v) => a + v, 0);
    const grandePctBn = totalGeralBn ? ((totalPorteBn.GRANDE || 0) / totalGeralBn) * 100 : null;
    $('#ee-analise-bndes').innerHTML = `O setor recebeu <strong>${fmt.brl(bndesHistorico)}</strong> em desembolsos do BNDES entre ${s.bndes.yearly[0].ano} e ${last(s.bndes.yearly).ano}, com média de <strong>${fmt.brl(bndesMediaRecente)}</strong> ao ano nos 3 exercícios mais recentes. `
      + (grandePctBn != null ? `Desse total, <strong>${fmt.full1(grandePctBn)}%</strong> foi para empresas de grande porte, uma concentração que limita o acesso das empresas menores a essa linha de financiamento. ` : '')
      + `O gráfico a seguir olha esse crédito pela ótica do emprego, dividindo o total acumulado de cada estado pelos vínculos mais recentes, para checar se o crédito realmente se traduziu em mais gente contratada.`;

    const percapita = s.bndes.uf_total
      .map(r => { const v = vincFimPorUf.get(r.uf); return v > 0 ? { uf: r.uf, label: r.nome_uf, value: r.valor_desembolsado / v } : null; })
      .filter(Boolean).sort((a, b) => b.value - a.value).slice(0, 8);
    hBarChart($('#ee-chart-bndes-percapita'), {
      items: percapita.map(r => ({ uf: r.uf, label: r.label, value: r.value, color: 'var(--series-8)' })),
      formatVal: fmt.brl,
    });
    const topInv = percapita[0];
    $('#ee-evidence-bndes').innerHTML = topInv
      ? `<strong>${topInv.label}</strong> teve o maior desembolso do BNDES por vínculo do segmento, <strong>${fmt.brl(topInv.value)}</strong> por trabalhador, acumulado entre ${s.bndes.yearly[0].ano} e ${last(s.bndes.yearly).ano}, sem que isso signifique necessariamente o estado que mais cresceu em emprego no período.`
      : '';

    // 3) Heterogeneidade de firmas (Melitz, 2003): distribuição por porte +
    // concentração geográfica de quem exporta.
    const anoTam = Math.max(...s.rais.tamanho_yearly.map(r => r.ano));
    const tamLatest = s.rais.tamanho_yearly.filter(r => r.ano === anoTam);
    // "0 Empregado" = estabelecimento ativo sem vínculo em 31/12 (a RAIS da
    // borracha traz essa faixa; a da fundição começava em 20).
    const ORDEM_PORTE_TAM = ['0 Empregado', 'De 1 a 4', 'De 5 a 9', 'De 10 a 19', 'De 20 a 49', 'De 50 a 99',
      'De 100 a 249', 'De 250 a 499', 'De 500 a 999', '1000 ou Mais'];
    const tamOrdenado = ORDEM_PORTE_TAM.map(faixa => tamLatest.find(r => r.faixa === faixa)).filter(Boolean);

    // Contexto adicional: consolidação do número de estabelecimentos ao longo
    // do tempo e escolaridade da mão de obra (outra seção do painel), que
    // ajudam a explicar a heterogeneidade retratada nos dois gráficos abaixo.
    const totBase = s.rais.uf_yearly_total.find(r => r.ano === anoBaseRais);
    const totFim = s.rais.uf_yearly_total.find(r => r.ano === anoFimVinc);
    const varEstab = (totBase && totBase.estabelecimentos) ? ((totFim.estabelecimentos - totBase.estabelecimentos) / totBase.estabelecimentos) * 100 : null;
    const esc = s.rais.escolaridade_latest;
    const totalEsc = esc.items.reduce((a, i) => a + i.frequencia, 0);
    const baixaEsc = esc.items.filter(i => /analfabeto|fundamental|5ª/i.test(i.categoria)).reduce((a, i) => a + i.frequencia, 0);
    const pctBaixaEsc = totalEsc ? (baixaEsc / totalEsc) * 100 : null;
    $('#ee-analise-melitz').innerHTML = (totBase && totFim
      ? `O número de estabelecimentos do setor foi de <strong>${fmt.full(totBase.estabelecimentos)}</strong> em ${anoBaseRais} para <strong>${fmt.full(totFim.estabelecimentos)}</strong> em ${anoFimVinc}, uma variação de ${fmt.full1(varEstab)}%, coerente com uma indústria de capital intensivo, em que crescer costuma significar produzir mais por planta, não necessariamente abrir mais unidades. `
      : '')
      + (pctBaixaEsc != null ? `Some a isso o fato de que <strong>${fmt.full1(pctBaixaEsc)}%</strong> da mão de obra (${esc.ano}) ainda tem no máximo o ensino fundamental completo, o que ajuda a explicar por que a adoção de processos mais automatizados avança devagar. ` : '')
      + `Os dois gráficos a seguir mostram essa heterogeneidade por outro ângulo, como as empresas se distribuem por porte e como a atividade exportadora, que exige escala mínima, se concentra num grupo bem mais restrito de estados.`;

    barChart($('#ee-chart-porte'), {
      categories: tamOrdenado.map(r => r.faixa), formatY: fmt.full, height: 260,
      series: [{ label: 'Estabelecimentos', color: 'var(--series-2)', values: tamOrdenado.map(r => r.estabelecimentos) }],
    });
    const anoExpUf = anoFechado(Math.max(...s.comex.uf_yearly.map(r => r.ano)));
    const exportUfAno = s.comex.uf_yearly.filter(r => r.ano === anoExpUf && r.fluxo === 'Exportação' && r.valor_usd > 0);
    const exportUf = [...exportUfAno].sort((a, b) => b.valor_usd - a.valor_usd).slice(0, 10);
    hBarChart($('#ee-chart-export-uf'), {
      items: exportUf.map(r => ({ uf: r.uf, label: r.nome_uf, value: r.valor_usd, color: 'var(--series-4)' })),
      formatVal: fmt.usd,
    });
    const totalEstab = tamOrdenado.reduce((a, r) => a + r.estabelecimentos, 0);
    const pequenas = tamOrdenado.filter(r => ['0 Empregado', 'De 1 a 4', 'De 5 a 9', 'De 10 a 19'].includes(r.faixa)).reduce((a, r) => a + r.estabelecimentos, 0);
    const pctPequenas = totalEstab ? (pequenas / totalEstab) * 100 : null;
    const totalExp = exportUfAno.reduce((a, r) => a + r.valor_usd, 0);
    const topExportShare = (exportUf[0] && totalExp) ? (exportUf[0].valor_usd / totalExp) * 100 : null;
    $('#ee-evidence-melitz').innerHTML =
      (pctPequenas != null ? `<strong>${fmt.full1(pctPequenas)}%</strong> dos estabelecimentos do segmento (${anoTam}) têm até 19 vínculos. ` : '') +
      (!residual && exportUf[0] && topExportShare != null ? `Mas a exportação é concentrada, com <strong>${exportUf[0].nome_uf}</strong> respondendo sozinho por <strong>${fmt.full1(topExportShare)}%</strong> do valor exportado em ${anoExpUf}.` : '');

    // 4) Instabilidade da produtividade (Hsieh & Klenow, 2009, proxy agregada).
    const grupo = setorCfg().grupo_cnae;
    const finF = sh.financeiro.grupo;
    const produtividadeF = finF.map(r => (r.vti != null && r.pessoal_ocupado) ? (r.vti * 1000) / r.pessoal_ocupado : null);

    // Contexto adicional: produtividade do segmento em 2024 (PIA por classe,
    // único ano com essa abertura) frente ao grupo, no mesmo ano.
    const prodGrupoLatest = produtividadeF[produtividadeF.length - 1];
    const finCnae = sh.financeiro.por_cnae_2024.find(r => r.cnae === state.sector);
    const grupoMesmoAno = finCnae ? finF.find(r => r.ano === finCnae.ano) : null;
    const prodCnae = (finCnae && finCnae.vti != null && finCnae.pessoal_ocupado) ? (finCnae.vti * 1000) / finCnae.pessoal_ocupado : null;
    const prodGrupoMesmoAno = (grupoMesmoAno && grupoMesmoAno.vti != null && grupoMesmoAno.pessoal_ocupado) ? (grupoMesmoAno.vti * 1000) / grupoMesmoAno.pessoal_ocupado : null;
    const gapProd = (prodCnae && prodGrupoMesmoAno) ? ((prodCnae - prodGrupoMesmoAno) / prodGrupoMesmoAno) * 100 : null;
    $('#ee-analise-produtividade').innerHTML = (prodGrupoLatest != null
      ? `Em ${last(finF).ano}, a produtividade do grupo ${grupo} (VTI por pessoal ocupado) chegou a <strong>${fmt.brl(prodGrupoLatest)}</strong>. `
      : '')
      + (gapProd != null
        ? `No mesmo recorte de ${finCnae.ano} aberto por classe, ${cnaeCfg().rotulo.toLowerCase()} ficou em <strong>${fmt.brl(prodCnae)}</strong>, ${fmt.full1(Math.abs(gapProd))}% ${gapProd >= 0 ? 'acima' : 'abaixo'} da média do grupo. `
        : '')
      + `O gráfico a seguir mostra a instabilidade dessa série ano a ano, o retrato mais próximo que os dados públicos permitem de má alocação de recursos dentro do setor.`;

    lineChart($('#ee-chart-produtividade'), {
      categories: finF.map(r => r.ano), formatY: fmt.brl, height: 260,
      series: [{ label: `VTI / pessoal ocupado (grupo ${grupo})`, color: 'var(--series-3)', values: produtividadeF, area: true }],
    });
    const variacoes = [];
    for (let i = 1; i < produtividadeF.length; i++) {
      if (produtividadeF[i - 1]) variacoes.push(((produtividadeF[i] - produtividadeF[i - 1]) / produtividadeF[i - 1]) * 100);
    }
    const maiorQueda = variacoes.length ? Math.min(...variacoes) : null;
    const maiorAlta = variacoes.length ? Math.max(...variacoes) : null;
    $('#ee-evidence-produtividade').innerHTML = (maiorQueda != null && maiorAlta != null)
      ? `Ano a ano, a produtividade do grupo ${grupo} já variou de <strong>${fmt.full1(maiorQueda)}%</strong> a <strong>+${fmt.full1(maiorAlta)}%</strong>.`
      : '';

    // 5) Produção x emprego, indexados (Rodrik, 2016, reaplicado ao setor).
    // Os dois índices partem de 100 no mesmo ano (o primeiro ano com as duas
    // séries), senão as linhas começam em pontos diferentes do gráfico.
    const prodRotulo = setorCfg().producao_titulo.toLowerCase();
    $('#ee-producao-emprego-sub').textContent = `Emprego do segmento (RAIS) x ${prodRotulo} (IBGE/PIM-PF, média anual do índice sem efeito sazonal; não é exclusiva do segmento)`;
    const producaoAnual = producaoMediaAnual('indice_dessaz');
    const empregoPorAnoEE = new Map(s.rais.uf_yearly_total.map(r => [r.ano, r.vinculos]));
    const anoInicioRodrik = Math.max(Math.min(...s.rais.uf_yearly_total.map(r => r.ano)), producaoAnual[0].ano);
    const catRodrik = annualCategories([s.rais.uf_yearly_total, producaoAnual]).filter(a => a >= anoInicioRodrik);
    const vincBaseTot = empregoPorAnoEE.get(anoInicioRodrik);
    const prodBase = (producaoAnual.find(r => r.ano === anoInicioRodrik) || {}).valor;
    const empregoIdx = s.rais.uf_yearly_total.map(r => ({ ano: r.ano, valor: vincBaseTot ? (r.vinculos / vincBaseTot) * 100 : null }));
    const producaoIdx = producaoAnual.map(r => ({ ano: r.ano, valor: prodBase ? (r.valor / prodBase) * 100 : null }));

    // Contexto adicional: variação de emprego numa janela mais curta (últimos
    // ~5 anos), pra separar o movimento recente da tendência de duas décadas.
    const vincHistorico = s.rais.uf_yearly_total;
    const vinc5 = vincHistorico[Math.max(0, vincHistorico.length - 6)];
    const vincAtualTot = last(vincHistorico);
    const varEmprego5 = (vinc5 && vinc5.vinculos) ? ((vincAtualTot.vinculos - vinc5.vinculos) / vinc5.vinculos) * 100 : null;
    $('#ee-analise-rodrik').innerHTML = (varEmprego5 != null
      ? `Nos últimos ${vincAtualTot.ano - vinc5.ano} anos, o emprego formal do segmento ${varEmprego5 >= 0 ? 'cresceu' : 'recuou'} ${fmt.full1(Math.abs(varEmprego5))}%. A ${prodRotulo} (referência nacional do IBGE, não exclusiva do segmento) segue uma trajetória própria. `
      : '')
      + `O gráfico a seguir indexa as duas séries a partir de ${anoInicioRodrik}, o que permite comparar o ritmo de cada uma ao longo do tempo sem depender da unidade de medida original de nenhuma delas.`;

    lineChart($('#ee-chart-producao-emprego'), {
      categories: catRodrik, formatY: n => fmt.full1(n), height: 260,
      series: [
        { label: 'Emprego (índice, base 100)', color: 'var(--series-2)', values: seriesAnnual(empregoIdx, 'valor', catRodrik) },
        { label: 'Produção física, divisão (índice, base 100)', color: 'var(--series-6)', values: seriesAnnual(producaoIdx, 'valor', catRodrik) },
      ],
    });
    const ultEmprego = last(empregoIdx.filter(r => catRodrik.includes(r.ano)));
    const ultProd = last(producaoIdx.filter(r => catRodrik.includes(r.ano) && r.valor != null));
    $('#ee-evidence-rodrik').innerHTML = (ultEmprego && ultProd && catRodrik.length)
      ? `Com base 100 em ${catRodrik[0]}, o emprego do segmento está em <strong>${fmt.full1(ultEmprego.valor)}</strong> (${ultEmprego.ano}) e a ${prodRotulo} em <strong>${fmt.full1(ultProd.valor)}</strong> (${ultProd.ano}).`
      : '';

    // Panorama do setor: parágrafo de abertura com dados de todo o painel
    // (produção, financeiro, emprego, CAGED, comex, BNDES), não só das 5
    // leituras abaixo, seguido de uma frase de transição e dos achados em
    // bullets. Texto corrido primeiro, números depois, como um research note.
    // Produção: só existe o índice da divisão (não há série em toneladas por
    // CNAE), então o texto fala da evolução do índice no último ano fechado.
    const prodBruto = producaoMediaAnual('indice_bruto');
    const prodUlt = last(prodBruto), prodPen = prodBruto[prodBruto.length - 2];
    const varProd = (prodUlt && prodPen && prodPen.valor) ? ((prodUlt.valor - prodPen.valor) / prodPen.valor) * 100 : null;

    const finLatest = last(sh.financeiro.grupo);
    const margemLatest = (finLatest && finLatest.receita_liquida_total && finLatest.custos_despesas_totais != null)
      ? ((finLatest.receita_liquida_total - finLatest.custos_despesas_totais) / finLatest.receita_liquida_total) * 100 : null;

    const vincLatest = last(s.rais.uf_yearly_total);
    const vincBaseTotal = s.rais.uf_yearly_total[0];
    const varEmpregoLongo = (vincBaseTotal && vincBaseTotal.vinculos) ? ((vincLatest.vinculos - vincBaseTotal.vinculos) / vincBaseTotal.vinculos) * 100 : null;
    const saldo12m = s.caged.saldo_monthly_national.slice(-12).reduce((a, r) => a + (r.saldo || 0), 0);

    const comexLatest = last(s.comex.yearly);
    const saldoComex = comexLatest ? comexLatest.exportacao_usd - comexLatest.importacao_usd : null;

    // totalPorteBn/grandePctBn já foram calculados lá em cima, na análise de crédito.
    // Ano corrente do Comex vem parcial: o panorama usa o último ano fechado.
    const comexFechado = comexLatest && comexLatest.ano === CURRENT_YEAR ? s.comex.yearly[s.comex.yearly.length - 2] : comexLatest;
    const saldoComexFechado = comexFechado ? comexFechado.exportacao_usd - comexFechado.importacao_usd : null;
    const sc = setorCfg();
    $('#ee-sumario-texto').innerHTML = (varProd != null
      ? `A ${sc.producao_titulo.toLowerCase()} (índice IBGE, referência para os dois segmentos) fechou ${prodUlt.ano} com variação de ${varProd >= 0 ? '+' : ''}${fmt.full1(varProd)}% sobre ${prodPen.ano}, e o grupo ${sc.grupo_cnae} teve margem operacional de ${fmt.full1(margemLatest)}% em ${finLatest.ano}. `
      : `O grupo ${sc.grupo_cnae} teve margem operacional de ${fmt.full1(margemLatest)}% em ${finLatest.ano}. `)
      + `Em ${s.label.toLowerCase()}, o emprego formal soma ${fmt.full(vincLatest.vinculos)} vínculos em ${vincLatest.ano}, uma variação de ${fmt.full1(varEmpregoLongo)}% desde ${vincBaseTotal.ano}, e o CAGED mostra saldo de ${fmt.full(saldo12m)} contratações líquidas nos últimos 12 meses. `
      + (cnaeCfg().comex_residual
        ? `O comércio exterior do segmento é residual (${fmt.usd(comexFechado.exportacao_usd)} exportados e ${fmt.usd(comexFechado.importacao_usd)} importados em ${comexFechado.ano}). `
        : `O comércio exterior fechou ${comexFechado.ano} em ${saldoComexFechado >= 0 ? 'superávit' : 'déficit'} de ${fmt.usd(Math.abs(saldoComexFechado))}. `)
      + (grandePctBn != null ? `No crédito do BNDES, empresas de grande porte respondem por ${fmt.full1(grandePctBn)}% do total desembolsado ao segmento. ` : '')
      + `As cinco leituras abaixo detalham a concorrência externa, o crédito e o investimento, a estrutura do setor, a produtividade e a relação entre produção e emprego, cada uma com gráfico e dado próprios.`;

    const bullets = [];
    if (topExp && !residual) bullets.push(`<strong>${topExp.label}</strong> é o estado mais exposto ao choque de importação chinesa, com indicador de ${fmt.full1(topExp.value)} p.p., num contexto em que a China ganhou ${fmt.full1(choqueNacional)} p.p. de participação nas importações do setor desde ${anoChinaBase}.`);
    if (topInv) bullets.push(`<strong>${topInv.label}</strong> concentra o maior desembolso do BNDES por vínculo, ${fmt.brl(topInv.value)} por trabalhador, o que mostra que volume de crédito não é sinônimo direto de geração de emprego.`);
    if (!residual && exportUf[0] && topExportShare != null) bullets.push(`A exportação é concentrada, com <strong>${exportUf[0].nome_uf}</strong> respondendo por ${fmt.full1(topExportShare)}% do valor exportado em ${anoExpUf}.`);
    if (maiorQueda != null && maiorAlta != null) bullets.push(`A produtividade do grupo ${grupo} já oscilou de ${fmt.full1(maiorQueda)}% a +${fmt.full1(maiorAlta)}% de um ano para o outro.`);
    if (ultEmprego && ultProd) bullets.push(`Com base 100 em ${catRodrik[0]}, o emprego do segmento está em ${fmt.full1(ultEmprego.valor)} e a ${prodRotulo} em ${fmt.full1(ultProd.valor)}.`);
    $('#ee-sumario-bullets').innerHTML = bullets.map(b => `<li>${b}</li>`).join('');
  }

  // ---------------------------------------------------------------------
  // Gargalos do setor
  // ---------------------------------------------------------------------
  function renderGargalos() {
    const s = csS(), sh = shared();
    const cards = [];

    {
      const esc = s.rais.escolaridade_latest;
      const total = esc.items.reduce((a, i) => a + i.frequencia, 0);
      const baixaEsc = esc.items.filter(i => /analfabeto|fundamental|5ª/i.test(i.categoria)).reduce((a, i) => a + i.frequencia, 0);
      const pct = total ? (baixaEsc / total) * 100 : null;
      cards.push({
        title: 'Mão de obra qualificada é escassa',
        text: 'Boa parte da força de trabalho do setor ainda não completou o ensino médio, o que limita a adoção de processos mais técnicos e automatizados.',
        evidence: pct != null ? `<strong>${fmt.full1(pct)}%</strong> dos trabalhadores (${esc.ano}) têm no máximo o ensino fundamental completo.` : ''
      });
    }
    {
      const items = s.caged.tipo_movimentacao_breakdown_total;
      const total = items.reduce((a, i) => a + i.quantidade, 0);
      const rotatividade = items.filter(i => /reemprego|a pedido|prazo det/i.test(i.tipo)).reduce((a, i) => a + i.quantidade, 0);
      const pct = total ? (rotatividade / total) * 100 : null;
      cards.push({
        title: 'Alta rotatividade de mão de obra',
        text: 'Muitas contratações e desligamentos são de curto prazo ou por decisão do próprio trabalhador, sinal de dificuldade em reter equipe treinada.',
        evidence: pct != null ? `<strong>${fmt.full1(pct)}%</strong> das movimentações registradas (${s.caged.coverage.inicio} a ${s.caged.coverage.fim}) foram reempregos, contratos por prazo determinado ou pedidos de desligamento.` : ''
      });
    }
    {
      const portes = s.bndes.porte_total;
      const total = portes.reduce((a, i) => a + i.valor_desembolsado, 0);
      const grande = portes.find(i => i.porte === 'GRANDE');
      const pct = grande && total ? (grande.valor_desembolsado / total) * 100 : null;
      const top3 = s.bndes.uf_total.slice(0, 3).reduce((a, i) => a + i.valor_desembolsado, 0);
      const pctUf = total ? (top3 / total) * 100 : null;
      cards.push({
        title: 'Acesso a crédito concentrado',
        text: 'O crédito do BNDES para o setor está concentrado em poucas empresas e estados, deixando fabricantes menores e de outras regiões com menos acesso a financiamento.',
        evidence: (pct != null ? `<strong>${fmt.full1(pct)}%</strong> dos desembolsos do BNDES foram para empresas de grande porte. ` : '') +
          (pctUf != null ? `Os 3 principais estados concentram <strong>${fmt.full1(pctUf)}%</strong> do total.` : '')
      });
    }
    // Concorrência externa: só vira gargalo quando o comércio exterior do
    // segmento é relevante e deficitário (no residual, % e saldo enganam).
    if (!cnaeCfg().comex_residual) {
      const anoRef = s.comex.top_paises_latest.ano;
      const row = s.comex.yearly.find(r => r.ano === anoRef);
      const saldo = row ? row.exportacao_usd - row.importacao_usd : null;
      const medidas = temDecom() ? sh.decom.filter(d => /medida compensat|antidumping|prorrogad/i.test(d.status)).length : null;
      if (saldo != null && saldo < 0) {
        const cobertura = row.importacao_usd ? (row.exportacao_usd / row.importacao_usd) * 100 : null;
        cards.push({
          title: 'Concorrência com produtos importados',
          text: 'O Brasil compra mais desse tipo de produto do exterior do que vende, o que pressiona os preços e a competitividade da produção nacional.',
          evidence: `Déficit comercial de <strong>${fmt.usd(Math.abs(saldo))}</strong> em ${anoRef}` +
            (cobertura != null ? `; as exportações cobrem <strong>${fmt.full1(cobertura)}%</strong> das importações. ` : '. ') +
            (medidas != null ? `Há <strong>${medidas}</strong> medida(s) de defesa comercial ativa(s) contra importados (fonte: DECOM/GECEX).` : '')
        });
      }
    }

    $('#gargalos-grid').innerHTML = cards.map((c, i) => `
      <div class="gargalo-row">
        <div class="gargalo-num">${String(i + 1).padStart(2, '0')}</div>
        <div>
          <h3>${c.title}</h3>
          <p>${c.text}</p>
          <div class="gargalo-evidence">${c.evidence}</div>
        </div>
      </div>
    `).join('');
  }

  // ---------------------------------------------------------------------
  // Referências: fontes e metodologia (estático, montado uma vez)
  // ---------------------------------------------------------------------
  function renderReferencias(data) {
    const sc = setorCfg();
    const secs = setores().map(c => data.sectors[c.codigo]).filter(Boolean);
    const s0 = secs[0];
    const anos = rows => { const a = (rows || []).map(r => r.ano).filter(Boolean); return a.length ? `${Math.min(...a)}–${Math.max(...a)}` : '-'; };
    const prod = data.shared.producao.indice;
    const cov = s0.caged.coverage || {};
    const ind = data.shared.financeiro.indicadores;
    const linhas = [
      ['Produção física', 'PIM-PF/IBGE', `${prod[0].ano}–${last(prod).ano}`],
      ['Financeiro e indicadores de desempenho', 'PIA-Empresa/IBGE', ind ? `${ind.ano_inicial}–${ind.ano_final}` : anos(data.shared.financeiro.grupo)],
      ['Empresas ativas', 'CEMPRE/IBGE', s0.cempre ? anos(s0.cempre.brasil) : '-'],
      ['Emprego formal e emprego por município', 'RAIS/MTE', anos(s0.rais.uf_yearly_total)],
      ['CAGED', 'CAGED/MTE', cov.inicio ? `${cov.inicio} a ${cov.fim}` : '-'],
      ['Comércio exterior', 'Comexstat', anos(s0.comex.yearly)],
      ['Comércio mundial', 'Comtrade', anos(s0.comtrade.brazil_yearly)],
      ['Mercado doméstico', 'PIA-Produto/IBGE e Comexstat', s0.mercado ? anos(s0.mercado.yearly) : '-'],
      ['BNDES', 'BNDES', anos(s0.bndes.yearly)],
      ['Cadeia produtiva', 'Contas Nacionais/IBGE', anos(data.cadeia.produto.oferta)],
      ['Energia industrial', 'EPE e ANEEL', '2012 em diante'],
      ['Preços e câmbio', 'IBGE (IPCA, IPP) e BCB', `1990–${last(data.shared.macro).ano}`],
    ];
    if ((data.shared.decom || []).length) linhas.splice(9, 0, ['Defesa comercial', 'DECOM/GECEX', 'Histórico']);
    $('#referencias-table tbody').innerHTML = linhas.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td class="mono">${r[2]}</td></tr>`).join('');

    const notas = [
      `Valores em reais constantes estão em R$ de ${anoBasePrecos()}.`,
      `${cfg().agregado ? cfg().agregado.rotulo + ' soma os dois segmentos do painel; ' : ''}o setor não inclui a fabricação de pneus novos.`,
      'O comércio exterior usa a mesma cesta de produtos do diagnóstico setorial da FIESP.',
      `A produção física cobre a divisão borracha e plástico (o IBGE não publica só borracha); alguns gráficos financeiros usam o grupo ${sc.grupo_cnae}, que inclui pneus novos, e estão sinalizados.`,
      'A RAIS muda de metodologia em 2022 e a PIA-Empresa em 2024 (nova série): compare com cautela os anos de transição.',
      margemFormula(),
      'Simulador de cenários: resultados ilustrativos, não são previsões.',
    ];
    $('#referencias-notas').innerHTML = notas.map(t => `<p class="pdi-note">• ${t}</p>`).join('');
  }

  // ---------------------------------------------------------------------
  // Cadeia Produtiva: Sankey fornecedores -> elo -> clientes, com dados das
  // Contas Nacionais (ver extrair_cadeia.py). O ponto de partida é o produto
  // do setor; clicar num fornecedor/cliente recentraliza o diagrama naquela
  // atividade, usando o fluxo atividade x atividade. Valores em R$ milhões.
  // Tudo que é específico do setor (produto, atividade, textos, botões de
  // elos, cores) vem de cadeia_config.json, via data.cadeia.config — para
  // replicar para outro CNAE não precisa mexer aqui (COMO_REPLICAR_CADEIA.md).
  // ---------------------------------------------------------------------
  const PRODUTO = 'produto'; // valor de "centro" que, na config, abre o próprio produto
  const CADEIA_TOP = 7;
  const CADEIA_CORES = {
    fornecedor: 'var(--series-2)', va: 'var(--series-5)', importado: 'var(--series-6)', margem: 'var(--baseline)',
    cliente: 'var(--text-muted)', demandaFinal: 'var(--series-4)', outros: 'var(--baseline)',
  };
  const NOMES_DF = {
    exportacao: 'Exportação', governo: 'Consumo do governo', isflsf: 'Consumo das ISFLSF',
    familias: 'Consumo das famílias', fbcf: 'Investimento (FBCF)', estoque: 'Variação de estoque',
  };

  function renderCadeia(data) {
    const c = data.cadeia;
    const cfg = c.config;
    const corCliente = cod => {
      const g = cfg.grupos_cor.find(x => x.cods.includes(cod));
      return g ? `var(--${g.cor})` : CADEIA_CORES.cliente;
    };
    const A = c.atividades;
    const idx = new Map(A.map((a, i) => [a.cod, i]));
    const vendas = A.map(() => []), compras = A.map(() => []);
    c.fluxos.forEach(([o, d, v]) => { vendas[o].push([d, v]); compras[d].push([o, v]); });
    const brl = v => fmt.brl(v * 1e6);
    const pct = (v, tot) => tot ? fmt.pct(100 * v / tot) : '-';
    const multOrdenado = A.map(a => a.multiplicador).sort((x, y) => y - x);
    const rankMult = m => multOrdenado.indexOf(m) + 1;
    const mult2 = m => m.toFixed(2).replace('.', ',');

    const ofertaUlt = c.produto.oferta[c.produto.oferta.length - 1];
    const ofertaPri = c.produto.oferta[0];
    const destUlt = c.produto.destinos.filter(d => d.ano === c.ano);
    const pImp = o => 100 * o.importacao / (o.producao + o.importacao);
    let trilha = [PRODUTO];

    // Agrupa os menores em "Outros" pra o diagrama não virar uma franja ilegível.
    function topN(nodes, n, rotuloOutros) {
      const pos = nodes.filter(x => x.value > 0).sort((a, b) => b.value - a.value);
      if (pos.length <= n + 1) return pos;
      const resto = pos.slice(n);
      return [...pos.slice(0, n), {
        label: rotuloOutros, value: resto.reduce((s, x) => s + x.value, 0), color: CADEIA_CORES.outros,
        tip: [{ label: 'Inclui', value: `${resto.length} itens menores` }],
      }];
    }
    // Um setor que compra dele mesmo (ex.: autopeças de autopeças) aparece
    // no diagrama, mas não é clicável: já é o centro.
    function noAtividade(i, value, cor, total) {
      const clickable = A[i].cod !== trilha[trilha.length - 1];
      return {
        label: A[i].nome, value, color: cor, cod: A[i].cod, clickable,
        tip: [{ label: 'Participação', value: pct(value, total) },
          ...(clickable ? [{ label: '', value: 'Clique para ver a cadeia deste setor' }] : [])],
      };
    }
    function nosDemandaFinal(df, total) {
      return Object.entries(df).filter(([, v]) => v > 0).map(([k, v]) => ({
        label: NOMES_DF[k], value: v, color: CADEIA_CORES.demandaFinal, tip: [{ label: 'Participação', value: pct(v, total) }],
      }));
    }

    function montarProduto() {
      const total = ofertaUlt.demanda;
      const direita = topN(destUlt.map(d => d.tipo === 'atividade'
        ? noAtividade(idx.get(d.cod), d.valor, corCliente(d.cod), total)
        : { label: d.nome, value: d.valor, color: CADEIA_CORES.demandaFinal, tip: [{ label: 'Participação', value: pct(d.valor, total) }] }),
        CADEIA_TOP, 'Outros clientes');

      // Insumos: estrutura de custos da atividade do setor, escalada para a produção do produto.
      const met = A[idx.get(cfg.atividade)];
      const escala = ofertaUlt.producao / met.vbp;
      const porAtividade = new Map();
      c.insumos_atividade.forEach(r => porAtividade.set(r.atividade, (porAtividade.get(r.atividade) || 0) + r.valor * escala));
      const margens = ofertaUlt.demanda - ofertaUlt.producao - ofertaUlt.importacao;
      const esquerda = [
        ...topN([...porAtividade].map(([cod, v]) => noAtividade(idx.get(cod), v, CADEIA_CORES.fornecedor, total)), CADEIA_TOP - 2, 'Outros insumos'),
        { label: 'Salários e lucros', value: met.va * escala, color: CADEIA_CORES.va,
          tip: [{ label: 'Participação', value: pct(met.va * escala, total) }, { label: '', value: `Valor adicionado do próprio setor (${cfg.nome})` }] },
        { label: `Importação de ${cfg.nome_produto}`, value: ofertaUlt.importacao, color: CADEIA_CORES.importado,
          tip: [{ label: 'Da oferta a preço básico', value: pct(ofertaUlt.importacao, ofertaUlt.producao + ofertaUlt.importacao) }] },
        { label: 'Margens e impostos', value: margens, color: CADEIA_CORES.margem,
          tip: [{ label: 'Participação', value: pct(margens, total) }, { label: '', value: 'Comércio, transporte e impostos sobre produtos' }] },
      ];
      // Link para a RAIS do painel, só se a config apontar setores que existem nele.
      const empregos = (cfg.empregos_rais || []).filter(s => data.sectors[s]).map(s => last(data.sectors[s].rais.uf_yearly_total));
      return {
        titulo: cfg.nome,
        sub: `${cfg.descricao_produto} · ${c.ano}`,
        esquerda, direita,
        resumo: [
          ['Produção nacional', brl(ofertaUlt.producao)],
          ['Importado', pct(ofertaUlt.importacao, ofertaUlt.producao + ofertaUlt.importacao)],
          ['Multiplicador', `${mult2(met.multiplicador)} (${rankMult(met.multiplicador)}º de ${A.length})`],
          ...(empregos.length ? [['Empregos formais', `${fmt.compact(empregos.reduce((s, e) => s + (e ? e.vinculos : 0), 0))} em ${empregos[0] ? empregos[0].ano : ''}`, cfg.empregos_rais[0], 'block-emprego']] : []),
        ],
        nota: `${cfg.nota_escopo ? cfg.nota_escopo + ' ' : ''}Clientes: IBGE, produto ${cfg.produto} da TRU. ${cfg.nota_insumos} Multiplicador: MIP 2015.`,
      };
    }

    function montarAtividade(cod) {
      const i = idx.get(cod), a = A[i];
      const totalDir = vendas[i].reduce((s, [, v]) => s + v, 0)
        + Object.values(a.demanda_final).reduce((s, v) => s + Math.max(v, 0), 0);
      const direita = topN([
        ...vendas[i].map(([j, v]) => noAtividade(j, v, corCliente(A[j].cod), totalDir)),
        ...nosDemandaFinal(a.demanda_final, totalDir),
      ], CADEIA_TOP, 'Outros clientes');
      const esquerda = [
        ...topN(compras[i].map(([j, v]) => noAtividade(j, v, CADEIA_CORES.fornecedor, a.vbp)), CADEIA_TOP - 1, 'Outros insumos'),
        { label: 'Salários e lucros', value: a.va, color: CADEIA_CORES.va, tip: [{ label: 'Participação', value: pct(a.va, a.vbp) }] },
      ];
      // A produção (VBP) e o que os clientes pagam (preço de consumidor) não
      // batem: a diferença são importações, margens e impostos — ou, no
      // comércio e nos transportes, margens embutidas no preço de outros produtos.
      const somaEsq = esquerda.reduce((s, n) => s + n.value, 0), somaDir = direita.reduce((s, n) => s + n.value, 0);
      const dif = somaDir - somaEsq;
      if (dif > 0.01 * somaDir) esquerda.push({ label: 'Importações, margens e impostos', value: dif, color: CADEIA_CORES.margem });
      else if (-dif > 0.01 * somaEsq) direita.push({ label: 'Margens embutidas em outros produtos', value: -dif, color: CADEIA_CORES.margem });
      return {
        titulo: a.nome,
        sub: `${a.descricao} · ${c.ano}`,
        esquerda, direita,
        resumo: [
          ['Produção', brl(a.vbp)],
          ['Ocupações', fmt.compact(a.ocupacoes)],
          ['Multiplicador', `${mult2(a.multiplicador)} (${rankMult(a.multiplicador)}º de ${A.length})`],
          ['Insumos importados', a.pct_insumos_importados != null ? fmt.pct(100 * a.pct_insumos_importados) : '-'],
        ],
        nota: 'Fluxo entre atividades: IBGE, TRU, consumo intermediário a preço de consumidor, levado de produto para a atividade que o produz; os insumos incluem a parte importada. Multiplicador e insumos importados: MIP 2015.',
      };
    }

    function nomeCentro(cod) { return cod === PRODUTO ? cfg.nome : A[idx.get(cod)].nome; }

    function renderTrilha() {
      const nav = $('#cadeia-trilha');
      nav.innerHTML = trilha.length < 2 ? '' : trilha.map((cod, i) => i === trilha.length - 1
        ? `<span class="cadeia-crumb atual" aria-current="true">${nomeCentro(cod)}</span>`
        : `<button type="button" class="cadeia-crumb" data-i="${i}">${nomeCentro(cod)}</button><span class="cadeia-crumb-sep">›</span>`).join('');
      nav.querySelectorAll('button[data-i]').forEach(b => b.addEventListener('click', () => {
        trilha = trilha.slice(0, +b.dataset.i + 1);
        desenhar();
      }));
    }

    function renderResumo(m) {
      const el = $('#cadeia-resumo');
      el.innerHTML = m.resumo.map(([rot, val, setor, bloco]) => setor
        ? `<button type="button" class="cad-resumo-item link" data-sector="${setor}" data-target="${bloco}">${rot} <b>${val}</b> →</button>`
        : `<span class="cad-resumo-item">${rot} <b>${val}</b></span>`).join('');
      el.querySelectorAll('[data-sector]').forEach(b => b.addEventListener('click', () => goToBlock(b.dataset.sector, b.dataset.target)));
    }

    function desenhar() {
      const centro = trilha[trilha.length - 1];
      const m = centro === PRODUTO ? montarProduto() : montarAtividade(centro);
      $('#cadeia-sankey-title').textContent = m.titulo;
      $('#cadeia-sankey-sub').textContent = m.sub;
      $('#cadeia-nota').textContent = m.nota;
      $('#cadeia-select').value = centro;
      sankeyChart($('#cadeia-sankey'), {
        left: m.esquerda, right: m.direita,
        center: { label: m.titulo },
        headers: { left: 'DE ONDE VEM', right: 'PARA ONDE VAI' },
        formatV: brl,
        onNodeClick: n => irPara(n.cod),
      });
      renderTrilha();
      renderResumo(m);
      document.querySelectorAll('#cad-elos .cad-elo').forEach(b => b.classList.toggle('ativo', b.dataset.centro === centro));
    }

    function irPara(cod) {
      if (!cod || cod === trilha[trilha.length - 1]) return;
      const ja = trilha.indexOf(cod);
      trilha = ja >= 0 ? trilha.slice(0, ja + 1) : [...trilha, cod];
      desenhar();
    }

    // Seletor com todas as atividades, pra quem quer olhar outra cadeia.
    const sel = $('#cadeia-select');
    sel.innerHTML = `<option value="${PRODUTO}">${cfg.nome} (${cfg.nome_produto})</option>` +
      [...A].sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map(a => `<option value="${a.cod}">${a.nome}</option>`).join('');
    sel.addEventListener('change', () => { trilha = [sel.value]; desenhar(); });

    $('#cad-elos').innerHTML = '<span class="cad-elos-chamada">Veja a cadeia de:</span>' + cfg.elos.map(grupo =>
      `<span class="cad-elo-grupo">${grupo.rotulo ? `<span class="cad-elo-rotulo">${grupo.rotulo}</span>` : ''}${grupo.itens.map(e =>
        `<button type="button" class="cad-elo${e.centro === PRODUTO ? ' principal' : ''}" data-centro="${e.centro}">${e.label}</button>`).join('')}</span>`
    ).join('<span class="cad-elo-seta" aria-hidden="true">→</span>');
    $('#cad-elos').querySelectorAll('.cad-elo').forEach(b => b.addEventListener('click', () => {
      trilha = b.dataset.centro === PRODUTO ? [PRODUTO] : [PRODUTO, b.dataset.centro];
      desenhar();
    }));

    // Linha fina: os três números que resumem a cadeia, no meio do texto.
    const base = destUlt.filter(d => d.valor > 0).reduce((s, d) => s + d.valor, 0);
    // Principais clientes da config, pra frase dizer exatamente o que soma.
    const pPrincipais = 100 * destUlt.filter(d => cfg.principais_clientes.cods.includes(d.cod)).reduce((s, d) => s + d.valor, 0) / base;
    $('#cad-chapeu').textContent = `Cadeia produtiva · IBGE, ${c.ano}`;
    $('#cad-titulo').textContent = cfg.titulo;
    $('#cad-linha-fina').innerHTML =
      `Em ${c.ano}, o Brasil consumiu <b>${brl(ofertaUlt.demanda)}</b> em ${cfg.nome_produto}. ` +
      `<b>${Math.round(pPrincipais)}%</b> foram para ${cfg.principais_clientes.rotulo}, e <b>${Math.round(pImp(ofertaUlt))}%</b> vieram de fora, ` +
      `contra ${fmt.pct(pImp(ofertaPri))} em ${ofertaPri.ano}.`;

    desenhar();
  }

  // ---------------------------------------------------------------------
  // Energia Industrial: consumo/custo de energia da indústria de
  // transformação inteira — 27 estados + Brasil, 24 divisões CNAE.
  // Filtros: estados (multi-select), setor (CNAE, single-select) e período
  // (mês inicial/final). A série completa por divisão x UF (~115 mil
  // linhas) é grande demais para embutir tudo no data.json principal, então
  // fica em 24 arquivos (data/energia/serie-cnae-N.json) carregados sob
  // demanda ao trocar de setor, com cache em memória depois do 1º fetch.
  // Clicar numa barra do ranking (gráfico 2) adiciona aquele estado ao
  // filtro; clicar numa barra da composição (gráfico 3) remove.
  // ---------------------------------------------------------------------
  function renderEnergiaIndustrial(data) {
    const ei = data.energia_industrial;
    const cache = {};
    const cacheComposicao = {};
    const anoMesLo0 = Number(ei.coverage.inicio.replace('-', ''));
    const anoMesHi0 = Number(ei.coverage.fim.replace('-', ''));
    const meses = [];
    for (let k = anoMesLo0; k <= anoMesHi0;) {
      meses.push(k);
      const a = Math.floor(k / 100), m = k % 100;
      k = m === 12 ? (a + 1) * 100 + 1 : k + 1;
    }

    const stateEI = {
      ufs: new Set(['SP', 'BR']), cnaes: new Set([10]),
      focoUf: 'SP', focoCnae: 10, lo: anoMesLo0, hi: anoMesHi0,
    };
    const ufInfo = {}; ei.ufs.forEach(u => { ufInfo[u.uf] = u.nome; });
    const divInfo = {}; ei.divisoes.forEach(d => { divInfo[d.cnae] = d; });
    const ufsOrdenadas = () => ei.ufs.map(u => u.uf).filter(uf => stateEI.ufs.has(uf));
    const cnaesOrdenadas = () => ei.divisoes.map(d => d.cnae).filter(c => stateEI.cnaes.has(c));

    async function ensureCnae(cnae) {
      if (!cache[cnae]) cache[cnae] = await fetch(`data/energia/serie-cnae-${cnae}.json?v=dev`).then(r => r.json());
      return cache[cnae];
    }
    async function ensureComposicaoUf(uf) {
      if (!cacheComposicao[uf]) cacheComposicao[uf] = await fetch(`data/energia/composicao-uf-${uf}.json?v=dev`).then(r => r.json());
      return cacheComposicao[uf];
    }

    // ---- Estados: multi-select em dropdown de checkboxes ----
    const ufBtn = $('#ei-uf-btn'), ufPanel = $('#ei-uf-panel');
    function renderUfPanel() {
      ufPanel.innerHTML = ei.ufs.map(u => `
        <label class="multiselect-option">
          <input type="checkbox" value="${u.uf}"${stateEI.ufs.has(u.uf) ? ' checked' : ''}>
          ${u.nome}
        </label>`).join('');
      ufPanel.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        if (inp.checked) { stateEI.ufs.add(inp.value); stateEI.focoUf = inp.value; }
        else if (stateEI.ufs.size > 1) {
          stateEI.ufs.delete(inp.value);
          if (stateEI.focoUf === inp.value) stateEI.focoUf = ufsOrdenadas()[0];
        } else inp.checked = true; // sempre pelo menos 1 estado selecionado
        syncUfBtn();
        update();
      }));
    }
    function syncUfBtn() {
      const sel = ufsOrdenadas();
      ufBtn.textContent = sel.length <= 3 ? sel.map(uf => ufInfo[uf]).join(', ') : sel.length + ' estados selecionados';
    }
    ufBtn.addEventListener('click', () => {
      const abrir = ufPanel.hidden;
      ufPanel.hidden = !abrir;
      ufBtn.setAttribute('aria-expanded', String(abrir));
    });
    document.addEventListener('click', (evt) => {
      if (!$('#ei-uf-multiselect').contains(evt.target)) {
        ufPanel.hidden = true; ufBtn.setAttribute('aria-expanded', 'false');
      }
    });
    renderUfPanel();
    syncUfBtn();

    // ---- Setores (CNAE): multi-select em dropdown de checkboxes, mesmo
    // widget dos estados — dá pra comparar setor igual dá pra comparar UF.
    const cnaeBtn = $('#ei-cnae-btn'), cnaePanel = $('#ei-cnae-panel');
    function renderCnaePanel() {
      cnaePanel.innerHTML = ei.divisoes.map(d => `
        <label class="multiselect-option">
          <input type="checkbox" value="${d.cnae}"${stateEI.cnaes.has(d.cnae) ? ' checked' : ''}>
          ${d.cnae} · ${titleCasePt(d.descricao)}
        </label>`).join('');
      cnaePanel.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        const cnae = Number(inp.value);
        if (inp.checked) { stateEI.cnaes.add(cnae); stateEI.focoCnae = cnae; }
        else if (stateEI.cnaes.size > 1) {
          stateEI.cnaes.delete(cnae);
          if (stateEI.focoCnae === cnae) stateEI.focoCnae = cnaesOrdenadas()[0];
        } else inp.checked = true; // sempre pelo menos 1 setor selecionado
        syncCnaeBtn();
        update();
      }));
    }
    function syncCnaeBtn() {
      const sel = cnaesOrdenadas();
      cnaeBtn.textContent = sel.length <= 2 ? sel.map(c => titleCasePt(divInfo[c].descricao)).join(', ') : sel.length + ' setores selecionados';
    }
    cnaeBtn.addEventListener('click', () => {
      const abrir = cnaePanel.hidden;
      cnaePanel.hidden = !abrir;
      cnaeBtn.setAttribute('aria-expanded', String(abrir));
    });
    document.addEventListener('click', (evt) => {
      if (!$('#ei-cnae-multiselect').contains(evt.target)) {
        cnaePanel.hidden = true; cnaeBtn.setAttribute('aria-expanded', 'false');
      }
    });
    renderCnaePanel();
    syncCnaeBtn();

    // ---- Período: mês/ano inicial e final ----
    const loSel = $('#ei-period-lo-select'), hiSel = $('#ei-period-hi-select');
    function fillMonthOptions(sel, selected) {
      sel.innerHTML = meses.map(k => `<option value="${k}"${k === selected ? ' selected' : ''}>${monthLabel(k)}</option>`).join('');
    }
    fillMonthOptions(loSel, stateEI.lo);
    fillMonthOptions(hiSel, stateEI.hi);
    loSel.addEventListener('change', () => { stateEI.lo = Math.min(Number(loSel.value), stateEI.hi); loSel.value = stateEI.lo; update(); });
    hiSel.addEventListener('change', () => { stateEI.hi = Math.max(Number(hiSel.value), stateEI.lo); hiSel.value = stateEI.hi; update(); });

    // ---- Limpar filtros: volta ao estado padrão (SP+Brasil, 1ª divisão CNAE, período completo) ----
    $('#ei-clear-filters').addEventListener('click', () => {
      stateEI.ufs = new Set(['SP', 'BR']);
      stateEI.cnaes = new Set([10]);
      stateEI.focoUf = 'SP';
      stateEI.focoCnae = 10;
      stateEI.lo = anoMesLo0;
      stateEI.hi = anoMesHi0;
      renderUfPanel(); syncUfBtn();
      renderCnaePanel(); syncCnaeBtn();
      fillMonthOptions(loSel, stateEI.lo);
      fillMonthOptions(hiSel, stateEI.hi);
      update();
    });

    async function update() {
      const cnaesSel = cnaesOrdenadas();
      const cnaesAlvo = cnaesSel.join(',');
      const seriesPorCnae = {};
      await Promise.all(cnaesSel.map(async c => { seriesPorCnae[c] = await ensureCnae(c); }));
      if (cnaesOrdenadas().join(',') !== cnaesAlvo) return; // usuário trocou de novo antes do fetch voltar
      const ufsSel = ufsOrdenadas();
      const inRange = rows => rows.filter(r => (r[0] * 100 + r[1]) >= stateEI.lo && (r[0] * 100 + r[1]) <= stateEI.hi);
      const multiCnae = cnaesSel.length > 1;
      const nomesSelecionados = cnaesSel.map(c => titleCasePt(divInfo[c].descricao)).join(', ');

      // Combinações estado x setor selecionados — 1 linha por combinação
      // nos gráficos de tendência (se só 1 setor estiver marcado, o rótulo
      // fica só o nome do estado, igual antes).
      const combos = [];
      ufsSel.forEach(uf => {
        cnaesSel.forEach(cnae => {
          const rows = inRange((seriesPorCnae[cnae] && seriesPorCnae[cnae][uf]) || []);
          combos.push({ uf, cnae, rows, label: multiCnae ? `${ufInfo[uf]} · ${titleCasePt(divInfo[cnae].descricao)}` : ufInfo[uf] });
        });
      });

      // Brasil fica de fora das 2 linhas de tendência: é o agregado
      // nacional, com magnitude bem maior que qualquer estado sozinho —
      // numa mesma escala linear, ele esmaga as linhas dos estados lá
      // embaixo perto de zero. Continua disponível na tabela e como
      // referência no ranking de custo.
      const combosGrafico = combos.filter(c => c.uf !== 'BR');
      const catTempo = combosGrafico.length ? combosGrafico[0].rows.map(r => r[0] * 100 + r[1]) : [];

      $('#ei-consumo-sub').textContent = `MWh por mês, ${nomesSelecionados}${combos.length !== combosGrafico.length ? ' (Brasil fora do gráfico, ver tabela)' : ''}`;
      lineChart($('#chart-ei-consumo'), {
        categories: catTempo, formatX: monthLabel, formatY: fmt.mwh, height: 280,
        series: combosGrafico.map((c, i) => ({ label: c.label, color: CORES[i % CORES.length], values: c.rows.map(r => r[2]), area: i === 0 })),
      });

      $('#ei-custo-tempo-sub').textContent = `R$/MWh a preços de ${ei.ano_base_deflacao} (deflacionado por IPCA), ${nomesSelecionados}${combos.length !== combosGrafico.length ? ' (Brasil fora do gráfico, ver tabela)' : ''}`;
      lineChart($('#chart-ei-custo-tempo'), {
        categories: catTempo, formatX: monthLabel, formatY: fmt.brl, height: 280,
        series: combosGrafico.map((c, i) => ({ label: c.label, color: CORES[i % CORES.length], values: c.rows.map(r => r[5]) })),
      });

      // Ranking: todos os 27 estados (sem Brasil, que é o agregado), custo
      // do setor em foco (o último marcado/clicado nos setores), no mês
      // final do período selecionado, do mais barato ao mais caro. Linha
      // tracejada marca o valor do Brasil como referência: mais barato que
      // a média nacional fica verde, mais caro fica vermelho. Estados
      // marcados no filtro ficam na cor de destaque, fora dessa escala —
      // assim o ranking mostra direto onde estão os estados escolhidos.
      const divisaoFoco = divInfo[stateEI.focoCnae];
      const serieFoco = seriesPorCnae[stateEI.focoCnae];
      const estados = ei.ufs.filter(u => u.uf !== 'BR');
      const rowsBrCusto = serieFoco['BR'] || [];
      const refCustoRow = rowsBrCusto.find(r => (r[0] * 100 + r[1]) === stateEI.hi) || rowsBrCusto[rowsBrCusto.length - 1];
      const refCusto = refCustoRow ? refCustoRow[5] : null;
      const itemsRanking = estados.map(u => {
        const rows = serieFoco[u.uf] || [];
        const row = rows.find(r => (r[0] * 100 + r[1]) === stateEI.hi) || rows[rows.length - 1];
        return row ? { uf: u.uf, label: u.nome, value: row[5] } : null;
      }).filter(Boolean).sort((a, b) => a.value - b.value);
      // Custo é a tarifa média real da classe Industrial por região (ANEEL/
      // MME) — não varia por divisão CNAE, só por estado/região e mês. O
      // setor em foco continua relevante pro consumo e pro gasto (consumo x
      // essa tarifa), mas não muda o custo unitário em si.
      $('#ei-ranking-custo-title').textContent = 'Ranking de estados por custo de energia (classe industrial)';
      $('#ei-ranking-custo-sub').textContent = `R$/MWh a preços de ${ei.ano_base_deflacao} (fonte: MME/ANEEL), ${monthLabel(stateEI.hi, true)}, estados marcados no filtro em destaque`;
      hBarChart($('#rank-ei-custo-estados'), {
        items: itemsRanking.map(it => ({
          uf: it.uf, label: it.label, value: it.value,
          color: stateEI.ufs.has(it.uf) ? 'var(--series-3)' : (refCusto != null && it.value <= refCusto ? 'var(--good)' : 'var(--bad)'),
        })),
        formatVal: n => fmt.brl(n) + '/MWh',
        reference: refCusto != null ? { value: refCusto, label: 'Brasil: ' + fmt.brl(refCusto) + '/MWh' } : null,
        tooltipExtra: (it) => [{ label: 'Região', value: UF_REGIAO_JS[it.uf] || '' }],
        onClick: (it) => { stateEI.ufs.add(it.uf); stateEI.focoUf = it.uf; renderUfPanel(); syncUfBtn(); update(); },
      });

      // Composição setorial de um estado por vez (o foco: o último estado
      // marcado/clicado) — top 7 divisões + outras. Evita empilhar muitos
      // estados juntos (virava um mosaico difícil de comparar); um estado
      // de cada vez com só 8 fatias é limpo. Divisões marcadas no filtro
      // de setores ficam destacadas, e clicar numa fatia marca esse setor.
      const focoUfAlvo = stateEI.focoUf;
      const composicaoUf = await ensureComposicaoUf(focoUfAlvo);
      if (focoUfAlvo !== stateEI.focoUf || cnaesOrdenadas().join(',') !== cnaesAlvo) return; // mudou de novo antes do fetch voltar
      const linhaComposicao = composicaoUf[String(stateEI.hi)];
      const itemsComposicao = ei.divisoes.map((d, idx) => ({
        cnae: d.cnae, label: titleCasePt(d.descricao), value: (linhaComposicao && linhaComposicao[idx]) || 0,
      })).sort((a, b) => b.value - a.value);
      const top7 = itemsComposicao.slice(0, 7);
      const outras = itemsComposicao.slice(7).reduce((a, it) => a + it.value, 0);
      const itemsComposicaoFinal = [...top7, { cnae: null, label: 'Outras divisões', value: outras }];
      $('#ei-composicao-title').textContent = 'Composição setorial: ' + ufInfo[stateEI.focoUf];
      $('#ei-composicao-sub').textContent = `% do consumo industrial por divisão CNAE, ${monthLabel(stateEI.hi, true)}. Clique num estado do ranking ou numa divisão aqui pra mudar o foco.`;
      rankList($('#rank-ei-composicao'), itemsComposicaoFinal.map((it, i) => ({
        cnae: it.cnae, label: it.label, value: it.value,
        color: it.cnae != null && stateEI.cnaes.has(it.cnae) ? 'var(--series-3)' : CORES[i % CORES.length],
      })), {
        formatVal: n => fmt.pct(n),
        onClick: (it) => {
          if (it.cnae == null) return; // "Outras divisões" não é 1 setor clicável
          stateEI.cnaes.add(it.cnae); stateEI.focoCnae = it.cnae;
          renderCnaePanel(); syncCnaeBtn(); update();
        },
      });

      // Tabela filtrada: estado x setor x mês, para tudo que está marcado.
      const linhas = [];
      combos.forEach(c => {
        c.rows.forEach(r => {
          linhas.push({
            uf: c.uf, uf_nome: ufInfo[c.uf], setor: titleCasePt(divInfo[c.cnae].descricao), k: r[0] * 100 + r[1],
            consumo_mwh: r[2], custo_rs_mwh: r[3], custo_real_rs_mwh: r[5], gasto_rs: r[2] * r[3], participacao_pct: r[4],
          });
        });
      });
      linhas.sort((a, b) => b.k - a.k);
      dataTable($('#table-ei-dados'), {
        columns: [
          { key: 'uf_nome', label: 'UF' },
          { key: 'setor', label: 'Setor' },
          { key: 'k', label: 'Mês', format: monthLabel },
          { key: 'consumo_mwh', label: 'Consumo', align: 'right', format: fmt.mwh },
          { key: 'custo_rs_mwh', label: 'Custo (nominal)', align: 'right', format: n => fmt.brl(n) + '/MWh' },
          { key: 'custo_real_rs_mwh', label: `Custo (R$ ${ei.ano_base_deflacao})`, align: 'right', format: n => fmt.brl(n) + '/MWh' },
          { key: 'gasto_rs', label: 'Gasto', align: 'right', format: fmt.brlFull },
          { key: 'participacao_pct', label: 'Participação', align: 'right', format: n => fmt.pct(n) },
        ],
        rows: linhas,
        pageSize: 20,
      });
    }

    update();
  }

  // ---------------------------------------------------------------------
  // Filtros por bloco: Produção (só período), Emprego/CAGED (período +
  // multi-select de estado), Comex (período + estado único). Cada bloco
  // re-renderiza só a si mesmo quando o filtro muda — não precisa mais de
  // renderAll(), já que os filtros não são mais globais.
  // ---------------------------------------------------------------------
  let empregoUfCtl, cagedUfCtl;

  function setupBlockFilters() {
    wireBlockPeriod(blocks.producao, $('#producao-lo-select'), $('#producao-hi-select'), renderProducao);
    $('#producao-clear').addEventListener('click', () => {
      const bs = blocks.producao;
      bs.lo = bs.boundsLo; bs.hi = bs.boundsHi;
      $('#producao-lo-select').value = bs.lo; $('#producao-hi-select').value = bs.hi;
      renderProducao();
    });

    wireBlockPeriod(blocks.emprego, $('#emprego-lo-select'), $('#emprego-hi-select'), renderEmprego);
    empregoUfCtl = wireBlockUf(blocks.emprego, $('#emprego-uf-btn'), $('#emprego-uf-panel'), $('#emprego-uf-multiselect'), renderEmprego);
    $('#emprego-clear').addEventListener('click', () => {
      const bs = blocks.emprego;
      bs.lo = bs.boundsLo; bs.hi = bs.boundsHi; bs.ufs = new Set(['BR']); bs.focoUf = 'BR';
      $('#emprego-lo-select').value = bs.lo; $('#emprego-hi-select').value = bs.hi;
      empregoUfCtl.render(); empregoUfCtl.sync();
      renderEmprego();
    });

    wireBlockPeriod(blocks.caged, $('#caged-lo-select'), $('#caged-hi-select'), renderCaged);
    cagedUfCtl = wireBlockUf(blocks.caged, $('#caged-uf-btn'), $('#caged-uf-panel'), $('#caged-uf-multiselect'), renderCaged);
    $('#caged-clear').addEventListener('click', () => {
      const bs = blocks.caged;
      bs.lo = bs.boundsLo; bs.hi = bs.boundsHi; bs.ufs = new Set(['BR']); bs.focoUf = 'BR';
      $('#caged-lo-select').value = bs.lo; $('#caged-hi-select').value = bs.hi;
      cagedUfCtl.render(); cagedUfCtl.sync();
      renderCaged();
    });

    wireBlockPeriod(blocks.comex, $('#comex-lo-select'), $('#comex-hi-select'), renderComex);
    wireComexUfSelect(blocks.comex, $('#comex-uf-select'), renderComex);
    $('#comex-clear').addEventListener('click', () => {
      const bs = blocks.comex;
      bs.lo = bs.boundsLo; bs.hi = bs.boundsHi; bs.focoUf = 'BR';
      $('#comex-lo-select').value = bs.lo; $('#comex-hi-select').value = bs.hi;
      $('#comex-uf-select').value = 'BR';
      renderComex();
    });
  }

  // Botões que dependem do setor: abas de segmento na barra lateral, menu
  // "Nesta seção" (só seções com dado) e seletor do Painel Executivo — todos
  // montados a partir de config_painel.json, sem CNAE escrito no HTML.
  // Também numera as seções (01, 02...) na ordem em que aparecem, já que
  // blocos opcionais (DECOM) podem não existir.
  function buildSectorNav() {
    $('#sector-tabs').innerHTML = setores().map(c =>
      `<button type="button" class="seg-btn" data-view="${c.codigo}" role="tab" aria-selected="false" title="${descricaoSetor(c.codigo)}"><span class="seg-btn-nome">${c.rotulo_exec || c.rotulo}</span><span class="seg-btn-cnae">${codigoCurto(c)}</span></button>`).join('');
    $('#exec-seg-toggle').innerHTML = setores().map(c =>
      `<button type="button" class="exec-seg-btn" data-seg="${c.codigo}" role="tab">${c.rotulo_exec}</button>`).join('');
    const metas = secoesVisiveis();
    $('#section-nav').innerHTML = metas.map(m =>
      `<button type="button" role="tab" data-target="${m.target}">${m.title}</button>`).join('');
    metas.forEach(m => {
      const el = document.querySelector(`#${m.target} .section-num`);
      if (el) el.textContent = m.num === '·' ? '' : m.num;
    });
    const grupo = setorCfg().grupo_cnae;
    document.querySelectorAll('[data-grupo-texto]').forEach(el => {
      el.textContent = el.dataset.grupoTexto.replace(/\{grupo\}/g, grupo);
    });
    $('#exec-chart-margem-sub').textContent = `Margem operacional (%) e produtividade (VTI por trabalhador), grupo ${grupo}`;
    document.title = setorCfg().titulo;
    $('#site-header-title').textContent = setorCfg().titulo;
    updateHeaderMeta();
  }

  // Faixa vermelha do topo: título fixo + vista atual e data de atualização,
  // pra quem rola a página saber onde está e de quando é o dado.
  const VIEW_LABELS = { home: 'Painel Executivo', diagnostico: 'Diagnóstico Setorial', simulador: 'Simulador de cenários', cadeia: 'Cadeia Produtiva', 'energia-industrial': 'Energia Industrial', relatorios: 'Relatórios', referencias: 'Referências' };
  function updateHeaderMeta() {
    const vista = isSectorView(state.view) ? rotuloCnae(state.view) : (VIEW_LABELS[state.view] || '');
    const atualizado = state.data.meta.gerado_em ? 'Painel publicado em ' + formatDataBr(state.data.meta.gerado_em) : '';
    $('#site-header-meta').textContent = [vista, atualizado].filter(Boolean).join(' · ');
  }

  // view-tabs (home) + sector-tabs (um por CNAE) + foot-tabs-top/bottom
  // (energia industrial/relatorios/referencias) formam juntas as "vistas"
  // mutuamente exclusivas. home é o Painel Executivo; as abas de CNAE
  // mostram o painel de dados (trocando o setor); as demais trocam para uma
  // página própria.
  function setupViewTabs() {
    const allBtns = Array.from(document.querySelectorAll('#view-tabs button, #sector-tabs button, #foot-tabs-top button, #foot-tabs-bottom button'));
    const homeView = $('#home-view');
    const dataView = $('#data-view');
    const btnDados = $('#btn-dados');
    const energiaIndustrialView = $('#energia-industrial-view');
    const cadeiaView = $('#cadeia-view');
    const diagnosticoView = $('#diagnostico-view');
    const simuladorView = $('#simulador-view');
    const relatoriosView = $('#relatorios-view');
    const referenciasView = $('#referencias-view');

    function applyVisibility() {
      const isData = isSectorView(state.view);
      homeView.hidden = state.view !== 'home';
      dataView.hidden = !isData;
      btnDados.classList.toggle('active', isData);
      btnDados.setAttribute('aria-selected', isData ? 'true' : 'false');
      energiaIndustrialView.hidden = state.view !== 'energia-industrial';
      cadeiaView.hidden = state.view !== 'cadeia';
      diagnosticoView.hidden = state.view !== 'diagnostico';
      simuladorView.hidden = state.view !== 'simulador';
      // O PDF (5,8 MB) só carrega quando a aba é aberta pela primeira vez.
      const pdf = $('#diagnostico-pdf');
      if (state.view === 'diagnostico' && !pdf.getAttribute('src')) pdf.setAttribute('src', pdf.dataset.src);
      relatoriosView.hidden = state.view !== 'relatorios';
      referenciasView.hidden = state.view !== 'referencias';
    }

    allBtns.forEach(b => b.addEventListener('click', () => {
      if (b.dataset.view === state.view) return;
      allBtns.forEach(x => { x.classList.remove('active'); x.setAttribute('aria-selected', 'false'); });
      b.classList.add('active'); b.setAttribute('aria-selected', 'true');
      state.view = b.dataset.view;
      if (isSectorView(state.view)) {
        state.sector = state.view;
        renderAll();
      }
      applyVisibility();
      updateHeaderMeta();
    }));

    // "Dados do setor" na barra lateral abre o segmento escolhido por último.
    btnDados.addEventListener('click', () => {
      const b = document.querySelector(`#sector-tabs button[data-view="${state.sector}"]`);
      if (b && state.view !== state.sector) b.click();
      window.scrollTo({ top: 0 });
    });

    setupSectionNav();
    applyVisibility();
  }

  function scrollToBlock(id) {
    const target = document.getElementById(id);
    if (!target) return;
    if (target.matches('#data-view > section.section')) {
      mostrarSecao(id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    const headerH = document.querySelector('.site-header').offsetHeight + document.querySelector('.filter-row').offsetHeight;
    const top = target.getBoundingClientRect().top + window.scrollY - headerH - 16;
    window.scrollTo({ top, behavior: 'smooth' });
  }

  // Navegação "nesta seção" na sidebar: clique rola até o bloco (sem usar
  // scrollIntoView, para não afetar o resto da página) e o botão ativo
  // acompanha a posição de leitura via IntersectionObserver.
  function setupSectionNav() {
    $('#section-nav').addEventListener('click', e => {
      const b = e.target.closest('button[data-target]');
      if (b) mostrarSecao(b.dataset.target);
    });
  }

  // ---------------------------------------------------------------------
  // Resumo do setor: KPIs de destaque + lista clicável para cada dado
  // ---------------------------------------------------------------------
  // num é atribuído na ordem (secoesVisiveis), pulando blocos opcionais
  // sem dado; '·' = seção sem número.
  const SECTION_META = [
    { target: 'block-producao', title: 'Produção física', sub: 'Índice de produção física da divisão (IBGE), mensal.' },
    { target: 'block-financeiro', title: 'Financeiro', sub: 'VTI, pessoal ocupado, receita e custos, PIA/IBGE.' },
    { target: 'block-emprego', title: 'Emprego formal', sub: 'Vínculos, escolaridade, ocupação e remuneração (RAIS).' },
    { target: 'block-caged', title: 'CAGED', sub: 'Admissões e desligamentos mensais.' },
    { target: 'block-comex', title: 'Comércio exterior', sub: 'Exportação e importação, Comex e Comtrade.' },
    { target: 'block-mercado', title: 'Mercado doméstico', sub: 'Consumo aparente, coeficiente de exportação e penetração da importação.', opcional: () => !!(state.data && csS().mercado) },
    { target: 'block-bndes', title: 'BNDES', sub: 'Desembolsos por UF, porte e instrumento.' },
    { target: 'block-decom', title: 'DECOM', sub: 'Medidas de defesa comercial em vigor.', opcional: () => temDecom() },
    { target: 'block-focus', title: 'Expectativas de mercado', sub: 'Selic, IPCA, dólar e PIB esperados pelo mercado (boletim Focus/BCB).', opcional: () => !!(state.data && shared().focus) },
    { target: 'block-estudos-especiais', title: 'Estudos especiais', sub: 'Panorama do setor: concorrência, crédito, estrutura, produtividade e emprego.' },
    { target: 'block-gargalos', semNumero: true, title: 'Gargalos do setor', sub: 'Pontos identificados a partir dos dados.' },
  ];
  function secoesVisiveis() {
    let n = 0;
    return SECTION_META.filter(m => !m.opcional || m.opcional())
      .map(m => ({ ...m, num: m.semNumero ? '·' : String(++n).padStart(2, '0') }));
  }
  function renderSectorSummary() {
    $('#sector-desc').textContent = descricaoSetor(state.sector);
    renderLeituras();
    mostrarSecao(state.secao);
  }

  // ---------------------------------------------------------------------
  // Legenda "Fonte · Período · Atualizado em" — mesmo padrão usado no
  // Painel Executivo e anexado a cada seção numerada, pra quem entra no
  // painel saber na hora o que está vendo (pedido do cliente).
  // ---------------------------------------------------------------------
  function formatDataBr(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-');
    return `${d}/${m}/${y}`;
  }
  // "Fonte · Dados até X": a data de publicação do site (meta.gerado_em) não
  // diz de quando é o dado — cada fonte tem sua defasagem (RAIS anual,
  // CAGED mensal, PIA com 2 anos de atraso...). cobertura = chave de coberturaDados().
  function renderCaptionMeta(el, { fonte, periodo, cobertura } = {}) {
    if (!el) return;
    const partes = [];
    if (fonte) partes.push('Fonte: ' + fonte);
    if (periodo) partes.push(periodo);
    const c = cobertura && coberturaDados()[cobertura];
    if (c) partes.push('Dados até ' + c);
    el.textContent = partes.join(' · ');
  }
  function mesAno(ano, mes) { return MESES[mes - 1] + '/' + ano; }
  function coberturaDados() {
    const d = state.data, sh = d.shared;
    const s = d.sectors[cnaeCodigos()[0]];
    const ultAno = rows => Math.max(...rows.map(r => r.ano));
    const prod = last(sh.producao.indice);
    const [cAno, cMes] = s.caged.coverage.fim.split('-').map(Number);
    const comexAno = ultAno(s.comex.yearly);
    return {
      producao: mesAno(prod.ano, prod.mes),
      financeiro: String(ultAno(sh.financeiro.grupo)),
      emprego: String(ultAno(s.rais.uf_yearly_total)),
      caged: mesAno(cAno, cMes),
      comex: comexAno === CURRENT_YEAR ? `${comexAno} (ano parcial)` : String(comexAno),
      comtrade: String(ultAno(s.comtrade.brazil_yearly)),
      mercado: s.mercado ? String(last(s.mercado.yearly).ano) : null,
      bndes: ultAno(s.bndes.yearly) === CURRENT_YEAR ? `${CURRENT_YEAR} (ano parcial)` : String(ultAno(s.bndes.yearly)),
    };
  }
  const SECTION_FONTES = {
    financeiro: 'IBGE — PIA-Empresa',
    emprego: 'RAIS',
    caged: 'CAGED',
    comex: 'MDIC/Comex Stat + UN Comtrade',
    bndes: 'BNDES',
    mercado: 'IBGE — PIA-Produto + MDIC/Comex Stat',
    decom: 'DECOM/GECEX',
    'estudos-especiais': 'RAIS, Comex, BNDES e PIA/IBGE (mesmas bases do restante do painel)',
  };
  function initSectionCaptions() {
    Object.keys(SECTION_FONTES).forEach(key => {
      renderCaptionMeta($('#section-caption-' + key), { fonte: SECTION_FONTES[key], cobertura: key });
    });
  }

  // ---------------------------------------------------------------------
  // Painel Executivo (Início): números principais do setor + menu de
  // navegação. Pensado pra quem entra pela 1ª vez e não quer o
  // detalhamento completo de cara (pedido do cliente) — não remove nem
  // esconde nada do painel de dados, é só uma porta de entrada mais simples.
  // ---------------------------------------------------------------------
  const EXEC_OUTRAS_SECOES = [
    { view: 'diagnostico', title: 'Diagnóstico Setorial', sub: 'Apresentação completa do planejamento estratégico do setor (DECOMTEC - FIESP, 2026).' },
    { view: 'simulador', title: 'Simulador de cenários', sub: 'Escolha o que acha que vai acontecer com a China, o câmbio e a demanda, e veja aonde isso leva o setor.' },
    { view: 'cadeia', title: 'Cadeia Produtiva', sub: 'De onde vêm os insumos da borracha e para quem ela vai (IBGE).' },
    { view: 'energia-industrial', title: 'Energia Industrial', sub: 'Consumo e custo de energia na indústria, por estado.' },
    { view: 'relatorios', title: 'Relatórios', sub: 'Em construção.' },
    { view: 'referencias', title: 'Referências', sub: 'Fontes e metodologia de cada indicador.' },
  ];

  function goToBlock(sector, target) {
    const btn = document.querySelector(`#sector-tabs button[data-view="${sector}"]`);
    if (btn) btn.click();
    requestAnimationFrame(() => scrollToBlock(target));
  }
  function goToView(view) {
    const btn = document.querySelector(`[data-view="${view}"]`);
    if (btn) btn.click();
  }

  function kpiTile({ id, label, value, unit, sub, note, trendHtml, sector, target }) {
    const clickable = !!(sector && target);
    const tag = clickable ? 'button' : 'div';
    const attrs = clickable ? `type="button" data-sector="${sector}" data-target="${target}"` : '';
    return `<${tag} class="kpi-tile${clickable ? '' : ' no-click'}" ${attrs} id="${id}">
      <span class="kpi-label">${label}</span>
      <span class="kpi-value">${value}${unit ? `<span class="kpi-unit">${unit}</span>` : ''}</span>
      <span class="kpi-sub">${sub || ''}</span>
      ${trendHtml || ''}
      ${note ? `<span class="kpi-note">${note}</span>` : ''}
      <span class="caption-meta" data-caption></span>
    </${tag}>`;
  }

  // Seta + variação % em relação ao período anterior, no formato pedido
  // pelo cliente ("IMPORTAÇÕES ↑ XX% em relação ao ano anterior").
  // subirEhRuim: a seta continua indicando a direção, mas a cor diz se foi
  // bom ou ruim para o setor (importação subindo = vermelho).
  function trendHtml(atual, anterior, labelPeriodo, subirEhRuim = false) {
    if (atual == null || anterior == null || !anterior) return '';
    const pct = ((atual - anterior) / Math.abs(anterior)) * 100;
    const dir = pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat';
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
    const cor = dir === 'flat' ? 'flat' : ((dir === 'up') !== subirEhRuim ? 'up' : 'down');
    return `<span class="kpi-trend kpi-trend-${cor}">${arrow} ${fmt.pct(Math.abs(pct))} ${labelPeriodo || 'em relação ao ano anterior'}</span>`;
  }
  // Pega o último ano "fechado" de uma série anual (ignora o ano corrente,
  // que costuma vir parcial no Comex/RAIS) e o ano anterior a ele, pra
  // comparação justa de variação.
  function ultimosDoisAnosFechados(rows) {
    if (!rows || !rows.length) return { atual: null, anterior: null };
    let idx = rows.length - 1;
    if (rows[idx].ano === CURRENT_YEAR && idx > 0) idx -= 1;
    return { atual: rows[idx] || null, anterior: rows[idx - 1] || null };
  }

  function renderExecutivo() {
    if (!state.data) return;
    const execSector = state.execSector || state.sector;
    document.querySelectorAll('#exec-seg-toggle .exec-seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.seg === execSector);
    });

    const sd = state.data.sectors[execSector];
    const sh = shared();
    $('#exec-seg-desc').textContent = descricaoSetor(execSector);
    const { atual: empregoAtual, anterior: empregoAnterior } = ultimosDoisAnosFechados(sd.rais.uf_yearly_total);
    const { atual: comexAtual, anterior: comexAnterior } = ultimosDoisAnosFechados(sd.comex.yearly);
    const finRow = sh.financeiro.por_cnae_2024.find(r => r.cnae === execSector);

    // Produção não tem cartão: o único dado é o índice da divisão (igual para
    // todos os segmentos), e indicador que não muda com o seletor de
    // segmento não fica na grade que muda (lição do painel-base). Ele entra
    // no gráfico 1, com rótulo explícito.
    //
    // Segmento com comércio exterior residual: variação % sobre valores
    // muito pequenos vira número absurdo (US$ 50 mil -> US$ 300 mil = +500%),
    // então os cartões de comex mostram só o valor, sem seta, com nota curta.
    const residual = !!(cnaeCfg(execSector) || {}).comex_residual;
    const notaResidual = residual ? 'Comércio exterior residual neste segmento' : '';
    const trendComex = (atual, anterior, subirEhRuim) => (residual || atual == null || anterior == null) ? '' : trendHtml(atual, anterior, null, subirEhRuim);

    const saldoAtualUsd = comexAtual ? (comexAtual.exportacao_usd - comexAtual.importacao_usd) : null;
    const saldoAnteriorUsd = comexAnterior ? (comexAnterior.exportacao_usd - comexAnterior.importacao_usd) : null;

    const serieFat = seriePiaSegmento(execSector).filter(r => r.receita_liquida);
    const fatU = serieFat[serieFat.length - 1], fatA = serieFat[serieFat.length - 2];
    const ippF = fatorIppAnual();
    const tiles = [
      kpiTile({
        id: 'exec-kpi-faturamento', label: 'Faturamento do setor',
        value: fatU ? fmt.brl(fatU.receita_liquida * 1000) : (finRow ? fmt.brl(finRow.receita_liquida_total * 1000) : '-'),
        sub: fatU ? `Receita líquida em ${fatU.ano}` : 'Receita líquida em 2024',
        trendHtml: fatU && fatA && ippF.fator[fatU.ano] && ippF.fator[fatA.ano] ? trendHtml(fatU.receita_liquida * ippF.fator[fatU.ano], fatA.receita_liquida * ippF.fator[fatA.ano]) : '',
        note: fatU && fatU.ano >= 2024 ? `Variação real (IPP); ${fatU.ano} é da nova série da PIA` : '',
        sector: execSector, target: 'block-financeiro',
      }),
      kpiTile({
        id: 'exec-kpi-emprego', label: 'Empregos formais',
        value: fmt.compact(empregoAtual ? empregoAtual.vinculos : null),
        sub: empregoAtual ? `Vínculos ativos em ${empregoAtual.ano}` : '',
        trendHtml: empregoAtual && empregoAnterior ? trendHtml(empregoAtual.vinculos, empregoAnterior.vinculos) : '',
        sector: execSector, target: 'block-emprego',
      }),
      kpiTile({
        id: 'exec-kpi-estabelecimentos', label: 'Número de estabelecimentos',
        value: fmt.compact(empregoAtual ? empregoAtual.estabelecimentos : null),
        sub: empregoAtual ? `Em ${empregoAtual.ano}` : '',
        trendHtml: empregoAtual && empregoAnterior ? trendHtml(empregoAtual.estabelecimentos, empregoAnterior.estabelecimentos) : '',
        sector: execSector, target: 'block-emprego',
      }),
      kpiTile({
        id: 'exec-kpi-exportacao', label: 'Exportações',
        value: comexAtual ? fmt.usd(comexAtual.exportacao_usd) : '-',
        sub: comexAtual ? `US$ FOB em ${comexAtual.ano}` : '',
        trendHtml: comexAtual && comexAnterior ? trendComex(comexAtual.exportacao_usd, comexAnterior.exportacao_usd) : '',
        note: notaResidual,
        sector: execSector, target: 'block-comex',
      }),
      kpiTile({
        id: 'exec-kpi-importacao', label: 'Importações',
        value: comexAtual ? fmt.usd(comexAtual.importacao_usd) : '-',
        sub: comexAtual ? `US$ FOB em ${comexAtual.ano}` : '',
        trendHtml: comexAtual && comexAnterior ? trendComex(comexAtual.importacao_usd, comexAnterior.importacao_usd, true) : '',
        note: notaResidual,
        sector: execSector, target: 'block-comex',
      }),
      kpiTile({
        id: 'exec-kpi-saldo', label: 'Saldo da balança comercial',
        value: saldoAtualUsd != null ? fmt.usd(saldoAtualUsd) : '-',
        sub: comexAtual ? `Exportação − importação, ${comexAtual.ano}` : '',
        trendHtml: trendComex(saldoAtualUsd, saldoAnteriorUsd),
        note: notaResidual,
        sector: execSector, target: 'block-comex',
      }),
    ];

    // Custo de energia saiu do Painel Executivo (pedido do usuário) — já
    // tem seção própria (Energia Industrial, no menu de navegação). Fica só
    // no gráfico 4 (margem/produtividade não inclui energia, ver abaixo) e
    // no detalhamento completo daquela seção.
    const grid = $('#exec-kpi-grid');
    grid.innerHTML = tiles.join('');
    grid.querySelectorAll('.kpi-tile[data-sector]').forEach(btn => {
      btn.addEventListener('click', () => goToBlock(btn.dataset.sector, btn.dataset.target));
    });

    renderCaptionMeta($('#exec-kpi-faturamento [data-caption]'), { fonte: 'IBGE/PIA-Empresa', periodo: fatU ? String(fatU.ano) : '2024' });
    renderCaptionMeta($('#exec-kpi-emprego [data-caption]'), { fonte: 'RAIS', cobertura: 'emprego' });
    renderCaptionMeta($('#exec-kpi-estabelecimentos [data-caption]'), { fonte: 'RAIS', cobertura: 'emprego' });
    renderCaptionMeta($('#exec-kpi-exportacao [data-caption]'), { fonte: 'MDIC/Comex Stat', cobertura: 'comex' });
    renderCaptionMeta($('#exec-kpi-importacao [data-caption]'), { fonte: 'MDIC/Comex Stat', cobertura: 'comex' });
    renderCaptionMeta($('#exec-kpi-saldo [data-caption]'), { fonte: 'MDIC/Comex Stat', cobertura: 'comex' });

    renderExecCharts(execSector);
    renderExecNavMenu(execSector);
  }

  // ---------------------------------------------------------------------
  // Os 4 gráficos executivos, respondendo às perguntas que o cliente listou:
  // o setor cresce? as importações crescem? de onde vem a concorrência?
  // como estão custos e competitividade?
  // ---------------------------------------------------------------------
  // Deflator do faturamento e do VTI: IPP da divisão do setor (preço ao
  // produtor da borracha e plástico, IBGE), média anual. Só anos com os 12
  // meses (a série começa em dez/2009). Fator para preços do último ano.
  function fatorIppAnual() {
    const porAno = {};
    shared().macro.forEach(r => { if (r.ipp_setor != null) (porAno[r.ano] = porAno[r.ano] || []).push(r.ipp_setor); });
    const medias = {};
    Object.entries(porAno).forEach(([a, v]) => { if (v.length === 12) medias[a] = v.reduce((x, y) => x + y, 0) / 12; });
    const anos = Object.keys(medias).map(Number).sort((a, b) => a - b);
    const anoBase = medias[anoBasePrecos()] ? anoBasePrecos() : anos[anos.length - 1];
    const base = medias[anoBase];
    const fator = {};
    anos.forEach(a => { fator[a] = base / medias[a]; });
    return { fator, anoBase, primeiroAno: anos[0] };
  }

  function indexarBase100(vals) {
    const base = vals.find(v => v != null && v !== 0);
    if (base == null) return vals.map(() => null);
    return vals.map(v => (v == null ? null : (v / base) * 100));
  }

  function renderExecCharts(execSector) {
    const sd = state.data.sectors[execSector];
    const sh = shared();

    // 1) O setor está crescendo? Produção (média anual do índice PIM-PF da
    // divisão — igual nos dois segmentos, dito no rótulo), faturamento
    // (grupo CNAE, combinado — não abre por segmento) e empregos (por
    // segmento), indexados a 100 no primeiro ano em comum.
    // Faturamento em R$ correntes subia ~3x de 2007 a 2024, quase tudo
    // inflação: ao lado de produção e empregos (volumes), parecia que o
    // faturamento tinha disparado. Agora é real, deflacionado pelo IPP do
    // setor — por isso o gráfico começa no primeiro ano com IPP completo.
    const sc = setorCfg();
    const ipp = fatorIppAnual();
    const serieSeg = seriePiaSegmento(execSector).filter(r => r.receita_liquida);
    const finAnos = serieSeg.length ? serieSeg.map(r => r.ano) : sh.financeiro.grupo.map(r => r.ano);
    const catCrescimento = finAnos.filter(a => a >= ipp.primeiroAno && ipp.fator[a]);
    $('#exec-chart-crescimento-sub').textContent = `Produção, faturamento real e empregos, indexados (base 100 em ${catCrescimento[0]}). Faturamento deflacionado pelo ${sc.ipp_rotulo} (IBGE)`;
    const producaoPorAno = new Map(producaoMediaAnual('indice_bruto').map(r => [r.ano, r.valor]));
    const empregoPorAno = new Map(sd.rais.uf_yearly_total.map(r => [r.ano, r.vinculos]));
    const finPorAno = serieSeg.length
      ? new Map(serieSeg.map(r => [r.ano, r.receita_liquida * ipp.fator[r.ano]]))
      : new Map(sh.financeiro.grupo.map(r => [r.ano, r.receita_liquida_total * ipp.fator[r.ano]]));
    lineChart($('#exec-chart-crescimento'), {
      categories: catCrescimento, formatY: n => fmt.compact(n), height: 260,
      series: [
        { label: `${sc.producao_titulo} (índice IBGE)`, color: 'var(--series-7)', values: indexarBase100(catCrescimento.map(a => producaoPorAno.has(a) ? producaoPorAno.get(a) : null)) },
        { label: serieSeg.length ? 'Faturamento real (segmento selecionado)' : `Faturamento real (grupo ${sc.grupo_cnae})`, color: 'var(--series-3)', values: indexarBase100(catCrescimento.map(a => finPorAno.has(a) ? finPorAno.get(a) : null)) },
        { label: 'Empregos (segmento selecionado)', color: 'var(--series-5)', values: indexarBase100(catCrescimento.map(a => empregoPorAno.has(a) ? empregoPorAno.get(a) : null)) },
      ],
    });

    // 2) Importações estão crescendo? Exportação x importação do segmento
    // selecionado, em R$ constantes do ano-base (mesma unidade da balança
    // comercial do detalhamento, pra não misturar nominal com real). Corta
    // o ano corrente se vier parcial, senão o fim da linha cai artificial.
    const comexCompleto = sd.comex.yearly.filter(r => r.ano !== CURRENT_YEAR);
    const catComex = comexCompleto.map(r => r.ano);
    $('#exec-chart-comex-sub').textContent = `Exportação x importação, R$ milhões de ${anoBasePrecos()}`
      + ((cnaeCfg(execSector) || {}).comex_residual ? ' — comércio exterior residual neste segmento' : '');
    lineChart($('#exec-chart-comex'), {
      categories: catComex, formatY: fmt.brl, height: 260,
      series: [
        { label: 'Exportação', color: 'var(--series-4)', values: comexCompleto.map(r => r.exportacao_brl_real) },
        { label: 'Importação', color: 'var(--series-6)', values: comexCompleto.map(r => r.importacao_brl_real) },
      ],
    });

    // 3) De onde vem a concorrência? Ranking de países de origem das
    // importações, ano mais recente completo (mesmo recorte do
    // detalhamento em Comércio Exterior).
    const paisesImp = sd.comex.top_paises_latest.importacao || [];
    $('#exec-chart-paises-imp-sub').textContent = `Principais países de origem das importações brasileiras do segmento, ${sd.comex.top_paises_latest.ano}`;
    const anoImp = sd.comex.top_paises_latest.ano;
    const totalImp = (sd.comex.yearly.find(r => r.ano === anoImp) || {}).importacao_usd;
    $('#exec-chart-paises-imp-sub').textContent += totalImp
      ? ` — barra = participação no total importado (${fmt.usd(totalImp)})` : '';
    rankList($('#exec-chart-paises-imp'), paisesImp.map(p => ({ label: p.pais, value: p.valor_usd })), {
      formatVal: fmt.usd, color: 'var(--series-6)', total: totalImp || undefined,
    });

    // 4) Competitividade e produtividade: margem operacional e produtividade
    // (VTI por trabalhador), as duas do grupo CNAE combinado (mesma
    // limitação do faturamento acima — abertura por segmento só em 2024).
    // Eixos diferentes (% x R$), por isso dois eixos no mesmo gráfico —
    // aqui faz sentido comparar, ao contrário de energia (fonte sem
    // relação direta com as duas).
    const finComp = seriePiaSegmento(execSector)
      .filter(r => r.receita_liquida && r.custos_despesas_total != null && r.vti != null && r.pessoal_ocupado)
      .filter(r => ipp.fator[r.ano])
      .map(r => ({
        ano: r.ano,
        margem: ((r.receita_liquida - r.custos_despesas_total) / r.receita_liquida) * 100,
        // VTI por trabalhador em R$ do ano-base (IPP do setor), não corrente
        produtividade: (r.vti * 1000 * ipp.fator[r.ano]) / r.pessoal_ocupado,
      }));
    $('#exec-chart-margem-sub').textContent = `Margem operacional (%) e produtividade (VTI por trabalhador, R$ de ${ipp.anoBase} pelo ${sc.ipp_rotulo}), ${rotuloCnae(execSector)}. ${finComp.length && last(finComp).ano >= 2024 ? last(finComp).ano + ' é da nova série da PIA.' : ''}`;
    $('#exec-margem-nota').textContent = margemFormula();
    dualAxisLineChart($('#exec-chart-margem'), {
      categories: finComp.map(r => r.ano), height: 260,
      seriesLeft: { label: 'Margem operacional (%)', color: 'var(--series-8)', values: finComp.map(r => r.margem) },
      seriesRight: { label: `Produtividade (R$ de ${ipp.anoBase}/trabalhador)`, color: 'var(--series-2)', values: finComp.map(r => r.produtividade) },
      formatYLeft: n => fmt.pct(n), formatYRight: n => fmt.brl(n), plainAxis: true,
    });
  }

  function renderExecNavMenu(execSector) {
    const blocos = secoesVisiveis().map(sec =>
      `<button type="button" class="sector-section-row" data-sector="${execSector}" data-target="${sec.target}"><span class="ssr-num">${sec.num}</span><span class="ssr-text"><span class="ssr-title">${sec.title}</span><span class="ssr-sub">${sec.sub}</span></span><span class="ssr-arrow">→</span></button>`
    ).join('');
    const outras = EXEC_OUTRAS_SECOES.map(v =>
      `<button type="button" class="sector-section-row" data-view="${v.view}"><span class="ssr-num">·</span><span class="ssr-text"><span class="ssr-title">${v.title}</span><span class="ssr-sub">${v.sub}</span></span><span class="ssr-arrow">→</span></button>`
    ).join('');
    const menu = $('#exec-nav-menu');
    menu.innerHTML = blocos + outras;
    menu.querySelectorAll('button[data-target]').forEach(btn =>
      btn.addEventListener('click', () => goToBlock(btn.dataset.sector, btn.dataset.target)));
    menu.querySelectorAll('button[data-view]').forEach(btn =>
      btn.addEventListener('click', () => goToView(btn.dataset.view)));
  }

  function setupExecSegToggle() {
    document.querySelectorAll('#exec-seg-toggle .exec-seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        state.execSector = btn.dataset.seg;
        renderExecutivo();
      });
    });
  }

  // Produção física e Financeiro não variam por segmento: link fixo no HTML.
  function updateDownloadLinks() {
    const NOME_ARQUIVO = { comex: 'Comercio_Exterior', caged: 'CAGED', bndes: 'BNDES', emprego: 'Emprego', mercado: 'Mercado_Domestico' };
    ['emprego', 'caged', 'comex', 'bndes', 'mercado'].forEach(id => {
      const el = $('#download-' + id);
      if (el) el.href = `data/downloads/${NOME_ARQUIVO[id]}_${state.sector}.xlsx`;
    });
  }

  function renderCharts() {
    aplicarFontesExhibits(); renderProducao(); renderFinanceiro(); renderEmprego(); renderCaged();
    renderComex(); renderMercado(); renderBndes(); renderDecom(); renderEstudosEspeciais();
    updateDownloadLinks();
  }
  function renderAll() {
    renderCharts();
    renderGargalos();
    renderSectorSummary();
  }

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  fetch('data/data.json?v=dev')
    .then(r => r.json())
    .then(data => {
      state.data = data;
      state.sector = setores()[0].codigo;
      buildSectorNav();
      initBlocks();
      setupBlockFilters();
      setupTema();
      // Celular: menu recolhível; fecha ao escolher um item.
      (() => {
        const btn = $('#menu-btn'), side = document.querySelector('.sidebar');
        if (!btn || !side) return;
        btn.addEventListener('click', () => { const ab = side.classList.toggle('aberto'); btn.setAttribute('aria-expanded', ab ? 'true' : 'false'); });
        side.addEventListener('click', e => { if (e.target.closest('.sidebar-menu button')) { side.classList.remove('aberto'); btn.setAttribute('aria-expanded', 'false'); } });
      })();
      setupCempre();
      setupMunicipios();
      setupComexAmpliado();
      setupViewTabs();
      renderReferencias(data);
      renderEnergiaIndustrial(data);
      renderCadeia(data);
      setupCenarios();
      renderAll();
      initSectionCaptions();
      setupExecSegToggle();
      renderExecutivo();
    })
    .catch(err => {
      document.querySelector('.wrap').innerHTML = '<p style="padding:40px;color:var(--bad)">Não foi possível carregar os dados (data/data.json). Detalhe: ' + err.message + '</p>';
      console.error(err);
    });
})();
