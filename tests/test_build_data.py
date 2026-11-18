"""Testes de fumaça do pipeline de dados: garantem que build_data.py roda contra
os CSVs reais e produz um data.json com o schema esperado, simétrico entre
os CNAEs de config_painel.json. Não usa mocks — o dataset é pequeno o
suficiente para rodar em CI."""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import build_data  # noqa: E402

CNAES = [c['codigo'] for c in build_data.SETORES]  # CNAEs + recorte agregado (se houver)
AGREGADO = build_data.AGREGADO


@pytest.fixture(scope='module')
def data():
    build_data.main()
    with open(ROOT / 'data' / 'data.json', encoding='utf-8') as f:
        return json.load(f)


def test_top_level_schema(data):
    assert set(data.keys()) == {'meta', 'shared', 'sectors', 'energia_industrial', 'cadeia'}
    assert set(data['sectors'].keys()) == set(CNAES)


def test_config_repassado_ao_json(data):
    cfg = data['meta']['config']
    assert [c['codigo'] for c in cfg['cnaes']] == [c['codigo'] for c in build_data.CNAES]
    for c in cfg['cnaes']:
        assert c['rotulo'] and c['rotulo_exec'] and c['cesta_ncm']


def test_sectors_are_symmetric(data):
    def keys(d, prefix=''):
        out = set()
        for k, v in d.items():
            out.add(prefix + k)
            if isinstance(v, dict):
                out |= keys(v, prefix + k + '.')
        return out

    referencia = keys(data['sectors'][CNAES[0]])
    for cnae in CNAES[1:]:
        assert keys(data['sectors'][cnae]) == referencia


@pytest.mark.parametrize('cnae', CNAES)
def test_core_series_not_empty(data, cnae):
    s = data['sectors'][cnae]
    assert len(s['rais']['uf_yearly_total']) > 0
    assert len(s['comex']['yearly']) > 0
    assert len(s['comtrade']['brazil_yearly']) > 0
    assert len(s['bndes']['yearly']) > 0
    assert len(s['bndes']['table']) > 0


@pytest.mark.parametrize('cnae', CNAES)
def test_comex_importacao_china_resto(data, cnae):
    rows = data['sectors'][cnae]['comex']['importacao_china_resto_yearly']
    assert len(rows) > 0
    for r in rows:
        assert set(r.keys()) == {'ano', 'china_usd', 'resto_usd'}
    is_sorted_by(rows, lambda r: r['ano'])


@pytest.mark.parametrize('cnae', CNAES)
def test_comex_ncm_por_fluxo(data, cnae):
    # Arquivo Comex_{cnae}_NCM.csv tem os dois fluxos numa coluna Fluxo
    # (renomeado por nome, não por posição — ver build_sector).
    ncm = data['sectors'][cnae]['comex']['ncm']
    assert set(ncm.keys()) == {'exportacao', 'importacao'}
    for bloco in ncm.values():
        for item in bloco['latest']['itens']:
            assert item['ncm'].isdigit() and len(item['ncm']) == 8


def test_producao_indice(data):
    rows = data['shared']['producao']['indice']
    assert len(rows) > 0
    assert all(r['indice_bruto'] is not None for r in rows)


def test_financeiro_has_materias_primas(data):
    rows = data['shared']['financeiro']['grupo']
    assert len(rows) > 0
    assert all('consumo_materias_primas' in r for r in rows)
    por_cnae = data['shared']['financeiro']['por_cnae_2024']
    assert {r['cnae'] for r in por_cnae} == set(CNAES)


def test_json_is_utf8_no_bom():
    raw = (ROOT / 'data' / 'data.json').read_bytes()
    assert not raw.startswith(b'\xef\xbb\xbf')


def is_sorted_by(rows, key):
    values = [key(r) for r in rows]
    assert values == sorted(values)


@pytest.mark.parametrize('cnae', CNAES)
def test_yearly_and_monthly_series_are_chronological(data, cnae):
    # Séries usadas diretamente como categorias de eixo X nos gráficos —
    # se a ordem do CSV de origem não for cronológica, o gráfico embaralha
    # o eixo (bug real encontrado com massa_nacional_yearly).
    s = data['sectors'][cnae]
    is_sorted_by(data['shared']['producao']['indice'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(data['shared']['financeiro']['grupo'], lambda r: r['ano'])
    is_sorted_by(s['rais']['uf_yearly_total'], lambda r: r['ano'])
    is_sorted_by(s['rais']['massa_nacional_yearly'], lambda r: r['ano'])
    is_sorted_by(s['caged']['saldo_monthly_national'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(s['comex']['yearly'], lambda r: r['ano'])
    is_sorted_by(s['bndes']['yearly'], lambda r: r['ano'])


@pytest.mark.parametrize('cnae', CNAES)
def test_caged_uf_monthly_series(data, cnae):
    caged = data['sectors'][cnae]['caged']
    assert len(caged['saldo_uf_monthly']) > 0
    assert len(caged['salario_uf_monthly']) > 0
    assert set(caged['saldo_uf_monthly'][0].keys()) == {'ano', 'mes', 'uf', 'saldo'}
    assert set(caged['salario_uf_monthly'][0].keys()) == {'ano', 'mes', 'uf', 'massa_salarial'}
    is_sorted_by(caged['saldo_uf_monthly'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(caged['salario_uf_monthly'], lambda r: r['ano'] * 100 + r['mes'])


@pytest.mark.parametrize('cnae', CNAES)
def test_caged_sem_buracos(data, cnae):
    # Junção CAGED antigo (até 2019) + novo (2020+) + FTP: nenhum mês pode faltar.
    meses = [r['ano'] * 12 + r['mes'] for r in data['sectors'][cnae]['caged']['saldo_monthly_national']]
    assert meses == list(range(meses[0], meses[-1] + 1))


@pytest.mark.parametrize('cnae', CNAES)
def test_rais_ocupacao_detalhada(data, cnae):
    ocup = data['sectors'][cnae]['rais']['ocupacao_detalhada_latest']
    assert ocup['ano'] > 0
    assert len(ocup['items']) > 0


def test_energia_industrial_schema(data):
    ei = data['energia_industrial']
    assert len(ei['ufs']) == 28  # 27 estados + Brasil
    assert {'BR', 'SP', 'AC', 'RR'} <= {u['uf'] for u in ei['ufs']}
    assert ei['ufs'][0]['uf'] == 'BR'  # Brasil primeiro na lista
    assert len(ei['divisoes']) == 24
    assert all('cnae' in d and 'descricao' in d for d in ei['divisoes'])
    assert ei['serie_campos'] == ['ano', 'mes', 'consumo_mwh', 'custo_rs_mwh', 'participacao_pct', 'custo_real_rs_mwh']


@pytest.mark.parametrize('cnae', [10, 22, 24, 33])
def test_energia_industrial_serie_por_divisao(data, cnae):
    path = ROOT / 'data' / 'energia' / f'serie-cnae-{cnae}.json'
    assert path.exists()
    with open(path, encoding='utf-8') as f:
        obj = json.load(f)
    ufs_esperadas = {u['uf'] for u in data['energia_industrial']['ufs']}
    assert set(obj.keys()) == ufs_esperadas


@pytest.mark.parametrize('uf', ['BR', 'SP', 'AC'])
def test_energia_industrial_composicao_por_uf(data, uf):
    path = ROOT / 'data' / 'energia' / f'composicao-uf-{uf}.json'
    assert path.exists()
    with open(path, encoding='utf-8') as f:
        by_month = json.load(f)
    assert len(by_month) > 0
    for valores in by_month.values():
        assert len(valores) == 24


@pytest.mark.skipif(not AGREGADO, reason='painel sem recorte agregado')
def test_agregado_e_a_soma_dos_componentes(data):
    # "Borracha - Total" tem de bater exatamente com a soma dos segmentos.
    tot = data['sectors'][AGREGADO['codigo']]
    comps = [data['sectors'][c] for c in AGREGADO['componentes']]

    def por_ano(s, bloco, serie, campo):
        return {r['ano']: r[campo] for r in s[bloco][serie]}

    for bloco, serie, campo in [('rais', 'uf_yearly_total', 'vinculos'),
                                ('rais', 'uf_yearly_total', 'estabelecimentos'),
                                ('comex', 'yearly', 'exportacao_usd'),
                                ('comex', 'yearly', 'importacao_usd'),
                                ('bndes', 'yearly', 'valor_desembolsado')]:
        t = por_ano(tot, bloco, serie, campo)
        for ano, v in t.items():
            soma = sum(por_ano(c, bloco, serie, campo).get(ano, 0) or 0 for c in comps)
            assert v == pytest.approx(soma), (bloco, serie, campo, ano)

    saldo = lambda s: {(r['ano'], r['mes']): r['saldo'] for r in s['caged']['saldo_monthly_national']}
    for k, v in saldo(tot).items():
        assert v == sum(saldo(c).get(k, 0) for c in comps)

    pia = {r['cnae']: r['receita_liquida_total'] for r in data['shared']['financeiro']['por_cnae_2024']}
    assert pia[AGREGADO['codigo']] == pytest.approx(sum(pia[c] for c in AGREGADO['componentes']))


def test_cadeia_produtiva(data):
    c = data['cadeia']
    cods = [a['cod'] for a in c['atividades']]
    assert len(cods) == 68 and c['config']['atividade'] in cods
    n = len(cods)
    assert all(0 <= o < n and 0 <= d < n and v > 0 for o, d, v in c['fluxos'])
    anos = [o['ano'] for o in c['produto']['oferta']]
    assert anos == sorted(anos) and anos[-1] == c['ano']
    ult = [d for d in c['produto']['destinos'] if d['ano'] == c['ano']]
    # o que os compradores levam + demanda final fecha com a demanda total do produto
    assert abs(sum(d['valor'] for d in ult) - c['produto']['oferta'][-1]['demanda']) < 1
    assert c['insumos_atividade']


def test_cadeia_config(data):
    cfg = data['cadeia']['config']
    assert not any(k.startswith('_') for k in cfg), 'comentários da config não devem ir pro data.json'
    for chave in ('produto', 'atividade', 'nome', 'nome_produto', 'titulo', 'elos', 'principais_clientes', 'grupos_cor'):
        assert chave in cfg, chave
    centros = [i['centro'] for e in cfg['elos'] for i in e['itens']]
    assert 'produto' in centros, 'algum botão de elo precisa abrir o próprio produto'
    # os setores de RAIS citados precisam existir no painel
    assert set(cfg.get('empregos_rais', [])) <= set(data['sectors'])


@pytest.mark.parametrize('cnae', CNAES)
def test_mercado_domestico(data, cnae):
    # Consumo aparente = produção + importação - exportação; coeficientes em %.
    m = data['sectors'][cnae]['mercado']
    if m is None:
        pytest.skip('sem PIA_Produto_<Rotulo>.csv')
    assert m['yearly'], 'série vazia'
    for r in m['yearly']:
        assert r['consumo_aparente'] == pytest.approx(r['producao'] + r['importacao'] - r['exportacao'])
        if r['producao']:
            assert r['coef_exportacao'] == pytest.approx(r['exportacao'] / r['producao'] * 100)
        if r['consumo_aparente']:
            assert r['penetracao_importacao'] == pytest.approx(r['importacao'] / r['consumo_aparente'] * 100)
    anos = [r['ano'] for r in m['yearly']]
    assert anos == sorted(anos)
    assert m['produtos']['itens']


@pytest.mark.skipif(not AGREGADO, reason='painel sem recorte agregado')
def test_mercado_total_e_soma(data):
    tot = data['sectors'][AGREGADO['codigo']]['mercado']
    comps = [data['sectors'][c]['mercado'] for c in AGREGADO['componentes']]
    if tot is None:
        pytest.skip('sem PIA_Produto_<Rotulo>.csv')
    for i, r in enumerate(tot['yearly']):
        for campo in ('producao', 'exportacao', 'importacao'):
            soma = sum(next(x[campo] for x in c['yearly'] if x['ano'] == r['ano']) for c in comps)
            assert r[campo] == pytest.approx(soma), (campo, r['ano'])


def test_indicadores_desempenho(data):
    ind = data['shared']['financeiro']['indicadores']
    assert ind is not None
    codigos = [c['codigo'] for c in ind['colunas']]
    assert codigos[0] == 'ind_transformacao'
    assert all(c in codigos for c in CNAES)
    assert len(ind['linhas']) == 8
    assert ind['tabelas'] and ind['tabelas'][-1]['ano_final'] == ind['ano_final']
    for tab in ind['tabelas']:
        assert len(tab['linhas']) == 8
    assert {l['tipo'] for l in ind['linhas']} == {'var', 'pp', 'nivel'}
    for l in ind['linhas']:
        assert set(l['valores']) == set(codigos)
    if AGREGADO:
        # Pessoal ocupado do total = soma das classes, nos dois anos extremos.
        serie = ind['serie']
        for ano in (ind['ano_inicial'], ind['ano_final']):
            linha = {r['recorte']: r for r in serie if r['ano'] == ano}
            soma = sum(linha[c]['pessoal_ocupado'] for c in AGREGADO['componentes'])
            assert linha[AGREGADO['codigo']]['pessoal_ocupado'] == soma


@pytest.mark.parametrize('cnae', CNAES)
def test_simulador(data, cnae):
    s = data['sectors'][cnae]['simulador']
    assert s is not None
    assert s['ano_inicial'] < s['ano_base'] < s['ano_horizonte']
    seg = s['segmento']
    for k in ('producao', 'exportacao', 'importacao'):
        assert seg[k] is not None and seg[k] >= 0
    # Base do simulador = último ano do mercado doméstico.
    ultimo = data['sectors'][cnae]['mercado']['yearly'][-1]
    assert abs(seg['producao'] - ultimo['producao_real']) < 1
    if 'importacao_china' in seg:
        assert abs(seg['importacao_china'] + seg['importacao_resto'] - seg['importacao']) < 1
    for p in s['produtos']:
        assert p['producao'] > 0 and p['grupo']


def test_simulador_impacto(data):
    imp = data['shared']['simulador_impacto']
    assert imp is not None
    for c in CNAES:
        d = imp['diretos'][c]
        assert d['empregos_por_milhao'] > 0 and d['salario_medio_anual'] > 0
        assert 0 < d['va_sobre_vbp'] < 1
    cad = imp['cadeia']
    assert cad and cad['multiplicador'] > 1 and cad['empregos_indiretos_por_milhao'] > 0
    # Grupos de produto do simulador sabem a qual CNAE pertencem (coeficiente direto).
    for c in CNAES:
        for p in data['sectors'][c]['simulador']['produtos']:
            assert p['cnae'] in imp['diretos']


@pytest.mark.parametrize('cnae', CNAES)
def test_cempre(data, cnae):
    c = data['sectors'][cnae]['cempre']
    assert c and c['brasil'], 'CEMPRE ausente'
    u = c['brasil'][-1]
    assert u['empresas'] > 0 and u['pessoal_ocupado'] > 0
    assert c['ind_transformacao_brasil'][-1]['empresas'] > u['empresas']
    assert len(c['uf_ultimo_ano']) == 27


def test_cempre_total_e_soma(data):
    if not AGREGADO:
        pytest.skip('sem agregado')
    tot = data['sectors'][AGREGADO['codigo']]['cempre']['brasil'][-1]
    soma = sum(data['sectors'][c]['cempre']['brasil'][-1]['empresas'] for c in AGREGADO['componentes'])
    assert tot['empresas'] == soma


@pytest.mark.parametrize('cnae', CNAES)
def test_municipios(data, cnae):
    m = data['sectors'][cnae]['municipios']
    assert m and m['itens']
    ids = [x['id'] for x in m['itens']]
    assert len(ids) == len(set(ids)), 'município repetido'
    assert all(len(i) == 7 for i in ids), 'código IBGE sem 7 dígitos'
    assert all(x['vinc'] >= 0 and x['estab'] >= 0 for x in m['itens'])


def test_malha_municipal():
    geo = ROOT / 'assets' / 'geo'
    arquivos = sorted(geo.glob('mun-*.json'))
    assert len(arquivos) == 27


@pytest.mark.parametrize('cnae', CNAES)
def test_comtrade_grupos(data, cnae):
    g = data['sectors'][cnae]['comtrade']['grupos_mundo']
    assert g and g['itens']
    for x in g['itens']:
        assert x['mundo_usd'] > 0
        assert 0 <= x['brasil_pct'] <= 100


def test_comparativos_e_outros_indicadores(data):
    cmp = data['shared']['producao']['comparativos']
    assert cmp and {'industria_geral', 'industria_transformacao'} <= set(cmp)
    outros = data['shared']['financeiro']['indicadores']['outros']
    assert outros and len(outros['linhas']) >= 5


@pytest.mark.parametrize('cnae', CNAES)
def test_comex_mensal_bate_com_anual(data, cnae):
    c = data['sectors'][cnae]['comex']
    if not c.get('mensal'):
        pytest.skip('sem base bruta do Comex Stat')
    anual = {r['ano']: r for r in c['yearly']}
    soma = {}
    for r in c['mensal']:
        soma.setdefault(r['ano'], [0.0, 0.0])
        soma[r['ano']][0] += r['exportacao_fob']
        soma[r['ano']][1] += r['importacao_fob']
        assert r['importacao_cif'] >= r['importacao_fob'] - 1
    for ano in (2015, 2020, 2024):
        if ano in anual and ano in soma:
            assert abs(soma[ano][1] - anual[ano]['importacao_usd']) <= max(1.0, 0.001 * anual[ano]['importacao_usd'])


def test_comex_externas(data):
    ext = data['shared']['comex_externas']
    assert ext and {e['cesta'] for e in ext} >= {'natural', 'pneus_novos'}


def test_comex_municipio(data):
    m = data['sectors'][CNAES[0]]['municipios'].get('comex')
    if not m or not m['itens']:
        pytest.skip('sem comércio por município')
    nac = {r['ano']: r for r in data['sectors'][CNAES[0]]['comex']['yearly']}[m['ano']]
    assert abs(m['total_exp'] - nac['exportacao_usd']) <= 0.02 * nac['exportacao_usd']
    assert all(len(x['id']) == 7 and not x['nome'].startswith('Município ') for x in m['itens'][:50])
