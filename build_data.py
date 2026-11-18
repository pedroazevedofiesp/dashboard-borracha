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

# Tudo o que é específico do setor (CNAEs, rótulos, prefixos dos nomes de
# arquivo) vem de config_painel.json — ver README, "Replicar para outro setor".
with open(ROOT / 'config_painel.json', encoding='utf-8') as _f:
    CONFIG = json.load(_f)
SETOR = CONFIG['setor']
SLUG = SETOR['slug']                    # rais_vinc_{slug}_..., caged_{slug}_...
ROTULO_ARQUIVO = SETOR['rotulo_arquivo']  # Empregos_RAIS_UF_{rotulo}_..., Comtrade_Global_{rotulo}_...
CNAES = CONFIG['cnaes']
# ISO3 (código do Comtrade) -> [ISO2 minúsculo para a bandeira, nome em português]
with open(ROOT / 'assets' / 'paises_iso3.json', encoding='utf-8') as _f:
    PAISES_ISO3 = json.load(_f)
RANKING_MUNDIAL_TOP = 25
# Recorte opcional que soma vários CNAEs (ex.: "Borracha - Total" = 2212 + 2219).
AGREGADO = CONFIG.get('agregado')
# Todos os recortes do painel: o agregado (se houver) primeiro, depois os CNAEs.
SETORES = ([AGREGADO] if AGREGADO else []) + CNAES


# ---------------------------------------------------------------------------
# Helpers genéricos
# ---------------------------------------------------------------------------
# Ano-base único de todas as séries em R$ constantes do painel.
ANO_BASE_PRECOS = int(SETOR.get('ano_base_precos', 2024))


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
    """Índice de produção física (PIM-PF/IBGE) da divisão CNAE do setor.
    É uma série só, igual para todos os segmentos do painel (o IBGE não abre
    a PIM-PF por classe CNAE)."""
    df = read_csv(f"Producao_Fisica_Mensal_{SETOR['producao_rotulo_arquivo']}.csv")
    indice = [
        {'ano': to_int(r.ano), 'mes': to_int(r.mes), 'data': r.data,
         'indice_bruto': to_num(r.indice_bruto_base_100),
         'indice_dessaz': to_num(r.indice_dessazonalizado_base_100)}
        for r in df.itertuples(index=False)
    ]
    return sorted(indice, key=lambda r: r['ano'] * 100 + r['mes'])


# ---------------------------------------------------------------------------
# SHARED: Financeiro (PIA) — grupo CNAE do setor + abertura por classe (2024)
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
    """Quebra do financeiro por classe CNAE (só existe pra 2024 — série nova
    da PIA/IBGE; nos demais anos só há o grupo CNAE combinado)."""
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
         'ipp_setor': to_num(r.ipp_setor_indice)}
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


def build_fator_brl(macro_rows, ano_base):
    """Fator anual USD -> R$ constantes de ano_base: câmbio médio do ano x
    deflator IPCA (médias anuais). Usado na balança comercial (comex), sem
    trocar a unidade (US$ FOB) do resto do bloco de comércio exterior."""
    dolar_by_year, ipca_by_year = {}, {}
    for r in macro_rows:
        if r['dolar'] is not None:
            dolar_by_year.setdefault(r['ano'], []).append(r['dolar'])
        if r['ipca'] is not None:
            ipca_by_year.setdefault(r['ano'], []).append(r['ipca'])
    dolar_avg = {ano: sum(v) / len(v) for ano, v in dolar_by_year.items()}
    ipca_avg = {ano: sum(v) / len(v) for ano, v in ipca_by_year.items()}
    ipca_base = ipca_avg.get(ano_base)
    if not ipca_base:
        return {}
    return {
        ano: dolar_avg[ano] * (ipca_base / ipca_avg[ano])
        for ano in dolar_avg
        if ano in ipca_avg and ipca_avg[ano]
    }


def build_decom(arquivo):
    """Processos de defesa comercial (DECOM). Bloco opcional: só existe se
    config_painel.json apontar um arquivo em blocos_opcionais.decom."""
    if not arquivo:
        return []
    df = read_csv(arquivo).rename(columns={
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
    ano_base_energia = ANO_BASE_PRECOS
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
# Cadeia produtiva (Contas Nacionais do IBGE: TRU 2010-2021 + MIP 2015).
# Os CSVs saem de extrair_cadeia.py, que só roda quando o IBGE publica
# tabelas novas ou ao trocar de setor. O que é específico do setor (produto,
# atividade, textos, botões, cores) vem de cadeia_config.json e vai junto no
# data.json, para a aba não ter nada do setor fixo no código.
# ---------------------------------------------------------------------------
def build_cadeia():
    config = json.loads((ROOT / 'cadeia_config.json').read_text(encoding='utf-8'))
    config = {k: v for k, v in config.items() if not k.startswith('_')}  # tira os comentários
    cod = {'dtype': {'Codigo': str, 'Origem': str, 'Destino': str, 'Produto': str, 'Atividade_Produtora': str}}
    ativ = read_csv('Cadeia_Atividades.csv', **cod)
    fluxos = read_csv('Cadeia_Fluxos_Atividades.csv', **cod)
    destinos = read_csv('Cadeia_Produto_Destinos.csv', **cod)
    oferta = read_csv('Cadeia_Produto_Oferta.csv')
    insumos = read_csv('Cadeia_Insumos_Atividade.csv', **cod)

    df_cols = [c for c in ativ.columns if c.startswith('DF_')]
    atividades = [{
        'cod': r.Codigo, 'nome': r.Nome_Curto, 'descricao': r.Descricao,
        'vbp': to_num(r.VBP), 'va': to_num(r.Valor_Adicionado), 'ocupacoes': to_int(r.Ocupacoes),
        'ci': to_num(r.Consumo_Intermediario), 'pct_insumos_importados': to_num(r.Pct_Insumos_Importados_2015),
        'multiplicador': to_num(r.Multiplicador_Producao_2015),
        'demanda_final': {c[3:].lower(): to_num(getattr(r, c)) for c in df_cols},
    } for r in ativ.itertuples(index=False)]
    idx = {a['cod']: i for i, a in enumerate(atividades)}

    centros = {i['centro'] for e in config['elos'] for i in e['itens']} - {'produto'}
    cods_config = centros | set(config['principais_clientes']['cods']) | {config['atividade']} \
        | {c for g in config['grupos_cor'] for c in g['cods']}
    faltando = cods_config - set(idx)
    if faltando:
        raise ValueError(f'cadeia_config.json cita atividades que não existem na TRU: {sorted(faltando)}')

    return {
        'ano': int(ativ['Ano'].max()),
        'config': config,
        'atividades': atividades,
        # [índice da atividade vendedora, índice da compradora, R$ mi] — compacto, ~4 mil pares
        'fluxos': [[idx[r.Origem], idx[r.Destino], to_num(r.Valor)] for r in fluxos.itertuples(index=False)],
        'produto': {
            'oferta': [{'ano': int(r.Ano), 'producao': to_num(r.Producao_Nacional), 'importacao': to_num(r.Importacao),
                        'demanda': to_num(r.Demanda_Total)} for r in oferta.itertuples(index=False)],
            'destinos': [{'ano': int(r.Ano), 'tipo': r.Tipo, 'cod': r.Codigo, 'nome': r.Nome, 'valor': to_num(r.Valor)}
                         for r in destinos.itertuples(index=False)],
        },
        'insumos_atividade': [{'produto': r.Produto, 'descricao': r.Descricao, 'atividade': r.Atividade_Produtora,
                          'valor': to_num(r.Valor), 'pct_importado': to_num(r.Pct_Importado_2015)}
                         for r in insumos.itertuples(index=False)],
    }


# ---------------------------------------------------------------------------
# Mercado doméstico: consumo aparente (produção + importação - exportação),
# coeficiente de exportação (exportação / produção) e penetração da importação
# (importação / consumo aparente), no método do diagnóstico setorial da FIESP.
# Produção: PIA-Produto (IBGE), valor da produção dos produtos da cesta PRODLIST
# (PIA_Produto_<Rotulo>.csv, de Setor <Nome>/2_Scripts/obter_pia_produto.R).
# Comércio: Comex Stat da cesta de NCM, em R$ pelo câmbio médio do ano.
# cesta_componentes.csv liga NCM e PRODLIST ao mesmo produto (componente da
# FIESP), para a tabela por produto. Sem o CSV da PIA-Produto, o bloco não existe.
# ---------------------------------------------------------------------------
def build_mercado_domestico(codes, ncm_df, macro_rows):
    arquivo = SRC_DIR / f'PIA_Produto_{ROTULO_ARQUIVO}.csv'
    mapa_path = ROOT / 'cesta_componentes.csv'
    if not arquivo.exists() or not mapa_path.exists():
        return None
    pia = read_csv(arquivo.name, dtype={'Codigo_Prodlist': str, 'cnae_subclasse': str})
    pia = pia[pia['cnae_subclasse'].isin(codes)].copy()
    pia['Valor_Producao_mil_R'] = pd.to_numeric(pia['Valor_Producao_mil_R'], errors='coerce')
    pia['sigilo'] = is_true_col(pia['Sigilo'])
    mapa = pd.read_csv(mapa_path, sep=';', dtype=str, encoding='utf-8')
    mapa = mapa[mapa['cnae'].isin(codes)]
    comp_prod = dict(zip(mapa.loc[mapa.tipo == 'PRODLIST', 'codigo'], mapa.loc[mapa.tipo == 'PRODLIST', 'componente']))
    comp_ncm = dict(zip(mapa.loc[mapa.tipo == 'NCM', 'codigo'], mapa.loc[mapa.tipo == 'NCM', 'componente']))
    desc = dict(zip(mapa['componente'], mapa['descricao_componente']))
    pia['comp'] = pia['Codigo_Prodlist'].map(comp_prod)

    tr = ncm_df.copy()
    tr['comp'] = tr['Codigo_NCM'].astype(str).str.replace(r'\.0$', '', regex=True).str.zfill(8).map(comp_ncm)

    # Câmbio médio anual (R$/US$) e fator IPCA para preços do último ano da série.
    dol, ipca = {}, {}
    for r in macro_rows:
        if r['dolar'] is not None:
            dol.setdefault(r['ano'], []).append(r['dolar'])
        if r['ipca'] is not None:
            ipca.setdefault(r['ano'], []).append(r['ipca'])
    dol = {a: sum(v) / len(v) for a, v in dol.items()}
    anos_pia = set(int(a) for a in pia['Ano'].unique())
    anos_tr = set(int(a) for a in tr['Ano'].unique() if int(a) < date.today().year)  # ano corrente é parcial
    anos = sorted(a for a in anos_pia & anos_tr if a in dol)
    if not anos:
        return None
    ano_base = ANO_BASE_PRECOS
    fator_ipca = build_fator_ipca(macro_rows, ano_base)

    def trade(ano, fluxo, comp=None):
        sub = tr[(tr['Ano'] == ano) & (tr['Fluxo'] == fluxo)]
        if comp is not None:
            sub = sub[sub['comp'] == comp]
        return float(sub['Valor_US_FOB'].sum()) * dol[ano]  # R$ correntes

    def linha(ano, prod, exp, imp, n_sigilo):
        ca = prod + imp - exp if prod is not None else None
        f = fator_ipca.get(ano)
        real = (lambda v: v * f if (v is not None and f) else None)
        return {
            'ano': ano, 'producao': prod, 'exportacao': exp, 'importacao': imp, 'consumo_aparente': ca,
            'producao_real': real(prod), 'exportacao_real': real(exp), 'importacao_real': real(imp),
            'consumo_aparente_real': real(ca),
            'coef_exportacao': (exp / prod * 100) if prod else None,
            'penetracao_importacao': (imp / ca * 100) if ca else None,
            'produtos_sigilo': n_sigilo,
        }

    yearly = []
    for ano in anos:
        p = pia[pia['Ano'] == ano]
        prod = float(p['Valor_Producao_mil_R'].sum()) * 1000
        yearly.append(linha(ano, prod, trade(ano, 'Exportação'), trade(ano, 'Importação'), int(p['sigilo'].sum())))

    def produtos(ano):
        itens = []
        p_ano = pia[pia['Ano'] == ano]
        for comp in sorted(set(mapa['componente'])):
            p = p_ano[p_ano['comp'] == comp]
            # Subproduto em sigilo: soma o que o IBGE divulga e marca como parcial
            # (só fica sem produção se todos os subprodutos estiverem em sigilo).
            sig = bool(p['sigilo'].any())
            prod = None if p.empty or p['sigilo'].all() else float(p['Valor_Producao_mil_R'].sum()) * 1000
            it = linha(ano, prod, trade(ano, 'Exportação', comp), trade(ano, 'Importação', comp), int(p['sigilo'].sum()))
            it.update({'componente': comp, 'descricao': (desc.get(comp) or '').strip(), 'sigilo': sig})
            if (it['producao'] or 0) + it['exportacao'] + it['importacao'] > 0 or sig:
                itens.append(it)
        itens.sort(key=lambda x: -((x['consumo_aparente'] if x['consumo_aparente'] is not None else x['importacao']) or 0))
        return itens

    return {
        'ano_base_real': ano_base,
        'yearly': yearly,
        'produtos': {'ano': ano_base, 'itens': produtos(ano_base), 'ano_inicial': anos[0],
                     'itens_inicial': produtos(anos[0])},
    }


# ---------------------------------------------------------------------------
# Por setor (um bloco por CNAE de config_painel.json)
# ---------------------------------------------------------------------------
def latest_breakdown(df):
    ano_max = int(df['ano'].max())
    sub = df[(df['ano'] == ano_max) & (~is_true_col(df['is_total']))]
    items = [{'categoria': r.categoria, 'frequencia': to_int(r.frequencia)} for r in sub.itertuples(index=False)]
    items.sort(key=lambda x: -(x['frequencia'] or 0))
    return {'ano': ano_max, 'items': items}


def build_sector(cfg, fator_brl, macro_rows=None):
    cnae, label = cfg['codigo'], cfg['rotulo']
    # Um recorte é um CNAE ou a soma de vários (agregado, com 'componentes').
    # Os arquivos são sempre por CNAE: lê os de cada componente e soma.
    codes = [str(c) for c in cfg.get('componentes', [cnae])]
    somando = len(codes) > 1
    print(f'  Setor {cnae} ({label}{", soma de " + " + ".join(codes) if somando else ""})...')

    def rotulo_de(code):
        # Prefixo dos arquivos Empregos_RAIS_*/Comtrade_Global_*: o do setor, ou
        # um por CNAE se o config definir (a fundição usava Ferro_Aco/Nao_Ferrosos).
        c = next((x for x in CNAES if x['codigo'] == code), {})
        return c.get('rotulo_arquivo', ROTULO_ARQUIVO)

    def read_multi(nome):
        # nome(code, rotulo) -> nome do arquivo daquele CNAE
        return pd.concat([read_csv(nome(c, rotulo_de(c))) for c in codes], ignore_index=True)

    def somar(df, chaves, valores):
        # Só agrega quando há mais de um CNAE (para um CNAE só, o dado fica
        # exatamente como na fonte). sort=False mantém a ordem original das
        # categorias (faixas de tamanho, por exemplo).
        if not somando:
            return df
        return df.groupby(chaves, as_index=False, sort=False)[valores].sum()

    # --- RAIS: estabelecimentos/vínculos por UF, anual ---
    rais_df = somar(read_multi(lambda c, r: f'Empregos_RAIS_UF_{r}_{c}.csv'),
                    ['Ano', 'UF'], ['Estabelecimentos', 'Vinculos'])
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
    tam_df = somar(read_multi(lambda c, r: f'Empregos_RAIS_Tamanho_{r}_{c}.csv'),
                   ['Ano', 'Faixa_Tamanho'], ['Estabelecimentos', 'Vinculos'])
    tamanho_yearly = sorted([
        {'ano': to_int(r.Ano), 'faixa': r.Faixa_Tamanho, 'estabelecimentos': to_int(r.Estabelecimentos),
         'vinculos': to_int(r.Vinculos)}
        for r in tam_df.itertuples(index=False) if r.Faixa_Tamanho != 'Total'
    ], key=lambda r: r['ano'])

    # --- Perfis detalhados RAIS (retrato do último ano) ---
    def rais_vinc(perfil):
        df = read_multi(lambda c, r: f'rais_vinc_{SLUG}_{perfil}_{c}.csv')
        return somar(df, ['ano', 'categoria', 'is_total'], ['frequencia'])

    esc_df = rais_vinc('escolaridade')
    escolaridade_latest = latest_breakdown(esc_df)
    ocupacao_agrupada_latest = latest_breakdown(rais_vinc('ocupacao_agrupada'))
    ocupacao_detalhada_latest = latest_breakdown(rais_vinc('ocupacao'))
    tempo_emprego_latest = latest_breakdown(rais_vinc('tempo_emprego'))

    # --- Escolaridade como série completa (para área empilhada) ---
    esc_full = esc_df[(~is_true_col(esc_df['is_total'])) & (esc_df['categoria'] != 'Total')]
    escolaridade_yearly = sorted([
        {'ano': to_int(r.ano), 'categoria': r.categoria, 'frequencia': to_int(r.frequencia)}
        for r in esc_full.itertuples(index=False)
    ], key=lambda r: r['ano'])

    # --- Remuneração (massa salarial) ---
    massa_df = read_multi(lambda c, r: f'rais_vinc_{SLUG}_massa_{c}.csv')
    if somando:
        # Remuneração média da soma = massa total / vínculos (não a média das médias).
        massa_df = somar(massa_df, ['ano', 'categoria', 'is_total'], ['frequencia', 'vl_remun_dezembro_nom'])
        massa_df['remuneracao_media_nominal'] = massa_df['vl_remun_dezembro_nom'] / massa_df['frequencia']
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
        df = df[df['cnae_subclasse'].astype(str).str.strip().isin(codes)]
        return df[df['Competencia'] != 'Total'].copy()

    def with_competencia(df):
        parsed = df['Competencia'].apply(parse_competencia)
        df = df.assign(cyr=[p[0] if p else None for p in parsed],
                        cmo=[p[1] if p else None for p in parsed])
        return df.dropna(subset=['cyr', 'cmo'])

    caged_saldo = with_competencia(load_caged(f'caged_{SLUG}_saldo_mensal_uf_cnae.csv'))
    caged_saldo['Saldo_Movimentacao'] = pd.to_numeric(caged_saldo['Saldo_Movimentacao'], errors='coerce')
    saldo_monthly_national = (
        caged_saldo.groupby(['cyr', 'cmo'])['Saldo_Movimentacao'].sum()
        .reset_index().sort_values(['cyr', 'cmo'])
    )
    saldo_monthly_national = [
        {'ano': to_int(r.cyr), 'mes': to_int(r.cmo), 'saldo': to_int(r.Saldo_Movimentacao)}
        for r in saldo_monthly_national.itertuples(index=False)
    ]

    caged_salario = with_competencia(load_caged(f'caged_{SLUG}_salario_mensal_uf_cnae.csv'))
    caged_salario['Salario_Mensal'] = pd.to_numeric(caged_salario['Salario_Mensal'], errors='coerce')
    # Erro de digitação isolado na fonte (ex. visto na fundição: Santa Catarina, Jun/2025 =
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

    tipomov_all = read_csv(f'caged_{SLUG}_tipo_movimentacao_mensal_cnae.csv')
    tipomov_all = tipomov_all[tipomov_all['cnae_subclasse'].astype(str).str.strip().isin(codes)]
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
    comex_df = read_multi(lambda c, r: f'Comex_Exportacao_Importacao_{c}.csv')
    comex_df['Valor_US_FOB'] = pd.to_numeric(comex_df['Valor_US_FOB'], errors='coerce')
    comex_df['Quilograma_Liquido'] = pd.to_numeric(comex_df['Quilograma_Liquido'], errors='coerce')

    # Os totais nacionais (exportação x importação, kg, balança) vêm da
    # extração por NCM da cesta do segmento (Comex_{cnae}_NCM.csv — cesta
    # definida em Setor <Nome>/2_Scripts/config_setor.R e descrita na nota
    # metodológica do painel). Ranking por país usa
    # Comex_Exportacao_Importacao_{cnae}.csv, que tem a abertura por país.
    ncm_df = read_multi(lambda c, r: f'Comex_{c}_NCM.csv')
    ncm_df['Fluxo'] = ncm_df['Fluxo'].astype(str).str.strip()
    ncm_df['Valor_US_FOB'] = pd.to_numeric(ncm_df['Valor_US_FOB'], errors='coerce')
    ncm_df['Quilograma_Liquido'] = pd.to_numeric(ncm_df['Quilograma_Liquido'], errors='coerce')
    cy_source = ncm_df

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

    # Balança comercial em R$ milhões constantes (ANO_BASE_PRECOS) (câmbio médio do ano + IPCA),
    # pra comparar com relatórios do setor que reportam em real constante
    # em vez de US$ FOB corrente.
    for row in comex_yearly:
        f = fator_brl.get(row['ano'])
        if f:
            row['exportacao_brl_real'] = row['exportacao_usd'] * f / 1e6
            row['importacao_brl_real'] = row['importacao_usd'] * f / 1e6
            row['saldo_brl_real'] = row['exportacao_brl_real'] - row['importacao_brl_real']
        else:
            row['exportacao_brl_real'] = None
            row['importacao_brl_real'] = None
            row['saldo_brl_real'] = None

    # Ranking por UF: mesma extração por NCM, aberta por UF.
    uf_df = read_multi(lambda c, r: f'Comex_{c}_NCM_UF.csv')
    uf_df['Fluxo'] = uf_df['Fluxo'].astype(str).str.strip()
    uf_df['Valor_US_FOB'] = pd.to_numeric(uf_df['Valor_US_FOB'], errors='coerce')

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
    # do cliente pra dar mais destaque à evolução das origens de importação
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
    # produtos chineses mais baratos sobre o mercado interno.
    importacao_china_resto_yearly = []
    for ano in sorted(imp_df['Ano'].unique().tolist()):
        yr = imp_df[imp_df['Ano'] == ano]
        total_ano_imp = to_num(yr['Valor_US_FOB'].sum()) or 0.0
        china = to_num(yr[yr['Pais'] == 'China']['Valor_US_FOB'].sum()) or 0.0
        importacao_china_resto_yearly.append({
            'ano': to_int(ano), 'china_usd': china, 'resto_usd': round(total_ano_imp - china, 2),
        })

    # --- Comex por NCM/produto: preço médio (US$/kg) e ranking de produtos.
    # Mesmo arquivo dos totais (Comex_{cnae}_NCM.csv), filtrado por Fluxo.
    # Colunas renomeadas por nome, não por posição.
    ncm_prod = ncm_df.rename(columns={'Codigo_NCM': 'NCM', 'Descricao_NCM': 'Descricao'})
    ncm_prod['Descricao'] = ncm_prod['Descricao'].astype(str).str.strip()

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

    # Agrupamento por componente (grupo de produto) do diagnóstico da FIESP,
    # via cesta_componentes.csv. NCM sem componente cai em "Outros".
    mapa_comp_path = ROOT / 'cesta_componentes.csv'
    comp_de_ncm, desc_comp = {}, {}
    if mapa_comp_path.exists():
        mapa_c = pd.read_csv(mapa_comp_path, sep=';', dtype=str, encoding='utf-8')
        mapa_c = mapa_c[mapa_c['tipo'] == 'NCM']
        comp_de_ncm = dict(zip(mapa_c['codigo'], mapa_c['componente']))
        desc_comp = dict(zip(mapa_c['componente'], mapa_c['descricao_componente']))

    def _grupos_ano(itens):
        if not comp_de_ncm:
            return None
        total = sum(i['valor_usd'] or 0 for i in itens)
        grupos = {}
        for i in itens:
            comp = comp_de_ncm.get(i['ncm'].zfill(8))
            g = grupos.setdefault(comp, {'componente': comp,
                                         'grupo': desc_comp.get(comp, 'Outros produtos da cesta'),
                                         'valor_usd': 0.0, 'kg': 0.0, 'n_ncm': 0})
            g['valor_usd'] += i['valor_usd'] or 0
            g['kg'] += i['kg'] or 0
            g['n_ncm'] += 1
        out = sorted(grupos.values(), key=lambda g: -g['valor_usd'])
        for g in out:
            g['pct_total'] = g['valor_usd'] / total * 100 if total else None
            g['preco_medio_usd_kg'] = round(g['valor_usd'] / g['kg'], 4) if g['kg'] else None
        return out

    def _ncm_latest(df, ano):
        itens = _ncm_itens_ano(df, ano)
        return {'ano': ano, 'itens': itens, 'grupos': _grupos_ano(itens)}

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

    dfs_por_fluxo = {
        'Exportação': ncm_prod[ncm_prod['Fluxo'] == 'Exportação'],
        'Importação': ncm_prod[ncm_prod['Fluxo'] == 'Importação'],
    }

    comex_ncm = {}
    for fluxo, chave in (('Exportação', 'exportacao'), ('Importação', 'importacao')):
        df_fluxo = dfs_por_fluxo.get(fluxo)
        if df_fluxo is None or df_fluxo.empty:
            continue
        ano_latest = int(df_fluxo['Ano'].max())
        ano_latest = ano_latest - 1 if ano_latest == date.today().year else ano_latest
        comex_ncm[chave] = {
            'latest': _ncm_latest(df_fluxo, ano_latest),
            'preco_medio_yearly': _ncm_preco_medio_yearly(df_fluxo),
        }

    # --- Comtrade global (agregação pesada: ~250k linhas) ---
    ct_df = read_multi(lambda c, r: f'Comtrade_Global_{r}_{c}.csv')
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
    # Ranking mundial de exportadores por ano (exportação de cada país para
    # "World"): top N + o Brasil, mesmo fora do top, com posição e % do total
    # mundial. Usa exportação porque a importação mundial vem subestimada
    # (muitos países declaram importação em CIF; aqui só entra FOB).
    ct_rank = (ct_world_exp.groupby(['Ano', 'Reporter_ISO', 'Reporter'], as_index=False)['Valor_US_FOB'].sum())
    ranking_exportadores = {}
    for ano, g in ct_rank.groupby('Ano'):
        g = g.sort_values('Valor_US_FOB', ascending=False).reset_index(drop=True)
        total_mundo = g['Valor_US_FOB'].sum()
        linhas = []
        for pos, r in enumerate(g.itertuples(index=False), start=1):
            if pos > RANKING_MUNDIAL_TOP and r.Reporter_ISO != 'BRA':
                continue
            iso2, nome = PAISES_ISO3.get(r.Reporter_ISO, [None, r.Reporter])
            linhas.append({'pos': pos, 'iso2': iso2, 'pais': nome, 'valor_usd': to_num(r.Valor_US_FOB),
                           'pct_mundo': to_num(r.Valor_US_FOB / total_mundo * 100) if total_mundo else None})
        ranking_exportadores[str(int(ano))] = {'n_paises': len(g), 'itens': linhas}

    comtrade = {'brazil_yearly': brazil_yearly, 'world_yearly': world_yearly, 'top_partners_latest': top_partners_latest,
                'ranking_exportadores': ranking_exportadores}

    # --- BNDES ---
    bndes_df = read_multi(lambda c, r: f'BNDES_Desembolsos_{c}.csv')
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

    mercado = build_mercado_domestico(codes, ncm_df, macro_rows or [])
    return {
        'label': label,
        'cnae': cfg['cnae'],
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
        'mercado': mercado,
        'simulador': build_simulador(mercado, importacao_china_resto_yearly),
        'bndes': {'yearly': bndes_yearly, 'uf_total': bndes_uf_total,
                  'porte_total': bndes_porte_total, 'table': bndes_table},
    }




# ---------------------------------------------------------------------------
# Simulador de mercado doméstico (projeção do consumo aparente)
# ---------------------------------------------------------------------------
SIMULADOR_ANO_HORIZONTE = 2040


def _cnae_do_componente():
    path = ROOT / 'cesta_componentes.csv'
    if not path.exists():
        return {}
    m = pd.read_csv(path, sep=';', dtype=str, encoding='utf-8')
    return dict(zip(m['componente'], m['cnae']))


CNAE_DO_COMPONENTE = _cnae_do_componente()


def _cagr(v0, v1, anos):
    if not v0 or v0 <= 0 or v1 is None or v1 <= 0 or anos <= 0:
        return None
    return ((v1 / v0) ** (1 / anos) - 1) * 100


def build_simulador(mercado, china_resto_yearly):
    """Base do simulador: valores do último ano do mercado doméstico (R$ do
    ano-base) e ritmo de crescimento anual (CAGR real) desde o primeiro ano,
    para produção, exportação e importação (separando China e demais países
    no segmento; por grupo de produto só há o total importado). Mesma lógica
    da "Simulação de riscos da importação" do diagnóstico setorial; a
    projeção em si é feita no navegador."""
    if not mercado or not mercado.get('yearly'):
        return None
    anual = [r for r in mercado['yearly'] if r.get('producao_real')]
    if len(anual) < 2:
        return None
    r0, r1 = anual[0], anual[-1]
    n = r1['ano'] - r0['ano']
    share = {r['ano']: (r['china_usd'] / (r['china_usd'] + r['resto_usd']))
             for r in china_resto_yearly if (r['china_usd'] + r['resto_usd']) > 0}

    def base(r0, r1, com_china):
        d = {
            'producao': r1['producao_real'], 'exportacao': r1['exportacao_real'],
            'importacao': r1['importacao_real'],
            'g_producao': _cagr(r0['producao_real'], r1['producao_real'], n),
            'g_exportacao': _cagr(r0['exportacao_real'], r1['exportacao_real'], n),
            'g_importacao': _cagr(r0['importacao_real'], r1['importacao_real'], n),
        }
        if com_china and r0['ano'] in share and r1['ano'] in share:
            s0, s1 = share[r0['ano']], share[r1['ano']]
            d['importacao_china'] = r1['importacao_real'] * s1
            d['importacao_resto'] = r1['importacao_real'] * (1 - s1)
            d['g_importacao_china'] = _cagr(r0['importacao_real'] * s0, d['importacao_china'], n)
            d['g_importacao_resto'] = _cagr(r0['importacao_real'] * (1 - s0), d['importacao_resto'], n)
        return d

    segmento = base(r0, r1, True)
    produtos = []
    prod = mercado.get('produtos') or {}
    ini = {i['componente']: i for i in prod.get('itens_inicial') or []}
    if prod.get('ano') == r1['ano'] and prod.get('ano_inicial') == r0['ano']:
        for it in prod.get('itens') or []:
            i0 = ini.get(it['componente'])
            # Só grupos com produção conhecida (sem sigilo) nos dois anos.
            if not i0 or it.get('sigilo') or i0.get('sigilo') or not it.get('producao_real') or not i0.get('producao_real'):
                continue
            if not it.get('consumo_aparente_real') or it['consumo_aparente_real'] <= 0:
                continue
            produtos.append({'componente': it['componente'], 'grupo': it['descricao'],
                             'cnae': CNAE_DO_COMPONENTE.get(it['componente']),
                             **base(i0, it, False)})
    return {'ano_inicial': r0['ano'], 'ano_base': r1['ano'], 'ano_horizonte': SIMULADOR_ANO_HORIZONTE,
            'segmento': segmento, 'produtos': produtos}

# ---------------------------------------------------------------------------
# SHARED: indicadores de desempenho (PIA-Empresa por classe, 2007-2023)
# ---------------------------------------------------------------------------

def build_simulador_impacto(indicadores, cadeia, macro_rows):
    """Coeficientes do bloco "impacto" do simulador: quanto cada R$ milhão a
    mais de produção gera de emprego, massa salarial e valor adicionado no
    próprio segmento (PIA-Empresa por classe, último ano) e, na cadeia de
    fornecedores, pelo multiplicador de produção da MIP 2015 da atividade do
    setor e pelo emprego médio por R$ dos fornecedores diretos (TRU, ponderado
    pelo que a atividade compra de cada um, sem a própria atividade)."""
    if not indicadores or not indicadores.get('serie'):
        return None
    ano = indicadores['ano_final']
    diretos = {}
    for r in indicadores['serie']:
        if r['ano'] != ano or r['recorte'] in ('grupo', 'ind_transformacao'):
            continue
        vbp, po = r.get('vbp'), r.get('pessoal_ocupado')
        if not vbp or not po:
            continue
        diretos[r['recorte']] = {
            # vbp em mil R$ -> por R$ milhão
            'empregos_por_milhao': po / (vbp / 1000),
            'salario_medio_anual': (r['salarios_total'] or 0) * 1000 / po,
            'va_sobre_vbp': (r['valor_adicionado'] or 0) / vbp,
        }
    out = {'ano': ano, 'diretos': diretos, 'cadeia': None}
    if cadeia:
        cod = cadeia['config']['atividade']
        ativs = cadeia['atividades']
        idx = next((i for i, a in enumerate(ativs) if a['cod'] == cod), None)
        if idx is not None and ativs[idx].get('multiplicador'):
            compras = [(o, v) for o, d, v in cadeia['fluxos'] if d == idx and o != idx and v and v > 0]
            total = sum(v for _, v in compras)
            coef = sum(v / total * (ativs[o]['ocupacoes'] / ativs[o]['vbp'])
                       for o, v in compras if ativs[o].get('vbp')) if total else None
            # TRU em R$ milhões do ano da tabela -> R$ do ano dos coeficientes diretos (IPCA médio)
            fator = build_fator_ipca(macro_rows, ano).get(cadeia['ano'])
            out['cadeia'] = {
                'atividade': cod, 'nome': ativs[idx]['nome'], 'ano_tru': cadeia['ano'],
                'multiplicador': ativs[idx]['multiplicador'],
                'empregos_indiretos_por_milhao': coef / fator if coef and fator else None,
            }
    return out

ULTIMO_ANO_PIA_ANTIGA = 2023  # de 2024 em diante a PIA-Empresa é uma nova série


def build_indicadores_desempenho(macro_rows):
    """Mesmos indicadores da tabela "Pontos de destaque" do diagnóstico setorial
    da FIESP (metodologia da planilha DRE da PIA-Empresa): variação entre o
    primeiro ano (2007) e 2023 (fim da série antiga, tabelas SIDRA 7241-7245)
    ou o último ano disponível (nova série, tabela 10473, a partir de 2024).
    Valores em R$ deflacionados pelo IPCA de dezembro (como na planilha).
    Lucro bruto = valor adicionado - gastos de pessoal; margem bruta = lucro
    bruto / receita líquida; investimento líquido = aquisições + melhorias -
    baixas do ativo imobilizado."""
    arquivo = SRC_DIR / f'PIA_Empresa_Indicadores_{ROTULO_ARQUIVO}.csv'
    if not arquivo.exists():
        return None
    df = read_csv(arquivo.name, dtype={'recorte': str})
    campos = [c for c in df.columns if c not in ('ano', 'recorte')]
    linhas = {(int(r['ano']), str(r['recorte'])): {c: to_num(r[c]) for c in campos}
              for _, r in df.iterrows()}
    anos = sorted({a for a, _ in linhas})
    if AGREGADO:
        for a in anos:
            comp = [linhas.get((a, c)) for c in AGREGADO['componentes']]
            if all(comp):
                linhas[(a, AGREGADO['codigo'])] = {
                    c: (None if any(x[c] is None for x in comp) else sum(x[c] for x in comp))
                    for c in campos}

    ipca_dez = {r['ano']: r['ipca'] for r in macro_rows if r['mes'] == 12 and r['ipca']}
    a0, a1 = anos[0], anos[-1]

    def derivados(v, ano):
        ab = ANO_BASE_PRECOS
        f = ipca_dez[ab] / ipca_dez[ano] if ano in ipca_dez and ab in ipca_dez else None
        real = lambda x: None if x is None or f is None else x * f
        va, gp, rlv = v.get('valor_adicionado'), v.get('gastos_pessoal'), v.get('receita_liquida')
        lb = None if va is None or gp is None else va - gp
        aq = v.get('aquisicoes')
        il = None if aq is None else aq + (v.get('melhorias') or 0) - (v.get('baixas') or 0)
        return {
            'pessoal_ocupado': v.get('pessoal_ocupado'),
            'gastos_pessoal_real': real(gp), 'lucro_bruto_real': real(lb),
            'margem_bruta': lb / rlv if lb is not None and rlv else None,
            'investimento_liquido_real': real(il),
            'invest_liquido_rlv': il / rlv if il is not None and rlv else None,
        }

    colunas = [{'codigo': 'ind_transformacao', 'rotulo': 'Indústria de transformação'}]
    if AGREGADO:
        colunas.append({'codigo': AGREGADO['codigo'], 'rotulo': AGREGADO['rotulo']})
    colunas += [{'codigo': c['codigo'], 'rotulo': c.get('rotulo_exec') or c['rotulo']} for c in CNAES]

    def var(x0, x1):
        return None if x0 in (None, 0) or x1 is None else (x1 / abs(x0) - 1) * 100

    def pp(x0, x1):
        return None if x0 is None or x1 is None else (x1 - x0) * 100

    def pct(x):
        return None if x is None else x * 100

    def montar_tabela(af):
        defs = [
            ('Pessoal ocupado', 'var', 'pessoal_ocupado'),
            ('Gasto com pessoal', 'var', 'gastos_pessoal_real'),
            ('Lucro bruto', 'var', 'lucro_bruto_real'),
            (f'Margem bruta ({af})', 'nivel', 'margem_bruta'),
            ('Margem bruta (variação)', 'pp', 'margem_bruta'),
            ('Investimento líquido', 'var', 'investimento_liquido_real'),
            (f'Investimento líquido / faturamento ({af})', 'nivel', 'invest_liquido_rlv'),
            ('Investimento líquido / faturamento (variação)', 'pp', 'invest_liquido_rlv'),
        ]
        tabela = []
        for nome, tipo, chave in defs:
            valores = {}
            for col in colunas:
                v0, v1 = linhas.get((a0, col['codigo'])), linhas.get((af, col['codigo']))
                if not v0 or not v1:
                    valores[col['codigo']] = None
                    continue
                x0, x1 = derivados(v0, a0)[chave], derivados(v1, af)[chave]
                valores[col['codigo']] = {'var': var, 'pp': pp}[tipo](x0, x1) if tipo != 'nivel' else pct(x1)
            tabela.append({'indicador': nome, 'tipo': tipo, 'valores': valores})
        return tabela

    # Último ano da série antiga (comparável com o diagnóstico) e último ano
    # disponível (pode ser da nova série da PIA, a partir de 2024).
    finais = sorted({a for a in (ULTIMO_ANO_PIA_ANTIGA, a1) if a in anos})
    tabelas = [{'ano_final': af, 'nova_serie': af > ULTIMO_ANO_PIA_ANTIGA, 'linhas': montar_tabela(af)}
               for af in finais]

    # Outros indicadores da planilha DRE, no último ano (nível, não variação).
    def outros(v):
        rlv, po = v.get('receita_liquida'), v.get('pessoal_ocupado')
        va, gp = v.get('valor_adicionado'), v.get('gastos_pessoal')
        rt, ct = v.get('receita_total'), v.get('custos_despesas_total')
        div = lambda a, b, k=1: None if a is None or not b else a / b * k
        return {
            'margem_liquida': div(None if rt is None or ct is None else rt - ct, rlv, 100),
            'va_por_po': div(va, po),                       # mil R$ por pessoa
            'vti_por_po': div(v.get('vti'), po),
            'salario_medio_mensal': div(v.get('salarios_total'), po * 13 if po else None, 1000),
            'pessoal_sobre_va': div(gp, va, 100),
            'desp_fin_sobre_rlv': div(v.get('despesas_financeiras'), rlv, 100),
            'depreciacao_sobre_rlv': div(v.get('depreciacao'), rlv, 100),
            'invest_bruto_sobre_rlv': div(None if v.get('aquisicoes') is None else v['aquisicoes'] + (v.get('melhorias') or 0), rlv, 100),
            'rlv_por_empresa': div(rlv, v.get('numero_empresas')),  # mil R$
        }
    OUTROS_DEF = [
        ('Margem líquida (receita total − custos e despesas) / receita líquida', 'margem_liquida', 'pct'),
        ('Produtividade: valor adicionado por pessoa ocupada', 'va_por_po', 'milrs'),
        ('Produtividade: VTI por pessoa ocupada', 'vti_por_po', 'milrs'),
        ('Salário médio mensal', 'salario_medio_mensal', 'rs'),
        ('Gastos de pessoal / valor adicionado', 'pessoal_sobre_va', 'pct'),
        ('Despesas financeiras / receita líquida', 'desp_fin_sobre_rlv', 'pct'),
        ('Depreciação / receita líquida', 'depreciacao_sobre_rlv', 'pct'),
        ('Investimento bruto (aquisições + melhorias) / receita líquida', 'invest_bruto_sobre_rlv', 'pct'),
        ('Receita líquida por empresa', 'rlv_por_empresa', 'milrs'),
    ]
    outros_linhas = []
    for nome, chave, tipo in OUTROS_DEF:
        vals = {}
        for col in colunas:
            v = linhas.get((a1, col['codigo']))
            vals[col['codigo']] = outros(v)[chave] if v else None
        outros_linhas.append({'indicador': nome, 'tipo': tipo, 'valores': vals})

    serie = [{'ano': a, 'recorte': rc, **v, **derivados(v, a)}
             for (a, rc), v in sorted(linhas.items(), key=lambda kv: (kv[0][1], kv[0][0]))]
    return {'ano_inicial': a0, 'ano_final': a1, 'ano_base_precos': ANO_BASE_PRECOS, 'colunas': colunas,
            'tabelas': tabelas, 'linhas': tabelas[-1]['linhas'], 'serie': serie,
            'outros': {'ano': a1, 'linhas': outros_linhas}}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print(f'Lendo CSVs de {SRC_DIR}...')

    producao_indice = build_producao()
    grupo_arquivo = SETOR['grupo_cnae'].replace('.', '_')
    fin_grupo = read_financeiro(f'Dados_Financeiros_{ROTULO_ARQUIVO}_{grupo_arquivo}.csv')
    codigos = '_'.join(c['codigo'] for c in CNAES)
    fin_por_cnae = read_financeiro_por_cnae(f'Dados_Financeiros_CNAE_{codigos}_2024_SerieNova.csv')
    macro = build_macro()
    fator_brl = build_fator_brl(macro, ANO_BASE_PRECOS)
    decom = build_decom(CONFIG.get('blocos_opcionais', {}).get('decom'))
    energia_industrial = build_energia_industrial(macro)

    sectors = {c['codigo']: build_sector(c, fator_brl, macro) for c in SETORES}
    if AGREGADO:
        # PIA 2024 por classe: o agregado é a soma das linhas dos componentes.
        comp = [r for r in fin_por_cnae if r['cnae'] in AGREGADO['componentes']]
        soma = {'ano': comp[0]['ano'], 'cnae': AGREGADO['codigo']}
        for k in comp[0]:
            if k not in soma:
                vals = [r[k] for r in comp]
                soma[k] = None if any(v is None for v in vals) else sum(vals)
        fin_por_cnae.append(soma)

    indicadores = build_indicadores_desempenho(macro)
    cadeia = build_cadeia()
    uf_lista = sorted(({'uf': uf, 'nome': nome} for _, uf, nome in UF_TABLE), key=lambda x: x['nome'])

    data = {
        'meta': {
            'gerado_em': date.today().isoformat(),
            'periodo_slider_padrao': SETOR['periodo_slider_padrao'],
            'uf_lista': uf_lista,
            'config': CONFIG,
        },
        'shared': {
            'producao': {'indice': producao_indice},
            'financeiro': {'grupo': fin_grupo, 'por_cnae_2024': fin_por_cnae,
                           'indicadores': indicadores},
            'simulador_impacto': build_simulador_impacto(indicadores, cadeia, macro),
            'macro': macro,
            'decom': decom,
        },
        'sectors': sectors,
        'energia_industrial': energia_industrial,
        'cadeia': cadeia,
    }

    OUT_DIR.mkdir(exist_ok=True)
    out_path = OUT_DIR / 'data.json'
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'), default=np_default)
    size_kb = out_path.stat().st_size / 1024
    print(f'OK: {out_path} ({size_kb:.1f} KB)')


if __name__ == '__main__':
    main()
