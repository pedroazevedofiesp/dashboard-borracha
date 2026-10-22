"""Testes de fumaça do pipeline de dados: garantem que build_data.py roda contra
os CSVs reais e produz um data.json com o schema esperado, simétrico entre
2451 e 2452. Não usa mocks — o dataset é pequeno o suficiente para rodar em CI."""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import build_data  # noqa: E402


@pytest.fixture(scope='module')
def data():
    build_data.main()
    with open(ROOT / 'data' / 'data.json', encoding='utf-8') as f:
        return json.load(f)


def test_top_level_schema(data):
    assert set(data.keys()) == {'meta', 'shared', 'sectors', 'energia_industrial'}
    assert set(data['sectors'].keys()) == {'2451', '2452'}


def test_sectors_are_symmetric(data):
    # Exceções documentadas: produção física do 2452 é alumínio primário
    # (ABAL), sem equivalente pro 2451 (aço/Instituto Aço Brasil, que fica
    # em shared.producao por ser a fonte usada há mais tempo no painel).
    ONLY_2452 = {'producao_aluminio'}

    def keys(d, prefix=''):
        out = set()
        for k, v in d.items():
            out.add(prefix + k)
            if isinstance(v, dict):
                out |= keys(v, prefix + k + '.')
        return out

    keys_2451 = keys(data['sectors']['2451'])
    keys_2452 = keys(data['sectors']['2452']) - ONLY_2452
    assert keys_2451 == keys_2452


@pytest.mark.parametrize('cnae', ['2451', '2452'])
def test_core_series_not_empty(data, cnae):
    s = data['sectors'][cnae]
    assert len(s['rais']['uf_yearly_total']) > 0
    assert len(s['comex']['yearly']) > 0
    assert len(s['bndes']['yearly']) > 0
    assert len(s['bndes']['table']) > 0


@pytest.mark.parametrize('cnae', ['2451', '2452'])
def test_comex_importacao_china_resto(data, cnae):
    rows = data['sectors'][cnae]['comex']['importacao_china_resto_yearly']
    assert len(rows) > 0
    for r in rows:
        assert set(r.keys()) == {'ano', 'china_usd', 'resto_usd'}
    is_sorted_by(rows, lambda r: r['ano'])


def test_producao_has_laminados(data):
    rows = data['shared']['producao']['aco_gusa']
    assert len(rows) > 0
    assert all('laminados' in r for r in rows)


def test_financeiro_has_materias_primas(data):
    for chave in ('metalurgia_24', 'fundicao_24_5'):
        rows = data['shared']['financeiro'][chave]
        assert len(rows) > 0
        assert all('consumo_materias_primas' in r for r in rows)


def test_json_is_utf8_no_bom():
    raw = (ROOT / 'data' / 'data.json').read_bytes()
    assert not raw.startswith(b'\xef\xbb\xbf')


def is_sorted_by(rows, key):
    values = [key(r) for r in rows]
    assert values == sorted(values)


@pytest.mark.parametrize('cnae', ['2451', '2452'])
def test_yearly_and_monthly_series_are_chronological(data, cnae):
    # Séries usadas diretamente como categorias de eixo X nos gráficos —
    # se a ordem do CSV de origem não for cronológica, o gráfico embaralha
    # o eixo (bug real encontrado com massa_nacional_yearly).
    s = data['sectors'][cnae]
    is_sorted_by(data['shared']['producao']['metalurgia_indice'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(data['shared']['producao']['aco_gusa'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(data['shared']['producao']['aco_gusa_dessaz'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(data['shared']['financeiro']['fundicao_24_5'], lambda r: r['ano'])
    is_sorted_by(s['rais']['uf_yearly_total'], lambda r: r['ano'])
    is_sorted_by(s['rais']['massa_nacional_yearly'], lambda r: r['ano'])
    is_sorted_by(s['caged']['saldo_monthly_national'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(s['comex']['yearly'], lambda r: r['ano'])
    is_sorted_by(s['bndes']['yearly'], lambda r: r['ano'])


@pytest.mark.parametrize('cnae', ['2451', '2452'])
def test_caged_uf_monthly_series(data, cnae):
    caged = data['sectors'][cnae]['caged']
    assert len(caged['saldo_uf_monthly']) > 0
    assert len(caged['salario_uf_monthly']) > 0
    assert set(caged['saldo_uf_monthly'][0].keys()) == {'ano', 'mes', 'uf', 'saldo'}
    assert set(caged['salario_uf_monthly'][0].keys()) == {'ano', 'mes', 'uf', 'massa_salarial'}
    is_sorted_by(caged['saldo_uf_monthly'], lambda r: r['ano'] * 100 + r['mes'])
    is_sorted_by(caged['salario_uf_monthly'], lambda r: r['ano'] * 100 + r['mes'])


@pytest.mark.parametrize('cnae', ['2451', '2452'])
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


@pytest.mark.parametrize('cnae', [10, 24, 33])
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
