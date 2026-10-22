# Painel do Setor de Borracha — CNAE 2212/2219

Painel executivo estático (sem framework, sem build step de JS) sobre o setor de
borracha no Brasil, em dois recortes alternáveis:

| CNAE | Rótulo no painel | Descrição oficial |
|---|---|---|
| 22.12-9 (2212) | Reforma de pneumáticos | Reforma de pneumáticos usados |
| 22.19-6 (2219) | Artefatos de borracha | Fabricação de artefatos de borracha não especificados anteriormente |

Pneus novos (CNAE 2211) não fazem parte do escopo. Blocos: produção física
(índice IBGE), financeiro (PIA), emprego formal (RAIS), CAGED, comércio
exterior (Comex Stat e Comtrade), BNDES, estudos especiais e energia industrial
(EPE/MME-ANEEL).

Publicado em <https://pedroazevedofiesp.github.io/dashboard-borracha/>.
Construído a partir do painel de fundição
([samuelmro/dashboard-fundicao](https://samuelmro.github.io/dashboard-fundicao/)).

## Estrutura

```
config_painel.json      Tudo o que é específico do setor (CNAEs, rótulos, prefixos de arquivo, cestas de NCM, textos)
3_Dados_Tratados_CSV/   CSVs tratados (uma linha por ano/mês/UF/categoria), separador ';' e decimal ','
build_data.py           Lê os CSVs e gera data/data.json (+ data/energia/*.json)
build_downloads.py      Lê os CSVs e gera data/downloads/*.xlsx (botão "Baixar dados" de cada seção)
data/data.json          Dado consolidado que o dashboard consome via fetch()
data/downloads/         Planilhas Excel formatadas, uma por seção (uma por CNAE quando o dado varia por segmento)
index.html              Estrutura das seções do painel
css/style.css           Estilo (paleta vermelho/navy, layout de duas colunas)
js/charts.js            Motor de gráficos SVG vanilla (sem libs externas)
js/main.js              Lógica de filtros, cálculos derivados e wiring dos gráficos
tests/test_build_data.py Testes de fumaça do pipeline (pytest)
serve.ps1               Servidor HTTP estático simples (PowerShell 7), porta 8791
ATUALIZACAO.md          Processo de atualização periódica dos dados, por fonte
```

Os dados de cada CNAE vivem no mesmo `data.json`, em `sectors["2212"]` e
`sectors["2219"]` — o seletor de segmento só troca qual chave é lida, sem novo
fetch. Dados que não variam por segmento ficam em `shared`: produção física
(índice PIM-PF da divisão borracha e plástico, `shared.producao.indice`),
financeiro (PIA do grupo 22.1 em `shared.financeiro.grupo` e abertura por
classe de 2024 em `shared.financeiro.por_cnae_2024`), macro e o bloco opcional
DECOM. `config_painel.json` vai inteiro para `meta.config`, de onde
`js/main.js` tira rótulos, notas e a lista de CNAEs.

## Como regenerar os dados

Pré-requisito: Python 3.10+.

```powershell
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python build_data.py
.venv\Scripts\python build_downloads.py
```

`build_data.py` lê tudo em `3_Dados_Tratados_CSV/` e regrava `data/data.json`;
`build_downloads.py` regrava as planilhas. O CI (`.github/workflows/build.yml`)
executa os dois em sequência a cada push.

## Como rodar localmente

```powershell
.venv\Scripts\python -m http.server 8791
```

(ou `pwsh -File serve.ps1`, se o PowerShell 7 estiver instalado). Abre em
`http://localhost:8791`. É um servidor estático puro — não faz build.

## Testes

```powershell
.venv\Scripts\python -m pytest
```

Os testes rodam `build_data.py` contra os CSVs reais (não há mocks) e checam,
para cada CNAE do `config_painel.json`: schema de alto nível, simetria entre os
setores, séries não vazias e em ordem cronológica, CAGED sem meses faltando,
Comex por NCM com os dois fluxos e o bloco de energia industrial.

## Replicar para outro setor

O painel foi montado como modelo: um setor novo é configuração e dados, não
código novo.

1. Gere os CSVs do setor com os scripts R de coleta (`Setor <Nome>/2_Scripts/`,
   fora deste repositório — ver `ATUALIZACAO.md`). Os nomes seguem o padrão
   abaixo, com `{slug}` e `{rotulo}` definidos no `config_painel.json`:
   - `Empregos_RAIS_UF_{rotulo}_{cnae}.csv`, `Empregos_RAIS_Tamanho_{rotulo}_{cnae}.csv`
   - `rais_vinc_{slug}_{escolaridade|ocupacao|ocupacao_agrupada|tempo_emprego|massa}_{cnae}.csv`
   - `caged_{slug}_{saldo_mensal_uf_cnae|salario_mensal_uf_cnae|tipo_movimentacao_mensal_cnae}.csv`
   - `Comex_Exportacao_Importacao_{cnae}.csv`, `Comex_{cnae}_NCM.csv`, `Comex_{cnae}_NCM_UF.csv`
   - `Comtrade_Global_{rotulo}_{cnae}.csv`, `BNDES_Desembolsos_{cnae}.csv`
   - `Dados_Financeiros_{rotulo}_{grupo com _}.csv`, `Dados_Financeiros_CNAE_{cnae1}_{cnae2}_2024_SerieNova.csv`
   - `Producao_Fisica_Mensal_{producao_rotulo_arquivo}.csv`, `Indicadores_Macro_e_Inflacao.csv`
   - `energia_industria_transformacao_*.csv` (iguais para todos os setores; copie de um painel existente)
2. Edite `config_painel.json`: nome, slug, rótulos, grupo CNAE, textos da
   produção física, CNAEs (com a cesta de NCM de cada um e se o comércio
   exterior é residual) e, se houver, o arquivo de DECOM em `blocos_opcionais`.
3. Rode `pytest`, `build_data.py` e `build_downloads.py` e revise o painel.

Um CNAE pode usar um prefixo próprio nos arquivos de RAIS/Comtrade com a chave
opcional `rotulo_arquivo` dentro do item do CNAE.

## Fontes de dados

| Bloco | Base | Cobertura |
|---|---|---|
| Produção física | IBGE — PIM-PF, divisão "3.22 borracha e plástico" (índice) | 2002–2026 (mensal) |
| Financeiro | IBGE — PIA-Empresa (grupo 22.1; por classe só em 2024) | 2007–2024 (anual) |
| Emprego formal | RAIS | 2006–2025 (anual) |
| CAGED | CAGED + novo CAGED (saldo, salário, tipo de movimentação) | jan/2008 a jul/2026 (mensal) |
| Comércio exterior | MDIC — Comex Stat, por cesta de NCM | 2006–2026 (anual, ano corrente parcial) |
| Comércio exterior (contexto mundial) | UN Comtrade (proxy por HS) | 2015–2024 (anual) |
| Energia Industrial | EPE (consumo) + MME/ANEEL (tarifa média faturada) | 2012–2026 (mensal, por UF e divisão CNAE) |
| BNDES | Desembolsos por UF/porte/instrumento | 2002–2026 (anual) |

Detalhes de cobertura e limitações metodológicas de cada fonte estão na aba
**Referências** do próprio painel, gerada a partir do mesmo `data.json`.

## Publicação (GitHub Pages)

`.github/workflows/build.yml` roda os testes, regenera `data/` e publica o site
a cada push na branch `main` que toque nos CSVs, no código ou no
`config_painel.json`. Em **Settings → Pages**, a fonte ("Source") deve ser
**GitHub Actions**. O `data/` gerado também é versionado, então o site
funciona mesmo com a fonte em "Deploy from a branch".
