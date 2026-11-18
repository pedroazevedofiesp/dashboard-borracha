#!/usr/bin/env python3
"""Gera as planilhas Excel formatadas de data/downloads/, uma por seção do
painel (uma para cada CNAE de config_painel.json onde a seção varia por
segmento). Lê direto dos CSVs de 3_Dados_Tratados_CSV/ — roda depois de
build_data.py. As abas derivadas (CEMPRE, municípios, Comtrade por grupo,
mercado doméstico, outros indicadores) vêm do data/data.json já gerado."""

import json
import re
from pathlib import Path

import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from build_data import (ANO_BASE_PRECOS, CNAES, CONFIG, ROTULO_ARQUIVO, SETOR, SETORES, SLUG, UF_REGIAO, build_fator_ipca,
                        build_indicadores_desempenho, build_macro, tarifa_industrial_regiao_ano)

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / '3_Dados_Tratados_CSV'
OUT_DIR = ROOT / 'data' / 'downloads'
_DATA = {}


def _data():
    """data/data.json gerado pelo build_data.py (lido uma vez)."""
    if 'd' not in _DATA:
        caminho = ROOT / 'data' / 'data.json'
        _DATA['d'] = json.loads(caminho.read_text(encoding='utf-8')) if caminho.exists() else None
    return _DATA['d']


def _df(linhas, colunas=None, renomear=None):
    df = pd.DataFrame(linhas or [])
    if colunas:
        df = df[[c for c in colunas if c in df.columns]]
    if renomear:
        df = df.rename(columns=renomear)
    return df

FONT_NAME = 'Arial'
HEADER_FONT = Font(name=FONT_NAME, bold=True, color='FFFFFF')
HEADER_FILL = PatternFill('solid', fgColor='000000')
BODY_FONT = Font(name=FONT_NAME, color='000000')
NOTE_FONT = Font(name=FONT_NAME, italic=True, size=9, color='595959')
TITLE_FONT = Font(name=FONT_NAME, bold=True, size=13, color='000000')
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)

NO_SEP_HINTS = ('ano', 'mes', 'mês', 'cnae', 'codigo', 'código', 'code', 'reporter_code', 'partner_code')


def _read(name, **kwargs):
    defaults = dict(sep=';', decimal=',', encoding='utf-8-sig')
    defaults.update(kwargs)
    return pd.read_csv(SRC_DIR / name, **defaults)


def _sheet_name(name):
    name = re.sub(r'[:\\/?*\[\]]', '-', str(name))
    return name[:31]


def _is_plain_int_col(header):
    h = str(header).lower()
    return any(hint in h for hint in NO_SEP_HINTS)



# Acima disso, estilo por célula (borda + fonte em cada uma) fica lento
# demais (Comtrade e energia industrial passam de 100 mil linhas) — nesse
# caso usa escrita em bloco (ws.append) e só formata número, sem borda/fonte
# por célula, pra não travar o build.
LARGE_SHEET_THRESHOLD = 3000


def _normalize_value(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _write_df(ws, df, title=None, note=None):
    r = 1
    if title:
        ws.cell(row=r, column=1, value=title).font = TITLE_FONT
        r += 2
    headers = list(df.columns)
    for c, h in enumerate(headers, start=1):
        cell = ws.cell(row=r, column=c, value=str(h))
        cell.font = HEADER_FONT
        cell.fill = HEADER_FILL
        cell.border = BORDER
        cell.alignment = Alignment(vertical='center', wrap_text=True)
    header_row = r
    r += 1
    plain_int_cols = {h for h in headers if _is_plain_int_col(h)}
    n_rows = len(df)
    style_cells = n_rows <= LARGE_SHEET_THRESHOLD

    if style_cells:
        for _, row in df.iterrows():
            for c, h in enumerate(headers, start=1):
                v = _normalize_value(row[h])
                cell = ws.cell(row=r, column=c, value=v)
                cell.font = BODY_FONT
                cell.border = BORDER
                if isinstance(v, (int, float)):
                    cell.number_format = '0' if h in plain_int_cols else '#,##0.##'
            r += 1
    else:
        # values.tolist() + ws.append: ordens de magnitude mais rápido que
        # ws.cell() célula a célula pra planilhas de centenas de milhares
        # de linhas.
        for row_vals in df[headers].values.tolist():
            ws.append([_normalize_value(v) for v in row_vals])
        num_formats = ['0' if h in plain_int_cols else '#,##0.##' for h in headers]
        for row in ws.iter_rows(min_row=header_row + 1, max_row=header_row + n_rows):
            for cell, fmt in zip(row, num_formats):
                if isinstance(cell.value, (int, float)):
                    cell.number_format = fmt
        r = header_row + 1 + n_rows

    for c, h in enumerate(headers, start=1):
        sample = df[h].head(300)
        max_len = max((len(str(x)) for x in sample if pd.notna(x)), default=10)
        width = max(10, min(42, len(str(h)) + 2, max_len + 2))
        ws.column_dimensions[get_column_letter(c)].width = width
    ws.freeze_panes = f'A{header_row + 1}'
    if note:
        nr = r + 1
        ws.cell(row=nr, column=1, value=note).font = NOTE_FONT
        ws.merge_cells(start_row=nr, start_column=1, end_row=nr, end_column=max(1, len(headers)))
    return r


def _new_workbook():
    wb = Workbook()
    wb.remove(wb.active)
    return wb


def _add_sheet(wb, sheet_name, df, title=None, note=None):
    base = _sheet_name(sheet_name)
    name = base
    i = 2
    while name in wb.sheetnames:
        name = _sheet_name(f'{base[:28]}_{i}')
        i += 1
    ws = wb.create_sheet(name)
    _write_df(ws, df, title=title, note=note)
    return ws


def _save(wb, filename):
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / filename
    wb.save(path)
    print(f'  data/downloads/{filename}')
    return path


# ---------------------------------------------------------------------------
# 01 — Produção física (índice da divisão; igual para todos os segmentos,
# por isso um arquivo só)
# ---------------------------------------------------------------------------
def build_producao_download():
    wb = _new_workbook()
    _add_sheet(wb, 'Indice mensal', _read(f"Producao_Fisica_Mensal_{SETOR['producao_rotulo_arquivo']}.csv"),
               title=f"Produção física — {SETOR['producao_titulo']} (índice mensal, base 100)",
               note=f"Fonte: IBGE/PIM-PF. {SETOR['producao_descricao']}")
    if (SRC_DIR / 'Producao_Fisica_Comparativos.csv').exists():
        _add_sheet(wb, 'Comparativos', _read('Producao_Fisica_Comparativos.csv'),
                   title='Produção física — indústria geral e indústria de transformação (índice mensal, base 100)',
                   note='Fonte: PIM-PF/IBGE. Elaboração: DECAP/FIESP. Para comparar com a divisão do setor.')
    _save(wb, 'Producao_Fisica.xlsx')


# ---------------------------------------------------------------------------
# 02 — Financeiro (PIA, não varia por setor)
# ---------------------------------------------------------------------------
def build_financeiro_download():
    grupo = SETOR['grupo_cnae']
    codigos = '_'.join(c['codigo'] for c in CNAES)
    rotulos = ' x '.join(f"{c['rotulo']} ({c['codigo']})" for c in CNAES)
    wb = _new_workbook()
    _add_sheet(wb, f'Grupo {grupo}', _read(f"Dados_Financeiros_{ROTULO_ARQUIVO}_{grupo.replace('.', '_')}.csv"),
               title=f"Financeiro — {SETOR['grupo_descricao']} (CNAE {grupo})",
               note=f"Grupo CNAE completo, sem abertura por classe. {SETOR.get('grupo_nota', '')} "
                    f"Fonte: IBGE/PIA-Empresa.")
    _add_sheet(wb, 'Por CNAE (2024)', _read(f'Dados_Financeiros_CNAE_{codigos}_2024_SerieNova.csv'),
               title=f'Financeiro — {rotulos}',
               note='Só 2024 — primeira vez com essa abertura por classe. Fonte: IBGE/PIA-Empresa.')
    ind = build_indicadores_desempenho(build_macro())
    if ind:
        a0, a1 = ind['ano_inicial'], ind['ano_final']
        unid = {'var': 'variação %', 'pp': 'p.p.', 'nivel': '%'}
        for tab in ind['tabelas']:
            af = tab['ano_final']
            tabela = pd.DataFrame([
                {'Variável': l['indicador'], 'Unidade': unid[l['tipo']],
                 **{c['rotulo']: (None if l['valores'][c['codigo']] is None else round(l['valores'][c['codigo']], 1))
                    for c in ind['colunas']}}
                for l in tab['linhas']])
            _add_sheet(wb, f'Indicadores {a0}-{af}', tabela,
                       title=f'Indicadores de desempenho — variação {a0}/{af}',
                       note=f'Fonte: PIA/IBGE. Elaboração: DECAP/FIESP. R$ constantes de {a1}.'
                            + (f' {af} é da nova série da PIA (quebra metodológica).' if tab['nova_serie'] else ''))
        rot = {c['codigo']: c['rotulo'] for c in ind['colunas']}
        rot['grupo'] = f"Grupo {grupo}"
        serie = pd.DataFrame(ind['serie'])
        serie.insert(1, 'recorte_nome', serie['recorte'].map(lambda r: rot.get(r, r)))
        for c in ('margem_bruta', 'invest_liquido_rlv'):
            serie[c] = serie[c] * 100
        d = _data()
        outros = d and d['shared']['financeiro']['indicadores'].get('outros')
        if outros:
            tab_o = pd.DataFrame([{'Indicador': l['indicador'],
                                   **{c['rotulo']: (None if l['valores'][c['codigo']] is None else round(l['valores'][c['codigo']], 2))
                                      for c in ind['colunas']}} for l in outros['linhas']])
            _add_sheet(wb, f"Outros indicadores {outros['ano']}", tab_o,
                       title=f"Outros indicadores de desempenho — {outros['ano']}",
                       note='Fonte: PIA/IBGE. Elaboração: DECAP/FIESP. Percentuais em %; produtividade e receita por empresa em mil R$; salário em R$.')
        _add_sheet(wb, 'PIA por classe', serie,
                   title=f'PIA-Empresa por classe, {a0}-{a1}',
                   note=f'Fonte: PIA/IBGE. Elaboração: DECAP/FIESP. Valores em mil R$ correntes; colunas *_real '
                        f'em mil R$ de {a1}; margem_bruta e invest_liquido_rlv em %. O total soma as classes do setor.')
    _save(wb, 'Financeiro.xlsx')


# ---------------------------------------------------------------------------
# Recorte agregado (ex.: "Borracha - Total"): as planilhas trazem as linhas de
# cada CNAE componente, identificadas na coluna "cnae" — quem baixa vê de onde
# vem cada número e pode somar como quiser.
# ---------------------------------------------------------------------------
def _componentes(cfg):
    return [str(c) for c in cfg.get('componentes', [cfg['codigo']])]


def _rotulo_de(code):
    c = next((x for x in CNAES if x['codigo'] == code), {})
    return c.get('rotulo_arquivo', ROTULO_ARQUIVO)


def _read_setor(cfg, nome):
    '''nome(code, rotulo) -> arquivo daquele CNAE. Para um CNAE, lê o arquivo
    como está; para um agregado, junta os dos componentes com coluna "cnae".'''
    codes = _componentes(cfg)
    if len(codes) == 1:
        return _read(nome(codes[0], _rotulo_de(codes[0])))
    partes = []
    for c in codes:
        df = _read(nome(c, _rotulo_de(c)))
        df.insert(0, 'cnae', c)
        partes.append(df)
    return pd.concat(partes, ignore_index=True)


def _nota_agregado(cfg):
    if len(_componentes(cfg)) == 1:
        return ''
    return f" {cfg.get('descricao', '')} Linhas separadas por CNAE (coluna cnae)."


# ---------------------------------------------------------------------------
# 03 — Emprego formal / RAIS (por setor)
# ---------------------------------------------------------------------------
EMPREGO_ARQUIVOS = [
    (lambda c, r: f'Empregos_RAIS_UF_{r}_{c}.csv', 'RAIS por UF'),
    (lambda c, r: f'Empregos_RAIS_Tamanho_{r}_{c}.csv', 'RAIS por tamanho'),
    (lambda c, r: f'rais_vinc_{SLUG}_escolaridade_{c}.csv', 'RAIS escolaridade'),
    (lambda c, r: f'rais_vinc_{SLUG}_massa_{c}.csv', 'RAIS massa salarial'),
    (lambda c, r: f'rais_vinc_{SLUG}_ocupacao_{c}.csv', 'RAIS ocupacao detalhada'),
    (lambda c, r: f'rais_vinc_{SLUG}_ocupacao_agrupada_{c}.csv', 'RAIS ocupacao agrupada'),
    (lambda c, r: f'rais_vinc_{SLUG}_tempo_emprego_{c}.csv', 'RAIS tempo de emprego'),
]


def build_emprego_download(cfg):
    wb = _new_workbook()
    for nome, sheet in EMPREGO_ARQUIVOS:
        _add_sheet(wb, sheet, _read_setor(cfg, nome), title=f"Emprego formal (RAIS) — {cfg['rotulo']}",
                   note='Fonte: RAIS.' + _nota_agregado(cfg))
    d = _data()
    sd = d and d['sectors'].get(cfg['codigo'])
    if sd and sd.get('cempre'):
        cols = ['ano', 'uf', 'sigla', 'empresas', 'pessoal_ocupado', 'pessoal_assalariado', 'salarios_mil', 'salario_medio_mensal']
        nomes = {'sigla': 'UF', 'empresas': 'Empresas ativas', 'pessoal_ocupado': 'Pessoal ocupado', 'pessoal_assalariado': 'Assalariados',
                 'salarios_mil': 'Salários (mil R$)', 'salario_medio_mensal': 'Salário médio mensal (R$)'}
        _add_sheet(wb, 'Empresas CEMPRE Brasil', _df(sd['cempre']['brasil'], cols, nomes).drop(columns=['uf', 'UF'], errors='ignore'),
                   title=f"Empresas ativas (CEMPRE) — Brasil — {cfg['rotulo']}",
                   note='Fonte: CEMPRE/IBGE. Elaboração: DECAP/FIESP. A partir de 2022 o IBGE publica o cadastro em outra tabela.')
        _add_sheet(wb, 'Empresas CEMPRE UF', _df(sd['cempre']['uf_yearly'], cols, nomes).drop(columns=['uf'], errors='ignore'),
                   title=f"Empresas ativas (CEMPRE) — por estado — {cfg['rotulo']}",
                   note='Fonte: CEMPRE/IBGE. Elaboração: DECAP/FIESP. Valores vazios = sigilo do IBGE.')
    if sd and sd.get('municipios'):
        m = sd['municipios']
        _add_sheet(wb, 'Municipios', _df(m['itens'], ['id', 'nome', 'uf', 'estab', 'vinc', 'ind_estab', 'ind_vinc', 'remun', 'ind_remun'], {
            'id': 'Código IBGE', 'nome': 'Município', 'uf': 'Código UF', 'estab': 'Estabelecimentos do setor', 'vinc': 'Vínculos do setor',
            'ind_estab': 'Estabelecimentos da ind. transformação', 'ind_vinc': 'Vínculos da ind. transformação',
            'remun': f"Remuneração média dez/{m.get('ano_remun') or ''} do setor (R$)", 'ind_remun': 'Remuneração média da ind. transformação (R$)'}),
            title=f"Emprego por município — {cfg['rotulo']}",
            note=f"Fonte: RAIS/MTE. Elaboração: DECAP/FIESP. Vínculos e estabelecimentos de {m['ano']}; remuneração de {m.get('ano_remun') or '-'}.")
    _save(wb, f"Emprego_{cfg['codigo']}.xlsx")


# ---------------------------------------------------------------------------
# 04 — CAGED (arquivos únicos com os dois setores, filtrados por cnae_subclasse)
# ---------------------------------------------------------------------------
def build_caged_download(cfg):
    cnae, label = cfg['codigo'], cfg['rotulo']
    wb = _new_workbook()
    for fname, sheet in [
        (f'caged_{SLUG}_saldo_mensal_uf_cnae.csv', 'CAGED saldo mensal'),
        (f'caged_{SLUG}_salario_mensal_uf_cnae.csv', 'CAGED salario mensal'),
        (f'caged_{SLUG}_tipo_movimentacao_mensal_cnae.csv', 'CAGED tipo movimentacao'),
    ]:
        df = _read(fname)
        df = df[df['cnae_subclasse'].astype(str).str.strip().isin(_componentes(cfg))].reset_index(drop=True)
        _add_sheet(wb, sheet, df, title=f'CAGED — {label}', note='Fonte: CAGED/Novo CAGED.' + _nota_agregado(cfg))
    _save(wb, f'CAGED_{cnae}.xlsx')


# ---------------------------------------------------------------------------
# 05 — Comércio exterior (por setor: cesta de NCM, país, Comtrade)
# ---------------------------------------------------------------------------
def build_comex_download(cfg):
    cnae, label = cfg['codigo'], cfg['rotulo']
    agregado = len(_componentes(cfg)) > 1
    cesta = f"Cesta de NCMs do segmento: {cfg['cesta_ncm']}"
    wb = _new_workbook()
    _add_sheet(wb, 'Balanca por NCM', _read_setor(cfg, lambda c, r: f'Comex_{c}_NCM.csv'),
               title=f'Comércio exterior — Balança comercial por NCM — {label}',
               note=f'Fonte: Comex Stat/MDIC. {cesta}' + _nota_agregado(cfg))
    _add_sheet(wb, 'UF por NCM', _read_setor(cfg, lambda c, r: f'Comex_{c}_NCM_UF.csv'),
               title=f'Comércio exterior — UF de origem, por NCM — {label}',
               note='Mesma cesta de NCMs da aba "Balanca por NCM" — usada no ranking por UF do painel.')
    _add_sheet(wb, 'Pais parceiro', _read_setor(cfg, lambda c, r: f'Comex_Exportacao_Importacao_{c}.csv'),
               title=f'Comércio exterior — País parceiro e UF — {label}',
               note='Mesma cesta de NCMs, aberta por país — usada no ranking por país do painel.')
    # Comtrade do agregado ficaria com ~780 mil linhas (~38 MB) e repetiria o
    # que já está nas planilhas de cada segmento: só nas planilhas por CNAE.
    if not agregado:
        _add_sheet(wb, 'Comtrade mundial', _read(f'Comtrade_Global_{_rotulo_de(cnae)}_{cnae}.csv'),
                   title=f'Comércio mundial (Comtrade, proxy por HS) — {label}',
                   note='Contexto global — classificação por código HS como proxy do CNAE, não é o número oficial de comércio exterior do Brasil (ver Comex/MDIC pra isso).')
    d = _data()
    gm = d and (d['sectors'].get(cnae, {}).get('comtrade') or {}).get('grupos_mundo')
    if gm:
        linhas = [{'Grupo (SH)': x['hs'], 'Grupo de produto': x['grupo'], f"Mundo {gm['ano']} (US$)": x['mundo_usd'],
                   f"Crescimento ao ano {gm['ano_inicial']}-{gm['ano']} (%)": x['cresc_aa'], 'Brasil (US$)': x['brasil_usd'],
                   'Brasil (% do mundo)': x['brasil_pct'], 'Posição do Brasil': x['brasil_pos'],
                   'Maiores exportadores': ', '.join(f"{l['pais']} ({l['pct']:.0f}%)" for l in x['lideres'])} for x in gm['itens']]
        _add_sheet(wb, 'Comtrade por grupo', pd.DataFrame(linhas),
                   title=f'Comércio mundial por grupo de produto — {label}',
                   note=f"Fonte: Comtrade. Elaboração: DECAP/FIESP. Exportações mundiais por grupo do Sistema Harmonizado, {gm['ano']}.")
    cx = d and d['sectors'].get(cnae, {}).get('comex', {})
    if cx and cx.get('mensal'):
        _add_sheet(wb, 'Mensal FOB e CIF', _df(cx['mensal'], ['ano', 'mes', 'exportacao_fob', 'importacao_fob', 'importacao_cif'],
                   {'ano': 'Ano', 'mes': 'Mês', 'exportacao_fob': 'Exportação FOB (US$)', 'importacao_fob': 'Importação FOB (US$)', 'importacao_cif': 'Importação CIF (US$)'}),
                   title=f'Comércio exterior mês a mês — {label}',
                   note='Fonte: Comexstat. Elaboração: DECAP/FIESP. CIF = FOB + frete + seguro.')
    ext = d and d['shared'].get('comex_externas')
    if ext:
        linhas = [{'Cesta (fora do setor)': e['rotulo'], 'Ano': r['ano'], 'Exportação FOB (US$)': r['exp'],
                   'Importação FOB (US$)': r['imp'], 'Importação CIF (US$)': r['imp_cif']} for e in ext for r in e['serie']]
        _add_sheet(wb, 'Fora do setor', pd.DataFrame(linhas),
                   title='Produtos relacionados, fora do setor',
                   note='Fonte: Comexstat. Elaboração: DECAP/FIESP. Matérias-primas e produtos relacionados que não fazem parte do setor.')
    _save(wb, f'Comercio_Exterior_{cnae}.xlsx')


def build_mercado_download(cfg):
    d = _data()
    m = d and d['sectors'].get(cfg['codigo'], {}).get('mercado')
    if not m:
        return
    ab = m.get('ano_base_real')
    wb = _new_workbook()
    nomes = {'ano': 'Ano', 'producao_real': f'Produção (R$ de {ab})', 'exportacao_real': f'Exportação (R$ de {ab})',
             'importacao_real': f'Importação (R$ de {ab})', 'consumo_aparente_real': f'Consumo aparente (R$ de {ab})',
             'coef_exportacao': 'Coeficiente de exportação (%)', 'penetracao_importacao': 'Penetração da importação (%)'}
    _add_sheet(wb, 'Mercado anual', _df(m['yearly'], list(nomes), nomes),
               title=f"Mercado doméstico — {cfg['rotulo']}",
               note='Fonte: PIA/IBGE e Comexstat. Elaboração: DECAP/FIESP. Consumo aparente = produção + importação − exportação.')
    prod = m.get('produtos') or {}
    if prod.get('itens'):
        nomes_p = {'descricao': 'Grupo de produto', 'producao_real': 'Produção (R$)', 'exportacao_real': 'Exportação (R$)',
                   'importacao_real': 'Importação (R$)', 'consumo_aparente_real': 'Consumo aparente (R$)',
                   'coef_exportacao': 'Coeficiente de exportação (%)', 'penetracao_importacao': 'Penetração da importação (%)', 'sigilo': 'Sigilo parcial'}
        _add_sheet(wb, f"Por grupo de produto {prod['ano']}", _df(prod['itens'], list(nomes_p), nomes_p),
                   title=f"Mercado doméstico por grupo de produto, {prod['ano']} — {cfg['rotulo']}",
                   note='Fonte: PIA/IBGE e Comexstat. Elaboração: DECAP/FIESP. "Sigilo parcial" = parte da produção não divulgada pelo IBGE.')
    _save(wb, f"Mercado_Domestico_{cfg['codigo']}.xlsx")


# ---------------------------------------------------------------------------
# 06 — BNDES (por setor)
# ---------------------------------------------------------------------------
def build_bndes_download(cfg):
    cnae = cfg['codigo']
    df = _read_setor(cfg, lambda c, r: f'BNDES_Desembolsos_{c}.csv')
    wb = _new_workbook()
    _add_sheet(wb, 'Desembolsos', df,
               title=f"BNDES — Desembolsos — {cfg['rotulo']}",
               note=f"Fonte: BNDES, {int(df['Ano'].min())}-{int(df['Ano'].max())}. Valores em R$ correntes." + _nota_agregado(cfg))
    _save(wb, f'BNDES_{cnae}.xlsx')


# ---------------------------------------------------------------------------
# 07 — DECOM (bloco opcional, só se config_painel.json apontar o arquivo)
# ---------------------------------------------------------------------------
def build_decom_download(arquivo):
    wb = _new_workbook()
    _add_sheet(wb, 'Processos', _read(arquivo),
               title='DECOM — Processos de defesa comercial',
               note='Fonte: DECOM/GECEX.')
    _save(wb, 'DECOM.xlsx')


# ---------------------------------------------------------------------------
# Energia Industrial (view própria, comum a todos os painéis setoriais)
# ---------------------------------------------------------------------------
def build_energia_download():
    wb = _new_workbook()

    # Custo = tarifa média REAL faturada da classe Industrial por região
    # (MME/ANEEL), não o fator-de-carga-assumido do CSV bruto (checado contra
    # tarifa publicada e descartado — dava menos da metade do valor real).
    # Gasto/custo real (deflacionado por IPCA) na mesma lógica do build_data.py.
    df_energia = _read('energia_industria_transformacao_estados_brasil_2012-2026.csv', decimal='.')
    df_energia = df_energia.drop(columns=['FATOR_CARGA_ASSUMIDO'])  # não alimenta mais o custo, ver nota abaixo
    macro = build_macro()
    ipca_by_year = {}
    for r in macro:
        if r['ipca'] is not None:
            ipca_by_year.setdefault(r['ano'], []).append(r['ipca'])
    ipca_avg = {ano: sum(v) / len(v) for ano, v in ipca_by_year.items()}

    df_energia['CONSUMO_MWH'] = pd.to_numeric(df_energia['CONSUMO_MWH'], errors='coerce')
    df_energia['REGIAO'] = df_energia['UF'].map(UF_REGIAO).fillna('Brasil')
    df_energia['CUSTO_TOTAL_RS_MWH'] = df_energia.apply(
        lambda r: tarifa_industrial_regiao_ano(r['REGIAO'], int(r['ANO']), ipca_avg), axis=1)
    df_energia['GASTO_ESTIMADO_RS'] = df_energia['CONSUMO_MWH'] * df_energia['CUSTO_TOTAL_RS_MWH']

    meses_por_ano = df_energia.groupby('ANO')['MES'].nunique()
    ano_max = int(df_energia['ANO'].max())
    ano_base_energia = ANO_BASE_PRECOS
    fator_ipca_energia = build_fator_ipca(macro, ano_base_energia)
    df_energia['FATOR_IPCA'] = df_energia['ANO'].map(fator_ipca_energia)
    df_energia[f'CUSTO_REAL_RS_MWH_{ano_base_energia}'] = df_energia['CUSTO_TOTAL_RS_MWH'] * df_energia['FATOR_IPCA']
    df_energia[f'GASTO_ESTIMADO_REAL_RS_{ano_base_energia}'] = df_energia['GASTO_ESTIMADO_RS'] * df_energia['FATOR_IPCA']
    df_energia = df_energia.drop(columns=['FATOR_IPCA'])

    _add_sheet(wb, 'Estados x divisoes CNAE', df_energia,
               title='Energia industrial — Consumo/custo por UF e divisão CNAE (2012-2026)',
               note=f'Consumo (MWh): fonte própria por UF/divisão CNAE. Custo (R$/MWh): tarifa média REAL faturada '
                    f'da classe Industrial por região — MME/ANEEL, "Informativo Tarifário/Gestão do Setor Elétrico", '
                    f'Tabela "Tarifa Média Faturada por Classe de Consumo e Região" (gov.br/mme). Não varia por '
                    f'estado dentro da região nem por divisão CNAE. Anos sem edição publicada são interpolados/'
                    f'extrapolados por IPCA (ver coluna REGIAO). Gasto/custo real em R$ de {ano_base_energia} '
                    f'(deflacionado por IPCA).')
    _add_sheet(wb, 'SP detalhado', _read('energia_industria_transformacao_sp_brasil_2012-2026.csv', decimal='.'),
               title='Energia industrial — São Paulo (detalhado)')
    _save(wb, 'Energia_Industrial.xlsx')


def build_all_downloads():
    print('Gerando planilhas de download (data/downloads/)...')
    build_producao_download()
    build_financeiro_download()
    for cfg in SETORES:
        build_emprego_download(cfg)
        build_caged_download(cfg)
        build_comex_download(cfg)
        build_bndes_download(cfg)
        build_mercado_download(cfg)
    decom = CONFIG.get('blocos_opcionais', {}).get('decom')
    if decom:
        build_decom_download(decom)
    build_energia_download()


if __name__ == '__main__':
    build_all_downloads()
