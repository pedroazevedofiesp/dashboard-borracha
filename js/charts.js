// Motor de gráficos SVG vanilla JS — sem bibliotecas externas.
// Expõe window.Charts = { lineChart, barChart, rankList, fmt }

(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------
  // Formatação (pt-BR)
  // ---------------------------------------------------------------------
  const fmtCompact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
  const fmtFull = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const fmtFull1 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

  const fmt = {
    compact(n) { return n == null || isNaN(n) ? '-' : fmtCompact.format(n); },
    full(n) { return n == null || isNaN(n) ? '-' : fmtFull.format(n); },
    full1(n) { return n == null || isNaN(n) ? '-' : fmtFull1.format(n); },
    usd(n) { return n == null || isNaN(n) ? '-' : 'US$ ' + fmtCompact.format(n); },
    brl(n) { return n == null || isNaN(n) ? '-' : 'R$ ' + fmtCompact.format(n); },
    usdFull(n) { return n == null || isNaN(n) ? '-' : 'US$ ' + fmtFull.format(n); },
    brlFull(n) { return n == null || isNaN(n) ? '-' : 'R$ ' + fmtFull.format(n); },
    mwh(n) { return n == null || isNaN(n) ? '-' : fmtCompact.format(n) + ' MWh'; },
    pct(n, signed) {
      if (n == null || isNaN(n)) return '-';
      const s = (signed && n > 0 ? '+' : '') + fmtFull1.format(n) + '%';
      return s;
    }
  };

  // ---------------------------------------------------------------------
  // Tooltip singleton
  // ---------------------------------------------------------------------
  let ttEl = null;
  function tooltip() {
    if (!ttEl) {
      ttEl = document.createElement('div');
      ttEl.className = 'chart-tooltip';
      document.body.appendChild(ttEl);
    }
    return ttEl;
  }
  function showTooltip(x, y, titleText, rows) {
    const el = tooltip();
    el.innerHTML = '';
    const title = document.createElement('div');
    title.className = 'tt-title';
    title.textContent = titleText;
    el.appendChild(title);
    rows.forEach(r => {
      const row = document.createElement('div');
      row.className = 'tt-row';
      if (r.color) {
        const key = document.createElement('span');
        key.className = 'tt-key';
        key.style.background = r.color;
        row.appendChild(key);
      }
      const label = document.createElement('span');
      label.textContent = r.label;
      row.appendChild(label);
      const val = document.createElement('span');
      val.className = 'tt-val';
      val.textContent = r.value;
      row.appendChild(val);
      el.appendChild(row);
    });
    el.classList.add('visible');
    positionTooltip(x, y);
  }
  function positionTooltip(x, y) {
    const el = tooltip();
    const pad = 14;
    let left = x + pad, top = y + pad;
    const rect = el.getBoundingClientRect();
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  function hideTooltip() {
    if (ttEl) ttEl.classList.remove('visible');
  }

  function svgEl(tag, attrs) {
    const el = document.createElementNS(NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step;
    if (norm < 1.5) step = 1 * mag;
    else if (norm < 3) step = 2 * mag;
    else if (norm < 7) step = 5 * mag;
    else step = 10 * mag;
    const niceMin = Math.floor(min / step) * step;
    const niceMax = Math.ceil(max / step) * step;
    const ticks = [];
    for (let v = niceMin; v <= niceMax + step * 0.001; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
    return ticks;
  }

  // Índices do eixo X que recebem legenda, espaçados pra não lotar — mas
  // sempre incluindo a última categoria (senão, dependendo de como o passo
  // se alinha com n, ela nunca aparece, mesmo com dado ali).
  function labelIndices(n, innerW) {
    const maxLabels = Math.max(2, Math.floor(innerW / 56));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    const idx = [];
    for (let i = 0; i < n; i += step) idx.push(i);
    const last = n - 1;
    if (idx[idx.length - 1] !== last) {
      if (idx.length > 1 && last - idx[idx.length - 1] < step / 2) idx[idx.length - 1] = last;
      else idx.push(last);
    }
    return new Set(idx);
  }

  // Acha a posição (em índice, possivelmente fracionário) de um valor de
  // categoria dentro do array de categorias — usado para posicionar faixas
  // (bands) que não caem exatamente sobre uma categoria existente.
  function catIndexFloor(categories, val) {
    if (val <= categories[0]) return 0;
    for (let i = 0; i < categories.length - 1; i++) {
      if (categories[i] <= val && val <= categories[i + 1]) return i;
    }
    return categories.length - 1;
  }
  function catIndexCeil(categories, val) {
    if (val >= categories[categories.length - 1]) return categories.length - 1;
    for (let i = 0; i < categories.length - 1; i++) {
      if (categories[i] <= val && val <= categories[i + 1]) return i + 1;
    }
    return 0;
  }

  function roundedBarPath(x, w, yBase, yVal, r) {
    const up = yVal <= yBase;
    const top = up ? yVal : yBase;
    const bottom = up ? yBase : yVal;
    r = Math.min(r, w / 2, Math.max(0, bottom - top));
    if (r <= 0.6 || bottom - top <= 1) {
      return `M${x},${top} H${x + w} V${bottom} H${x} Z`;
    }
    if (up) {
      return `M${x},${bottom} V${top + r} A${r},${r} 0 0 1 ${x + r},${top} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${top + r} V${bottom} Z`;
    }
    return `M${x},${top} H${x + w} V${bottom - r} A${r},${r} 0 0 1 ${x + w - r},${bottom} H${x + r} A${r},${r} 0 0 1 ${x},${bottom - r} V${top} Z`;
  }

  // ---------------------------------------------------------------------
  // Legend (HTML, ao lado/abaixo do gráfico)
  // ---------------------------------------------------------------------
  function renderLegend(container, items) {
    if (items.length < 2) return;
    const leg = document.createElement('div');
    leg.className = 'legend';
    items.forEach(it => {
      const el = document.createElement('div');
      el.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch';
      sw.style.background = it.color;
      el.appendChild(sw);
      const txt = document.createElement('span');
      txt.textContent = it.label;
      el.appendChild(txt);
      leg.appendChild(el);
    });
    container.appendChild(leg);
  }

  // ---------------------------------------------------------------------
  // Line chart — várias séries, eixo X categórico (ano ou ano-mês)
  // opts: { series:[{label,color,values:[num|null], area?}], categories:[str],
  //         formatY, formatX, height, yMin0 }
  // ---------------------------------------------------------------------
  function lineChart(container, opts) {
    container.innerHTML = '';
    const { series, categories, formatY = fmt.compact, formatX = (s => s), height = 220, stacked = false, bands = [], tooltipExtra, endLabels = false, formatEndLabel = formatY } = opts;
    const n = categories.length;
    if (!n || !series.some(s => s.values.some(v => v != null))) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis para o período selecionado.</div>';
      return;
    }
    const width = 600;
    const margin = { top: 14, right: endLabels ? 46 : 14, bottom: 26, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    let vmin = Infinity, vmax = -Infinity;
    if (stacked) {
      vmin = 0;
      for (let i = 0; i < n; i++) {
        let sum = 0;
        series.forEach(s => { sum += (s.values[i] != null ? s.values[i] : 0); });
        vmax = Math.max(vmax, sum);
      }
      if (!isFinite(vmax)) vmax = 1;
    } else {
      series.forEach(s => s.values.forEach(v => { if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } }));
      if (opts.yMin0) vmin = Math.min(0, vmin);
      if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
    }
    const ticks = niceTicks(vmin, vmax, 4);
    const yLo = ticks[0], yHi = ticks[ticks.length - 1];
    const yScale = v => margin.top + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;
    const xScale = i => n === 1 ? margin.left + innerW / 2 : margin.left + (i * innerW) / (n - 1);

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });

    // faixas de contexto (ex.: recessões), desenhadas atrás de tudo
    bands.forEach(b => {
      const i0 = catIndexFloor(categories, b.from), i1 = catIndexCeil(categories, b.to);
      const x1 = xScale(i0), x2 = xScale(i1);
      svg.appendChild(svgEl('rect', { x: Math.min(x1, x2), y: margin.top, width: Math.max(2, Math.abs(x2 - x1)), height: innerH, fill: 'var(--text-muted)', opacity: 0.1 }));
    });

    // gridlines + y labels
    ticks.forEach(t => {
      const y = yScale(t);
      svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: t === 0 ? 'baseline' : 'gridline' }));
      const lbl = svgEl('text', { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', class: 'axis-label' });
      lbl.textContent = formatY(t);
      svg.appendChild(lbl);
    });

    // x labels (subset to avoid crowding, sempre incluindo a última categoria)
    labelIndices(n, innerW).forEach(i => {
      const lbl = svgEl('text', { x: xScale(i), y: height - 6, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = formatX(categories[i]);
      svg.appendChild(lbl);
    });

    // crosshair (hidden by default)
    const crosshair = svgEl('line', { x1: 0, x2: 0, y1: margin.top, y2: margin.top + innerH, class: 'gridline', style: 'display:none' });
    svg.appendChild(crosshair);

    if (stacked) {
      const cum = new Array(n).fill(0);
      series.forEach(s => {
        const floor = cum.slice();
        for (let i = 0; i < n; i++) cum[i] += (s.values[i] != null ? s.values[i] : 0);
        const ceil = cum.slice();
        let d = 'M' + xScale(0) + ',' + yScale(floor[0]);
        for (let i = 1; i < n; i++) d += ' L' + xScale(i) + ',' + yScale(floor[i]);
        for (let i = n - 1; i >= 0; i--) d += ' L' + xScale(i) + ',' + yScale(ceil[i]);
        d += ' Z';
        svg.appendChild(svgEl('path', { d, fill: s.color, opacity: 0.85, stroke: 'none' }));
        let ld = 'M' + xScale(0) + ',' + yScale(ceil[0]);
        for (let i = 1; i < n; i++) ld += ' L' + xScale(i) + ',' + yScale(ceil[i]);
        svg.appendChild(svgEl('path', { d: ld, fill: 'none', stroke: 'var(--surface-card)', 'stroke-width': 1 }));
      });
    } else {
      series.forEach(s => {
        // build segments split by nulls
        let segStart = null;
        let d = '';
        s.values.forEach((v, i) => {
          if (v == null) { segStart = null; return; }
          const x = xScale(i), y = yScale(v);
          d += (segStart === null ? 'M' : 'L') + x + ',' + y + ' ';
          segStart = i;
        });
        if (s.area) {
          // fill area under line (only contiguous run supported simply)
          const pts = [];
          s.values.forEach((v, i) => { if (v != null) pts.push([xScale(i), yScale(v)]); });
          if (pts.length > 1) {
            const areaD = 'M' + pts[0][0] + ',' + yScale(yLo) + ' ' + pts.map(p => 'L' + p[0] + ',' + p[1]).join(' ') + ' L' + pts[pts.length - 1][0] + ',' + yScale(yLo) + ' Z';
            svg.appendChild(svgEl('path', { d: areaD, fill: s.color, opacity: 0.1, stroke: 'none' }));
          }
        }
        svg.appendChild(svgEl('path', { d: d.trim(), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

        // end marker on last non-null point
        for (let i = s.values.length - 1; i >= 0; i--) {
          if (s.values[i] != null) {
            svg.appendChild(svgEl('circle', { cx: xScale(i), cy: yScale(s.values[i]), r: 4, fill: s.color, stroke: 'var(--surface-card)', 'stroke-width': 2 }));
            break;
          }
        }
      });

      // rótulos de valor no fim de cada linha (estilo "relatório"), com
      // separação vertical mínima pra não sobrepor quando as linhas terminam
      // perto umas das outras.
      if (endLabels) {
        const labelPositions = [];
        series.forEach(s => {
          for (let i = s.values.length - 1; i >= 0; i--) {
            if (s.values[i] != null) {
              labelPositions.push({ y: yScale(s.values[i]), text: formatEndLabel(s.values[i]), color: s.color });
              break;
            }
          }
        });
        labelPositions.sort((a, b) => a.y - b.y);
        const minGap = 13;
        for (let i = 1; i < labelPositions.length; i++) {
          if (labelPositions[i].y - labelPositions[i - 1].y < minGap) {
            labelPositions[i].y = labelPositions[i - 1].y + minGap;
          }
        }
        labelPositions.forEach(p => {
          const lbl = svgEl('text', {
            x: width - margin.right + 6, y: p.y + 3, 'text-anchor': 'start',
            style: `fill:${p.color};font-weight:700;font-size:11px`,
          });
          lbl.textContent = p.text;
          svg.appendChild(lbl);
        });
      }
    }

    // hit columns
    const colW = innerW / n;
    for (let i = 0; i < n; i++) {
      const hit = svgEl('rect', {
        x: margin.left + i * colW - (i === 0 ? 0 : 0), y: margin.top, width: Math.max(colW, 4), height: innerH,
        class: 'hit-area', tabindex: 0
      });
      hit.style.cursor = 'crosshair';
      const onEnter = (evt) => {
        crosshair.setAttribute('x1', xScale(i)); crosshair.setAttribute('x2', xScale(i));
        crosshair.style.display = '';
        const rows = series
          .filter(s => s.values[i] != null)
          .map(s => ({ label: s.label, color: s.color, value: formatY(s.values[i]) }));
        if (tooltipExtra) rows.push(...tooltipExtra(i));
        if (!rows.length) return;
        const pos = clientPosFromEvent(evt, hit);
        showTooltip(pos.x, pos.y, formatX(categories[i], true), rows);
      };
      hit.addEventListener('pointerenter', onEnter);
      hit.addEventListener('pointermove', onEnter);
      hit.addEventListener('pointerleave', () => { crosshair.style.display = 'none'; hideTooltip(); });
      hit.addEventListener('focus', onEnter);
      hit.addEventListener('blur', () => { crosshair.style.display = 'none'; hideTooltip(); });
      svg.appendChild(hit);
    }

    container.appendChild(svg);
    renderLegend(container, series.map(s => ({ label: s.label, color: s.color })));
  }

  function clientPosFromEvent(evt, svgNode) {
    if (evt.clientX != null) return { x: evt.clientX, y: evt.clientY };
    const r = svgNode.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top };
  }

  // ---------------------------------------------------------------------
  // Bar chart — categorias no eixo X, 1+ séries agrupadas, ou divergente
  // opts: { series:[{label,color,values}], categories, formatY, height, diverging }
  // ---------------------------------------------------------------------
  function barChart(container, opts) {
    container.innerHTML = '';
    const { series, categories, formatY = fmt.compact, formatX = (s => s), height = 220, stacked = false, tooltipExtra, onCategoryClick } = opts;
    const n = categories.length;
    if (!n || !series.some(s => s.values.some(v => v != null))) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis para o período selecionado.</div>';
      return;
    }
    const width = 600;
    const margin = { top: 14, right: 14, bottom: 26, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    let vmin = 0, vmax = -Infinity;
    if (stacked) {
      for (let i = 0; i < n; i++) {
        let sum = 0;
        series.forEach(s => { sum += Math.max(0, s.values[i] || 0); });
        vmax = Math.max(vmax, sum);
      }
    } else {
      series.forEach(s => s.values.forEach(v => { if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } }));
    }
    if (!isFinite(vmax)) vmax = 1;
    const ticks = niceTicks(vmin, vmax, 4);
    const yLo = ticks[0], yHi = ticks[ticks.length - 1];
    const yScale = v => margin.top + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;
    const yBase = yScale(0);

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });

    ticks.forEach(t => {
      const y = yScale(t);
      svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: t === 0 ? 'baseline' : 'gridline' }));
      const lbl = svgEl('text', { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', class: 'axis-label' });
      lbl.textContent = formatY(t);
      svg.appendChild(lbl);
    });

    const showLabel = labelIndices(n, innerW);
    const slotW = innerW / n;
    const nSeries = series.length;
    const gap = 2;
    const barW = stacked ? Math.min(36, slotW * 0.6) : Math.min(24, (slotW - gap * (nSeries + 1)) / nSeries);

    for (let i = 0; i < n; i++) {
      const slotX = margin.left + i * slotW;
      if (showLabel.has(i)) {
        const lbl = svgEl('text', { x: slotX + slotW / 2, y: height - 6, 'text-anchor': 'middle', class: 'axis-label' });
        lbl.textContent = formatX(categories[i]);
        svg.appendChild(lbl);
      }
      const rows = [];
      if (stacked) {
        const bx = slotX + (slotW - barW) / 2;
        let cum = 0;
        series.forEach(s => {
          const v = s.values[i] || 0;
          if (s.values[i] != null && v !== 0) {
            const y0 = yScale(cum);
            cum += v;
            const y1 = yScale(cum);
            svg.appendChild(svgEl('rect', { x: bx, y: Math.min(y0, y1), width: barW, height: Math.max(1, Math.abs(y0 - y1)), fill: s.color, class: 'bar-mark' }));
            rows.push({ label: s.label, color: s.color, value: formatY(v) });
          }
        });
      } else {
        const groupW = nSeries * barW + (nSeries - 1) * gap;
        let bx = slotX + (slotW - groupW) / 2;
        series.forEach(s => {
          const v = s.values[i];
          if (v != null) {
            const y = yScale(v);
            const path = svgEl('path', { d: roundedBarPath(bx, barW, yBase, y, 4), fill: s.color, class: 'bar-mark' });
            svg.appendChild(path);
            rows.push({ label: s.label, color: s.color, value: formatY(v) });
          }
          bx += barW + gap;
        });
      }
      // hit area spans whole slot
      const hit = svgEl('rect', { x: slotX, y: margin.top, width: slotW, height: innerH, class: 'hit-area', tabindex: 0 });
      hit.style.cursor = 'pointer';
      const onEnter = (evt) => {
        const allRows = tooltipExtra ? [...rows, ...tooltipExtra(i)] : rows;
        if (!allRows.length) return;
        const pos = clientPosFromEvent(evt, hit);
        showTooltip(pos.x, pos.y, formatX(categories[i], true), allRows);
      };
      hit.addEventListener('pointerenter', onEnter);
      hit.addEventListener('pointermove', onEnter);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', onEnter);
      hit.addEventListener('blur', hideTooltip);
      if (onCategoryClick) hit.addEventListener('click', () => onCategoryClick(categories[i], i));
      svg.appendChild(hit);
    }

    container.appendChild(svg);
    renderLegend(container, series.map(s => ({ label: s.label, color: s.color })));
  }

  // ---------------------------------------------------------------------
  // Ranking em barras horizontais — 1 barra por item, com grade numérica de
  // verdade (não é uma lista em HTML) e linha de referência tracejada
  // opcional (ex.: valor nacional), pra responder "onde eu estou perto da
  // média" de cara, não só "quem é maior que quem".
  // opts: { items:[{label,value,color,tooltip?}], formatVal, reference?:
  //         {value,label}, rowHeight, onClick, tooltipExtra(item) }
  // ---------------------------------------------------------------------
  function hBarChart(container, opts) {
    container.innerHTML = '';
    const { items, formatVal = fmt.compact, reference, rowHeight = 26, onClick, tooltipExtra } = opts;
    if (!items.length) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>';
      return;
    }
    const width = 600;
    const margin = { top: reference ? 24 : 10, right: 56, bottom: 22, left: 138 };
    const innerW = width - margin.left - margin.right;
    const innerH = items.length * rowHeight;
    const height = margin.top + innerH + margin.bottom;

    const values = items.map(i => i.value || 0).concat(reference ? [reference.value] : []);
    const ticks = niceTicks(Math.min(0, ...values), Math.max(...values, 1), 4);
    const xLo = ticks[0], xHi = ticks[ticks.length - 1];
    const xScale = v => margin.left + ((v - xLo) / (xHi - xLo || 1)) * innerW;

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });

    ticks.forEach(t => {
      const x = xScale(t);
      svg.appendChild(svgEl('line', { x1: x, x2: x, y1: margin.top, y2: margin.top + innerH, class: t === 0 ? 'baseline' : 'gridline' }));
      const lbl = svgEl('text', { x, y: height - 6, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = formatVal(t);
      svg.appendChild(lbl);
    });

    items.forEach((it, i) => {
      const y = margin.top + i * rowHeight;
      const yc = y + rowHeight / 2;
      const barH = Math.min(16, rowHeight - 10);
      const x0 = xScale(Math.min(0, it.value || 0)), x1 = xScale(Math.max(0, it.value || 0));

      const lbl = svgEl('text', { x: margin.left - 8, y: yc + 3, 'text-anchor': 'end', class: 'axis-label hbar-label' });
      lbl.textContent = it.label;
      svg.appendChild(lbl);

      svg.appendChild(svgEl('rect', {
        x: Math.min(x0, x1), y: yc - barH / 2, width: Math.max(1.5, Math.abs(x1 - x0)), height: barH,
        fill: it.color || 'var(--series-1)', rx: 2, class: 'bar-mark',
      }));

      const val = svgEl('text', { x: x1 + 6, y: yc + 3, 'text-anchor': 'start', class: 'hbar-val' });
      val.textContent = formatVal(it.value);
      svg.appendChild(val);

      const hit = svgEl('rect', { x: margin.left, y, width: innerW, height: rowHeight, class: 'hit-area', tabindex: 0 });
      hit.style.cursor = onClick ? 'pointer' : 'default';
      const rows = [{ label: it.label, color: it.color, value: formatVal(it.value) }];
      if (tooltipExtra) rows.push(...tooltipExtra(it));
      const onEnter = (evt) => {
        const pos = clientPosFromEvent(evt, hit);
        showTooltip(pos.x, pos.y, it.label, rows);
      };
      hit.addEventListener('pointerenter', onEnter);
      hit.addEventListener('pointermove', onEnter);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', onEnter);
      hit.addEventListener('blur', hideTooltip);
      if (onClick) hit.addEventListener('click', () => onClick(it));
      svg.appendChild(hit);
    });

    if (reference) {
      const xr = xScale(reference.value);
      svg.appendChild(svgEl('line', {
        x1: xr, x2: xr, y1: margin.top - 6, y2: margin.top + innerH,
        stroke: 'var(--text-muted)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3',
      }));
      const lbl = svgEl('text', { x: xr, y: margin.top - 10, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = reference.label;
      svg.appendChild(lbl);
    }

    container.appendChild(svg);
  }

  // ---------------------------------------------------------------------
  // Linha com dois eixos Y (esquerda/direita) — ex.: VBPI x VTI
  // opts: { seriesLeft:{label,color,values}, seriesRight:{label,color,values},
  //         categories, formatYLeft, formatYRight, formatX, height }
  // ---------------------------------------------------------------------
  function dualAxisLineChart(container, opts) {
    container.innerHTML = '';
    const { seriesLeft, seriesRight, categories, formatYLeft = fmt.compact, formatYRight = fmt.compact, formatX = (s => s), height = 220, plainAxis = false } = opts;
    const n = categories.length;
    if (!n || (!seriesLeft.values.some(v => v != null) && !seriesRight.values.some(v => v != null))) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis para o período selecionado.</div>';
      return;
    }
    const width = 600;
    const margin = { top: 14, right: 48, bottom: 26, left: 48 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    function domain(values) {
      let vmin = Infinity, vmax = -Infinity;
      values.forEach(v => { if (v != null) { vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); } });
      if (!isFinite(vmin)) { vmin = 0; vmax = 1; }
      return niceTicks(vmin, vmax, 4);
    }
    const ticksL = domain(seriesLeft.values), ticksR = domain(seriesRight.values);
    const yLoL = ticksL[0], yHiL = ticksL[ticksL.length - 1];
    const yLoR = ticksR[0], yHiR = ticksR[ticksR.length - 1];
    const yScaleL = v => margin.top + innerH - ((v - yLoL) / (yHiL - yLoL || 1)) * innerH;
    const yScaleR = v => margin.top + innerH - ((v - yLoR) / (yHiR - yLoR || 1)) * innerH;
    const xScale = i => n === 1 ? margin.left + innerW / 2 : margin.left + (i * innerW) / (n - 1);

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });

    ticksL.forEach(t => {
      const y = yScaleL(t);
      svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: t === 0 ? 'baseline' : 'gridline' }));
      const lbl = svgEl('text', plainAxis
        ? { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', class: 'axis-label' }
        : { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', class: 'axis-label', style: 'fill:' + seriesLeft.color });
      lbl.textContent = formatYLeft(t);
      svg.appendChild(lbl);
    });
    ticksR.forEach(t => {
      const y = yScaleR(t);
      const lbl = svgEl('text', plainAxis
        ? { x: width - margin.right + 6, y: y + 3, 'text-anchor': 'start', class: 'axis-label' }
        : { x: width - margin.right + 6, y: y + 3, 'text-anchor': 'start', class: 'axis-label', style: 'fill:' + seriesRight.color });
      lbl.textContent = formatYRight(t);
      svg.appendChild(lbl);
    });

    labelIndices(n, innerW).forEach(i => {
      const lbl = svgEl('text', { x: xScale(i), y: height - 6, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = formatX(categories[i]);
      svg.appendChild(lbl);
    });

    function drawLine(s, yScale) {
      let segStart = null, d = '';
      s.values.forEach((v, i) => {
        if (v == null) { segStart = null; return; }
        const x = xScale(i), y = yScale(v);
        d += (segStart === null ? 'M' : 'L') + x + ',' + y + ' ';
        segStart = i;
      });
      svg.appendChild(svgEl('path', { d: d.trim(), fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
      for (let i = s.values.length - 1; i >= 0; i--) {
        if (s.values[i] != null) {
          svg.appendChild(svgEl('circle', { cx: xScale(i), cy: yScale(s.values[i]), r: 4, fill: s.color, stroke: 'var(--surface-card)', 'stroke-width': 2 }));
          break;
        }
      }
    }
    drawLine(seriesLeft, yScaleL);
    drawLine(seriesRight, yScaleR);

    const colW = innerW / n;
    for (let i = 0; i < n; i++) {
      const hit = svgEl('rect', { x: margin.left + i * colW, y: margin.top, width: Math.max(colW, 4), height: innerH, class: 'hit-area', tabindex: 0 });
      hit.style.cursor = 'crosshair';
      const rows = [];
      if (seriesLeft.values[i] != null) rows.push({ label: seriesLeft.label, color: seriesLeft.color, value: formatYLeft(seriesLeft.values[i]) });
      if (seriesRight.values[i] != null) rows.push({ label: seriesRight.label, color: seriesRight.color, value: formatYRight(seriesRight.values[i]) });
      const onEnter = (evt) => {
        if (!rows.length) return;
        const pos = clientPosFromEvent(evt, hit);
        showTooltip(pos.x, pos.y, formatX(categories[i], true), rows);
      };
      hit.addEventListener('pointerenter', onEnter);
      hit.addEventListener('pointermove', onEnter);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', onEnter);
      hit.addEventListener('blur', hideTooltip);
      svg.appendChild(hit);
    }

    container.appendChild(svg);
    renderLegend(container, [{ label: seriesLeft.label, color: seriesLeft.color }, { label: seriesRight.label, color: seriesRight.color }]);
  }

  // ---------------------------------------------------------------------
  // Waterfall — decomposição de um total em parcelas (ex.: custos)
  // opts: { items:[{label,value,isTotal?}], formatY, height }
  // ---------------------------------------------------------------------
  function waterfallChart(container, opts) {
    container.innerHTML = '';
    const { items, formatY = fmt.brl, height = 240 } = opts;
    if (!items || !items.length) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>';
      return;
    }
    const width = 600;
    const margin = { top: 14, right: 14, bottom: 42, left: 52 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const n = items.length;

    let running = 0;
    const bars = items.map(it => {
      if (it.isTotal) { running = it.value; return { from: 0, to: it.value, label: it.label, value: it.value, isTotal: true }; }
      const from = running;
      running += it.value;
      return { from, to: running, label: it.label, value: it.value, isTotal: false };
    });

    let vmin = 0, vmax = -Infinity;
    bars.forEach(b => { vmin = Math.min(vmin, b.from, b.to); vmax = Math.max(vmax, b.from, b.to); });
    const ticks = niceTicks(vmin, vmax, 4);
    const yLo = ticks[0], yHi = ticks[ticks.length - 1];
    const yScale = v => margin.top + innerH - ((v - yLo) / (yHi - yLo || 1)) * innerH;

    const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, class: 'chart-svg', role: 'img' });
    ticks.forEach(t => {
      const y = yScale(t);
      svg.appendChild(svgEl('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: t === 0 ? 'baseline' : 'gridline' }));
      const lbl = svgEl('text', { x: margin.left - 6, y: y + 3, 'text-anchor': 'end', class: 'axis-label' });
      lbl.textContent = formatY(t);
      svg.appendChild(lbl);
    });

    const slotW = innerW / n;
    const barW = Math.min(56, slotW * 0.6);
    bars.forEach((b, i) => {
      const slotX = margin.left + i * slotW + (slotW - barW) / 2;
      const y0 = yScale(b.from), y1 = yScale(b.to);
      const color = b.isTotal ? 'var(--text-secondary)' : (b.value >= 0 ? 'var(--good)' : 'var(--bad)');
      svg.appendChild(svgEl('path', { d: roundedBarPath(slotX, barW, y0, y1, 3), fill: color, class: 'bar-mark' }));
      if (i < n - 1 && !bars[i + 1].isTotal) {
        const nextSlotX = margin.left + (i + 1) * slotW + (slotW - barW) / 2;
        svg.appendChild(svgEl('line', { x1: slotX + barW, x2: nextSlotX, y1, y2: y1, class: 'gridline' }));
      }
      const lbl = svgEl('text', { x: slotX + barW / 2, y: height - 24, 'text-anchor': 'middle', class: 'axis-label' });
      lbl.textContent = b.label;
      svg.appendChild(lbl);
      const vlbl = svgEl('text', { x: slotX + barW / 2, y: height - 8, 'text-anchor': 'middle', class: 'axis-label' });
      vlbl.textContent = formatY(b.value);
      svg.appendChild(vlbl);

      const hit = svgEl('rect', { x: margin.left + i * slotW, y: margin.top, width: slotW, height: innerH, class: 'hit-area', tabindex: 0 });
      hit.style.cursor = 'pointer';
      const onEnter = (evt) => {
        const pos = clientPosFromEvent(evt, hit);
        showTooltip(pos.x, pos.y, b.label, [{ color, label: b.isTotal ? 'Total' : 'Valor', value: formatY(b.value) }]);
      };
      hit.addEventListener('pointerenter', onEnter);
      hit.addEventListener('pointermove', onEnter);
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('focus', onEnter);
      hit.addEventListener('blur', hideTooltip);
      svg.appendChild(hit);
    });

    container.appendChild(svg);
  }

  // ---------------------------------------------------------------------
  // Donut — composição (ex.: top ocupações + "Outras")
  // opts: { items:[{label,value,color}], formatVal, size }
  // ---------------------------------------------------------------------
  function donutChart(container, opts) {
    container.innerHTML = '';
    container.className = 'donut-chart-wrap';
    const { items, formatVal = fmt.full, size = 200 } = opts;
    if (!items || !items.length || !items.some(i => i.value > 0)) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>';
      return;
    }
    const total = items.reduce((a, i) => a + (i.value || 0), 0);
    const cx = size / 2, cy = size / 2, r = size * 0.34, strokeW = size * 0.16;
    const circumference = 2 * Math.PI * r;
    const svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'chart-svg donut-svg', role: 'img' });
    let offset = 0;
    items.forEach(it => {
      const frac = total ? (it.value || 0) / total : 0;
      const dash = frac * circumference;
      const circle = svgEl('circle', {
        cx, cy, r, fill: 'none', stroke: it.color, 'stroke-width': strokeW,
        'stroke-dasharray': `${dash} ${circumference - dash}`,
        'stroke-dashoffset': -offset,
        transform: `rotate(-90 ${cx} ${cy})`,
      });
      circle.style.cursor = 'pointer';
      svg.appendChild(circle);
      offset += dash;
      const onEnter = (evt) => {
        const pos = clientPosFromEvent(evt, circle);
        showTooltip(pos.x, pos.y, it.label, [{ color: it.color, label: 'Participação', value: fmt.pct(frac * 100) }]);
      };
      circle.addEventListener('pointerenter', onEnter);
      circle.addEventListener('pointermove', onEnter);
      circle.addEventListener('pointerleave', hideTooltip);
    });
    const centerLbl = svgEl('text', { x: cx, y: cy - 4, 'text-anchor': 'middle', style: 'font-size:14px;font-weight:700', fill: 'var(--text-primary)' });
    centerLbl.textContent = formatVal(total);
    svg.appendChild(centerLbl);
    const centerSub = svgEl('text', { x: cx, y: cy + 13, 'text-anchor': 'middle', class: 'axis-label' });
    centerSub.textContent = 'total';
    svg.appendChild(centerSub);

    container.appendChild(svg);
    renderLegend(container, items.map(i => ({ label: i.label, color: i.color })));
  }

  // ---------------------------------------------------------------------
  // Tabela genérica (HTML), com ordenação por coluna — BNDES, DECOM
  // opts: { columns:[{key,label,align,format}], rows:[{...}], pageSize? }
  // Com pageSize, mostra só as N primeiras linhas (da ordenação atual) e um
  // botão "Ver mais" que revela mais N a cada clique.
  // ---------------------------------------------------------------------
  function dataTable(container, opts) {
    const { columns, rows, pageSize } = opts;
    if (!rows || !rows.length) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>';
      return;
    }
    let sortKey = null, sortDir = 1;
    let visibleCount = pageSize || rows.length;
    function render() {
      const sorted = sortKey ? [...rows].sort((a, b) => {
        const av = a[sortKey], bv = b[sortKey];
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number') return (av - bv) * sortDir;
        return String(av).localeCompare(String(bv)) * sortDir;
      }) : rows;
      const shown = sorted.slice(0, visibleCount);
      const wrap = document.createElement('div');
      wrap.className = 'data-table-wrap';
      const table = document.createElement('table');
      table.className = 'data-table';
      const thead = document.createElement('thead');
      const trh = document.createElement('tr');
      columns.forEach(col => {
        const th = document.createElement('th');
        th.textContent = col.label + (sortKey === col.key ? (sortDir === 1 ? ' ▲' : ' ▼') : '');
        if (col.align) th.style.textAlign = col.align;
        th.addEventListener('click', () => {
          if (sortKey === col.key) sortDir = -sortDir; else { sortKey = col.key; sortDir = -1; }
          render();
        });
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
      const tbody = document.createElement('tbody');
      shown.forEach(r => {
        const tr = document.createElement('tr');
        columns.forEach(col => {
          const td = document.createElement('td');
          const raw = r[col.key];
          td.textContent = col.format ? col.format(raw) : (raw == null ? '-' : raw);
          if (col.align) td.style.textAlign = col.align;
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrap.appendChild(table);
      container.innerHTML = '';
      container.appendChild(wrap);

      if (pageSize && visibleCount < sorted.length) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'table-more-btn';
        moreBtn.textContent = `Ver mais (${sorted.length - visibleCount} restantes)`;
        moreBtn.addEventListener('click', () => { visibleCount += pageSize; render(); });
        container.appendChild(moreBtn);
      }
    }
    render();
  }

  // ---------------------------------------------------------------------
  // Lista ranqueada (barras horizontais em HTML) — países, UFs, categorias
  // ---------------------------------------------------------------------
  function rankList(container, items, opts) {
    container.innerHTML = '';
    const { formatVal = fmt.compact, color = 'var(--series-1)', onClick } = opts || {};
    if (!items.length) {
      container.innerHTML = '<div class="empty-note">Sem dados disponíveis.</div>';
      return;
    }
    const max = Math.max(...items.map(i => Math.abs(i.value || 0)), 1);
    const ul = document.createElement('ul');
    ul.className = 'rank-list';
    items.forEach(it => {
      const li = document.createElement('li');
      if (onClick) {
        li.classList.add('rank-clickable');
        li.addEventListener('click', () => onClick(it));
      }
      const name = document.createElement('span');
      name.className = 'rank-name';
      name.textContent = it.label;
      name.title = it.tooltip ? it.label + ' · ' + it.tooltip : it.label;
      const barWrap = document.createElement('span');
      barWrap.className = 'rank-bar-wrap';
      const bar = document.createElement('span');
      bar.className = 'rank-bar';
      bar.style.width = Math.max(2, (Math.abs(it.value || 0) / max) * 100) + '%';
      bar.style.background = it.color || color;
      barWrap.appendChild(bar);
      const val = document.createElement('span');
      val.className = 'rank-val';
      val.textContent = formatVal(it.value);
      li.appendChild(name); li.appendChild(barWrap); li.appendChild(val);
      ul.appendChild(li);
    });
    container.appendChild(ul);
  }

  window.Charts = { lineChart, barChart, hBarChart, dualAxisLineChart, waterfallChart, donutChart, dataTable, rankList, fmt, hideTooltip };
})();
