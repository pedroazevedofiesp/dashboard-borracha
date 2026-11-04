#!/usr/bin/env python3
"""Extrai das Contas Nacionais do IBGE os CSVs da aba Cadeia Produtiva.

Duas fontes, cada uma usada no que tem de melhor:

* Tabelas de Recursos e Usos (TRU), nível 68 atividades, 2010-2021 — a mais
  recente nesse nível de detalhe. Dá os valores exibidos: quem compra o
  produto do setor (definido em cadeia_config.json; hoje, artigos de borracha,
  22001), o que a atividade dele compra, o fluxo entre todas as atividades,
  VBP, valor adicionado e ocupações. Valores a preço de consumidor (com
  margens e impostos), R$ milhões correntes.
* Matriz Insumo-Produto (MIP) 2015, nível 67 — a mais recente publicada (o
  IBGE monta a MIP a cada 5 anos). Usada só no que a TRU não tem: a parcela
  importada de cada compra e o multiplicador de produção (Leontief).

Entradas (Setor Borracha/1_Dados_Manuais_XLS/, ao lado desta pasta e fora do git;
ou na pasta indicada pela variável de ambiente CADEIA_DADOS_DIR):
  TRU_Nivel_68_2010_2021/68_tab1_AAAA.xls, 68_tab2_AAAA.xls
    ftp.ibge.gov.br/Contas_Nacionais/Sistema_de_Contas_Nacionais/2021/tabelas_xls/tabelas_de_recursos_e_usos/nivel_68_2010_2021_xls.zip
  MIP_2015_Nivel_67.xls
    ftp.ibge.gov.br/Contas_Nacionais/Matriz_de_Insumo_Produto/2015/Matriz_de_Insumo_Produto_2015_Nivel_67.xls

Saídas (3_Dados_Tratados_CSV/):
  Cadeia_Atividades.csv          uma linha por atividade (ano mais recente da TRU)
  Cadeia_Fluxos_Atividades.csv   vendas intermediárias atividade -> atividade
  Cadeia_Produto_Destinos.csv    para quem vai o produto do setor, por ano
  Cadeia_Produto_Oferta.csv      produção nacional e importação do produto, por ano
  Cadeia_Insumos_Atividade.csv   o que a atividade do setor compra, por produto

Uso:
  python extrair_cadeia.py              gera os CSVs para o setor de cadeia_config.json
  python extrair_cadeia.py --listar     lista os códigos de produtos e atividades da TRU
  python extrair_cadeia.py --sugerir 22001
                                        mostra quem produz e quem compra o produto,
                                        para preencher a config com base nos dados

Para replicar para outro CNAE, ver COMO_REPLICAR_CADEIA.md. Só precisa rodar
de novo quando o IBGE publicar TRU ou MIP novas, ou ao trocar de setor."""

import argparse
import json
import os
import re
from pathlib import Path

import numpy as np
import pandas as pd
import xlrd

ROOT = Path(__file__).resolve().parent
# Copiado do painel de fundição; aqui as tabelas do IBGE ficam na pasta de
# coleta do setor, ao lado do repositório (C:/Dashboards/Setor Borracha/Setor Borracha/).
MANUAIS = Path(os.environ['CADEIA_DADOS_DIR']) if os.environ.get('CADEIA_DADOS_DIR')     else ROOT.parent / 'Setor Borracha' / '1_Dados_Manuais_XLS'
TRU_DIR = MANUAIS / 'TRU_Nivel_68_2010_2021'
MIP_XLS = MANUAIS / 'MIP_2015_Nivel_67.xls'
OUT_DIR = ROOT / '3_Dados_Tratados_CSV'
CONFIG = ROOT / 'cadeia_config.json'
PRIMEIRA_LINHA = 5  # dados começam na linha 6 de todas as tabelas
# A MIP 2015 junta o comércio numa atividade só; a TRU separa em duas.
MIP_EQUIVALENTE = {'4500': '4580', '4680': '4580'}

# Nomes curtos para caber nos rótulos do diagrama (o nome oficial do IBGE vai junto no CSV).
NOME_CURTO = {
    '0191': 'Agricultura', '0192': 'Pecuária', '0280': 'Florestal, pesca e aquicultura',
    '0580': 'Carvão e minerais não metálicos', '0680': 'Petróleo e gás', '0791': 'Minério de ferro',
    '0792': 'Minerais metálicos não ferrosos', '1091': 'Carnes e laticínios', '1092': 'Açúcar',
    '1093': 'Outros alimentos', '1100': 'Bebidas', '1200': 'Fumo', '1300': 'Têxteis',
    '1400': 'Vestuário', '1500': 'Calçados e couro', '1600': 'Madeira', '1700': 'Celulose e papel',
    '1800': 'Impressão', '1991': 'Refino de petróleo e coque', '1992': 'Biocombustíveis',
    '2091': 'Químicos e resinas', '2092': 'Tintas e químicos diversos',
    '2093': 'Limpeza e cosméticos', '2100': 'Farmacêuticos', '2200': 'Borracha e plástico',
    '2300': 'Minerais não metálicos', '2491': 'Siderurgia (ferro-gusa e aço)',
    '2492': 'Metalurgia de não ferrosos e fundição', '2500': 'Produtos de metal',
    '2600': 'Informática e eletrônicos', '2700': 'Máquinas e equipamentos elétricos',
    '2800': 'Máquinas e equipamentos mecânicos', '2991': 'Automóveis, caminhões e ônibus',
    '2992': 'Peças para veículos', '3000': 'Outros equipamentos de transporte',
    '3180': 'Móveis e indústrias diversas', '3300': 'Manutenção de máquinas',
    '3500': 'Energia elétrica e gás', '3680': 'Água, esgoto e resíduos', '4180': 'Construção',
    '4500': 'Comércio de veículos', '4680': 'Comércio atacadista e varejista',
    '4900': 'Transporte terrestre', '5000': 'Transporte aquaviário',
    '5100': 'Transporte aéreo', '5280': 'Armazenagem e correio', '5500': 'Alojamento',
    '5600': 'Alimentação', '5800': 'Edição', '5980': 'TV, rádio e cinema', '6100': 'Telecomunicações',
    '6280': 'Sistemas e informação', '6480': 'Finanças e seguros', '6800': 'Imobiliárias',
    '6980': 'Jurídico, contábil e consultoria', '7180': 'Engenharia e P&D',
    '7380': 'Outras atividades técnicas', '7700': 'Aluguéis não imobiliários',
    '7880': 'Serviços administrativos', '8000': 'Vigilância e segurança',
    '8400': 'Administração pública', '8591': 'Educação pública', '8592': 'Educação privada',
    '8691': 'Saúde pública', '8692': 'Saúde privada', '9080': 'Artes e espetáculos',
    '9480': 'Associações e serviços pessoais', '9700': 'Serviços domésticos',
}
DEMANDA_FINAL = [  # (chave, nome) na ordem das colunas da TRU/MIP
    ('exportacao', 'Exportação'), ('governo', 'Consumo do governo'), ('isflsf', 'Consumo das ISFLSF'),
    ('familias', 'Consumo das famílias'), ('fbcf', 'Investimento (FBCF)'), ('estoque', 'Variação de estoque'),
]


def _num(v):
    return float(v) if isinstance(v, (int, float)) else 0.0


def ler_produtos(sheet, col_ini, n_cols):
    """Linhas de produto (código numérico) de uma tabela: [(código, descrição, [valores])]."""
    linhas = []
    for r in range(PRIMEIRA_LINHA, sheet.nrows):
        v = sheet.cell_value(r, 0)
        # a TRU de 2016 grava o código como número (24922.0), as outras como texto
        cod = str(int(v)).zfill(5) if isinstance(v, float) else str(v).strip()
        if not cod.isdigit():
            break
        linhas.append((cod, str(sheet.cell_value(r, 1)).strip(),
                       [_num(sheet.cell_value(r, c)) for c in range(col_ini, col_ini + n_cols)]))
    return linhas


def atividades_do_cabecalho(sheet, linha, col_ini):
    """Lê '0191\\nAgricultura...' do cabeçalho até a coluna 'Total'."""
    ativs = []
    for c in range(col_ini, sheet.ncols):
        m = re.match(r'\s*(\d{4})\s+(.*)', str(sheet.cell_value(linha, c)), re.S)
        if not m:
            break
        ativs.append((m.group(1), ' '.join(m.group(2).split())))
    return ativs


def ler_tru(ano):
    t1 = xlrd.open_workbook(str(TRU_DIR / f'68_tab1_{ano}.xls'))
    t2 = xlrd.open_workbook(str(TRU_DIR / f'68_tab2_{ano}.xls'))
    s_prod, s_imp, s_ci, s_df, s_va = (t1.sheet_by_name('producao'), t1.sheet_by_name('importacao'),
                                       t2.sheet_by_name('CI'), t2.sheet_by_name('demanda'), t2.sheet_by_name('VA'))
    ativs = atividades_do_cabecalho(s_ci, 3, 2)
    n = len(ativs)
    assert atividades_do_cabecalho(s_prod, 3, 2) == ativs or [a for a, _ in atividades_do_cabecalho(s_prod, 3, 2)] == [a for a, _ in ativs]
    prod = ler_produtos(s_prod, 2, n)
    ci = ler_produtos(s_ci, 2, n)
    dfin = ler_produtos(s_df, 2, len(DEMANDA_FINAL))
    imp = ler_produtos(s_imp, 2, 1)
    assert [p[0] for p in prod] == [p[0] for p in ci] == [p[0] for p in dfin] == [p[0] for p in imp]
    va = {}
    for r in range(PRIMEIRA_LINHA, s_va.nrows):
        rot = str(s_va.cell_value(r, 0)).strip()
        if rot.startswith('Valor adicionado bruto'):
            va['va'] = [_num(s_va.cell_value(r, c)) for c in range(1, 1 + n)]
        elif rot == 'Valor da produção':
            va['vbp'] = [_num(s_va.cell_value(r, c)) for c in range(1, 1 + n)]
        elif rot.startswith('Fator trabalho'):
            va['ocupacoes'] = [_num(s_va.cell_value(r, c)) for c in range(1, 1 + n)]
    return {
        'ativs': ativs,
        'produtos': [(p[0], p[1]) for p in prod],
        'prod': np.array([p[2] for p in prod]),      # produto x atividade
        'ci': np.array([p[2] for p in ci]),          # produto x atividade (preço de consumidor)
        'df': np.array([p[2] for p in dfin]),        # produto x demanda final
        'imp': np.array([p[2][0] for p in imp]),     # importação por produto
        **{k: np.array(v) for k, v in va.items()},
    }


def ler_mip():
    """Da MIP 2015: parcela importada de cada (produto, atividade compradora) e
    (produto, demanda final), e o multiplicador de produção de cada atividade."""
    b = xlrd.open_workbook(str(MIP_XLS))
    s03, s04, s15 = b.sheet_by_name('03'), b.sheet_by_name('04'), b.sheet_by_name('15')
    ativs = atividades_do_cabecalho(s03, 3, 3)
    n = len(ativs)
    nac = ler_produtos(s03, 3, n + 1 + len(DEMANDA_FINAL))
    imp = ler_produtos(s04, 3, n + 1 + len(DEMANDA_FINAL))
    pct_imp = {}
    for (cod, _, vn), (_, _, vi) in zip(nac, imp):
        cols = [a for a, _ in ativs] + ['_total'] + [k for k, _ in DEMANDA_FINAL]
        for col, a, b_ in zip(cols, vn, vi):
            if a + b_ > 0:
                pct_imp[(cod, col)] = b_ / (a + b_)
    linha0 = next(r for r in range(s15.nrows) if str(s15.cell_value(r, 0)).strip() == '0191')
    col0 = next(c for c in range(s15.ncols) if _num(s15.cell_value(linha0, c)) > 0)
    leontief = np.array([[_num(s15.cell_value(r, c)) for c in range(col0, col0 + n)]
                         for r in range(linha0, linha0 + n)])
    mult = dict(zip([a for a, _ in ativs], leontief.sum(axis=0)))
    return pct_imp, mult


def anos_tru():
    return sorted(int(m.group(1)) for f in TRU_DIR.glob('68_tab2_*.xls') if (m := re.search(r'_(\d{4})\.xls$', f.name)))


def listar():
    """Códigos de produtos (5 dígitos) e atividades (4 dígitos) da TRU mais recente."""
    t = ler_tru(anos_tru()[-1])
    print('ATIVIDADES (4 dígitos) — o CNAE de cada uma está no Tradutor_Atividade_CNAE.xls do IBGE')
    for a, d in t['ativs']:
        print(f'  {a}  {d}')
    print('\nPRODUTOS (5 dígitos)')
    for p, d in t['produtos']:
        print(f'  {p}  {d}')


def sugerir(produto):
    """Quem produz e quem compra o produto (ano mais recente, e em quantos anos
    da série cada comprador aparece): base para preencher cadeia_config.json."""
    anos = anos_tru()
    trus = {ano: ler_tru(ano) for ano in anos}
    t = trus[anos[-1]]
    cods = [a for a, _ in t['ativs']]
    i = next((k for k, (p, _) in enumerate(t['produtos']) if p == produto), None)
    if i is None:
        raise SystemExit(f'Produto {produto} não existe na TRU. Rode com --listar.')
    print(f'{produto}  {t["produtos"][i][1]}  ({anos[-1]}, R$ milhões)\n')
    prod = t['prod'][i]
    print('QUEM PRODUZ (a primeira costuma ser a "atividade" da config):')
    for j in np.argsort(-prod)[:3]:
        if prod[j]:
            print(f'  {cods[j]}  {NOME_CURTO[cods[j]]:<40} {prod[j]:>10,.0f}  {100 * prod[j] / prod.sum():5.1f}%')

    def aparece(cod):
        # em quantos anos da série a atividade comprou o produto
        n = 0
        for tr in trus.values():
            ip = [p for p, _ in tr['produtos']].index(produto)
            ia = [a for a, _ in tr['ativs']].index(cod)
            n += tr['ci'][ip, ia] > 0
        return n

    compras = [(c, NOME_CURTO[c], t['ci'][i, j], aparece(c)) for j, c in enumerate(cods) if t['ci'][i, j] > 0]
    compras += [(k, nome, t['df'][i, n], None) for n, (k, nome) in enumerate(DEMANDA_FINAL) if t['df'][i, n] > 0]
    total = sum(v for _, _, v, _ in compras)
    print(f'\nQUEM COMPRA DIRETO ("anos" = em quantos dos {len(anos)} anos da série o comprador aparece):')
    acum = 0
    for cod, nome, v, n in sorted(compras, key=lambda x: -x[2]):
        acum += v
        anos_txt = f'anos {n}/{len(anos)}' if n is not None else 'demanda final'
        print(f'  {cod:<11} {nome:<40} {v:>10,.0f}  {100 * v / total:5.1f}%  acum. {100 * acum / total:5.1f}%  {anos_txt}')
    print(f'\nImportação: {t["imp"][i]:,.0f} ({100 * t["imp"][i] / (prod.sum() + t["imp"][i]):.1f}% da oferta a preço básico)')
    print('Quem não aparece acima não compra o produto direto, mesmo que esteja na cadeia (ex.: montadoras e peças fundidas).')


def main():
    cfg = json.loads(CONFIG.read_text(encoding='utf-8'))
    produto_setor, atividade_setor = cfg['produto'], cfg['atividade']
    anos = anos_tru()
    ano_ref = anos[-1]
    trus = {ano: ler_tru(ano) for ano in anos}
    t = trus[ano_ref]
    cods = [a for a, _ in t['ativs']]
    n = len(cods)
    pct_imp, mult = ler_mip()

    def pct_importado(produto, col):
        return pct_imp.get((produto, MIP_EQUIVALENTE.get(col, col)))

    # Matriz D (market share): quanto de cada produto cada atividade produz.
    tot_prod = t['prod'].sum(axis=1)
    D = np.divide(t['prod'], tot_prod[:, None], out=np.zeros_like(t['prod']), where=tot_prod[:, None] > 0).T
    fluxo = D @ t['ci']          # atividade vendedora x atividade compradora
    df_ativ = D @ t['df']        # atividade x componente da demanda final
    # Parcela importada dos insumos de cada atividade (estrutura 2015, aplicada aos valores do ano de referência).
    insumos_importados = []
    for j, a in enumerate(cods):
        tot = t['ci'][:, j].sum()
        imp_j = sum(t['ci'][i, j] * (pct_importado(p, a) or 0) for i, (p, _) in enumerate(t['produtos']))
        insumos_importados.append(imp_j / tot if tot else None)

    OUT_DIR.mkdir(exist_ok=True)
    csv_kw = dict(sep=';', decimal=',', encoding='utf-8-sig', index=False)

    pd.DataFrame({
        'Ano': ano_ref,
        'Codigo': cods,
        'Descricao': [d for _, d in t['ativs']],
        'Nome_Curto': [NOME_CURTO[c] for c in cods],
        'VBP': t['vbp'].round(1),
        'Valor_Adicionado': t['va'].round(1),
        'Ocupacoes': t['ocupacoes'].round(0),
        'Consumo_Intermediario': t['ci'].sum(axis=0).round(1),
        'Pct_Insumos_Importados_2015': np.round(np.array(insumos_importados, dtype=float), 4),
        'Multiplicador_Producao_2015': [round(mult[MIP_EQUIVALENTE.get(c, c)], 4) for c in cods],
        **{f'DF_{k.capitalize()}': df_ativ[:, i].round(1) for i, (k, _) in enumerate(DEMANDA_FINAL)},
    }).to_csv(OUT_DIR / 'Cadeia_Atividades.csv', **csv_kw)

    fl = [(ano_ref, cods[i], cods[j], round(fluxo[i, j], 1))
          for i in range(n) for j in range(n) if fluxo[i, j] >= 0.5]
    pd.DataFrame(fl, columns=['Ano', 'Origem', 'Destino', 'Valor']).to_csv(OUT_DIR / 'Cadeia_Fluxos_Atividades.csv', **csv_kw)

    destinos, oferta = [], []
    for ano, tr in trus.items():
        i = next(k for k, (p, _) in enumerate(tr['produtos']) if p == produto_setor)
        for j, (a, _) in enumerate(tr['ativs']):
            if tr['ci'][i, j]:
                destinos.append((ano, 'atividade', a, NOME_CURTO[a], tr['ci'][i, j], pct_importado(produto_setor, a)))
        for k, (chave, nome) in enumerate(DEMANDA_FINAL):
            if tr['df'][i, k]:
                destinos.append((ano, 'demanda_final', chave, nome, tr['df'][i, k], pct_importado(produto_setor, chave)))
        oferta.append((ano, tr['prod'][i].sum(), tr['imp'][i], tr['ci'][i].sum() + tr['df'][i].sum()))
    pd.DataFrame(destinos, columns=['Ano', 'Tipo', 'Codigo', 'Nome', 'Valor', 'Pct_Importado_2015']).to_csv(
        OUT_DIR / 'Cadeia_Produto_Destinos.csv', **csv_kw)
    pd.DataFrame(oferta, columns=['Ano', 'Producao_Nacional', 'Importacao', 'Demanda_Total']).to_csv(
        OUT_DIR / 'Cadeia_Produto_Oferta.csv', **csv_kw)

    j = cods.index(atividade_setor)
    produtor = {p: cods[int(np.argmax(t['prod'][i]))] for i, (p, _) in enumerate(t['produtos'])}
    insumos = [(ano_ref, p, d, produtor[p], t['ci'][i, j], pct_importado(p, atividade_setor))
               for i, (p, d) in enumerate(t['produtos']) if t['ci'][i, j]]
    pd.DataFrame(insumos, columns=['Ano', 'Produto', 'Descricao', 'Atividade_Produtora', 'Valor', 'Pct_Importado_2015']).to_csv(
        OUT_DIR / 'Cadeia_Insumos_Atividade.csv', **csv_kw)

    # Conferência: vendas intermediárias + demanda final de cada atividade ~ oferta dos seus produtos.
    oferta_ativ = D @ (t['ci'].sum(axis=1) + t['df'].sum(axis=1))
    desvio = np.abs((fluxo.sum(axis=1) + df_ativ.sum(axis=1)) / oferta_ativ - 1).max()
    print(f'OK: TRU {anos[0]}-{ano_ref}, {n} atividades, {len(fl)} fluxos, desvio máx. = {desvio:.2%}')
    print(f'Produto {produto_setor} ({cfg["nome_produto"]}) {ano_ref}: produção {oferta[-1][1]:.0f}, importação {oferta[-1][2]:.0f}, demanda {oferta[-1][3]:.0f} (R$ mi)')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description='Extrai das Contas Nacionais do IBGE os CSVs da aba Cadeia Produtiva.')
    ap.add_argument('--listar', action='store_true', help='lista os códigos de produtos e atividades da TRU')
    ap.add_argument('--sugerir', metavar='PRODUTO', help='mostra quem produz e quem compra o produto')
    args = ap.parse_args()
    if args.listar:
        listar()
    elif args.sugerir:
        sugerir(args.sugerir)
    else:
        main()
