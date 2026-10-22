#!/usr/bin/env python3
"""Pré-processa os CSVs brutos em 3_Dados_Tratados_CSV/ e gera data/data.json
para o dashboard estático (index.html + js/main.js)."""

import json
import math
import re
import unicodedata
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent
SRC_DIR = ROOT / '3_Dados_Tratados_CSV'
OUT_DIR = ROOT / 'data'


# ---------------------------------------------------------------------------
# Helpers genéricos
# ---------------------------------------------------------------------------
def read_csv(name, **kwargs):
    return pd.read_csv(SRC_DIR / name, sep=';', decimal=',', encoding='utf-8-sig', **kwargs)


def is_true_col(series):
    return series.astype(str).str.strip().str.upper() == 'TRUE'


def clean(v):
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    return v


def to_int(v):
    v = clean(v)
    return None if v is None else int(round(float(v)))


def to_num(v):
    v = clean(v)
    return None if v is None else float(v)


def np_default(o):
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.floating):
        return None if np.isnan(o) else float(o)
    if isinstance(o, np.bool_):
        return bool(o)
    raise TypeError(f'Object of type {type(o).__name__} is not JSON serializable')


# ---------------------------------------------------------------------------
# Tabela de UF (código IBGE -> sigla/nome canônicos)
# ---------------------------------------------------------------------------
UF_TABLE = [
    ('11', 'RO', 'Rondônia'), ('12', 'AC', 'Acre'), ('13', 'AM', 'Amazonas'),
    ('14', 'RR', 'Roraima'), ('15', 'PA', 'Pará'), ('16', 'AP', 'Amapá'),
    ('17', 'TO', 'Tocantins'), ('21', 'MA', 'Maranhão'), ('22', 'PI', 'Piauí'),
    ('23', 'CE', 'Ceará'), ('24', 'RN', 'Rio Grande do Norte'), ('25', 'PB', 'Paraíba'),
    ('26', 'PE', 'Pernambuco'), ('27', 'AL', 'Alagoas'), ('28', 'SE', 'Sergipe'),
    ('29', 'BA', 'Bahia'), ('31', 'MG', 'Minas Gerais'), ('32', 'ES', 'Espírito Santo'),
    ('33', 'RJ', 'Rio de Janeiro'), ('35', 'SP', 'São Paulo'), ('41', 'PR', 'Paraná'),
    ('42', 'SC', 'Santa Catarina'), ('43', 'RS', 'Rio Grande do Sul'),
    ('50', 'MS', 'Mato Grosso do Sul'), ('51', 'MT', 'Mato Grosso'),
    ('52', 'GO', 'Goiás'), ('53', 'DF', 'Distrito Federal'),
]
BY_CODE = {code: (uf, nome) for code, uf, nome in UF_TABLE}
BY_ABBR = {uf: (uf, nome) for _, uf, nome in UF_TABLE}


def _norm_name(s):
    s = unicodedata.normalize('NFKD', s.strip().lower())
    return s.encode('ascii', 'ignore').decode('ascii')


BY_NAME_NORM = {_norm_name(nome): (uf, nome) for _, uf, nome in UF_TABLE}


def resolve_uf(raw):
    """Resolve uma string de UF em qualquer formato observado nos CSVs
    ("15 - Pará", " SP", "São Paulo", "15 - Para")."""
    if raw is None:
        return None
    try:
        if pd.isna(raw):
            return None
    except (TypeError, ValueError):
        pass
    s = str(raw).strip().strip('"').strip()
    if s == '' or s == 'Total':
        return None
    m = re.match(r'^(\d{2})\s*-\s*(.+)$', s)
    if m and m.group(1) in BY_CODE:
        return BY_CODE[m.group(1)]
    if s.upper() in BY_ABBR:
        return BY_ABBR[s.upper()]
    norm = _norm_name(s)
    if norm in BY_NAME_NORM:
        return BY_NAME_NORM[norm]
    return None


MESES_PT = {'Jan': 1, 'Fev': 2, 'Mar': 3, 'Abr': 4, 'Mai': 5, 'Jun': 6,
            'Jul': 7, 'Ago': 8, 'Set': 9, 'Out': 10, 'Nov': 11, 'Dez': 12}


def monthly_coverage(rows):
    """Calcula {inicio, fim} ('AAAA-MM') a partir do min/max real de uma lista
    de registros mensais — evita datas de cobertura hardcoded ficarem
    desatualizadas quando a fonte é atualizada com mais meses."""
    if not rows:
        return {'inicio': None, 'fim': None}
    keys = sorted(r['ano'] * 100 + r['mes'] for r in rows)
    fmt = lambda k: f'{k // 100:04d}-{k % 100:02d}'
    return {'inicio': fmt(keys[0]), 'fim': fmt(keys[-1])}


def parse_competencia(s):
    """Meses abreviados PT-BR usados no CAGED ("Dez/2019")."""
    if not isinstance(s, str):
        return None
    s = s.strip().strip('"')
    m = re.match(r'^(\w{3})/(\d{4})$', s)
    if not m or m.group(1) not in MESES_PT:
        return None
    return int(m.group(2)), MESES_PT[m.group(1)]


# ---------------------------------------------------------------------------
# SHARED: Produção física
# ---------------------------------------------------------------------------
def build_producao():
    met_df = read_csv('Producao_Fisica_Mensal_Metalurgia.csv')
    metalurgia_indice = [
        {'ano': to_int(r.ano), 'mes': to_int(r.mes), 'data': r.data,
         'indice_bruto': to_num(r.indice_bruto_base_100),
         'indice_dessaz': to_num(r.indice_dessazonalizado_base_100)}
        for r in met_df.itertuples(index=False)
    ]

    ag_df = read_csv('Producao_Fisica_Aco_Gusa_Bruto.csv').rename(columns={
        'Período': 'periodo', 'Aço Bruto': 'aco_bruto', 'Laminados': 'laminados',
        'Ferro-Gusa*': 'ferro_gusa', 'Semi-Acabados': 'semi_acabados',
    })
    aco_gusa = []
    for r in ag_df.itertuples(index=False):
        ano, mes = int(r.periodo[0:4]), int(r.periodo[5:7])
        aco_gusa.append({'ano': ano, 'mes': mes, 'data': r.periodo,
                          'aco_bruto': to_num(r.aco_bruto), 'laminados': to_num(r.laminados),
                          'ferro_gusa': to_num(r.ferro_gusa), 'semi_acabados': to_num(r.semi_acabados)})

    ds_df = read_csv('Producao_Fisica_Aco_Gusa_Dessazonalizado.csv').rename(columns={
        'Período': 'periodo', 'Aço Bruto': 'aco_bruto', 'Total sem Ferro-Gusa': 'total_sem_ferro_gusa',
    })
    aco_gusa_dessaz = []
    for r in ds_df.itertuples(index=False):
        ano, mes = int(r.periodo[0:4]), int(r.periodo[5:7])
        aco_gusa_dessaz.append({'ano': ano, 'mes': mes, 'data': r.periodo,
                                 'aco_bruto': to_num(r.aco_bruto),
                                 'total_sem_ferro_gusa': to_num(r.total_sem_ferro_gusa)})

    key = lambda r: r['ano'] * 100 + r['mes']

    # Alumínio primário (ABAL) — produção física do 2452. Diferente do aço
    # (2451), aqui é só uma série (não abre por produto), então não tem
    # equivalente a laminados/ferro-gusa/semi-acabados.
    al_df = read_csv('Producao_Aluminio_Primario_ABAL.csv')
    aluminio_primario = sorted([
        {'ano': to_int(r.Ano), 'mes': to_int(r.Mes),
         'producao': to_num(r.Producao_Mil_T), 'producao_dessaz': to_num(r.Producao_Dessaz_Mil_T)}
        for r in al_df.itertuples(index=False)
    ], key=key)

    return (sorted(metalurgia_indice, key=key), sorted(aco_gusa, key=key), sorted(aco_gusa_dessaz, key=key),
            aluminio_primario)


# ---------------------------------------------------------------------------
# SHARED: Financeiro (PIA) — metalurgia ampla + fundição 24.5 (2451+2452)
# ---------------------------------------------------------------------------
def read_financeiro(name):
    df = read_csv(name)

    def col(*names):
        for n in names:
            if n in df.columns:
                return df[n]
        return pd.Series([None] * len(df))

    numero = col('numero_empresas', 'numero_unidades_locais')
    receita = col('receita_liquida_total', 'total_receitas_liquidas')
    custos = col('custos_despesas_totais', 'total_custos_despesas')
    gastos_pessoal = col('gastos_pessoal_total', 'salarios_retiradas')
    materias_primas = col('consumo_materias_primas')

    out = []
    for i in range(len(df)):
        out.append({
            'ano': to_int(df['ano'].iat[i]),
            'numero_empresas': to_int(numero.iat[i]),
            'pessoal_ocupado': to_int(df['pessoal_ocupado'].iat[i]),
            'receita_liquida_total': to_num(receita.iat[i]),
            'custos_despesas_totais': to_num(custos.iat[i]),
            'gastos_pessoal_total': to_num(gastos_pessoal.iat[i]),
            'consumo_materias_primas': to_num(materias_primas.iat[i]),
            'vbpi': to_num(df['vbpi'].iat[i]),
            'vti': to_num(df['vti'].iat[i]),
        })
    return sorted(out, key=lambda r: r['ano'])


def read_financeiro_por_cnae(name):
    """Quebra 2451 x 2452 do financeiro (só existe pra 2024 — PIA/IBGE não
    abre por classe nos demais anos, só no grupo 24.5 combinado)."""
    df = read_csv(name)
    out = []
    for r in df.itertuples(index=False):
        out.append({
            'ano': to_int(r.ano), 'cnae': str(r.cnae_subclasse).strip(),
            'numero_empresas': to_int(r.numero_empresas_estrato_certo),
            'pessoal_ocupado': to_int(r.pessoal_ocupado),
            'receita_liquida_total': to_num(r.receita_liquida_total),
            'custos_despesas_totais': to_num(r.custos_despesas_totais),
            'gastos_pessoal_total': to_num(r.gastos_pessoal_total),
            'custos_operacoes_industriais': to_num(r.custos_operacoes_industriais),
            'vbpi': to_num(r.vbpi), 'vti': to_num(r.vti),
        })
    return sorted(out, key=lambda r: (r['ano'], r['cnae']))


# ---------------------------------------------------------------------------
# SHARED: Macro + DECOM
# ---------------------------------------------------------------------------
def build_macro():
    df = read_csv('Indicadores_Macro_e_Inflacao.csv')
    df = df[df['ano'] >= 1990]
    rows = [
        {'ano': to_int(r.ano), 'mes': to_int(r.mes), 'data': r.data,
         'ipca': to_num(r.ipca_indice_inflacao), 'dolar': to_num(r.dolar_venda),
         'ipp_metalurgia': to_num(r.ipp_metalurgia_indice)}
        for r in df.itertuples(index=False)
    ]
    return sorted(rows, key=lambda r: r['ano'] * 100 + r['mes'])


def build_fator_ipca(macro_rows, ano_base):
    """Fator anual de deflação só por IPCA (sem câmbio), pra série que já é
    R$ nominal. fator[ano] = IPCA médio de ano_base / IPCA médio do ano."""
    ipca_by_year = {}
    for r in macro_rows:
        if r['ipca'] is not None:
            ipca_by_year.setdefault(r['ano'], []).append(r['ipca'])
    ipca_avg = {ano: sum(v) / len(v) for ano, v in ipca_by_year.items()}
    ipca_base = ipca_avg.get(ano_base)
    if not ipca_base:
        return {}
    return {ano: ipca_base / v for ano, v in ipca_avg.items() if v}


def build_fator_brl_2023(macro_rows):
    """Fator anual USD -> R$ de 2023: câmbio médio do ano x deflator IPCA
    (base = média de 2023). Usado só na balança comercial (comex), pra dar
    a mesma leitura 'R$ constante' que aparece em relatórios do setor,
    sem trocar a unidade (US$ FOB) do resto do bloco de comércio exterior."""
    dolar_by_year, ipca_by_year = {}, {}
    for r in macro_rows:
        if r['dolar'] is not None:
            dolar_by_year.setdefault(r['ano'], []).append(r['dolar'])
        if r['ipca'] is not None:
            ipca_by_year.setdefault(r['ano'], []).append(r['ipca'])
    dolar_avg = {ano: sum(v) / len(v) for ano, v in dolar_by_year.items()}
    ipca_avg = {ano: sum(v) / len(v) for ano, v in ipca_by_year.items()}
    ipca_2023 = ipca_avg.get(2023)
    if not ipca_2023:
        return {}
    return {
        ano: dolar_avg[ano] * (ipca_2023 / ipca_avg[ano])
        for ano in dolar_avg
        if ano in ipca_avg and ipca_avg[ano]
    }


def build_decom():
    df = read_csv('decom_fundicao_processos_2451.csv').rename(columns={
        'NCM': 'ncm', 'País': 'pais', 'Status': 'status', 'Alíquota_USD_Ton': 'aliquota',
        'Data_Início': 'data_inicio', 'Data_Resolução': 'data_resolucao',
        'Circular_Referência': 'circular',
    })
    cols = ['ncm', 'pais', 'status', 'aliquota', 'data_inicio', 'data_resolucao', 'circular']
    return [{k: clean(v) for k, v in row.items()} for row in df[cols].to_dict('records')]


# ---------------------------------------------------------------------------
# ENERGIA INDUSTRIAL: consumo/custo de energia de toda a indústria de
# transformação (24 divisões CNAE), com abertura pelas 27 UFs + Brasil.
# Consumo: fonte própria (formato diferente dos demais CSVs, separador
# decimal '.', não ','). A série completa por divisão x UF (~115 mil linhas)
# é grande demais para embutir inteira no data.json principal, então é
# gravada em 24 arquivos separados (data/energia/serie-cnae-N.json) e
# carregada sob demanda pelo dashboard só quando aquela divisão é selecionada.
#
# Custo (R$/MWh): o CSV bruto trazia uma estimativa por "fator de carga
# assumido" (fixo por divisão CNAE, nunca varia por estado nem por ano) que,
# checada contra tarifa real publicada (ANEEL, subgrupo A4), dava menos da
# metade do valor real faturado — não é confiável. Substituído pela tarifa
# média REAL faturada da classe Industrial, por região e ano, publicada pelo
# MME/ANEEL no "Informativo Tarifário/Gestão do Setor Elétrico" (ver
# ANEEL_TARIFA_INDUSTRIAL_ANUAL abaixo — fonte e citação completa na aba
# Referências do painel). É mais grosso (5 regiões, não 27 estados; 1 classe
# "Industrial", não 24 divisões CNAE) mas é dado real, não modelado.
# ---------------------------------------------------------------------------
UF_NOME_EXTRA = {'BR': 'Brasil'}

UF_REGIAO = {
    'AC': 'Norte', 'AP': 'Norte', 'AM': 'Norte', 'PA': 'Norte', 'RO': 'Norte', 'RR': 'Norte', 'TO': 'Norte',
    'AL': 'Nordeste', 'BA': 'Nordeste', 'CE': 'Nordeste', 'MA': 'Nordeste', 'PB': 'Nordeste',
    'PE': 'Nordeste', 'PI': 'Nordeste', 'RN': 'Nordeste', 'SE': 'Nordeste',
    'DF': 'Centro-Oeste', 'GO': 'Centro-Oeste', 'MT': 'Centro-Oeste', 'MS': 'Centro-Oeste',
    'ES': 'Sudeste', 'MG': 'Sudeste', 'RJ': 'Sudeste', 'SP': 'Sudeste',
    'PR': 'Sul', 'RS': 'Sul', 'SC': 'Sul',
}

# Tarifa média REAL faturada, classe Industrial, R$/MWh nominal — MME/ANEEL,
# "Informativo Tarifário/Gestão do Setor Elétrico" (Tabela 7, "Tarifa Média
# Faturada por Classe de Consumo e Região"), edições anuais. 2017/2019 são
# médias do ano; 2022-2025 são a competência de dezembro (ou outubro/2022,
# mês disponível na edição daquele ano) — pequena inconsistência de
# competência entre anos, mas é o dado real publicado, não estimado.
ANEEL_TARIFA_INDUSTRIAL_ANUAL = {
    2017: {'Brasil': 397.07, 'Centro-Oeste': 364.75, 'Nordeste': 370.18, 'Norte': 433.84, 'Sudeste': 406.35, 'Sul': 397.17},
    2019: {'Brasil': 479.22, 'Centro-Oeste': 477.67, 'Nordeste': 435.89, 'Norte': 524.27, 'Sudeste': 492.17, 'Sul': 471.87},
    2022: {'Brasil': 577.14, 'Centro-Oeste': 669.26, 'Nordeste': 582.24, 'Norte': 591.10, 'Sudeste': 583.29, 'Sul': 545.57},
    2023: {'Brasil': 638.21, 'Centro-Oeste': 775.19, 'Nordeste': 674.37, 'Norte': 735.06, 'Sudeste': 630.85, 'Sul': 594.53},
    2024: {'Brasil': 694.65, 'Centro-Oeste': 824.33, 'Nordeste': 712.20, 'Norte': 756.71, 'Sudeste': 694.82, 'Sul': 652.35},
    2025: {'Brasil': 785.53, 'Centro-Oeste': 955.71, 'Nordeste': 825.31, 'Norte': 825.59, 'Sudeste': 769.14, 'Sul': 752.67},
}
_ANOS_TARIFA_REAL = sorted(ANEEL_TARIFA_INDUSTRIAL_ANUAL)


def tarifa_industrial_regiao_ano(regiao, ano, ipca_avg):
    """Tarifa média industrial (R$/MWh nominal) pra uma região/ano: valor
    real da ANEEL quando existe; interpolação linear entre os dois anos
    reais mais próximos quando o ano cai no meio; e fora do intervalo
    conhecido, extrapola pela variação do IPCA a partir da ponta mais
    próxima (mantém a tarifa real em termos reais, não trava um valor
    nominal congelado)."""
    if ano in ANEEL_TARIFA_INDUSTRIAL_ANUAL:
        return ANEEL_TARIFA_INDUSTRIAL_ANUAL[ano][regiao]
    primeiro, ultimo = _ANOS_TARIFA_REAL[0], _ANOS_TARIFA_REAL[-1]
    if ano < primeiro or ano > ultimo:
        ano_ref = primeiro if ano < primeiro else ultimo
        base = ANEEL_TARIFA_INDUSTRIAL_ANUAL[ano_ref][regiao]
        ipca_ano = ipca_avg.get(ano) or ipca_avg.get(ano_ref)
        ipca_ref = ipca_avg.get(ano_ref)
        if not ipca_ano or not ipca_ref:
            return base
        return base * ipca_ano / ipca_ref
    lo = max(a for a in _ANOS_TARIFA_REAL if a <= ano)
    hi = min(a for a in _ANOS_TARIFA_REAL if a >= ano)
    if lo == hi:
        return ANEEL_TARIFA_INDUSTRIAL_ANUAL[lo][regiao]
    frac = (ano - lo) / (hi - lo)
    v_lo, v_hi = ANEEL_TARIFA_INDUSTRIAL_ANUAL[lo][regiao], ANEEL_TARIFA_INDUSTRIAL_ANUAL[hi][regiao]
    return v_lo + (v_hi - v_lo) * frac


def build_energia_industrial(macro_rows):
    df = pd.read_csv(SRC_DIR / 'energia_industria_transformacao_estados_brasil_2012-2026.csv',
                      sep=';', decimal='.', encoding='utf-8-sig')
    num_cols = ['CONSUMO_MWH', 'PARTICIPACAO_PCT_SETOR_NA_UF']
    for c in num_cols:
        df[c] = pd.to_numeric(df[c], errors='coerce')

    ipca_by_year = {}
    for r in macro_rows:
        if r['ipca'] is not None:
            ipca_by_year.setdefault(r['ano'], []).append(r['ipca'])
    ipca_avg = {ano: sum(v) / len(v) for ano, v in ipca_by_year.items()}

    df['REGIAO'] = df['UF'].map(UF_REGIAO).fillna('Brasil')
    df['CUSTO_TOTAL_RS_MWH'] = df.apply(
        lambda r: tarifa_industrial_regiao_ano(r['REGIAO'], int(r['ANO']), ipca_avg), axis=1)
    df['GASTO_ESTIMADO_RS'] = df['CONSUMO_MWH'] * df['CUSTO_TOTAL_RS_MWH']

    # Deflaciona pro último ano completo disponível (mesmo padrão — só IPCA,
    # sem câmbio — usado no faturamento da Fundição), pra não misturar
    # inflação acumulada de 14 anos com variação real de custo.
    meses_por_ano = df.groupby('ANO')['MES'].nunique()
    ano_max = int(df['ANO'].max())
    ano_base_energia = ano_max if meses_por_ano.get(ano_max, 0) >= 12 else ano_max - 1
    fator_ipca_energia = build_fator_ipca(macro_rows, ano_base_energia)
    df['fator_ipca'] = df['ANO'].map(fator_ipca_energia)
    df['CUSTO_REAL_RS_MWH'] = df['CUSTO_TOTAL_RS_MWH'] * df['fator_ipca']
    df['GASTO_ESTIMADO_REAL_RS'] = df['GASTO_ESTIMADO_RS'] * df['fator_ipca']

    def nome_uf(uf):
        if uf in UF_NOME_EXTRA:
            return UF_NOME_EXTRA[uf]
        found = BY_ABBR.get(uf)
        return found[1] if found else uf

    ufs = [{'uf': uf, 'nome': nome_uf(uf)} for uf in sorted(df['UF'].unique().tolist())]
    ufs.sort(key=lambda u: (u['uf'] != 'BR', u['nome']))

    # fator_carga_assumido da fonte não alimenta mais o custo (ver nota acima
    # sobre a troca pela tarifa real ANEEL) — não é exposto no schema.
    divisoes_df = (df[['CNAE_DIVISAO', 'CNAE_DIVISAO_DESCRICAO']]
                   .drop_duplicates('CNAE_DIVISAO').sort_values('CNAE_DIVISAO'))
    divisoes = [
        {'cnae': to_int(r.CNAE_DIVISAO), 'descricao': r.CNAE_DIVISAO_DESCRICAO}
        for r in divisoes_df.itertuples(index=False)
    ]
    coverage = monthly_coverage(
        [{'ano': to_int(r.ANO), 'mes': to_int(r.MES)} for r in df[['ANO', 'MES']].drop_duplicates().itertuples(index=False)]
    )

    ordem_cnae = [d['cnae'] for d in divisoes]
    energia_dir = OUT_DIR / 'energia'
    energia_dir.mkdir(parents=True, exist_ok=True)

    # Por divisão (as 24), série completa nos 28 UFs — alimenta os gráficos
    # de tendência/ranking que comparam UFs para um setor já escolhido.
    for d in divisoes:
        sub = df[df['CNAE_DIVISAO'] == d['cnae']]
        obj = {}
        for uf, g in sub.groupby('UF'):
            g = g.sort_values(['ANO', 'MES'])
            obj[uf] = [
                [to_int(r.ANO), to_int(r.MES), to_num(r.CONSUMO_MWH), to_num(r.CUSTO_TOTAL_RS_MWH),
                 to_num(r.PARTICIPACAO_PCT_SETOR_NA_UF), to_num(r.CUSTO_REAL_RS_MWH)]
                for r in g.itertuples(index=False)
            ]
        with open(energia_dir / f"serie-cnae-{d['cnae']}.json", 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, separators=(',', ':'), default=np_default)

    # Por UF (as 28), participação (%) das 24 divisões em cada mês, na ordem
    # fixa de `divisoes` — alimenta o gráfico de composição setorial "de um
    # estado por vez" (drill-down ao clicar num estado do ranking).
    for uf, g in df.groupby('UF'):
        by_month = {}
        for (ano, mes), gg in g.groupby(['ANO', 'MES']):
            part_por_cnae = {int(r.CNAE_DIVISAO): to_num(r.PARTICIPACAO_PCT_SETOR_NA_UF) for r in gg.itertuples(index=False)}
            by_month[str(ano * 100 + mes)] = [part_por_cnae.get(c) for c in ordem_cnae]
        with open(energia_dir / f'composicao-uf-{uf}.json', 'w', encoding='utf-8') as f:
            json.dump(by_month, f, ensure_ascii=False, separators=(',', ':'), default=np_default)

    return {
        'coverage': coverage,
        'ufs': ufs,
        'divisoes': divisoes,
        'serie_campos': ['ano', 'mes', 'consumo_mwh', 'custo_rs_mwh', 'participacao_pct', 'custo_real_rs_mwh'],
        'ano_base_deflacao': ano_base_energia,
    }


# ---------------------------------------------------------------------------
# Por setor (2451 / 2452)
# ---------------------------------------------------------------------------
def latest_breakdown(file):
    df = read_csv(file)
    ano_max = int(df['ano'].max())
    sub = df[(df['ano'] == ano_max) & (~is_true_col(df['is_total']))]
    items = [{'categoria': r.categoria, 'frequencia': to_int(r.frequencia)} for r in sub.itertuples(index=False)]
    items.sort(key=lambda x: -(x['frequencia'] or 0))
    return {'ano': ano_max, 'items': items}


def build_sector(cnae, label, fator_brl_2023):
    print(f'  Setor {cnae} ({label})...')

    # --- RAIS: estabelecimentos/vínculos por UF, anual ---
    rais_file = 'Empregos_RAIS_UF_Ferro_Aco_2451.csv' if cnae == '2451' else 'Empregos_RAIS_UF_Nao_Ferrosos_2452.csv'
    rais_df = read_csv(rais_file)
    uf_yearly = []
    for r in rais_df.itertuples(index=False):
        ufi = resolve_uf(r.UF)
        if ufi:
            uf_yearly.append({'ano': to_int(r.Ano), 'uf': ufi[0], 'nome_uf': ufi[1],
                               'estabelecimentos': to_int(r.Estabelecimentos), 'vinculos': to_int(r.Vinculos)})
    uf_yearly.sort(key=lambda r: (r['ano'], r['uf']))
    uf_yearly_total = sorted([
        {'ano': to_int(r.Ano), 'estabelecimentos': to_int(r.Estabelecimentos), 'vinculos': to_int(r.Vinculos)}
        for r in rais_df.itertuples(index=False) if str(r.UF).strip() == 'Total'
    ], key=lambda r: r['ano'])

    # --- RAIS por porte ---
    tam_file = 'Empregos_RAIS_Tamanho_Ferro_Aco_2451.csv' if cnae == '2451' else 'Empregos_RAIS_Tamanho_Nao_Ferrosos_2452.csv'
    tam_df = read_csv(tam_file)
    tamanho_yearly = sorted([
        {'ano': to_int(r.Ano), 'faixa': r.Faixa_Tamanho, 'estabelecimentos': to_int(r.Estabelecimentos),
         'vinculos': to_int(r.Vinculos)}
        for r in tam_df.itertuples(index=False) if r.Faixa_Tamanho != 'Total'
    ], key=lambda r: r['ano'])

    # --- Perfis detalhados RAIS (retrato do último ano) ---
    escolaridade_latest = latest_breakdown(f'rais_vinc_fundicao_escolaridade_{cnae}.csv')
    ocupacao_agrupada_latest = latest_breakdown(f'rais_vinc_fundicao_ocupacao_agrupada_{cnae}.csv')
    ocupacao_detalhada_latest = latest_breakdown(f'rais_vinc_fundicao_ocupacao_{cnae}.csv')
    tempo_emprego_latest = latest_breakdown(f'rais_vinc_fundicao_tempo_emprego_{cnae}.csv')

    # --- Escolaridade como série completa (para área empilhada) ---
    esc_df = read_csv(f'rais_vinc_fundicao_escolaridade_{cnae}.csv')
    esc_full = esc_df[(~is_true_col(esc_df['is_total'])) & (esc_df['categoria'] != 'Total')]
    escolaridade_yearly = sorted([
        {'ano': to_int(r.ano), 'categoria': r.categoria, 'frequencia': to_int(r.frequencia)}
        for r in esc_full.itertuples(index=False)
    ], key=lambda r: r['ano'])

    # --- Remuneração (massa salarial) ---
    massa_df = read_csv(f'rais_vinc_fundicao_massa_{cnae}.csv')
    massa_ano_max = int(massa_df['ano'].max())
    massa_latest = massa_df[massa_df['ano'] == massa_ano_max]
    massa_latest_total_mask = is_true_col(massa_latest['is_total'])
    massa_nat_rows = massa_latest[massa_latest_total_mask]
    massa_nat = None
    if len(massa_nat_rows):
        rr = massa_nat_rows.iloc[0]
        massa_nat = {'frequencia': to_int(rr['frequencia']),
                     'remuneracao_media_nominal': to_num(rr['remuneracao_media_nominal'])}
    massa_items = []
    for r in massa_latest[~massa_latest_total_mask].itertuples(index=False):
        ufi = resolve_uf(r.categoria)
        if ufi:
            massa_items.append({'uf': ufi[0], 'nome_uf': ufi[1], 'frequencia': to_int(r.frequencia),
                                 'remuneracao_media_nominal': to_num(r.remuneracao_media_nominal)})
    massa_uf_latest = {'ano': massa_ano_max, 'nacional': massa_nat, 'items': massa_items}

    massa_nat_all = massa_df[is_true_col(massa_df['is_total'])].sort_values('ano')
    massa_nacional_yearly = [
        {'ano': to_int(r.ano), 'frequencia': to_int(r.frequencia),
         'remuneracao_media_nominal': to_num(r.remuneracao_media_nominal)}
        for r in massa_nat_all.itertuples(index=False)
    ]

    # --- CAGED (2008-2019, por UF) ---
    def load_caged(file):
        df = read_csv(file)
        df = df[df['cnae_subclasse'].astype(str).str.strip() == cnae]
        return df[df['Competencia'] != 'Total'].copy()

    def with_competencia(df):
        parsed = df['Competencia'].apply(parse_competencia)
        df = df.assign(cyr=[p[0] if p else None for p in parsed],
                        cmo=[p[1] if p else None for p in parsed])
        return df.dropna(subset=['cyr', 'cmo'])

    caged_saldo = with_competencia(load_caged('caged_fundicao_saldo_mensal_uf_cnae.csv'))
    caged_saldo['Saldo_Movimentacao'] = pd.to_numeric(caged_saldo['Saldo_Movimentacao'], errors='coerce')
    saldo_monthly_national = (
        caged_saldo.groupby(['cyr', 'cmo'])['Saldo_Movimentacao'].sum()
        .reset_index().sort_values(['cyr', 'cmo'])
    )
    saldo_monthly_national = [
        {'ano': to_int(r.cyr), 'mes': to_int(r.cmo), 'saldo': to_int(r.Saldo_Movimentacao)}
        for r in saldo_monthly_national.itertuples(index=False)
    ]

    caged_salario = with_competencia(load_caged('caged_fundicao_salario_mensal_uf_cnae.csv'))
    caged_salario['Salario_Mensal'] = pd.to_numeric(caged_salario['Salario_Mensal'], errors='coerce')
    # Erro de digitação isolado na fonte (ex.: Santa Catarina/2451, Jun/2025 =
    # R$33,4 milhões contra ~R$2-3 mil em todos os outros meses do mesmo
    # estado — 10.000x fora da curva): descarta linhas > 15x a mediana
    # daquele estado antes de somar, senão 1 ponto ruim esmaga a escala do
    # gráfico inteiro.
    mediana_por_uf = caged_salario.groupby('UF')['Salario_Mensal'].transform('median')
    caged_salario.loc[caged_salario['Salario_Mensal'] > mediana_por_uf * 15, 'Salario_Mensal'] = np.nan
    # Soma entre UFs: cada linha já é uma massa salarial por UF/mês (varia com o
    # tamanho do estado, de centenas a centenas de milhares — não é um salário
    # médio por trabalhador), então o total nacional é a soma, não a média.
    salario_monthly_national = (
        caged_salario.groupby(['cyr', 'cmo'])['Salario_Mensal'].sum()
        .reset_index().sort_values(['cyr', 'cmo'])
    )
    salario_monthly_national = [
        {'ano': to_int(r.cyr), 'mes': to_int(r.cmo), 'massa_salarial': to_num(r.Salario_Mensal)}
        for r in salario_monthly_national.itertuples(index=False)
    ]

    salario_uf_rows = []
    for r in caged_salario.itertuples(index=False):
        ufi = resolve_uf(r.UF)
        if ufi:
            salario_uf_rows.append({'ano': int(r.cyr), 'mes': int(r.cmo), 'uf': ufi[0], 'massa_salarial': r.Salario_Mensal})
    salario_uf_monthly = []
    if salario_uf_rows:
        salario_uf_df = pd.DataFrame(salario_uf_rows).groupby(['ano', 'mes', 'uf'])['massa_salarial'].sum().reset_index()
        salario_uf_monthly = sorted([
            {'ano': to_int(r.ano), 'mes': to_int(r.mes), 'uf': r.uf, 'massa_salarial': to_num(r.massa_salarial)}
            for r in salario_uf_df.itertuples(index=False)
        ], key=lambda x: (x['ano'] * 100 + x['mes'], x['uf']))

    # Granularidade mensal por UF (a fonte já tem UF+competência; antes só
    # virava total anual, perdendo a abertura mensal que o filtro de período
    # do dashboard principal usa para as demais séries CAGED).
    saldo_uf_rows = []
    for r in caged_saldo.itertuples(index=False):
        ufi = resolve_uf(r.UF)
        if ufi:
            saldo_uf_rows.append({'ano': int(r.cyr), 'mes': int(r.cmo), 'uf': ufi[0], 'saldo': r.Saldo_Movimentacao})
    saldo_uf_monthly = []
    if saldo_uf_rows:
        saldo_uf_df = pd.DataFrame(saldo_uf_rows).groupby(['ano', 'mes', 'uf'])['saldo'].sum().reset_index()
        saldo_uf_monthly = sorted([
            {'ano': to_int(r.ano), 'mes': to_int(r.mes), 'uf': r.uf, 'saldo': to_int(r.saldo)}
            for r in saldo_uf_df.itertuples(index=False)
        ], key=lambda x: (x['ano'] * 100 + x['mes'], x['uf']))

    tipomov_all = read_csv('caged_fundicao_tipo_movimentacao_mensal_cnae.csv')
    tipomov_all = tipomov_all[tipomov_all['cnae_subclasse'].astype(str).str.strip() == cnae]
    tipomov_monthly_src = with_competencia(tipomov_all[tipomov_all['Competencia'] != 'Total'].copy())
    tipomov_monthly_src['Quantidade'] = pd.to_numeric(tipomov_monthly_src['Quantidade'], errors='coerce')
    tipo_movimentacao_monthly = []
    for (ano, mes), g in tipomov_monthly_src.groupby(['cyr', 'cmo']):
        adm = g[g['Tipo_Movimentacao'].str.contains('admiss', case=False, na=False)]['Quantidade'].sum()
        desl = g[g['Tipo_Movimentacao'].str.contains('desligamento', case=False, na=False)]['Quantidade'].sum()
        tipo_movimentacao_monthly.append({'ano': int(ano), 'mes': int(mes), 'admissoes': to_int(adm),
                                           'desligamentos': to_int(desl)})
    tipo_movimentacao_monthly.sort(key=lambda r: r['ano'] * 100 + r['mes'])

    tipomov_total_src = tipomov_all[tipomov_all['Competencia'] == 'Total'].copy()
    tipomov_total_src['Quantidade'] = pd.to_numeric(tipomov_total_src['Quantidade'], errors='coerce')
    tmt = (tipomov_total_src.groupby('Tipo_Movimentacao')['Quantidade'].sum()
           .reset_index().sort_values('Quantidade', ascending=False))
    tipo_movimentacao_breakdown_total = [
        {'tipo': r.Tipo_Movimentacao, 'quantidade': to_int(r.Quantidade)} for r in tmt.itertuples(index=False)
    ]

    # --- Comércio exterior (Comex Brasil) ---
    comex_df = read_csv(f'Comex_Exportacao_Importacao_{cnae}.csv')
    comex_df['Valor_US_FOB'] = pd.to_numeric(comex_df['Valor_US_FOB'], errors='coerce')
    comex_df['Quilograma_Liquido'] = pd.to_numeric(comex_df['Quilograma_Liquido'], errors='coerce')

    # Os totais nacionais (exportação x importação, kg, balança) vêm de uma
    # extração por NCM específica de fundição — mais fiel ao escopo do que
    # `Comex_Exportacao_Importacao_{cnae}.csv` (que superestimava os valores,
    # provavelmente com NCMs correlatos demais):
    #   2451: grupo 7325, "obras moldadas de ferro/aço" (limpo, só fundido)
    #   2452: "outras obras" de cobre/níquel/alumínio/chumbo/zinco/estanho
    #         (74199100, 75089000/90, 76169900, 78060090, 79070090, 80070090)
    #         — aproximação: mistura fundido com outros processos, mas exclui
    #         os itens claramente não-fundidos (esponja, tubo, chapa, higiene)
    # Ranking por país/UF segue no arquivo antigo até termos essa abertura
    # também na extração por NCM.
    NCM_OVERRIDE_FILE = {'2451': 'Comex_2451_NCM7325.csv', '2452': 'Comex_2452_NCM_NaoFerrosos.csv'}
    if cnae in NCM_OVERRIDE_FILE:
        ncm_df = read_csv(NCM_OVERRIDE_FILE[cnae])
        ncm_df['Valor_US_FOB'] = pd.to_numeric(ncm_df['Valor_US_FOB'], errors='coerce')
        ncm_df['Quilograma_Liquido'] = pd.to_numeric(ncm_df['Quilograma_Liquido'], errors='coerce')
        cy_source = ncm_df
    else:
        cy_source = comex_df

    cy = cy_source.groupby(['Ano', 'Fluxo']).agg(
        valor_usd=('Valor_US_FOB', 'sum'), peso_kg=('Quilograma_Liquido', 'sum')).reset_index()
    comex_yearly = []
    for ano, g in cy.groupby('Ano'):
        exp = g[g['Fluxo'] == 'Exportação']
        imp = g[g['Fluxo'] == 'Importação']
        comex_yearly.append({
            'ano': to_int(ano),
            'exportacao_usd': to_num(exp['valor_usd'].iloc[0]) if len(exp) else 0,
            'exportacao_kg': to_num(exp['peso_kg'].iloc[0]) if len(exp) else 0,
            'importacao_usd': to_num(imp['valor_usd'].iloc[0]) if len(imp) else 0,
            'importacao_kg': to_num(imp['peso_kg'].iloc[0]) if len(imp) else 0,
        })
    comex_yearly.sort(key=lambda r: r['ano'])

    # Balança comercial em R$ milhões de 2023 (câmbio médio do ano + IPCA),
    # pra comparar com relatórios do setor que reportam em real constante
    # em vez de US$ FOB corrente.
    for row in comex_yearly:
        f = fator_brl_2023.get(row['ano'])
        if f:
            row['exportacao_brl_2023'] = row['exportacao_usd'] * f / 1e6
            row['importacao_brl_2023'] = row['importacao_usd'] * f / 1e6
            row['saldo_brl_2023'] = row['exportacao_brl_2023'] - row['importacao_brl_2023']
        else:
            row['exportacao_brl_2023'] = None
            row['importacao_brl_2023'] = None
            row['saldo_brl_2023'] = None

    # Ranking por UF: usa a mesma extração por NCM de fundição acima, quando
    # já disponível pro setor.
    NCM_UF_OVERRIDE_FILE = {'2451': 'Comex_2451_NCM7325_UF.csv', '2452': 'Comex_2452_NCM_NaoFerrosos_UF.csv'}
    if cnae in NCM_UF_OVERRIDE_FILE:
        uf_df = read_csv(NCM_UF_OVERRIDE_FILE[cnae])
        uf_df['Valor_US_FOB'] = pd.to_numeric(uf_df['Valor_US_FOB'], errors='coerce')
    else:
        uf_df = comex_df

    uf_totals = (uf_df.groupby('UF_Produto')['Valor_US_FOB'].sum()
                 .reset_index().sort_values('Valor_US_FOB', ascending=False))
    top_uf_names = [u for u in uf_totals['UF_Produto'] if resolve_uf(u)][:8]
    cuf = (uf_df[uf_df['UF_Produto'].isin(top_uf_names)]
           .groupby(['Ano', 'UF_Produto', 'Fluxo'])['Valor_US_FOB'].sum().reset_index())
    comex_uf_yearly = []
    for r in cuf.itertuples(index=False):
        ufi = resolve_uf(r.UF_Produto)
        if ufi:
            comex_uf_yearly.append({'ano': to_int(r.Ano), 'uf': ufi[0], 'nome_uf': ufi[1],
                                     'fluxo': r.Fluxo, 'valor_usd': to_num(r.Valor_US_FOB)})

    ano_max_comex = int(comex_df['Ano'].max())
    ano_atual = date.today().year
    ano_top_comex = ano_max_comex - 1 if ano_max_comex == ano_atual else ano_max_comex

    def top_paises(fluxo, ano, n=10):
        sub = comex_df[(comex_df['Ano'] == ano) & (comex_df['Fluxo'] == fluxo)]
        g = (sub.groupby('Pais')['Valor_US_FOB'].sum().reset_index()
             .sort_values('Valor_US_FOB', ascending=False))
        return [{'pais': r.Pais, 'valor_usd': to_num(r.Valor_US_FOB)} for r in g.head(n).itertuples(index=False)]

    top_paises_latest = {
        'ano': ano_top_comex,
        'exportacao': top_paises('Exportação', ano_top_comex),
        'importacao': top_paises('Importação', ano_top_comex),
    }

    # Top 3 destinos de exportação (por valor total no período) + série anual
    # ("Outros" = resto). Era top 8 + outros (9 cores empilhadas), ilegível;
    # top 3 é o suficiente pra contar a história de concentração/diversificação
    # sem virar um mosaico de cores.
    exp_df = comex_df[comex_df['Fluxo'] == 'Exportação']
    top_countries = list(
        exp_df.groupby('Pais')['Valor_US_FOB'].sum().sort_values(ascending=False).head(3).index
    )
    by_year_country = exp_df.groupby(['Ano', 'Pais'])['Valor_US_FOB'].sum().reset_index()
    top_paises_yearly = {'paises': top_countries, 'yearly': []}
    for ano in sorted(exp_df['Ano'].unique().tolist()):
        yr = by_year_country[by_year_country['Ano'] == ano]
        total_ano = to_num(yr['Valor_US_FOB'].sum()) or 0.0
        row = {'ano': to_int(ano)}
        soma_top = 0.0
        for pais in top_countries:
            v = yr[yr['Pais'] == pais]['Valor_US_FOB']
            val = to_num(v.iloc[0]) if len(v) else 0.0
            row[pais] = val or 0.0
            soma_top += val or 0.0
        row['Outros'] = round(total_ano - soma_top, 2)
        top_paises_yearly['yearly'].append(row)

    # Mesmo recorte "top 3 países + Outros", mas para importação — pedido
    # do SIFESP pra dar mais destaque à evolução das origens de importação
    # (hoje só existia a versão de exportação acima).
    imp_df = comex_df[comex_df['Fluxo'] == 'Importação']
    top_countries_imp = list(
        imp_df.groupby('Pais')['Valor_US_FOB'].sum().sort_values(ascending=False).head(3).index
    )
    by_year_country_imp = imp_df.groupby(['Ano', 'Pais'])['Valor_US_FOB'].sum().reset_index()
    top_paises_imp_yearly = {'paises': top_countries_imp, 'yearly': []}
    for ano in sorted(imp_df['Ano'].unique().tolist()):
        yr = by_year_country_imp[by_year_country_imp['Ano'] == ano]
        total_ano = to_num(yr['Valor_US_FOB'].sum()) or 0.0
        row = {'ano': to_int(ano)}
        soma_top = 0.0
        for pais in top_countries_imp:
            v = yr[yr['Pais'] == pais]['Valor_US_FOB']
            val = to_num(v.iloc[0]) if len(v) else 0.0
            row[pais] = val or 0.0
            soma_top += val or 0.0
        row['Outros'] = round(total_ano - soma_top, 2)
        top_paises_imp_yearly['yearly'].append(row)

    # Importação: China x resto do mundo, série anual. Mede a pressão de
    # peças fundidas chinesas mais baratas sobre o mercado interno (usado no
    # case de PD&I para o setor).
    importacao_china_resto_yearly = []
    for ano in sorted(imp_df['Ano'].unique().tolist()):
        yr = imp_df[imp_df['Ano'] == ano]
        total_ano_imp = to_num(yr['Valor_US_FOB'].sum()) or 0.0
        china = to_num(yr[yr['Pais'] == 'China']['Valor_US_FOB'].sum()) or 0.0
        importacao_china_resto_yearly.append({
            'ano': to_int(ano), 'china_usd': china, 'resto_usd': round(total_ano_imp - china, 2),
        })

    # --- Comex por NCM/produto: preço médio (US$/kg) e ranking de produtos.
    # 2451 já tem extrações nacionais separadas por fluxo; 2452 só tem a
    # versão aberta por UF, então soma-se UF pra chegar no total nacional.
    NCM_PRODUTO_FILES = {
        '2451': {'Exportação': 'Comex_Fonte_2451_Exportacao_NCM.csv',
                 'Importação': 'Comex_Fonte_2451_Importacao_NCM.csv'},
    }

    def _ncm_df_from_file(path):
        df = read_csv(path)
        df.columns = ['Ano', 'NCM', 'Descricao', 'Valor_US_FOB', 'Quilograma_Liquido']
        df['Valor_US_FOB'] = pd.to_numeric(df['Valor_US_FOB'], errors='coerce')
        df['Quilograma_Liquido'] = pd.to_numeric(df['Quilograma_Liquido'], errors='coerce')
        df['Descricao'] = df['Descricao'].astype(str).str.strip()
        return df

    def _ncm_itens_ano(df, ano):
        sub = df[df['Ano'] == ano].groupby(['NCM', 'Descricao'], as_index=False)[
            ['Valor_US_FOB', 'Quilograma_Liquido']].sum()
        sub = sub.sort_values('Valor_US_FOB', ascending=False)
        itens = []
        for r in sub.itertuples(index=False):
            kg = to_num(r.Quilograma_Liquido)
            valor = to_num(r.Valor_US_FOB)
            itens.append({
                'ncm': str(int(r.NCM)), 'descricao': r.Descricao,
                'valor_usd': valor, 'kg': kg,
                'preco_medio_usd_kg': round(valor / kg, 4) if valor and kg else None,
            })
        return itens

    def _ncm_preco_medio_yearly(df):
        by_year = df.groupby('Ano', as_index=False)[['Valor_US_FOB', 'Quilograma_Liquido']].sum()
        out = []
        for r in by_year.itertuples(index=False):
            kg = to_num(r.Quilograma_Liquido)
            valor = to_num(r.Valor_US_FOB)
            out.append({
                'ano': to_int(r.Ano),
                'preco_medio_usd_kg': round(valor / kg, 4) if valor and kg else None,
            })
        out.sort(key=lambda x: x['ano'])
        return out

    if cnae in NCM_PRODUTO_FILES:
        dfs_por_fluxo = {fluxo: _ncm_df_from_file(fname) for fluxo, fname in NCM_PRODUTO_FILES[cnae].items()}
    elif cnae == '2452':
        uf_df_2452 = read_csv('Comex_Fonte_2452_ExpImp_UF.csv')
        uf_df_2452.columns = ['Fluxo', 'Ano', 'NCM', 'Descricao', 'UF', 'Valor_US_FOB', 'Quilograma_Liquido']
        uf_df_2452['Fluxo'] = uf_df_2452['Fluxo'].astype(str).str.strip()
        uf_df_2452['Valor_US_FOB'] = pd.to_numeric(uf_df_2452['Valor_US_FOB'], errors='coerce')
        uf_df_2452['Quilograma_Liquido'] = pd.to_numeric(uf_df_2452['Quilograma_Liquido'], errors='coerce')
        uf_df_2452['Descricao'] = uf_df_2452['Descricao'].astype(str).str.strip()
        dfs_por_fluxo = {
            'Exportação': uf_df_2452[uf_df_2452['Fluxo'] == 'Exportação'],
            'Importação': uf_df_2452[uf_df_2452['Fluxo'] == 'Importação'],
        }
    else:
        dfs_por_fluxo = {}

    comex_ncm = {}
    for fluxo, chave in (('Exportação', 'exportacao'), ('Importação', 'importacao')):
        df_fluxo = dfs_por_fluxo.get(fluxo)
        if df_fluxo is None or df_fluxo.empty:
            continue
        ano_latest = int(df_fluxo['Ano'].max())
        ano_latest = ano_latest - 1 if ano_latest == date.today().year else ano_latest
        comex_ncm[chave] = {
            'latest': {'ano': ano_latest, 'itens': _ncm_itens_ano(df_fluxo, ano_latest)},
            'preco_medio_yearly': _ncm_preco_medio_yearly(df_fluxo),
        }

    # --- Comtrade global (agregação pesada: ~250k linhas) ---
    ct_df = read_csv(f'Comtrade_Global_Fundicao_{cnae}.csv')
    ct_df['Valor_US_FOB'] = pd.to_numeric(ct_df['Valor_US_FOB'], errors='coerce')

    ct_bw = ct_df[(ct_df['Reporter'] == 'Brazil') & (ct_df['Partner'] == 'World')]
    by = ct_bw.groupby(['Ano', 'Fluxo'])['Valor_US_FOB'].sum().reset_index()
    brazil_yearly = []
    for ano, g in by.groupby('Ano'):
        exp = g[g['Fluxo'].str.contains('export', case=False, na=False)]
        imp = g[g['Fluxo'].str.contains('import', case=False, na=False)]
        brazil_yearly.append({
            'ano': to_int(ano),
            'export_usd': to_num(exp['Valor_US_FOB'].iloc[0]) if len(exp) else 0,
            'import_usd': to_num(imp['Valor_US_FOB'].iloc[0]) if len(imp) else 0,
        })
    brazil_yearly.sort(key=lambda r: r['ano'])

    ct_world_exp = ct_df[(ct_df['Partner'] == 'World') & (ct_df['Fluxo'].str.contains('export', case=False, na=False))]
    wy = ct_world_exp.groupby('Ano')['Valor_US_FOB'].sum().reset_index().sort_values('Ano')
    world_yearly = [{'ano': to_int(r.Ano), 'export_usd': to_num(r.Valor_US_FOB)} for r in wy.itertuples(index=False)]

    ano_max_ct = int(ct_bw['Ano'].max())
    ct_partners = ct_df[(ct_df['Reporter'] == 'Brazil') & (ct_df['Partner'] != 'World') &
                         (ct_df['Ano'] == ano_max_ct) &
                         (ct_df['Fluxo'].str.contains('export', case=False, na=False))]
    tp = ct_partners.groupby('Partner')['Valor_US_FOB'].sum().reset_index().sort_values('Valor_US_FOB', ascending=False)
    top_partners_latest = {
        'ano': ano_max_ct,
        'items': [{'pais': r.Partner, 'valor_usd': to_num(r.Valor_US_FOB)} for r in tp.head(10).itertuples(index=False)],
    }
    comtrade = {'brazil_yearly': brazil_yearly, 'world_yearly': world_yearly, 'top_partners_latest': top_partners_latest}

    # --- BNDES ---
    bndes_df = read_csv(f'BNDES_Desembolsos_{cnae}.csv')
    bndes_df['UF'] = bndes_df['UF'].astype(str).str.strip()
    bndes_df['Valor_Contratado'] = pd.to_numeric(bndes_df['Valor_Contratado'], errors='coerce')
    bndes_df['Valor_Desembolsado'] = pd.to_numeric(bndes_df['Valor_Desembolsado'], errors='coerce')

    by_year = (bndes_df.groupby('Ano').agg(
        valor_contratado=('Valor_Contratado', 'sum'), valor_desembolsado=('Valor_Desembolsado', 'sum'))
        .reset_index().sort_values('Ano'))
    bndes_yearly = [{'ano': to_int(r.Ano), 'valor_contratado': to_num(r.valor_contratado),
                      'valor_desembolsado': to_num(r.valor_desembolsado)} for r in by_year.itertuples(index=False)]

    uf_rows = []
    for r in bndes_df.itertuples(index=False):
        ufi = resolve_uf(r.UF)
        if ufi:
            uf_rows.append({'uf': ufi[0], 'nome_uf': ufi[1], 'valor': r.Valor_Desembolsado})
    bndes_uf_total = []
    if uf_rows:
        bt = (pd.DataFrame(uf_rows).groupby(['uf', 'nome_uf'])['valor'].sum()
              .reset_index().sort_values('valor', ascending=False))
        bndes_uf_total = [{'uf': r.uf, 'nome_uf': r.nome_uf, 'valor_desembolsado': to_num(r.valor)}
                           for r in bt.itertuples(index=False)]

    bp = (bndes_df.groupby('Porte')['Valor_Desembolsado'].sum()
          .reset_index().sort_values('Valor_Desembolsado', ascending=False))
    bndes_porte_total = [{'porte': r.Porte, 'valor_desembolsado': to_num(r.Valor_Desembolsado)}
                          for r in bp.itertuples(index=False)]

    bti = (bndes_df.groupby(['Ano', 'Porte', 'Instrumento']).agg(
        valor_contratado=('Valor_Contratado', 'sum'), valor_desembolsado=('Valor_Desembolsado', 'sum'))
        .reset_index().sort_values('valor_desembolsado', ascending=False))
    bndes_table = [
        {'ano': to_int(r.Ano), 'porte': r.Porte, 'instrumento': r.Instrumento,
         'valor_contratado': to_num(r.valor_contratado), 'valor_desembolsado': to_num(r.valor_desembolsado)}
        for r in bti.itertuples(index=False)
    ]

    return {
        'label': label,
        'rais': {
            'uf_yearly': uf_yearly, 'uf_yearly_total': uf_yearly_total,
            'tamanho_yearly': tamanho_yearly,
            'escolaridade_latest': escolaridade_latest, 'escolaridade_yearly': escolaridade_yearly,
            'ocupacao_agrupada_latest': ocupacao_agrupada_latest,
            'ocupacao_detalhada_latest': ocupacao_detalhada_latest,
            'tempo_emprego_latest': tempo_emprego_latest,
            'massa_uf_latest': massa_uf_latest, 'massa_nacional_yearly': massa_nacional_yearly,
        },
        'caged': {
            'coverage': monthly_coverage(saldo_monthly_national),
            'saldo_monthly_national': saldo_monthly_national,
            'salario_monthly_national': salario_monthly_national,
            'saldo_uf_monthly': saldo_uf_monthly,
            'salario_uf_monthly': salario_uf_monthly,
            'tipo_movimentacao_monthly': tipo_movimentacao_monthly,
            'tipo_movimentacao_breakdown_total': tipo_movimentacao_breakdown_total,
        },
        'comex': {
            'yearly': comex_yearly, 'uf_yearly': comex_uf_yearly,
            'top_paises_latest': top_paises_latest, 'top_paises_yearly': top_paises_yearly,
            'top_paises_imp_yearly': top_paises_imp_yearly,
            'importacao_china_resto_yearly': importacao_china_resto_yearly,
            'ncm': comex_ncm,
        },
        'comtrade': comtrade,
        'bndes': {'yearly': bndes_yearly, 'uf_total': bndes_uf_total,
                  'porte_total': bndes_porte_total, 'table': bndes_table},
    }


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f'Lendo CSVs de {SRC_DIR}...')

    metalurgia_indice, aco_gusa, aco_gusa_dessaz, aluminio_primario = build_producao()
    fin_metalurgia = read_financeiro('Dados_Financeiros_Metalurgia_24.csv')
    fin_fundicao = read_financeiro('Dados_Financeiros_Fundicao_24_5.csv')
    fin_por_cnae = read_financeiro_por_cnae('Dados_Financeiros_CNAE_2451_2452_2024_SerieNova.csv')
    macro = build_macro()
    fator_brl_2023 = build_fator_brl_2023(macro)
    decom = build_decom()
    energia_industrial = build_energia_industrial(macro)

    sector_2451 = build_sector('2451', 'Fundição de ferro e aço', fator_brl_2023)
    sector_2452 = build_sector('2452', 'Fundição de metais não ferrosos', fator_brl_2023)
    # Produção física do 2452 é alumínio primário (ABAL), não aço — ao
    # contrário do resto do bloco "shared", aqui os dois segmentos têm
    # fontes de fato diferentes.
    sector_2452['producao_aluminio'] = aluminio_primario

    uf_lista = sorted(({'uf': uf, 'nome': nome} for _, uf, nome in UF_TABLE), key=lambda x: x['nome'])

    data = {
        'meta': {
            'gerado_em': date.today().isoformat(),
            'periodo_slider_padrao': {'inicio': 2016, 'fim': 2026},
            'uf_lista': uf_lista,
        },
        'shared': {
            'producao': {'metalurgia_indice': metalurgia_indice, 'aco_gusa': aco_gusa,
                         'aco_gusa_dessaz': aco_gusa_dessaz},
            'financeiro': {'metalurgia_24': fin_metalurgia, 'fundicao_24_5': fin_fundicao, 'por_cnae_2024': fin_por_cnae},
            'macro': macro,
            'decom': decom,
        },
        'sectors': {'2451': sector_2451, '2452': sector_2452},
        'energia_industrial': energia_industrial,
    }

    OUT_DIR.mkdir(exist_ok=True)
    out_path = OUT_DIR / 'data.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'), default=np_default)
    size_kb = out_path.stat().st_size / 1024
    print(f'OK: {out_path} ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
